use serde::Deserialize;
use tauri::{AppHandle, Emitter, Runtime, Manager};
use tauri::path::BaseDirectory;

// DVR Module (Rust native implementation)
mod dvr;
use dvr::{DvrState, models::*};

// Bulk database operations module
mod db_bulk_ops;

// Streaming EPG parser module
mod epg_streaming;

// TMDB caching module
mod tmdb_cache;
use tmdb_cache::{TmdbCache, MatchResult, CacheStats};

// MPV Player module (platform-specific implementations)
mod mpv;
use mpv::MpvState;


// Bulk insert structures
#[derive(Debug, Deserialize)]
struct BulkInsertRequest {
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    operation: String, // "insert" or "replace"
}

// Note: MpvState, MpvStatus, MpvResponse are now defined in the mpv module

// Helper to get socket path
fn get_socket_path() -> String {
    #[cfg(target_os = "windows")]
    {
        format!(r"\\.\pipe\mpv-socket-{}", std::process::id())
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("/tmp/mpv-socket-{}", std::process::id())
    }
}

// Note: get_socket_path, spawn_mpv, connect_ipc, send_command functions
// are now in the mpv module (sidecar.rs for Windows/Linux, macos.rs for macOS)

// ============================================================================
// MPV Commands - Delegates to platform-specific implementation
// ============================================================================

#[tauri::command]
async fn init_mpv<R: Runtime>(app: AppHandle<R>, args: Vec<String>, state: tauri::State<'_, MpvState>) -> Result<(), String> {
    mpv::init_mpv(app, args, state).await
}

#[tauri::command]
async fn mpv_load<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    mpv::mpv_load(app, url).await
}

#[tauri::command]
async fn mpv_play<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_play(app).await
}

#[tauri::command]
async fn mpv_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_pause(app).await
}

#[tauri::command]
async fn mpv_resume<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_resume(app).await
}

#[tauri::command]
async fn mpv_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_stop(app).await
}

#[tauri::command]
async fn mpv_set_volume<R: Runtime>(app: AppHandle<R>, volume: f64) -> Result<(), String> {
    mpv::mpv_set_volume(app, volume).await
}

#[tauri::command]
async fn mpv_seek<R: Runtime>(app: AppHandle<R>, seconds: f64) -> Result<(), String> {
    mpv::mpv_seek(app, seconds).await
}

#[tauri::command]
async fn mpv_cycle_audio<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_cycle_audio(app).await
}

#[tauri::command]
async fn mpv_cycle_sub<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_cycle_sub(app).await
}

#[tauri::command]
async fn mpv_toggle_mute<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_toggle_mute(app).await
}

#[tauri::command]
async fn mpv_toggle_stats<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_toggle_stats(app).await
}

#[tauri::command]
fn mpv_toggle_fullscreen<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv::mpv_toggle_fullscreen(app)
}

#[tauri::command]
async fn mpv_get_track_list<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    mpv::mpv_get_track_list(app).await
}

#[tauri::command]
async fn mpv_set_audio<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<(), String> {
    mpv::mpv_set_audio(app, id).await
}

#[tauri::command]
async fn mpv_set_subtitle<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<(), String> {
    mpv::mpv_set_subtitle(app, id).await
}

#[tauri::command]
async fn mpv_set_property<R: Runtime>(app: AppHandle<R>, name: String, value: serde_json::Value) -> Result<(), String> {
    mpv::mpv_set_property(app, name, value).await
}

#[tauri::command]
async fn mpv_get_property<R: Runtime>(app: AppHandle<R>, name: String) -> Result<serde_json::Value, String> {
    mpv::mpv_get_property(app, name).await
}

#[tauri::command]
async fn mpv_set_video_margins<R: Runtime>(
    app: AppHandle<R>,
    left: Option<f64>,
    right: Option<f64>,
    top: Option<f64>,
    bottom: Option<f64>,
) -> Result<(), String> {
    mpv::mpv_set_video_margins(app, left, right, top, bottom).await
}

