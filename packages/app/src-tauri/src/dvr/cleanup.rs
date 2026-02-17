//! Cleanup manager for storage management
//!
//! Handles automatic deletion of old recordings and enforces disk quotas.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use sysinfo::Disks;
use tokio::time::interval;
use tracing::{debug, error, info, warn};

use crate::dvr::database::DvrDatabase;
use crate::dvr::models::DiskInfo;

/// Cleanup interval (1 hour)
const CLEANUP_INTERVAL_HOURS: u64 = 1;

/// Minimum free space percentage before aggressive cleanup
const MIN_FREE_SPACE_PERCENT: f64 = 10.0;

/// Manages storage cleanup
pub struct CleanupManager {
    db: Arc<DvrDatabase>,
}

impl CleanupManager {
    /// Create a new cleanup manager
    pub fn new(db: Arc<DvrDatabase>) -> Self {
        Self { db }
    }

    /// Start periodic cleanup task
    pub async fn start_periodic_cleanup(&self
    ) -> Result<()> {
        let db = self.db.clone();

        tokio::spawn(async move {
            let mut cleanup_interval = interval(
                Duration::from_secs(CLEANUP_INTERVAL_HOURS * 3600)
            );

            loop {
                cleanup_interval.tick().await;

                if let Err(e) = run_cleanup(&db).await {
                    error!("Cleanup failed: {}", e);
                }
            }
        });

        info!("Periodic cleanup task started (every {} hours)", CLEANUP_INTERVAL_HOURS);
        Ok(())
    }

    /// Run cleanup immediately (for manual trigger)
    pub async fn run_now(&self
    ) -> Result<()> {
        run_cleanup(&self.db).await
    }
}

/// Run cleanup operations
async fn run_cleanup(db: &Arc<DvrDatabase>) -> Result<()> {
    info!("Running storage cleanup...");

    let settings = db.get_settings()?;

    // Get storage path
    let storage_path = if settings.storage_path.is_empty() {
        let home = dirs::home_dir()
            .ok_or_else(|| anyhow::anyhow!("Failed to get home directory"))?;
        home.join("Videos").join("IPTV-Recordings")
    } else {
        std::path::PathBuf::from(&settings.storage_path)
    };

    // Check disk usage
    let disk_info = get_disk_info(&storage_path)?;
    info!(
        "Disk usage: {:.1}% ({} GB free of {} GB)",
        disk_info.usage_percent,
        disk_info.available_bytes / 1_000_000_000,
        disk_info.total_bytes / 1_000_000_000
    );

    // Delete old recordings based on age policy
    if let Some(keep_days) = settings.keep_recordings_days {
        let deleted = delete_old_recordings(db, &storage_path, keep_days).await?;
        if deleted > 0 {
            info!("Deleted {} old recordings ({} days policy)", deleted, keep_days);
        }
    }

    // Enforce disk quota if enabled
    if settings.auto_cleanup_enabled && disk_info.usage_percent > settings.max_disk_usage_percent as f64 {
        let target_usage = settings.max_disk_usage_percent as f64;
        let deleted = enforce_quota(db, &storage_path, disk_info.used_bytes, target_usage).await?;
        if deleted > 0 {
            info!("Deleted {} recordings to enforce {:.0}% quota", deleted, target_usage);
        }
    }

    // Emergency cleanup if critically low on space
    if disk_info.usage_percent > (100.0 - MIN_FREE_SPACE_PERCENT) {
        warn!("CRITICAL: Low disk space ({:.1}% free)!", 100.0 - disk_info.usage_percent);
        let deleted = emergency_cleanup(db, &storage_path).await?;
        if deleted > 0 {
            warn!("Emergency cleanup deleted {} recordings", deleted);
        }
    }

    // Update recording file sizes in database
    update_recording_sizes(db, &storage_path).await?;

    info!("Storage cleanup completed");
    Ok(())
}

/// Get disk information for a path
fn get_disk_info(path: &Path) -> Result<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();

    // Find the disk containing our path
    for disk in &disks {
        let mount_point = disk.mount_point();
        if path.starts_with(mount_point) {
            let total = disk.total_space();
            let available = disk.available_space();
            let used = total - available;
            let percent = (used as f64 / total as f64) * 100.0;

            return Ok(DiskInfo {
                total_bytes: total,
                available_bytes: available,
                used_bytes: used,
                usage_percent: percent,
            });
        }
    }

    // Could not determine disk info
    Err(anyhow::anyhow!("Could not determine disk info for path"))
}

