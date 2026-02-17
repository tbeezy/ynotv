//! Recording manager
//!
//! Manages FFmpeg processes for recording streams.
//! Handles process lifecycle, monitoring, and status updates.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::dvr::database::DvrDatabase;
use crate::dvr::models::{RecordingEvent, RecordingStatus, Schedule, ScheduleStatus};
use crate::dvr::stream_resolver::resolve_stream_url;
use crate::dvr::thumbnail::generate_thumbnail;
use rusqlite::OptionalExtension;
use tauri::{Emitter, Manager};

use tokio::sync::watch;

/// Active recording handle
struct RecordingHandle {
    /// FFmpeg child process (wrapped in Option so we can take ownership)
    process: Option<Child>,
    /// Recording ID in database
    recording_id: i64,
    /// Schedule that triggered this recording
    schedule: Schedule,
    /// When recording started
    start_time: Instant,
    /// Cancellation signal sender (cloned for external use)
    cancel_tx: watch::Sender<bool>,
}

/// Manages active recordings
pub struct RecordingManager {
    /// Active recordings by schedule ID
    active_recordings: Arc<Mutex<HashMap<i64, RecordingHandle>>>,
    /// Path to FFmpeg binary
    ffmpeg_path: PathBuf,
    /// Default storage directory
    default_storage: PathBuf,
    /// Database reference
    db: Arc<DvrDatabase>,
    /// App handle for emitting events
    app_handle: tauri::AppHandle,
    /// Channel for recording events
    event_tx: mpsc::Sender<RecordingEvent>,
}