// Native bulk insert command
#[tauri::command]
async fn bulk_insert(
    app: AppHandle,
    request: BulkInsertRequest,
) -> Result<u64, String> {
    let db_path = app
        .path()
        .resolve(format!("{}.db", "ynotv"), BaseDirectory::AppConfig)
        .map_err(|e| format!("Failed to resolve db path: {}", e))?;

    let db_path_str = db_path.to_string_lossy().to_string();

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&format!("sqlite:{}", db_path_str))
        .await
        .map_err(|e| format!("Failed to connect to database: {}", e))?;

    let columns = request.columns.join(", ");
    let placeholders: Vec<String> = (0..request.columns.len())
        .map(|i| format!("?{}", i + 1))
        .collect();
    let placeholders_str = placeholders.join(", ");

    let sql = format!(
        "INSERT {} INTO {} ({}) VALUES ({})",
        if request.operation == "replace" { "OR REPLACE" } else { "" },
        request.table,
        columns,
        placeholders_str
    );

    let mut total_inserted: u64 = 0;
    let mut tx = pool.begin().await.map_err(|e| format!("Failed to begin transaction: {}", e))?;

    for row in request.rows {
        let mut query = sqlx::query(&sql);

        for value in row {
            query = match value {
                serde_json::Value::Null => query.bind(None::<String>),
                serde_json::Value::Bool(b) => query.bind(b),
                serde_json::Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        query.bind(i)
                    } else if let Some(f) = n.as_f64() {
                        query.bind(f)
                    } else {
                        query.bind(n.to_string())
                    }
                }
                serde_json::Value::String(s) => query.bind(s),
                _ => query.bind(value.to_string()),
            };
        }

        match query.execute(&mut *tx).await {
            Ok(result) => total_inserted += result.rows_affected(),
            Err(e) => {
                let _ = tx.rollback().await;
                return Err(format!("Insert error: {}", e));
            }
        }
    }

    tx.commit().await.map_err(|e| format!("Failed to commit transaction: {}", e))?;
    pool.close().await;

    Ok(total_inserted)
}

// =============================================================================
// Optimized Bulk Sync Commands (New Implementation)
// =============================================================================

/// Bulk upsert channels - optimized for sync operations
#[tauri::command]
async fn bulk_upsert_channels(
    state: tauri::State<'_, DvrState>,
    channels: Vec<db_bulk_ops::BulkChannel>,
) -> Result<db_bulk_ops::BulkResult, String> {
    println!("[bulk_upsert_channels] Called with {} channels", channels.len());
    db_bulk_ops::bulk_upsert_channels(&state.db, channels)
        .map_err(|e| {
            println!("[bulk_upsert_channels] ERROR: {}", e);
            format!("Bulk upsert channels failed: {}", e)
        })
}

/// Bulk upsert categories - optimized for sync operations
#[tauri::command]
async fn bulk_upsert_categories(
    state: tauri::State<'_, DvrState>,
    categories: Vec<db_bulk_ops::BulkCategory>,
) -> Result<db_bulk_ops::BulkResult, String> {
    db_bulk_ops::bulk_upsert_categories(&state.db, categories)
        .map_err(|e| format!("Bulk upsert categories failed: {}", e))
}

/// Bulk replace EPG programs for a source
#[tauri::command]
async fn bulk_replace_programs(
    state: tauri::State<'_, DvrState>,
    source_id: String,
    programs: Vec<db_bulk_ops::BulkProgram>,
) -> Result<db_bulk_ops::BulkResult, String> {
    db_bulk_ops::bulk_replace_programs(&state.db, &source_id, programs)
        .map_err(|e| format!("Bulk replace programs failed: {}", e))
}