/// Delete recordings older than specified days
async fn delete_old_recordings(
    db: &Arc<DvrDatabase>,
    _storage_path: &Path,
    max_age_days: i32
) -> Result<usize> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(max_age_days as i64);
    let cutoff_timestamp = cutoff.timestamp();

    let recordings = db.get_completed_recordings()?;
    let mut deleted_count = 0;

    for recording in recordings {
        // Check if recording is old enough
        let actual_end = recording.actual_end.unwrap_or(recording.created_at);
        if actual_end > cutoff_timestamp {
            continue;
        }

        // Check auto-delete policy
        match recording.auto_delete_policy.as_str() {
            "never" => continue,
            _ => {} // Delete for "space_needed" or invalid policies
        }

        // Delete file
        let file_path = std::path::PathBuf::from(&recording.file_path);
        if file_path.exists() {
            if let Err(e) = tokio::fs::remove_file(&file_path).await {
                warn!("Failed to delete old recording file {:?}: {}", file_path, e);
                continue;
            }
        }

        // Delete from database
        if let Err(e) = db.delete_recording(recording.id) {
            warn!("Failed to delete recording {} from DB: {}", recording.id, e);
            continue;
        }

        deleted_count += 1;
        debug!(
            "Deleted old recording: {} (ended {})",
            recording.program_title,
            chrono::DateTime::from_timestamp(actual_end, 0)
                .map(|dt| dt.format("%Y-%m-%d").to_string())
                .unwrap_or_default()
        );
    }

    Ok(deleted_count)
}

/// Enforce disk quota by deleting oldest recordings
async fn enforce_quota(
    db: &Arc<DvrDatabase>,
    storage_path: &Path,
    current_used: u64,
    target_percent: f64
) -> Result<usize> {
    // Get disk info
    let disk_info = get_disk_info(storage_path)?;

    // Calculate how much space we need to free
    let target_bytes = (disk_info.total_bytes as f64 * target_percent / 100.0) as u64;
    if current_used <= target_bytes {
        return Ok(0);
    }

    let bytes_to_free = current_used - target_bytes;
    let mut bytes_freed: u64 = 0;

    // Get recordings ordered by age (oldest first)
    let recordings = db.get_completed_recordings()?;
    let mut deleted_count = 0;

    for recording in recordings {
        if bytes_freed >= bytes_to_free {
            break;
        }

        // Skip if policy is "never"
        if recording.auto_delete_policy == "never" {
            continue;
        }

        // Delete file
        let file_path = std::path::PathBuf::from(&recording.file_path);
        if file_path.exists() {
            if let Err(e) = tokio::fs::remove_file(&file_path).await {
                warn!("Failed to delete recording file {:?}: {}", file_path, e);
                continue;
            }
            bytes_freed += recording.size_bytes.unwrap_or(0) as u64;
        }

        // Delete from database
        if let Err(e) = db.delete_recording(recording.id) {
            warn!("Failed to delete recording {} from DB: {}", recording.id, e);
            continue;
        }

        deleted_count += 1;
        debug!(
            "Deleted recording for quota: {} (freed {} MB)",
            recording.program_title,
            recording.size_bytes.unwrap_or(0) / 1_000_000
        );
    }

    Ok(deleted_count)
}

/// Emergency cleanup when critically low on space
async fn emergency_cleanup(
    db: &Arc<DvrDatabase>,
    _storage_path: &Path
) -> Result<usize> {
    // Get ALL completed recordings, ignore policy
    let recordings = db.get_completed_recordings()?;
    let mut deleted_count = 0;

    // Delete half of them (oldest first)
    let to_delete = recordings.len() / 2;

    for recording in recordings.iter().take(to_delete) {
        let file_path = std::path::PathBuf::from(&recording.file_path);
        if file_path.exists() {
            if let Err(e) = tokio::fs::remove_file(&file_path).await {
                warn!("Emergency delete failed for {:?}: {}", file_path, e);
                continue;
            }
        }

        if let Err(e) = db.delete_recording(recording.id) {
            warn!("Failed to delete recording {} from DB: {}", recording.id, e);
            continue;
        }

        deleted_count += 1;
    }

    Ok(deleted_count)
}

/// Update file sizes in database
async fn update_recording_sizes(
    db: &Arc<DvrDatabase>,
    _storage_path: &Path
) -> Result<()> {
    let recordings = db.get_completed_recordings()?;

    for recording in recordings {
        let file_path = std::path::PathBuf::from(&recording.file_path);
        if let Ok(metadata) = tokio::fs::metadata(&file_path).await {
            let size = metadata.len() as i64;
            if Some(size) != recording.size_bytes {
                if let Err(e) = db.update_recording_size(recording.id, size) {
                    warn!("Failed to update size for recording {}: {}", recording.id, e);
                }
            }
        }
    }

    Ok(())
}