impl RecordingManager {
    /// Create a new recording manager
    pub fn new(
        app_handle: &tauri::AppHandle,
        db: Arc<DvrDatabase>,
    ) -> Result<Self> {
        // Find FFmpeg binary
        let ffmpeg_path = find_ffmpeg(app_handle)?;
        info!("Using FFmpeg: {:?}", ffmpeg_path);

        // Get default storage path
        let default_storage = get_default_storage_path()?;
        info!("Default storage: {:?}", default_storage);

        // Ensure storage directory exists
        std::fs::create_dir_all(&default_storage)
            .context("Failed to create storage directory")?;

        // Create event channel
        let (event_tx, mut event_rx) = mpsc::channel::<RecordingEvent>(100);

        let manager = Self {
            active_recordings: Arc::new(Mutex::new(HashMap::new())),
            ffmpeg_path,
            default_storage,
            db,
            app_handle: app_handle.clone(),
            event_tx,
        };

        // Start event processing task
        let app_handle_clone = app_handle.clone();
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                if let Err(e) = app_handle_clone.emit("dvr:event", event) {
                    error!("Failed to emit DVR event: {}", e);
                }
            }
        });

        Ok(manager)
    }

    /// Record a scheduled program
    pub async fn record(&self, schedule: Schedule) -> Result<()> {
        // Check if this is a Stalker source that needs real-time URL resolution
        // Stalker sources have stream_url containing .m3u8, or we need to check the channel's direct_url
        let is_hls = schedule.stream_url.as_ref().map(|u| u.contains(".m3u8")).unwrap_or(false);

        // Also check if the channel's direct_url indicates Stalker
        let conn = self.db.get_conn()?;
        let direct_url: Option<String> = conn.query_row(
            "SELECT direct_url FROM channels WHERE stream_id = ?1",
            [&schedule.channel_id],
            |row| row.get(0)
        ).optional()?;

        let is_stalker_channel = direct_url.map(|url| url.starts_with("stalker_")).unwrap_or(false);

        let needs_url_resolution = is_hls || is_stalker_channel;

        println!("[DVR Recorder] Channel {}: is_hls={}, is_stalker={}, needs_resolution={}",
                 schedule.channel_id, is_hls, is_stalker_channel, needs_url_resolution);

        let stream_url = if needs_url_resolution {
            // For Stalker/HLS streams, request fresh URL from frontend
            println!("[DVR Recorder] Stalker/HLS stream detected, requesting fresh URL from frontend");

            // Emit event to frontend to resolve URL
            println!("[DVR Recorder] Emitting dvr:resolve_url_now event for schedule {}", schedule.id);
            let emit_result = self.app_handle.emit("dvr:resolve_url_now", serde_json::json!({
                "schedule_id": schedule.id,
                "channel_id": schedule.channel_id,
                "source_id": schedule.source_id,
            }));
            println!("[DVR Recorder] Emit result: {:?}", emit_result);

            // Wait for frontend to resolve and update the URL
            // Stalker resolution takes ~300-500ms, so we wait 1.5s to be safe
            println!("[DVR Recorder] Waiting 1.5s for frontend URL resolution...");
            tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

            // Re-fetch schedule to get updated URL
            let updated_schedule = self.db.get_schedule(schedule.id)?
                .ok_or_else(|| anyhow::anyhow!("Schedule disappeared"))?;

            if let Some(ref url) = updated_schedule.stream_url {
                println!("[DVR Recorder] Got updated URL from frontend: {}", url);
                url.clone()
            } else {
                // Fall back to original URL if frontend didn't update
                println!("[DVR Recorder] WARNING: Frontend didn't update URL, falling back to resolver");
                resolve_stream_url(&schedule, &self.db).await?
            }
        } else {
            // For non-HLS streams, use normal resolution
            println!("[DVR Recorder] Non-Stalker stream, using normal resolution");
            resolve_stream_url(&schedule, &self.db).await?
        };
        
        // DEBUG: Log the URL being used for recording
        println!("[DVR Recorder] Recording '{}' using URL: {}", schedule.program_title, stream_url);
        println!("[DVR Recorder] Schedule ID: {}, Channel ID: {}", schedule.id, schedule.channel_id);
        println!("[DVR Recorder] Stored stream_url in schedule: {:?}", schedule.stream_url);
        
        debug!("Resolved stream URL for {}", schedule.program_title);

        // Get storage path from settings or use default
        let storage_path = self.get_storage_path().await?;

        // Generate filename
        let filename = generate_filename(&schedule);
        let output_path = storage_path.join(&filename);

        // Calculate recording duration
        let duration_secs = schedule.actual_end() - schedule.actual_start();

        // Create recording entry in database
        let recording_id = self.db.add_recording(
            schedule.id,
            output_path.to_str().unwrap(),
            &filename,
            &schedule.channel_name,
            &schedule.program_title,
            schedule.scheduled_start,
            schedule.scheduled_end,
        )?;

        info!(
            "Recording #{}: {} ({} seconds)",
            recording_id, filename, duration_secs
        );

        // Emit started event
        let event = RecordingEvent::started(&schedule, recording_id);
        let _ = self.event_tx.send(event).await;

        // Detect stream type for appropriate FFmpeg flags
        let is_hls = stream_url.contains(".m3u8") || stream_url.contains("/mono.m3u8");
        println!("[DVR Recorder] Stream type: {}", if is_hls { "HLS (m3u8)" } else { "Direct TS" });
        
        // Build FFmpeg command
        let mut cmd = Command::new(&self.ffmpeg_path);
        
        // Input flags
        if is_hls {
            // HLS-specific flags
            cmd.arg("-live_start_index").arg("-1");  // Start from live edge
            cmd.arg("-http_persistent").arg("0");    // Don't reuse HTTP connections
        }
        
        cmd.arg("-timeout").arg("30000000")  // 30 second read timeout (microseconds)
            .arg("-i").arg(&stream_url)
            .arg("-c").arg("copy")              // Zero transcoding
            .arg("-t").arg(duration_secs.to_string())
            .arg("-fflags").arg("+flush_packets")  // Flush packets immediately
            .arg("-y")                           // Overwrite if exists
            .arg(&output_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Hide console window on Windows (CREATE_NO_WINDOW = 0x08000000)
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        // Spawn FFmpeg process
        let child = cmd.spawn()
            .context("Failed to spawn FFmpeg")?;

        // Create cancellation channel
        let (cancel_tx, cancel_rx) = watch::channel(false);

        // Track active recording
        let handle = RecordingHandle {
            process: Some(child),
            recording_id,
            schedule: schedule.clone(),
            start_time: Instant::now(),
            cancel_tx,
        };

        self.active_recordings.lock().insert(schedule.id, handle);

        // Wait for completion
        let result = self.wait_for_recording(schedule.id, recording_id, duration_secs, cancel_rx).await;

        // Remove from active recordings
        self.active_recordings.lock().remove(&schedule.id);

        // Handle result
        match result {
            Ok(()) => {
                info!("Recording #{} completed successfully", recording_id);

                // Get final file size
                let file_size = std::fs::metadata(&output_path)
                    .map(|m| m.len() as i64)
                    .ok();

                // Update recording status with file size
                self.db.update_recording_status(
                    recording_id,
                    RecordingStatus::Completed,
                    file_size,
                    None,
                )?;

                // Update schedule status to completed
                self.db.update_schedule_status(schedule.id, ScheduleStatus::Completed)?;

                // Get storage path for thumbnail generation
                let storage_path = self.get_storage_path().await?;

                // Generate thumbnail asynchronously
                let video_path = output_path.to_string_lossy().to_string();
                let db = self.db.clone();
                let recording_id_for_thumb = recording_id;
                let storage_path_for_thumb = storage_path.to_string_lossy().to_string();

                tokio::spawn(async move {
                    match generate_thumbnail(&video_path, recording_id_for_thumb, &storage_path_for_thumb).await {
                        Ok(Some(thumb_path)) => {
                            if let Err(e) = db.update_recording_thumbnail(
                                recording_id_for_thumb,
                                thumb_path.to_str().unwrap_or(""),
                            ) {
                                error!("Failed to update thumbnail path in database: {}", e);
                            }
                        }
                        Ok(None) => {
                            warn!("Thumbnail generation returned None for recording {}", recording_id_for_thumb);
                        }
                        Err(e) => {
                            error!("Thumbnail generation failed for recording {}: {}", recording_id_for_thumb, e);
                        }
                    }
                });

                // Emit completed event
                let event = RecordingEvent::completed(&schedule, recording_id);
                let _ = self.event_tx.send(event).await;

                Ok(())
            }
            Err(e) => {
                error!("Recording #{} failed: {}", recording_id, e);

                // Check if file was partially created
                let file_size = std::fs::metadata(&output_path)
                    .map(|m| m.len() as i64)
                    .unwrap_or(0);

                let status = if file_size > 0 {
                    RecordingStatus::Partial
                } else {
                    RecordingStatus::Failed
                };

                // Update database
                self.db.update_recording_status(
                    recording_id,
                    status.clone(),
                    Some(file_size),
                    Some(&e.to_string()),
                )?;

                // For partial recordings, also generate a thumbnail
                if file_size > 0 {
                    let storage_path = self.get_storage_path().await?;
                    let video_path = output_path.to_string_lossy().to_string();
                    let db = self.db.clone();
                    let recording_id_for_thumb = recording_id;
                    let storage_path_for_thumb = storage_path.to_string_lossy().to_string();

                    tokio::spawn(async move {
                        match generate_thumbnail(&video_path, recording_id_for_thumb, &storage_path_for_thumb).await {
                            Ok(Some(thumb_path)) => {
                                if let Err(e) = db.update_recording_thumbnail(
                                    recording_id_for_thumb,
                                    thumb_path.to_str().unwrap_or(""),
                                ) {
                                    error!("Failed to update thumbnail path for partial recording: {}", e);
                                }
                            }
                            Ok(None) => {
                                warn!("Thumbnail generation returned None for partial recording {}", recording_id_for_thumb);
                            }
                            Err(e) => {
                                error!("Thumbnail generation failed for partial recording {}: {}", recording_id_for_thumb, e);
                            }
                        }
                    });
                }

                // Emit failed event
                let event = RecordingEvent::failed(&schedule, e.to_string());
                let _ = self.event_tx.send(event).await;

                Err(e)
            }
        }
    }

    /// Wait for a recording to complete
    async fn wait_for_recording(
        &self,
        schedule_id: i64,
        recording_id: i64,
        expected_duration: i64,
        mut cancel_rx: watch::Receiver<bool>,
    ) -> Result<()> {
        // Take ownership of the process from the handle
        let mut child = {
            let mut recordings = self.active_recordings.lock();
            let handle = recordings.get_mut(&schedule_id)
                .context("Recording handle not found")?;
            handle.process.take()
                .context("Recording process already taken")?
        };

        // Start a task to capture stderr
        let stderr = child.stderr.take()
            .context("Failed to take stderr")?;

        let stderr_task = tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            let mut output = String::new();

            while let Ok(Some(line)) = lines.next_line().await {
                println!("[FFmpeg #{}] {}", recording_id, line);
                output.push_str(&line);
                output.push('\n');
            }

            output
        });

        // Wrap in Option to handle timeout case
        let mut stderr_task_opt = Some(stderr_task);

        // Wait for FFmpeg with timeout (duration + 5 minute buffer, min 10 minutes)
        let timeout_secs = std::cmp::max(expected_duration + 300, 600);
        let timeout = Duration::from_secs(timeout_secs as u64);
        info!("Recording #{} waiting with timeout: {}s", recording_id, timeout_secs);

        // Wait for completion, timeout, OR cancellation
        let result = tokio::select! {
            // Normal completion
            status = child.wait() => {
                // Get stderr output
                let stderr_task = stderr_task_opt.take()
                    .expect("stderr_task should exist");
                let stderr_output = match tokio::time::timeout(
                    Duration::from_secs(5),
                    stderr_task
                ).await {
                    Ok(Ok(output)) => output,
                    _ => "(stderr capture timed out or failed)".to_string(),
                };

                match status {
                    Ok(s) if s.success() => Ok(()),
                    Ok(s) => {
                        let code = s.code().unwrap_or(-1);
                        eprintln!("[DVR Recorder] FFmpeg stderr for recording #{}:\n{}", recording_id, stderr_output);
                        Err(anyhow::anyhow!("FFmpeg exited with code {}: {}", code, stderr_output.lines().last().unwrap_or("unknown error")))
                    }
                    Err(e) => Err(anyhow::anyhow!("FFmpeg wait error: {}", e))
                }
            }

            // Cancelled by user
            _ = cancel_rx.changed() => {
                info!("Recording #{} cancelled by user", recording_id);
                let _ = child.kill().await;
                if let Some(task) = stderr_task_opt {
                    task.abort();
                }
                Err(anyhow::anyhow!("Recording cancelled by user"))
            }

            // Timeout
            _ = tokio::time::sleep(timeout) => {
                warn!("Recording #{} timed out, killing FFmpeg", recording_id);
                let _ = child.kill().await;
                if let Some(task) = stderr_task_opt {
                    task.abort();
                }
                Err(anyhow::anyhow!("Recording timed out"))
            }
        };

        result
    }

    /// Stop a specific recording by schedule ID
    pub async fn stop_recording(&self, schedule_id: i64) -> Result<()> {
        println!("[DVR Recorder] stop_recording called for schedule {}", schedule_id);
        info!("Stopping recording for schedule {}", schedule_id);

        // Debug: print all active recordings
        {
            let recordings = self.active_recordings.lock();
            println!("[DVR Recorder] Active recordings: {:?}", recordings.keys().collect::<Vec<_>>());
        }

        // Get the cancel_tx sender
        let cancel_tx = {
            let recordings = self.active_recordings.lock();
            recordings.get(&schedule_id).map(|h| h.cancel_tx.clone())
        };

        if let Some(cancel_tx) = cancel_tx {
            println!("[DVR Recorder] Found recording, sending cancellation signal");
            info!("Sending cancellation signal for schedule {}", schedule_id);
            let _ = cancel_tx.send(true);

            // Give the cancellation a moment to be processed, then kill directly
            tokio::time::sleep(Duration::from_millis(100)).await;

            // Also try to kill the process directly
            // Take the process out of the handle while the lock is held, then kill outside
            let process_to_kill = {
                let mut recordings = self.active_recordings.lock();
                recordings.get_mut(&schedule_id).and_then(|h| h.process.take())
            };
            if let Some(mut process) = process_to_kill {
                println!("[DVR Recorder] Killing FFmpeg process directly");
                let _ = process.kill().await;
                info!("Killed FFmpeg process for schedule {}", schedule_id);
            } else {
                println!("[DVR Recorder] Process already taken (likely already stopped)");
            }
        } else {
            println!("[DVR Recorder] No active recording found for schedule {}", schedule_id);
            info!("No active recording found for schedule {}", schedule_id);
        }

        Ok(())
    }

    /// Stop all active recordings
    pub async fn stop_all_recordings(&self) -> Result<()> {
        let recordings: Vec<i64> = {
            let guard = self.active_recordings.lock();
            guard.keys().copied().collect()
        };

        info!("Stopping {} active recordings", recordings.len());

        for schedule_id in recordings {
            if let Some(mut handle) = self.active_recordings.lock().remove(&schedule_id) {
                if let Some(mut process) = handle.process.take() {
                    let _ = process.kill().await;
                }

                // Update status
                let _ = self.db.update_schedule_status(schedule_id, ScheduleStatus::Canceled);
            }
        }

        Ok(())
    }

    /// Get storage path from settings
    async fn get_storage_path(&self) -> Result<PathBuf> {
        let settings = self.db.get_settings()?;

        if settings.storage_path.is_empty() {
            Ok(self.default_storage.clone())
        } else {
            let path = PathBuf::from(&settings.storage_path);
            std::fs::create_dir_all(&path)?;
            Ok(path)
        }
    }

    /// Get active recordings with their current progress
    pub fn get_active_recordings(&self) -> Vec<RecordingProgress> {
        let recordings = self.active_recordings.lock();
        recordings
            .values()
            .map(|handle| {
                let elapsed = handle.start_time.elapsed().as_secs() as i64;
                RecordingProgress {
                    schedule_id: handle.schedule.id,
                    recording_id: handle.recording_id,
                    channel_name: handle.schedule.channel_name.clone(),
                    program_title: handle.schedule.program_title.clone(),
                    elapsed_seconds: elapsed,
                    scheduled_duration: handle.schedule.scheduled_end - handle.schedule.scheduled_start,
                }
            })
            .collect()
    }
}