/// Bulk upsert VOD movies
#[tauri::command]
async fn bulk_upsert_movies(
    state: tauri::State<'_, DvrState>,
    movies: Vec<db_bulk_ops::BulkMovie>,
) -> Result<db_bulk_ops::BulkResult, String> {
    db_bulk_ops::bulk_upsert_movies(&state.db, movies)
        .map_err(|e| format!("Bulk upsert movies failed: {}", e))
}

/// Bulk upsert VOD series
#[tauri::command]
async fn bulk_upsert_series(
    state: tauri::State<'_, DvrState>,
    series: Vec<db_bulk_ops::BulkSeries>,
) -> Result<db_bulk_ops::BulkResult, String> {
    db_bulk_ops::bulk_upsert_series(&state.db, series)
        .map_err(|e| format!("Bulk upsert series failed: {}", e))
}

/// Bulk delete channels
#[tauri::command]
async fn bulk_delete_channels(
    state: tauri::State<'_, DvrState>,
    stream_ids: Vec<String>,
) -> Result<usize, String> {
    db_bulk_ops::bulk_delete_channels(&state.db, stream_ids)
        .map_err(|e| format!("Bulk delete channels failed: {}", e))
}

/// Bulk delete categories
#[tauri::command]
async fn bulk_delete_categories(
    state: tauri::State<'_, DvrState>,
    category_ids: Vec<String>,
) -> Result<usize, String> {
    db_bulk_ops::bulk_delete_categories(&state.db, category_ids)
        .map_err(|e| format!("Bulk delete categories failed: {}", e))
}

/// Update source metadata
#[tauri::command]
async fn update_source_meta(
    state: tauri::State<'_, DvrState>,
    meta: db_bulk_ops::SourceMetaUpdate,
) -> Result<(), String> {
    println!("[update_source_meta] Called for source_id: {}", meta.source_id);
    db_bulk_ops::update_source_meta(&state.db, meta)
        .map_err(|e| {
            println!("[update_source_meta] ERROR: {}", e);
            format!("Update source meta failed: {}", e)
        })
}

/// Health check - verifies backend systems are ready
#[tauri::command]
async fn health_check(state: tauri::State<'_, DvrState>) -> Result<bool, String> {
    println!("[health_check] DVR state is active");
    Ok(true)
}

/// Stream and parse EPG from URL with progress updates
#[tauri::command]
async fn stream_parse_epg(
    app: AppHandle,
    state: tauri::State<'_, DvrState>,
    source_id: String,
    epg_url: String,
    channel_mappings: Vec<epg_streaming::ChannelMapping>,
) -> Result<epg_streaming::EpgParseResult, String> {
    epg_streaming::stream_parse_epg(app, &state.db, source_id, epg_url, channel_mappings)
        .await
        .map_err(|e| format!("Stream parse EPG failed: {}", e))
}

/// Parse EPG from local file with progress updates
#[tauri::command]
async fn parse_epg_file(
    app: AppHandle,
    state: tauri::State<'_, DvrState>,
    source_id: String,
    file_path: String,
    channel_mappings: Vec<epg_streaming::ChannelMapping>,
) -> Result<epg_streaming::EpgParseResult, String> {
    epg_streaming::parse_epg_file(app, &state.db, source_id, file_path, channel_mappings)
        .await
        .map_err(|e| format!("Parse EPG file failed: {}", e))
}

// =============================================================================
// DVR Commands (Rust Native Implementation)
// =============================================================================

/// Initialize the DVR system
#[tauri::command]
async fn init_dvr(
    app: AppHandle,
    state: tauri::State<'_, DvrState>,
) -> Result<(), String> {
    println!("[DVR Command] init_dvr called");

    state.start_background_tasks().await
        .map_err(|e| format!("Failed to start DVR: {}", e))?;

    // Emit ready event
    let _ = app.emit("dvr:ready", true);
    println!("[DVR Command] init_dvr completed successfully");

    Ok(())
}

