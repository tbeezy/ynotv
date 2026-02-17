//! DVR (Digital Video Recorder) module
//!
//! Provides scheduled recording functionality for IPTV streams.
//! Runs entirely within the Tauri process for efficiency.

pub mod database;
pub mod models;
pub mod scheduler;
pub mod recorder;
pub mod cleanup;
pub mod stream_resolver;
pub mod thumbnail;

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, error};
use tracing_subscriber;

use crate::dvr::database::DvrDatabase;
use crate::dvr::scheduler::Scheduler;
use crate::dvr::recorder::RecordingManager;
use crate::dvr::cleanup::CleanupManager;

/// Information about the currently playing stream
#[derive(Clone, Debug, Default)]
pub struct PlayingStream {
    pub source_id: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub stream_url: Option<String>,
    pub is_playing: bool,
}

/// Shared state for DVR operations
#[derive(Clone)]
pub struct DvrState {
    pub db: Arc<DvrDatabase>,
    pub scheduler: Arc<RwLock<Scheduler>>,
    pub recorder: Arc<RecordingManager>,
    pub cleanup: Arc<CleanupManager>,
    pub playing_stream: Arc<RwLock<PlayingStream>>,
}

// SAFETY: DvrState is only accessed from the Tokio runtime and all internal
// Arc pointers ensure thread-safe access to the underlying data.
// The JobScheduler inside Scheduler is wrapped in Arc<RwLock<>> which provides
// the necessary thread-safety guarantees.
unsafe impl Send for DvrState {}
unsafe impl Sync for DvrState {}

impl DvrState {
    /// Initialize the DVR system
    pub async fn new(app_handle: tauri::AppHandle) -> anyhow::Result<Self> {
        println!("[DVR State] Initializing DVR system...");
        info!("Initializing DVR system...");

        // Initialize database with connection pool
        println!("[DVR State] Creating DvrDatabase...");
        let db = match DvrDatabase::new(&app_handle) {
            Ok(db) => {
                println!("[DVR State] DVR database created successfully");
                Arc::new(db)
            }
            Err(e) => {
                println!("[DVR State] ERROR: Failed to create DvrDatabase: {}", e);
                return Err(e);
            }
        };
        info!("DVR database initialized");

        // Initialize recording manager
        println!("[DVR State] Creating RecordingManager...");
        let recorder = match RecordingManager::new(&app_handle, db.clone()) {
            Ok(rec) => {
                println!("[DVR State] RecordingManager created successfully");
                Arc::new(rec)
            }
            Err(e) => {
                println!("[DVR State] ERROR: Failed to create RecordingManager: {}", e);
                return Err(e);
            }
        };
        info!("Recording manager initialized");

        // Initialize cleanup manager
        println!("[DVR State] Creating CleanupManager...");
        let cleanup = Arc::new(CleanupManager::new(db.clone()));
        println!("[DVR State] CleanupManager created successfully");
        info!("Cleanup manager initialized");

        // Initialize scheduler
        println!("[DVR State] Creating Scheduler...");
        let scheduler = Arc::new(RwLock::new(Scheduler::new(db.clone(), recorder.clone())));
        println!("[DVR State] Scheduler created successfully");
        info!("Scheduler initialized");

        let state = Self {
            db,
            scheduler,
            recorder,
            cleanup,
            playing_stream: Arc::new(RwLock::new(PlayingStream::default())),
        };

        info!("DVR system initialized successfully");
        Ok(state)
    }

    /// Start all background tasks (scheduler, cleanup, etc.)
    pub async fn start_background_tasks(&self) -> anyhow::Result<()> {
        info!("Starting DVR background tasks...");

        // Start scheduler
        {
            let mut scheduler = self.scheduler.write().await;
            scheduler.start().await?;
        }
        info!("Scheduler started");

        // Start cleanup task
        self.cleanup.start_periodic_cleanup().await?;
        info!("Cleanup task started");

        info!("All DVR background tasks started");
        Ok(())
    }

    /// Stop all background tasks gracefully
    pub async fn stop(&self) {
        info!("Stopping DVR system...");

        // Stop scheduler
        {
            let mut scheduler = self.scheduler.write().await;
            scheduler.stop().await;
        }

        // Stop all active recordings
        if let Err(e) = self.recorder.stop_all_recordings().await {
            error!("Error stopping recordings: {}", e);
        }

        info!("DVR system stopped");
    }

    /// Update the currently playing stream information
    pub async fn set_playing_stream(&self, stream: PlayingStream) {
        let mut playing = self.playing_stream.write().await;
        *playing = stream;
    }

    /// Get the currently playing stream information
    pub async fn get_playing_stream(&self) -> PlayingStream {
        self.playing_stream.read().await.clone()
    }

    /// Check if recording would conflict with currently playing stream
    /// Returns true if there's a conflict (same source with limited connections)
    pub async fn check_viewing_conflict(
        &self,
        source_id: &str,
        _channel_id: &str,
    ) -> anyhow::Result<bool> {
        let playing = self.playing_stream.read().await;

        // If not playing anything, no conflict
        if !playing.is_playing {
            return Ok(false);
        }

        // Check if playing from the same source
        if let Some(playing_source) = &playing.source_id {
            if playing_source == source_id {
                // Get max connections for this source
                let max_connections = self.db.get_max_connections(source_id)?;

                // If single connection (1) or unknown (None/0), it's a conflict
                match max_connections {
                    Some(1) | None | Some(0) => {
                        return Ok(true);
                    }
                    Some(n) if n > 1 => {
                        // Multiple connections allowed, check if we're already using one
                        // For simplicity, assume watching uses 1 connection
                        // TODO: Track actual connection usage
                        return Ok(false);
                    }
                    _ => return Ok(true),
                }
            }
        }

        Ok(false)
    }
}

/// Initialize logging for DVR operations
///
/// When debug_logging is false, SQLX and other verbose logs are suppressed
pub fn init_logging(debug_logging: bool) {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = if debug_logging {
        // Show all logs including DEBUG
        EnvFilter::new("debug")
    } else {
        // Suppress sqlx and other verbose logs, only show INFO and above
        EnvFilter::new("info,sqlx=warn")
    };

    let subscriber = fmt()
        .with_target(true)
        .with_level(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true)
        .with_env_filter(filter)
        .finish();

    let _ = tracing::subscriber::set_global_default(subscriber);
}