/// Progress information for an active recording
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecordingProgress {
    pub schedule_id: i64,
    pub recording_id: i64,
    pub channel_name: String,
    pub program_title: String,
    pub elapsed_seconds: i64,
    pub scheduled_duration: i64,
}

/// Find FFmpeg binary
fn find_ffmpeg(app_handle: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;

    // First try to resolve as a sidecar (bundled external binary)
    // Sidecars are placed in the same directory as the main executable
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            // Sidecar naming: ffmpeg.exe on Windows, ffmpeg on Unix
            let sidecar_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
            let sidecar_path = dir.join(&sidecar_name);
            if sidecar_path.exists() {
                println!("[FFmpeg] Found sidecar at: {:?}", sidecar_path);
                return Ok(sidecar_path);
            }

            // Also check for platform-specific names (tauri bundles with target triple)
            #[cfg(target_os = "windows")]
            let platform_ffmpeg = dir.join("ffmpeg-x86_64-pc-windows-msvc.exe");
            #[cfg(target_os = "macos")]
            let platform_ffmpeg = dir.join("ffmpeg-x86_64-apple-darwin");
            #[cfg(target_os = "linux")]
            let platform_ffmpeg = dir.join("ffmpeg-x86_64-unknown-linux-gnu");

            if platform_ffmpeg.exists() {
                println!("[FFmpeg] Found platform-specific binary at: {:?}", platform_ffmpeg);
                return Ok(platform_ffmpeg);
            }
        }
    }

    // Try bundled FFmpeg in resources (legacy path)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        #[cfg(target_os = "windows")]
        let bundled = resource_dir.join("bin").join("ffmpeg-x86_64-pc-windows-msvc.exe");

        #[cfg(target_os = "macos")]
        let bundled = resource_dir.join("bin").join("ffmpeg-x86_64-apple-darwin");

        #[cfg(target_os = "linux")]
        let bundled = resource_dir.join("bin").join("ffmpeg-x86_64-unknown-linux-gnu");

        if bundled.exists() {
            println!("[FFmpeg] Found in resources: {:?}", bundled);
            return Ok(bundled);
        }
    }

    // Try development path
    #[cfg(debug_assertions)]
    {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });

        if dev_path.exists() {
            println!("[FFmpeg] Found in dev path: {:?}", dev_path);
            return Ok(dev_path);
        }
    }

    // Fallback to system FFmpeg
    let ffmpeg = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };

    // Check PATH
    if let Ok(path) = which::which(ffmpeg) {
        println!("[FFmpeg] Found in PATH: {:?}", path);
        return Ok(path);
    }

    Err(anyhow::anyhow!(
        "FFmpeg not found. Please install FFmpeg or ensure it's bundled with the app."
    ))
}

/// Get default storage path
fn get_default_storage_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Failed to get home directory")?;
    let path = home.join("Videos").join("IPTV-Recordings");
    Ok(path)
}

/// Generate filename for recording
fn generate_filename(schedule: &Schedule) -> String {
    let timestamp = chrono::DateTime::from_timestamp(schedule.scheduled_start, 0)
        .map(|dt| dt.format("%Y-%m-%dT%H-%M-%S").to_string())
        .unwrap_or_else(|| "unknown".to_string());

    // Sanitize for Windows
    let sanitized_title: String = schedule
        .program_title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c => c,
        })
        .take(50)
        .collect();

    let sanitized_channel: String = schedule
        .channel_name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c => c,
        })
        .take(30)
        .collect();

    format!("{}_{}_{}.ts", timestamp, sanitized_channel, sanitized_title)
}