/// Schedule a new recording
#[tauri::command]
async fn schedule_recording(
    state: tauri::State<'_, DvrState>,
    request: ScheduleRequest,
) -> Result<i64, String> {
    println!("[DVR Command] schedule_recording called: {}", request.program_title);
    println!("[DVR Command]   source_id: {}, channel_id: {}", request.source_id, request.channel_id);
    println!("[DVR Command]   scheduled_start: {}, scheduled_end: {}", request.scheduled_start, request.scheduled_end);

    // NOTE: For Stalker sources, we should NOT pre-resolve the URL because tokens expire quickly.
    // The URL will be resolved at recording time via resolve_dvr_stream_url command.
    // If a pre-resolved URL is provided for non-Stalker sources, it will be stored.

    let id = state.db.add_schedule(&request)
        .map_err(|e| {
            println!("[DVR Command] ERROR: Failed to schedule: {}", e);
            format!("Failed to schedule recording: {}", e)
        })?;

    println!("[DVR Command] Successfully scheduled with ID: {}", id);
    Ok(id)
}

/// Update the stream URL for a schedule (used by frontend to provide resolved Stalker URLs)
#[tauri::command]
async fn update_dvr_stream_url(
    state: tauri::State<'_, DvrState>,
    schedule_id: i64,
    stream_url: String,
) -> Result<(), String> {
    println!("[DVR Command] update_dvr_stream_url called for schedule {}: {}", schedule_id, stream_url);

    // Update the schedule with the resolved URL
    state.db.update_schedule_stream_url(schedule_id, &stream_url)
        .map_err(|e| format!("Failed to update stream URL: {}", e))?;

    println!("[DVR Command] Stream URL updated successfully for schedule {}", schedule_id);
    Ok(())
}

/// Get all scheduled recordings
#[tauri::command]
async fn get_scheduled_recordings(
    state: tauri::State<'_, DvrState>,
) -> Result<Vec<Schedule>, String> {
    let now = chrono::Utc::now().timestamp();

    let schedules = state.db.get_scheduled_recordings(now, 86400, 3600)
        .map_err(|e| format!("Failed to get recordings: {}", e))?;

    Ok(schedules)
}

/// Cancel a scheduled/recording item
#[tauri::command]
async fn cancel_recording(
    state: tauri::State<'_, DvrState>,
    id: i64,
) -> Result<(), String> {
    println!("[DVR Command] cancel_recording called for schedule {}", id);

    // First check if this is currently recording - if so, stop it
    let schedule = state.db.get_schedule(id)
        .map_err(|e| format!("Failed to get schedule: {}", e))?;

    if let Some(ref s) = schedule {
        if matches!(s.status, crate::dvr::models::ScheduleStatus::Recording) {
            println!("[DVR Command] Recording is active, stopping FFmpeg process...");
            state.recorder.stop_recording(id).await
                .map_err(|e| format!("Failed to stop recording: {}", e))?;
        }
    }

    // Cancel the schedule
    state.db.cancel_schedule(id)
        .map_err(|e| format!("Failed to cancel recording: {}", e))?;

    println!("[DVR Command] Recording {} canceled successfully", id);
    Ok(())
}

/// Delete a recording (file + thumbnail + database)
#[tauri::command]
async fn delete_recording(
    state: tauri::State<'_, DvrState>,
    id: i64,
) -> Result<(), String> {
    // Get file path and thumbnail path first
    let paths = state.db.delete_recording(id)
        .map_err(|e| format!("Failed to delete recording: {}", e))?;

    // Delete video file if it exists
    if let Some((file_path, thumbnail_path)) = paths {
        if std::path::Path::new(&file_path).exists() {
            let _ = tokio::fs::remove_file(file_path).await;
        }

        // Delete thumbnail if it exists
        if let Some(thumb_path) = thumbnail_path {
            if std::path::Path::new(&thumb_path).exists() {
                let _ = tokio::fs::remove_file(thumb_path).await;
            }
        }
    }

    Ok(())
}

/// Get all completed recordings
#[tauri::command]
async fn get_completed_recordings(
    state: tauri::State<'_, DvrState>,
) -> Result<Vec<Recording>, String> {
    let recordings = state.db.get_completed_recordings()
        .map_err(|e| format!("Failed to get recordings: {}", e))?;

    Ok(recordings)
}

/// Get active recordings with live progress
#[tauri::command]
async fn get_active_recordings(
    state: tauri::State<'_, DvrState>,
) -> Result<Vec<dvr::recorder::RecordingProgress>, String> {
    let progress = state.recorder.get_active_recordings();
    Ok(progress)
}

/// Get thumbnail image for a recording
#[tauri::command]
async fn get_recording_thumbnail(
    state: tauri::State<'_, DvrState>,
    recording_id: i64,
) -> Result<Option<Vec<u8>>, String> {
    // Get recording to find thumbnail path
    let recording = state.db.get_recording(recording_id)
        .map_err(|e| format!("Failed to get recording: {}", e))?;

    if let Some(rec) = recording {
        if let Some(thumbnail_path) = rec.thumbnail_path {
            // Read thumbnail file
            match tokio::fs::read(&thumbnail_path).await {
                Ok(data) => Ok(Some(data)),
                Err(e) => {
                    // Thumbnail file doesn't exist or can't be read
                    println!("[DVR] Thumbnail file not found or unreadable: {} - {}", thumbnail_path, e);
                    Ok(None)
                }
            }
        } else {
            // No thumbnail path set
            Ok(None)
        }
    } else {
        // Recording not found
        Err("Recording not found".to_string())
    }
}

/// Update schedule padding times
#[tauri::command]
async fn update_schedule_paddings(
    state: tauri::State<'_, DvrState>,
    id: i64,
    #[allow(non_snake_case)] startPaddingSec: i64,
    #[allow(non_snake_case)] endPaddingSec: i64,
) -> Result<(), String> {
    println!("[DVR Command] Updating padding for schedule {}: start={}, end={}", id, startPaddingSec, endPaddingSec);

    state.db.update_schedule_paddings(id, startPaddingSec, endPaddingSec)
        .map_err(|e| format!("Failed to update schedule paddings: {}", e))?;

    println!("[DVR Command] Schedule {} padding updated successfully", id);
    Ok(())
}

/// Check for schedule conflicts including connection limits
#[tauri::command]
async fn check_schedule_conflicts(
    state: tauri::State<'_, DvrState>,
    source_id: String,
    channel_id: String,
    start: i64,
    end: i64,
) -> Result<ScheduleConflict, String> {
    let (conflicts, max_connections) = state.db.check_conflicts(&source_id, start, end)
        .map_err(|e| format!("Failed to check conflicts: {}", e))?;

    // Check if max connections would be exceeded
    let max_conn = max_connections.unwrap_or(1);
    let would_exceed_limit = conflicts.len() as i32 >= max_conn;
    
    // Check if user is currently watching this source
    let viewing_conflict = state.check_viewing_conflict(&source_id, &channel_id).await
        .map_err(|e| format!("Failed to check viewing conflict: {}", e))?;

    let has_conflict = !conflicts.is_empty() || would_exceed_limit || viewing_conflict;
    
    let message = if has_conflict {
        let mut parts = Vec::new();
        if !conflicts.is_empty() {
            parts.push(format!("{} overlapping recording(s)", conflicts.len()));
        }
        if would_exceed_limit {
            parts.push(format!("connection limit ({} max)", max_conn));
        }
        if viewing_conflict {
            parts.push("you are currently watching this source".to_string());
        }
        Some(format!("Conflict: {}", parts.join(", ")))
    } else {
        None
    };

    Ok(ScheduleConflict {
        has_conflict,
        conflicts,
        message,
    })
}

/// Update currently playing stream information
#[tauri::command]
async fn update_playing_stream(
    state: tauri::State<'_, DvrState>,
    source_id: Option<String>,
    channel_id: Option<String>,
    channel_name: Option<String>,
    stream_url: Option<String>,
    is_playing: bool,
) -> Result<(), String> {
    use crate::dvr::PlayingStream;
    
    let stream = PlayingStream {
        source_id,
        channel_id,
        channel_name,
        stream_url,
        is_playing,
    };
    
    state.set_playing_stream(stream).await;
    Ok(())
}

/// Get DVR settings
#[tauri::command]
async fn get_dvr_settings(
    state: tauri::State<'_, DvrState>,
) -> Result<DvrSettings, String> {
    let settings = state.db.get_settings()
        .map_err(|e| format!("Failed to get settings: {}", e))?;

    Ok(settings)
}

/// Save DVR setting
#[tauri::command]
async fn save_dvr_setting(
    state: tauri::State<'_, DvrState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state.db.save_setting(&key, &value)
        .map_err(|e| format!("Failed to save setting: {}", e))?;

    Ok(())
}

/// Open log folder in system file explorer
#[tauri::command]
async fn open_log_folder() -> Result<(), String> {
    use std::process::Command;
    
    // Get the LOCAL app data directory (not roaming)
    // Tauri appLogDir uses local data directory on Windows
    let app_data_dir = if cfg!(target_os = "windows") {
        dirs::cache_dir()  // On Windows, cache_dir is actually LocalAppData
            .ok_or("Failed to get local data directory")?
            .join("com.ynotv.app")
            .join("logs")
    } else {
        dirs::data_dir()
            .ok_or("Failed to get data directory")?
            .join("com.ynotv.app")
            .join("logs")
    };
    
    // Create directory if it doesn't exist
    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create logs directory: {}", e))?;
    
    let path_str = app_data_dir.to_string_lossy().to_string();
    
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path_str)
            .spawn()
            .map_err(|e| format!("Failed to open log folder: {}", e))?;
    }
    
    Ok(())
}

/// Open file location in system file explorer
#[tauri::command]
async fn open_file_location(file_path: String) -> Result<(), String> {

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(&["/select,", &file_path])
            .spawn()
            .map_err(|e| format!("Failed to open file location: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(&["-R", &file_path])
            .spawn()
            .map_err(|e| format!("Failed to open file location: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&file_path).parent().ok_or("Failed to get parent directory")?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("Failed to open file location: {}", e))?;
    }

    Ok(())
}

/// Run cleanup now (manual trigger)
#[tauri::command]
async fn run_cleanup_now(
    state: tauri::State<'_, DvrState>,
) -> Result<(), String> {
    state.cleanup.run_now().await
        .map_err(|e| format!("Cleanup failed: {}", e))?;

    Ok(())
}

// =============================================================================
// TMDB Cache Commands
// =============================================================================

/// Get TMDB cache statistics
#[tauri::command]
async fn get_tmdb_cache_stats(app: AppHandle) -> Result<CacheStats, String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let cache = TmdbCache::new(cache_dir);
    cache.get_stats().await
        .map_err(|e| format!("Failed to get cache stats: {}", e))
}

/// Update TMDB movies cache
#[tauri::command]
async fn update_tmdb_movies_cache(app: AppHandle) -> Result<usize, String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let mut cache = TmdbCache::new(cache_dir);
    cache.update_movies_cache().await
        .map_err(|e| format!("Failed to update movies cache: {}", e))
}

/// Update TMDB series cache
#[tauri::command]
async fn update_tmdb_series_cache(app: AppHandle) -> Result<usize, String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let mut cache = TmdbCache::new(cache_dir);
    cache.update_series_cache().await
        .map_err(|e| format!("Failed to update series cache: {}", e))
}

/// Find movies by title
#[tauri::command]
async fn find_tmdb_movies(app: AppHandle, title: String) -> Result<Vec<MatchResult>, String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let mut cache = TmdbCache::new(cache_dir);
    cache.find_movies(&title).await
        .map_err(|e| format!("Failed to find movies: {}", e))
}

/// Find series by title
#[tauri::command]
async fn find_tmdb_series(app: AppHandle, title: String) -> Result<Vec<MatchResult>, String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let mut cache = TmdbCache::new(cache_dir);
    cache.find_series(&title).await
        .map_err(|e| format!("Failed to find series: {}", e))
}

/// Clear TMDB cache
#[tauri::command]
async fn clear_tmdb_cache(app: AppHandle) -> Result<(), String> {
    let cache_dir = app.path().app_cache_dir()
        .map_err(|e| format!("Failed to get cache dir: {}", e))?;

    let cache = TmdbCache::new(cache_dir);
    cache.clear_cache().await
        .map_err(|e| format!("Failed to clear cache: {}", e))
}

// App entry point
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
.plugin(tauri_plugin_log::Builder::new()
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
            .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { 
                file_name: Some("ynotv".into()) 
            }))
            .build())
        #[cfg(target_os = "macos")]
        .plugin(tauri_plugin_libmpv::init())
        .manage(mpv::MpvState::new())
        .setup(|app| {
            // Initialize DVR system FIRST before anything else
            let app_handle = app.handle().clone();

            // For now, disable verbose logging by default (sqlx logs are too noisy)
            // The debug setting will be checked dynamically when logging is requested
            dvr::init_logging(false);

            match tauri::async_runtime::block_on(async move {
                println!("[DVR Setup] Starting DVR initialization...");
                DvrState::new(app_handle).await
            }) {
                Ok(dvr_state) => {
                    println!("[DVR Setup] System initialized successfully, managing state...");
                    app.manage(dvr_state);
                    println!("[DVR Setup] State managed successfully");
                }
                Err(e) => {
                    eprintln!("[DVR Setup] WARNING: Failed to initialize full DVR: {}", e);
                    eprintln!("[DVR Setup] DVR features (recording) will be unavailable.");
                    eprintln!("[DVR Setup] Bulk sync operations may also be affected.");
                    // Don't try to create a partial state - bulk ops will fail gracefully
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            init_mpv,
            mpv_load,
            mpv_play,
            mpv_pause,
            mpv_resume,
            mpv_stop,
            mpv_set_volume,
            mpv_seek,
            mpv_cycle_audio,
            mpv_cycle_sub,
            mpv_toggle_mute,
            mpv_toggle_stats,
            mpv_toggle_fullscreen,
            mpv_get_track_list,
            mpv_set_audio,
            mpv_set_subtitle,
mpv_set_property,
            mpv_get_property,
            mpv_set_video_margins,
            bulk_insert,
            // Optimized bulk sync commands (new)
            bulk_upsert_channels,
            bulk_upsert_categories,
            bulk_replace_programs,
            bulk_upsert_movies,
            bulk_upsert_series,
            bulk_delete_channels,
            bulk_delete_categories,
            update_source_meta,
            health_check,
            // Streaming EPG commands (new)
            stream_parse_epg,
            parse_epg_file,
            // DVR commands (Rust native)
            init_dvr,
            schedule_recording,
            get_scheduled_recordings,
            cancel_recording,
            delete_recording,
            get_completed_recordings,
            get_active_recordings,
            get_recording_thumbnail,
            update_schedule_paddings,
            check_schedule_conflicts,
            update_playing_stream,
            update_dvr_stream_url,
            get_dvr_settings,
            save_dvr_setting,
            open_file_location,
            open_log_folder,
            run_cleanup_now,
            // TMDB cache commands (new)
            get_tmdb_cache_stats,
            update_tmdb_movies_cache,
            update_tmdb_series_cache,
            find_tmdb_movies,
            find_tmdb_series,
            clear_tmdb_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
