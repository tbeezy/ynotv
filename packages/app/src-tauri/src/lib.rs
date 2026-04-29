use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, Manager};
use tracing::{debug, info, warn, error};


// macOS-specific imports for window configuration
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

// Platform-specific MPV modules
#[cfg(target_os = "macos")]
mod mpv_macos;
#[cfg(target_os = "windows")]
mod mpv_windows;
#[cfg(target_os = "windows")]
mod mpv_secondary;

// Re-export the MPV state and functions based on platform
#[cfg(target_os = "macos")]
use mpv_macos::MpvState;
#[cfg(target_os = "windows")]
use mpv_windows::MpvState;
#[cfg(target_os = "windows")]
use mpv_secondary::SecondaryMpvState;

// DVR Module (Rust native implementation)
mod dvr;
use dvr::{DvrState, models::*};

// Bulk database operations module
mod db_bulk_ops;
mod sync_provider;

// Streaming EPG parser module
mod epg_streaming;

// TMDB caching module
mod tmdb_cache;

// TVMaze module for TV Calendar
mod tvmaze;
use tmdb_cache::{TmdbCache, MatchResult, CacheStats};


// Bulk insert structures
#[derive(Debug, Deserialize)]
struct BulkInsertRequest {
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    operation: String, // "insert" or "replace"
}

// MPV Status structure (used by both platforms)
#[derive(Serialize, Deserialize, Clone, Debug)]
struct MpvStatus {
    playing: bool,
    volume: f64,
    muted: bool,
    position: f64,
    duration: f64,
}

// ============================================================================
// MPV Helper Functions
// ============================================================================

/// Get custom MPV parameters from settings store.
/// Supports both nested `settings` object (frontend format) and root-level keys (legacy).
async fn get_mpv_params_from_store<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    use tauri_plugin_store::StoreExt;

    match app.store(".settings.dat") {
        Ok(store) => {
            let mut args: Vec<String> = Vec::new();

            // Try nested "settings" object first (frontend format), fall back to root level
            let nested = store.get("settings")
                .and_then(|v| v.as_object().cloned());

            // Helper to read a value: nested first, then root fallback
            let get_value = |key: &str| -> Option<serde_json::Value> {
                if let Some(ref obj) = nested {
                    if let Some(v) = obj.get(key) {
                        debug!("[MPV] Found '{}' in nested settings", key);
                        return Some(v.clone());
                    }
                }
                let root_val = store.get(key);
                if root_val.is_some() {
                    debug!("[MPV] Found '{}' at root level (legacy)", key);
                }
                root_val
            };

            // Load user-defined MPV params
            if let Some(params) = get_value("mpvParams") {
                if let Some(params_str) = params.as_str() {
                    let custom_args: Vec<String> = params_str
                        .lines()
                        .map(|line| line.trim())
                        .filter(|line| !line.is_empty() && !line.starts_with('#'))
                        .map(|s| s.to_string())
                        .collect();
                    debug!("[MPV] Loaded {} custom parameters from settings", custom_args.len());
                    for (i, arg) in custom_args.iter().enumerate() {
                        debug!("[MPV]   Custom arg[{}]: {}", i, arg);
                    }
                    args.extend(custom_args);
                }
            } else {
                debug!("[MPV] No mpvParams found in store");
            }

            // Inject timeshift back-buffer arg if enabled
            let ts_enabled = get_value("timeshiftEnabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            debug!("[MPV] TimeShift enabled from store: {}", ts_enabled);

            if ts_enabled {
                let cache_bytes = get_value("timeshiftCacheBytes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_073_741_824); // default 1 GB
                let flag = format!("--demuxer-max-back-bytes={}", cache_bytes);
                debug!("[MPV] TimeShift enabled — injecting: {}", flag);
                args.push(flag);
            }

            return args;
        }
        Err(e) => {
            error!("[MPV] Failed to open settings store: {}", e);
        }
    }
    Vec::new()
}

// ============================================================================
// MPV Security Allowlist
// ============================================================================

const ALLOWED_MPV_KEYS: &[&str] = &[
    "hwdec", "hwdec-codecs", "vo", "ao", "profile", "audio-device",
    "audio-spdif", "audio-channels", "volume-max", "audio-exclusive",
    "cache", "cache-secs", "cache-pause", "demuxer-max-bytes", "demuxer-max-back-bytes",
    "demuxer-readahead-secs", "force-seekable",
    "sub-font", "sub-font-size", "sub-color", "sub-border-color", "sub-border-size",
    "sub-shadow-color", "sub-shadow-offset", "sub-margin-y", "sub-align-x", "sub-align-y",
    "osd-font", "osd-font-size", "osd-color", "osd-border-color", "osd-border-size",
    "osd-shadow-color", "osd-shadow-offset", "osd-margin-x", "osd-margin-y",
    "slang", "alang", 
    "vd-lavc-dr", "vd-lavc-threads", "ad-lavc-threads",
    "video-sync", "interpolation", "tscale",
    "deinterlace",
    "scale", "cscale", "dscale", "dither-depth", "correct-downscaling", "linear-downscaling",
    "sigmoid-upscaling", "deband",
    "hr-seek-framedrop", "keep-open",
    "network-timeout", "stream-buffer-size",
    // TimeShift/Dumping parameters
    "stream-record", "capture", "dump-stream", "recorder-muxer", "record-file",
];

const BLOCKED_MPV_KEYS: &[&str] = &[
    "script", "script-opts", "scripts", 
    "config", "config-dir", "no-config",
    "input-ipc-server", "input-conf",
    "log-file", "dump-stats",
    "ytdl-raw-options", "lavfi-complex",
    "sub-file", "audio-file", "external-file",
];

fn sanitize_mpv_args(args: Vec<String>) -> Vec<String> {
    let mut safe_args = Vec::new();
    
    for arg in args {
        if !arg.starts_with("--") {
            log::warn!("SECURITY ALERT: Dropped malformed MPV argument (must start with --): {}", arg);
            continue;
        }
        
        let without_dashes = &arg[2..];
        let mut parts = without_dashes.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        
        // Special handling for script-opts: allow only stats-* options
        if key == "script-opts" {
            if let Some(value) = parts.next() {
                let opts: Vec<&str> = value.split(',').collect();
                let all_stats = opts.iter().all(|opt| {
                    let opt_key = opt.splitn(2, '=').next().unwrap_or("").trim();
                    !opt_key.is_empty() && opt_key.starts_with("stats-")
                });
                if all_stats && !opts.is_empty() {
                    safe_args.push(arg);
                } else {
                    log::warn!("SECURITY ALERT: Blocked script-opts with non-stats keys: {}", arg);
                }
            } else {
                log::warn!("SECURITY ALERT: Blocked script-opts without value: {}", arg);
            }
            continue;
        }
        
        if BLOCKED_MPV_KEYS.contains(&key) {
            log::warn!("SECURITY ALERT: Blocked blacklisted MPV argument: {}", key);
            continue;
        }
        
        if ALLOWED_MPV_KEYS.contains(&key) {
            safe_args.push(arg);
        } else {
            log::warn!("SECURITY ALERT: Dropped unrecognized/untrusted MPV argument: {}", key);
        }
    }
    
    safe_args
}

// ============================================================================
// MPV Commands - Unified API
// ============================================================================

#[tauri::command]
async fn init_mpv<R: Runtime>(app: AppHandle<R>, args: Vec<String>) -> Result<(), String> {
    debug!("[MPV] init_mpv called with {} args", args.len());
    for (i, arg) in args.iter().enumerate() {
        debug!("[MPV]   Arg[{}]: {}", i, arg);
    }

    // Load custom MPV parameters from settings
    let mut custom_params = get_mpv_params_from_store(&app).await;

    // Merge frontend-provided args (for timeshift settings from loaded state)
    // Frontend args are added after store params so they take precedence
    if !args.is_empty() {
        debug!("[MPV] Merging {} frontend-provided args", args.len());
        for arg in &args {
            debug!("[MPV]   Frontend arg: {}", arg);
            // Remove any existing arg with same prefix to avoid duplicates
            let prefix = arg.split('=').next().unwrap_or(arg);
            custom_params.retain(|p| !p.starts_with(prefix));
            custom_params.push(arg.clone());
        }
    }

    // Apply the Security Allowlist Firewall
    let safe_custom_params = sanitize_mpv_args(custom_params);

    debug!("[MPV] Final params for MPV:");
    for (i, param) in safe_custom_params.iter().enumerate() {
        debug!("[MPV]   [{}]: {}", i, param);
    }

    #[cfg(target_os = "macos")]
    {
        mpv_macos::init_mpv_with_params(app, safe_custom_params).await
    }
    #[cfg(target_os = "windows")]
    {
        let state = app.state::<MpvState>();
        mpv_windows::init_mpv_with_params(app.clone(), state, safe_custom_params).await
    }
}

#[tauri::command]
async fn mpv_load<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::load_file(&app, url).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::load_file(&app, url).await
    }
}

#[tauri::command]
async fn mpv_play<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::play(&app).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::play(&app).await
    }
}

#[tauri::command]
async fn mpv_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::pause(&app).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::pause(&app).await
    }
}

#[tauri::command]
async fn mpv_resume<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::play(&app).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::resume(&app).await
    }
}

#[tauri::command]
async fn mpv_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::stop(&app).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::stop(&app).await
    }
}

#[tauri::command]
async fn mpv_set_volume<R: Runtime>(app: AppHandle<R>, volume: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::set_volume(&app, volume).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::set_volume(&app, volume).await
    }
}

#[tauri::command]
async fn mpv_seek<R: Runtime>(app: AppHandle<R>, seconds: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::seek(&app, seconds).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::seek(&app, seconds).await
    }
}

#[tauri::command]
async fn mpv_toggle_mute<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::toggle_mute(&app).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::toggle_mute(&app).await
    }
}

#[tauri::command]
async fn mpv_cycle_audio<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::cycle_audio(&app).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::cycle_audio(&app).await
    }
}

#[tauri::command]
async fn mpv_cycle_sub<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::cycle_sub(&app).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::cycle_sub(&app).await
    }
}

#[tauri::command]
async fn mpv_get_track_list<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::get_track_list(&app).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::get_track_list(&app).await
    }
}

#[tauri::command]
async fn mpv_set_audio<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::set_audio_track(&app, id).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::set_audio_track(&app, id).await
    }
}

#[tauri::command]
async fn mpv_set_subtitle<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::set_subtitle_track(&app, id).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::set_subtitle_track(&app, id).await
    }
}

#[tauri::command]
async fn mpv_set_properties<R: Runtime>(
    app: AppHandle<R>,
    properties: Vec<(String, serde_json::Value)>,
) -> Result<(), String> {
    for (name, value) in properties {
        #[cfg(target_os = "macos")]
        {
            mpv_macos::set_property(&app, name, value).await?;
        }
        #[cfg(target_os = "windows")]
        {
            mpv_windows::set_property(&app, name, value).await?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn mpv_set_property<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    value: serde_json::Value,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::set_property(&app, name, value).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::set_property(&app, name, value).await
    }
}

#[tauri::command]
async fn mpv_get_property<R: Runtime>(app: AppHandle<R>, name: String) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::get_property(&app, &name).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::get_property(&app, name).await
    }
}

#[tauri::command]
async fn mpv_sync_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Main window not found")?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    
    #[cfg(target_os = "macos")]
    {
        mpv_macos::sync_window(&app, pos.x, pos.y, size.width, size.height).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::sync_window(&app, pos.x, pos.y, size.width, size.height).await
    }
}

#[tauri::command]
async fn mpv_kill<R: Runtime>(app: AppHandle<R>) {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::kill_mpv(&app).await;
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::kill_mpv(&app).await;
    }
}

/// Debug command to get all cache-related MPV properties
#[tauri::command]
async fn mpv_get_cache_debug<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    use serde_json::json;

    let mut result = serde_json::Map::new();

    // Get demuxer-max-back-bytes (the cache size setting)
    let max_bytes = mpv_get_property(app.clone(), "demuxer-max-back-bytes".to_string()).await;
    result.insert("demuxer-max-back-bytes".to_string(), max_bytes.unwrap_or(json!(null)));

    // Get demuxer-max-bytes
    let max_bytes_fwd = mpv_get_property(app.clone(), "demuxer-max-bytes".to_string()).await;
    result.insert("demuxer-max-bytes".to_string(), max_bytes_fwd.unwrap_or(json!(null)));

    // Get cache property
    let cache_enabled = mpv_get_property(app.clone(), "cache".to_string()).await;
    result.insert("cache".to_string(), cache_enabled.unwrap_or(json!(null)));

    // Get demuxer-cache-state
    let cache_state = mpv_get_property(app.clone(), "demuxer-cache-state".to_string()).await;
    result.insert("demuxer-cache-state".to_string(), cache_state.unwrap_or(json!(null)));

    debug!("[MPV Debug] Cache settings: {:?}", result);
    Ok(serde_json::Value::Object(result))
}

#[tauri::command]
async fn mpv_toggle_fullscreen<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
        
        // On Windows, if window is maximized and we're going fullscreen,
        // we need to unmaximize first to ensure proper fullscreen transition
        #[cfg(target_os = "windows")]
        if !is_fullscreen {
            let is_maximized = window.is_maximized().map_err(|e| e.to_string())?;
            if is_maximized {
                window.unmaximize().map_err(|e| e.to_string())?;
                // Small delay to let the window state settle before going fullscreen
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        
        window.set_fullscreen(!is_fullscreen).map_err(|e| e.to_string())?;
        
        // On Windows, trigger a geometry refresh after entering fullscreen
        // to ensure MPV fills the entire screen
        #[cfg(target_os = "windows")]
        {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = mpv_windows::mpv_set_geometry(&app, 0, 0, 0, 0).await;
        }
        
        // On macOS, we need to sync the window after fullscreen change
        #[cfg(target_os = "macos")]
        {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let pos = window.outer_position().map_err(|e| e.to_string())?;
            let size = window.outer_size().map_err(|e| e.to_string())?;
            mpv_macos::sync_window(&app, pos.x, pos.y, size.width, size.height).await?;
        }
        
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
async fn mpv_toggle_stats<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // Send script-binding command for stats display
    #[cfg(target_os = "macos")]
    {
        mpv_macos::send_command(&app, serde_json::json!({ 
            "command": ["script-binding", "stats/display-stats-toggle"] 
        })).await?;
    }
    #[cfg(target_os = "windows")]
    {
        use serde_json::json;
        mpv_windows::send_command(&app, "script-binding", vec![json!("stats/display-stats-toggle")]).await?;
    }
    Ok(())
}

#[tauri::command]
async fn mpv_set_geometry<R: Runtime>(
    app: AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // On macOS, hole-punch mode uses window syncing — geometry not directly supported
        let _ = (x, y, width, height);
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::mpv_set_geometry(&app, x, y, width, height).await
    }
}

// ============================================================================
// Secondary MPV commands for multiview
// ============================================================================

#[tauri::command]
async fn multiview_load_slot<R: Runtime>(
    app: AppHandle<R>,
    slot_id: u8,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    { mpv_secondary::load_slot(&app, slot_id, url, x, y, width, height).await }
    #[cfg(not(target_os = "windows"))]
    { let _ = (slot_id, url, x, y, width, height); Ok(()) }
}

#[tauri::command]
async fn multiview_stop_slot<R: Runtime>(
    app: AppHandle<R>,
    slot_id: u8,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    { mpv_secondary::stop_slot(&app, slot_id).await }
    #[cfg(not(target_os = "windows"))]
    { let _ = slot_id; Ok(()) }
}

#[tauri::command]
async fn multiview_set_property_slot<R: Runtime>(
    app: AppHandle<R>,
    slot_id: u8,
    property: String,
    value: serde_json::Value,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    { mpv_secondary::set_property_slot(&app, slot_id, &property, value).await }
    #[cfg(not(target_os = "windows"))]
    { let _ = (slot_id, property, value); Ok(()) }
}

#[tauri::command]
async fn multiview_reposition_slot<R: Runtime>(
    app: AppHandle<R>,
    slot_id: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    { mpv_secondary::reposition_slot(&app, slot_id, x, y, width, height).await }
    #[cfg(not(target_os = "windows"))]
    { let _ = (slot_id, x, y, width, height); Ok(()) }
}

#[tauri::command]
async fn multiview_kill_slot<R: Runtime>(
    app: AppHandle<R>,
    slot_id: u8,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    { mpv_secondary::kill_slot(&app, slot_id).await; Ok(()) }
    #[cfg(not(target_os = "windows"))]
    { let _ = slot_id; Ok(()) }
}

#[tauri::command]
async fn multiview_kill_all<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    { mpv_secondary::kill_all(&app).await; Ok(()) }
    #[cfg(not(target_os = "windows"))]
    { Ok(()) }
}

// ============================================================================
// DVR Commands (Rust Native Implementation)
// ============================================================================

/// Initialize the DVR system
#[tauri::command]
async fn init_dvr(
    app: AppHandle,
    state: tauri::State<'_, DvrState>,
) -> Result<(), String> {
    info!("[DVR Command] init_dvr called");

    state.start_background_tasks().await
        .map_err(|e| format!("Failed to start DVR: {}", e))?;

    // Emit ready event
    let _ = app.emit("dvr:ready", true);
    info!("[DVR Command] init_dvr completed successfully");

    Ok(())
}

/// Schedule a new recording
#[tauri::command]
async fn schedule_recording(
    state: tauri::State<'_, DvrState>,
    request: ScheduleRequest,
) -> Result<i64, String> {
    debug!("[DVR Command] schedule_recording called: {}", request.program_title);
    debug!("[DVR Command]   source_id: {}, channel_id: {}", request.source_id, request.channel_id);
    debug!("[DVR Command]   scheduled_start: {}, scheduled_end: {}", request.scheduled_start, request.scheduled_end);

    // NOTE: For Stalker sources, we should NOT pre-resolve the URL because tokens expire quickly.
    // The URL will be resolved at recording time via resolve_dvr_stream_url command.
    // If a pre-resolved URL is provided for non-Stalker sources, it will be stored.

    let id = state.db.add_schedule(&request)
        .map_err(|e| {
            error!("[DVR Command] ERROR: Failed to schedule: {}", e);
            format!("Failed to schedule recording: {}", e)
        })?;

    debug!("[DVR Command] Successfully scheduled with ID: {}", id);
    Ok(id)
}

/// Update the stream URL for a schedule (used by frontend to provide resolved Stalker URLs)
#[tauri::command]
async fn update_dvr_stream_url(
    state: tauri::State<'_, DvrState>,
    schedule_id: i64,
    stream_url: String,
) -> Result<(), String> {
    debug!("[DVR Command] update_dvr_stream_url called for schedule {}: {}", schedule_id, stream_url);

    // Update the schedule with the resolved URL
    state.db.update_schedule_stream_url(schedule_id, &stream_url)
        .map_err(|e| format!("Failed to update stream URL: {}", e))?;

    debug!("[DVR Command] Stream URL updated successfully for schedule {}", schedule_id);
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
    debug!("[DVR Command] cancel_recording called for schedule {}", id);

    // First check if this is currently recording - if so, stop it
    let schedule = state.db.get_schedule(id)
        .map_err(|e| format!("Failed to get schedule: {}", e))?;

    if let Some(ref s) = schedule {
        if matches!(s.status, crate::dvr::models::ScheduleStatus::Recording) {
            debug!("[DVR Command] Recording is active, stopping FFmpeg process...");
            state.recorder.stop_recording(id).await
                .map_err(|e| format!("Failed to stop recording: {}", e))?;
        }
    }

    // Cancel the schedule
    state.db.cancel_schedule(id)
        .map_err(|e| format!("Failed to cancel recording: {}", e))?;

    debug!("[DVR Command] Recording {} canceled successfully", id);
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
                    warn!("[DVR] Thumbnail file not found or unreadable: {} - {}", thumbnail_path, e);
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
    debug!("[DVR Command] Updating padding for schedule {}: start={}, end={}", id, startPaddingSec, endPaddingSec);

    state.db.update_schedule_paddings(id, startPaddingSec, endPaddingSec)
        .map_err(|e| format!("Failed to update schedule paddings: {}", e))?;

    debug!("[DVR Command] Schedule {} padding updated successfully", id);
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
// Optimized Bulk Sync Commands
// =============================================================================

/// Bulk upsert channels - optimized for sync operations
#[tauri::command]
async fn bulk_upsert_channels(
    state: tauri::State<'_, DvrState>,
    channels: Vec<db_bulk_ops::BulkChannel>,
) -> Result<db_bulk_ops::BulkResult, String> {
    debug!("[bulk_upsert_channels] Called with {} channels", channels.len());
    db_bulk_ops::bulk_upsert_channels(&state.db, channels)
        .map_err(|e| {
            error!("[bulk_upsert_channels] ERROR: {}", e);
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
    debug!("[update_source_meta] Called for source_id: {}", meta.source_id);
    db_bulk_ops::update_source_meta(&state.db, meta)
        .map_err(|e| {
            error!("[update_source_meta] ERROR: {}", e);
            format!("Update source meta failed: {}", e)
        })
}

/// Health check - verifies backend systems are ready
#[tauri::command]
async fn health_check(_state: tauri::State<'_, DvrState>) -> Result<bool, String> {
    debug!("[health_check] DVR state is active");
    Ok(true)
}

/// Stream and parse EPG from URL with progress updates
#[tauri::command]
async fn stream_parse_epg(
    app: AppHandle,
    state: tauri::State<'_, DvrState>,
    source_id: String,
    source_name: String,
    epg_url: String,
    channel_mappings: Vec<epg_streaming::ChannelMapping>,
    advanced_epg_matching: bool,
    timeshift_hours: Option<f64>,
) -> Result<epg_streaming::EpgParseResult, String> {
    epg_streaming::stream_parse_epg(app, &state.db, source_id, source_name, epg_url, channel_mappings, advanced_epg_matching, timeshift_hours.unwrap_or(0.0))
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
    advanced_epg_matching: bool,
    timeshift_hours: Option<f64>,
) -> Result<epg_streaming::EpgParseResult, String> {
    epg_streaming::parse_epg_file(app, &state.db, source_id, file_path, channel_mappings, advanced_epg_matching, timeshift_hours.unwrap_or(0.0))
        .await
        .map_err(|e| format!("Parse EPG file failed: {}", e))
}

// =============================================================================
// TMDB Cache State (managed, lives for the app lifetime)
// =============================================================================

/// Thread-safe wrapper around TmdbCache so it can be managed as Tauri state.
/// Using tokio::sync::Mutex (async-aware) because TmdbCache methods are async.
pub struct TmdbCacheState(pub tokio::sync::Mutex<TmdbCache>);

impl TmdbCacheState {
    /// Create with the given cache directory.
    pub fn new(cache_dir: std::path::PathBuf) -> Self {
        Self(tokio::sync::Mutex::new(TmdbCache::new(cache_dir)))
    }
}

// =============================================================================
// TMDB Cache Commands
// =============================================================================

/// Get TMDB cache statistics
#[tauri::command]
async fn get_tmdb_cache_stats(
    state: tauri::State<'_, TmdbCacheState>,
) -> Result<CacheStats, String> {
    let cache = state.0.lock().await;
    cache.get_stats().await
        .map_err(|e| format!("Failed to get cache stats: {}", e))
}

/// Update TMDB movies cache
#[tauri::command]
async fn update_tmdb_movies_cache(
    state: tauri::State<'_, TmdbCacheState>,
) -> Result<usize, String> {
    let mut cache = state.0.lock().await;
    cache.update_movies_cache().await
        .map_err(|e| format!("Failed to update movies cache: {}", e))
}

/// Update TMDB series cache
#[tauri::command]
async fn update_tmdb_series_cache(
    state: tauri::State<'_, TmdbCacheState>,
) -> Result<usize, String> {
    let mut cache = state.0.lock().await;
    cache.update_series_cache().await
        .map_err(|e| format!("Failed to update series cache: {}", e))
}

/// Find movies by title
#[tauri::command]
async fn find_tmdb_movies(
    state: tauri::State<'_, TmdbCacheState>,
    title: String,
) -> Result<Vec<MatchResult>, String> {
    let mut cache = state.0.lock().await;
    cache.find_movies(&title).await
        .map_err(|e| format!("Failed to find movies: {}", e))
}

/// Find series by title
#[tauri::command]
async fn find_tmdb_series(
    state: tauri::State<'_, TmdbCacheState>,
    title: String,
) -> Result<Vec<MatchResult>, String> {
    let mut cache = state.0.lock().await;
    cache.find_series(&title).await
        .map_err(|e| format!("Failed to find series: {}", e))
}

/// Clear TMDB cache
#[tauri::command]
async fn clear_tmdb_cache(
    state: tauri::State<'_, TmdbCacheState>,
) -> Result<(), String> {
    // clear_cache takes &self (not &mut self), but we lock for consistency
    let cache = state.0.lock().await;
    cache.clear_cache().await
        .map_err(|e| format!("Failed to clear cache: {}", e))
}

// =============================================================================
// TVMaze / TV Calendar Commands
// =============================================================================

#[tauri::command]
async fn search_tvmaze(query: String) -> Result<Vec<tvmaze::TvMazeShowResult>, String> {
    tvmaze::fetch_show_search(&query).await
}

#[tauri::command]
async fn add_tv_favorite(
    state: tauri::State<'_, DvrState>,
    tvmaze_id: i64,
    show_name: String,
    show_image: Option<String>,
    channel_name: Option<String>,
    channel_id: Option<String>,
    status: Option<String>,
) -> Result<(), String> {
    debug!("[TVMaze Command] add_tv_favorite called: id={}, name={}, channel={:?}, channel_id={:?}",
        tvmaze_id, show_name, channel_name, channel_id);

    state.db.tvmaze_add_favorite(
        tvmaze_id, &show_name,
        show_image.as_deref(), channel_name.as_deref(),
        channel_id.as_deref(), status.as_deref(),
    ).map_err(|e| {
        error!("[TVMaze Command] Failed to add favorite: {}", e);
        e.to_string()
    })?;

    debug!("[TVMaze Command] Favorite added to DB, fetching episodes...");

    // Fetch and store episodes immediately
    let episodes = tvmaze::fetch_episodes(tvmaze_id).await.map_err(|e| {
        warn!("[TVMaze Command] Failed to fetch episodes: {}", e);
        e
    })?;

    debug!("[TVMaze Command] Fetched {} episodes", episodes.len());

    state.db.tvmaze_upsert_episodes(tvmaze_id, &episodes)
        .map_err(|e| {
            error!("[TVMaze Command] Failed to upsert episodes: {}", e);
            e.to_string()
        })?;

    state.db.tvmaze_update_last_synced(tvmaze_id)
        .map_err(|e| e.to_string())?;

    info!("[TVMaze Command] Successfully added show with {} episodes", episodes.len());
    Ok(())
}

#[tauri::command]
async fn remove_tv_favorite(
    state: tauri::State<'_, DvrState>,
    tvmaze_id: i64,
) -> Result<(), String> {
    state.db.tvmaze_remove_favorite(tvmaze_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_tracked_shows(
    state: tauri::State<'_, DvrState>,
) -> Result<Vec<tvmaze::TrackedShow>, String> {
    state.db.tvmaze_get_favorites().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_calendar_episodes(
    state: tauri::State<'_, DvrState>,
    month: String,
) -> Result<Vec<tvmaze::CalendarEpisode>, String> {
    state.db.tvmaze_get_calendar_episodes(&month).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
struct AutoAddEpisode {
    tvmaze_id: i64,
    episode_id: i64,
    show_name: String,
    episode_name: Option<String>,
    season: Option<i64>,
    episode: Option<i64>,
    airdate: Option<String>,
    airtime: Option<String>,
    airstamp: Option<String>,
    runtime: Option<i64>,
    channel_id: Option<String>,
    reminder_enabled: bool,
    reminder_minutes: i32,
    autoswitch_enabled: bool,
    autoswitch_seconds: i32,
}

#[derive(Debug, Serialize)]
struct SyncResult {
    synced_count: u32,
    watchlist_added_count: u32,
    episodes_to_add: Vec<AutoAddEpisode>,
}

#[tauri::command]
async fn sync_tvmaze_shows(
    state: tauri::State<'_, DvrState>,
) -> Result<SyncResult, String> {
    let shows = state.db.tvmaze_get_running_shows().map_err(|e| e.to_string())?;
    let mut count = 0u32;
    let mut watchlist_added = 0u32;
    let mut episodes_to_add: Vec<AutoAddEpisode> = Vec::new();

    for (tvmaze_id, show_name) in shows {
        // Get watchlist settings for this show
        let settings = state.db.tvmaze_get_watchlist_settings(tvmaze_id).ok().flatten();
        // Get channel info for this show
        let channel_id = state.db.tvmaze_get_show_channel(tvmaze_id).ok().flatten();

        if let Ok(eps) = tvmaze::fetch_episodes(tvmaze_id).await {
            // Auto-add to watchlist if enabled
            if let Some((auto_add, reminder_enabled, reminder_minutes, autoswitch_enabled, autoswitch_seconds)) = settings {
                if auto_add {
                    // Clear tracking table so all upcoming episodes are returned fresh
                    // Frontend will handle clearing and re-adding to watchlist
                    let _ = state.db.tvmaze_clear_show_added_episodes(tvmaze_id);

                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64;

                    for ep in &eps {
                        // Only add future episodes
                        if let Some(ref airdate) = ep.airdate {
                            let air_timestamp = chrono::NaiveDate::parse_from_str(airdate, "%Y-%m-%d")
                                .ok()
                                .map(|d| d.and_hms_opt(0, 0, 0).unwrap_or_default().and_utc().timestamp_millis())
                                .unwrap_or(0);

                            if air_timestamp > now {
                                // Mark as added for tracking purposes
                                let _ = state.db.tvmaze_mark_episode_added_to_watchlist(tvmaze_id, ep.tvmaze_episode_id);
                                watchlist_added += 1;
                                debug!("[Sync] Adding episode {} for show {}", ep.tvmaze_episode_id, show_name);

                                // Add to episodes list for frontend
                                episodes_to_add.push(AutoAddEpisode {
                                    tvmaze_id,
                                    episode_id: ep.tvmaze_episode_id,
                                    show_name: show_name.clone(),
                                    episode_name: ep.episode_name.clone(),
                                    season: ep.season,
                                    episode: ep.episode,
                                    airdate: ep.airdate.clone(),
                                    airtime: ep.airtime.clone(),
                                    airstamp: ep.airstamp.clone(),
                                    runtime: ep.runtime,
                                    channel_id: channel_id.clone(),
                                    reminder_enabled,
                                    reminder_minutes,
                                    autoswitch_enabled,
                                    autoswitch_seconds,
                                });
                            }
                        }
                    }
                }
            }

            let _ = state.db.tvmaze_upsert_episodes(tvmaze_id, &eps);
            let _ = state.db.tvmaze_update_last_synced(tvmaze_id);
            count += 1;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    Ok(SyncResult {
        synced_count: count,
        watchlist_added_count: watchlist_added,
        episodes_to_add,
    })
}

/// Immediately add current upcoming episodes for a single show to watchlist
/// Called when user enables auto-add for a show
#[tauri::command]
async fn add_show_episodes_to_watchlist(
    state: tauri::State<'_, DvrState>,
    tvmaze_id: i64,
) -> Result<Vec<AutoAddEpisode>, String> {
    debug!("[TVMaze Command] add_show_episodes_to_watchlist called for id={}", tvmaze_id);

    // Get show name
    let shows = state.db.tvmaze_get_running_shows().map_err(|e| e.to_string())?;
    let show_name = shows
        .into_iter()
        .find(|(id, _)| *id == tvmaze_id)
        .map(|(_, name)| name)
        .unwrap_or_else(|| format!("Show {}", tvmaze_id));

    // Get watchlist settings for this show
    let settings = state
        .db
        .tvmaze_get_watchlist_settings(tvmaze_id)
        .ok()
        .flatten()
        .unwrap_or((false, true, 5, false, 30));
    let (_auto_add, reminder_enabled, reminder_minutes, autoswitch_enabled, autoswitch_seconds) =
        settings;

    // Get channel info
    let channel_id = state.db.tvmaze_get_show_channel(tvmaze_id).ok().flatten();

    // Fetch episodes from TVMaze
    let eps = tvmaze::fetch_episodes(tvmaze_id)
        .await
        .map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Clear tracking table so all upcoming episodes are returned fresh
    let _ = state.db.tvmaze_clear_show_added_episodes(tvmaze_id);

    let mut episodes_to_add: Vec<AutoAddEpisode> = Vec::new();

    for ep in &eps {
        // Only add future episodes
        if let Some(ref airdate) = ep.airdate {
            let air_timestamp = chrono::NaiveDate::parse_from_str(airdate, "%Y-%m-%d")
                .ok()
                .map(|d| {
                    d.and_hms_opt(0, 0, 0)
                        .unwrap_or_default()
                        .and_utc()
                        .timestamp_millis()
                })
                .unwrap_or(0);

            if air_timestamp > now {
                // Mark as added for tracking purposes
                let _ = state
                    .db
                    .tvmaze_mark_episode_added_to_watchlist(tvmaze_id, ep.tvmaze_episode_id);
                debug!(
                    "[Add Episodes] Adding episode {} for show {}",
                    ep.tvmaze_episode_id, show_name
                );

                // Add to episodes list for frontend
                episodes_to_add.push(AutoAddEpisode {
                    tvmaze_id,
                    episode_id: ep.tvmaze_episode_id,
                    show_name: show_name.clone(),
                    episode_name: ep.episode_name.clone(),
                    season: ep.season,
                    episode: ep.episode,
                    airdate: ep.airdate.clone(),
                    airtime: ep.airtime.clone(),
                    airstamp: ep.airstamp.clone(),
                    runtime: ep.runtime,
                    channel_id: channel_id.clone(),
                    reminder_enabled,
                    reminder_minutes,
                    autoswitch_enabled,
                    autoswitch_seconds,
                });
            }
        }
    }

    // Upsert episodes to database
    let _ = state.db.tvmaze_upsert_episodes(tvmaze_id, &eps);
    let _ = state.db.tvmaze_update_last_synced(tvmaze_id);

    debug!(
        "[Add Episodes] Returning {} episodes to add for show {}",
        episodes_to_add.len(),
        show_name
    );
    Ok(episodes_to_add)
}

/// Clear tracking for a show's episodes (called when user clears watchlist entries)
#[tauri::command]
async fn clear_show_watchlist_tracking(
    state: tauri::State<'_, DvrState>,
    tvmaze_id: i64,
) -> Result<usize, String> {
    debug!("[TVMaze Command] clear_show_watchlist_tracking called for id={}", tvmaze_id);
    state.db.tvmaze_clear_show_added_episodes(tvmaze_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_show_details(tvmaze_id: i64) -> Result<tvmaze::TvMazeShowDetails, String> {
    debug!("[TVMaze Command] get_show_details called for id={}", tvmaze_id);
    tvmaze::fetch_show_details(tvmaze_id).await
}

#[derive(Debug, Serialize)]
struct ShowDetailsWithEpisodes {
    details: tvmaze::TvMazeShowDetails,
    episodes: Vec<tvmaze::TvMazeEpisode>,
}

#[tauri::command]
async fn get_show_details_with_episodes(tvmaze_id: i64) -> Result<ShowDetailsWithEpisodes, String> {
    debug!("[TVMaze Command] get_show_details_with_episodes called for id={}", tvmaze_id);
    let (details, episodes) = tvmaze::fetch_show_details_with_episodes(tvmaze_id).await?;
    Ok(ShowDetailsWithEpisodes { details, episodes })
}

#[tauri::command]
async fn set_show_channel(
    state: tauri::State<'_, DvrState>,
    tvmaze_id: i64,
    channel_id: Option<String>,
) -> Result<(), String> {
    debug!("[TVMaze Command] set_show_channel called for id={:?}, channel_id={:?}", tvmaze_id, channel_id);

    // Get channel name if channel_id is provided
    let channel_name: Option<String> = if let Some(ref cid) = channel_id {
        match state.db.get_channel_by_id(cid) {
            Ok(Some(ch)) => Some(ch.name),
            Ok(None) => {
                warn!("[TVMaze Command] Channel not found: {}", cid);
                None
            }
            Err(e) => {
                error!("[TVMaze Command] Error getting channel: {}", e);
                None
            }
        }
    } else {
        None
    };

    state.db.tvmaze_update_channel(
        tvmaze_id,
        channel_id.as_deref(),
        channel_name.as_deref(),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_show_watchlist_settings(
    state: tauri::State<'_, DvrState>,
    tvmaze_id: i64,
    auto_add_to_watchlist: bool,
    watchlist_reminder_enabled: bool,
    watchlist_reminder_minutes: i32,
    watchlist_autoswitch_enabled: bool,
    watchlist_autoswitch_seconds: i32,
) -> Result<(), String> {
    debug!("[TVMaze Command] update_show_watchlist_settings called for id={} auto_add={}", tvmaze_id, auto_add_to_watchlist);
    state.db.tvmaze_update_watchlist_settings(
        tvmaze_id,
        auto_add_to_watchlist,
        watchlist_reminder_enabled,
        watchlist_reminder_minutes,
        watchlist_autoswitch_enabled,
        watchlist_autoswitch_seconds,
    ).map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_show_watchlist_settings(
    state: tauri::State<'_, DvrState>,
    tvmaze_id: i64,
) -> Result<serde_json::Value, String> {
    debug!("[TVMaze Command] get_show_watchlist_settings called for id={}", tvmaze_id);
    let settings_opt = state.db.tvmaze_get_watchlist_settings(tvmaze_id).map_err(|e| e.to_string())?;

    // Default settings if show not found
    let (auto_add, reminder_enabled, reminder_minutes, autoswitch_enabled, autoswitch_seconds) =
        settings_opt.unwrap_or((false, true, 5, false, 30));

    Ok(serde_json::json!({
        "auto_add_to_watchlist": auto_add,
        "watchlist_reminder_enabled": reminder_enabled,
        "watchlist_reminder_minutes": reminder_minutes,
        "watchlist_autoswitch_enabled": autoswitch_enabled,
        "watchlist_autoswitch_seconds": autoswitch_seconds,
    }))
}

#[tauri::command]
async fn get_episode_details(tvmaze_episode_id: i64) -> Result<serde_json::Value, String> {
    debug!("[TVMaze Command] get_episode_details called for episode_id={}", tvmaze_episode_id);
    let client = reqwest::Client::new();
    let url = format!("https://api.tvmaze.com/episodes/{}", tvmaze_episode_id);
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    debug!("[Open URL] Opening external URL: {}", url);
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

// =============================================================================
// Window State Persistence
// =============================================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

fn window_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("window_state.json"))
}

fn save_window_state(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // Don't save fullscreen state — restore to last windowed geometry instead
        if window.is_fullscreen().unwrap_or(false) {
            return;
        }
        // Get inner_size (physical pixels) and convert to logical pixels
        // This ensures the size is DPI-independent and won't double-scale on restore
        let physical_size = match window.inner_size() {
            Ok(s) => s,
            Err(_) => return,
        };
        let scale_factor = window.scale_factor().unwrap_or(1.0);
        let logical_size: tauri::LogicalSize<f64> = physical_size.to_logical(scale_factor);

        let pos = match window.outer_position() {
            Ok(p) => p,
            Err(_) => return,
        };
        // Sanity-check: ignore absurd values (minimised, off-screen, etc.)
        if physical_size.width < 400 || physical_size.height < 300 {
            return;
        }

        // Check if user has disabled saving window size on close
        let dont_save_size = should_skip_saving_window_size(app);

        // Save logical size (DPI-independent) to prevent double-scaling issues
        let state = WindowState {
            width: logical_size.width.round() as u32,
            height: logical_size.height.round() as u32,
            x: pos.x,
            y: pos.y,
        };
        // Save to window_state.json for position restoration
        // Only save size if user hasn't disabled it
        if let Some(path) = window_state_path(app) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if dont_save_size {
                // Only save position, not size
                let state_pos_only = WindowState {
                    width: 0, // 0 means "use settings value"
                    height: 0,
                    x: pos.x,
                    y: pos.y,
                };
                if let Ok(json) = serde_json::to_string(&state_pos_only) {
                    let _ = std::fs::write(&path, json);
                }
            } else {
                if let Ok(json) = serde_json::to_string(&state) {
                    let _ = std::fs::write(&path, json);
                }
            }
        }
        // Also update the startupWidth/startupHeight in tauri-plugin-store
        // so Settings -> UI shows the last closed size as the default
        // Use logical size to prevent DPI scaling issues
        // Skip this if user has disabled saving window size
        if !dont_save_size {
            update_startup_size_in_store(app, logical_size.width.round() as u32, logical_size.height.round() as u32);
        }
    }
}

/// Check if the user has disabled saving window size on close
fn should_skip_saving_window_size(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;

    match app.store(".settings.dat") {
        Ok(store) => {
            let settings: serde_json::Value = store
                .get("settings")
                .unwrap_or_else(|| serde_json::json!({}));
            let skip = settings
                .get("dontSaveWindowSizeOnClose")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            drop(store);
            skip
        }
        Err(e) => {
            warn!("[WindowState] Failed to read store for dontSaveWindowSizeOnClose: {}", e);
            false
        }
    }
}

/// Update the startupWidth and startupHeight in the tauri-plugin-store
/// so the Settings UI reflects the last closed window size
/// Uses the proper tauri-plugin-store API to ensure cache consistency
fn update_startup_size_in_store(app: &tauri::AppHandle, width: u32, height: u32) {
    use tauri_plugin_store::StoreExt;

    // Load the store using the proper API
    let store = app.store(".settings.dat");
    match store {
        Ok(store) => {
            // Get current settings or create empty object
            let current_settings: serde_json::Value = store
                .get("settings")
                .unwrap_or_else(|| serde_json::json!({}));

            // Merge the new size into settings
            let mut settings_obj = current_settings.as_object().cloned().unwrap_or_default();
            settings_obj.insert("startupWidth".to_string(), serde_json::json!(width));
            settings_obj.insert("startupHeight".to_string(), serde_json::json!(height));

            // Save back to store
            store.set("settings", serde_json::json!(settings_obj));

            // IMPORTANT: Save to disk immediately
            if let Err(e) = store.save() {
                warn!("[WindowState] Failed to save store: {}", e);
            } else {
                debug!("[WindowState] Successfully saved store with size: {}x{}", width, height);
            }

            // Drop the store to release the lock
            drop(store);
        }
        Err(e) => {
            warn!("[WindowState] Failed to open store: {}", e);
            // Fallback: try direct file manipulation
            fallback_update_store_file(app, width, height);
        }
    }
}

/// Fallback method using direct file manipulation if the store API fails
fn fallback_update_store_file(app: &tauri::AppHandle, width: u32, height: u32) {
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        let store_path = app_data_dir.join(".settings.dat");

        let contents = std::fs::read_to_string(&store_path).unwrap_or_else(|_| "{}".to_string());

        if let Ok(mut store_data) = serde_json::from_str::<serde_json::Value>(&contents) {
            if let Some(obj) = store_data.as_object_mut() {
                let settings = obj.entry("settings".to_string())
                    .or_insert_with(|| serde_json::json!({}))
                    .as_object_mut();

                if let Some(settings_obj) = settings {
                    settings_obj.insert("startupWidth".to_string(), serde_json::json!(width));
                    settings_obj.insert("startupHeight".to_string(), serde_json::json!(height));
                }

                if let Ok(updated_json) = serde_json::to_string_pretty(&store_data) {
                    let _ = std::fs::write(&store_path, updated_json);
                }
            }
        }
    }
}

fn restore_window_state(app: &tauri::AppHandle) {
    if let Some(path) = window_state_path(app) {
        if let Ok(json) = std::fs::read_to_string(&path) {
            if let Ok(state) = serde_json::from_str::<WindowState>(&json) {
                if let Some(window) = app.get_webview_window("main") {
                    // Apply size as logical size (DPI-independent)
                    // This ensures the window opens at the correct logical size regardless of monitor scaling
                    let _ = window.set_size(tauri::Size::Logical(
                        tauri::LogicalSize { width: state.width as f64, height: state.height as f64 }
                    ));
                    // Apply position (only if non-zero — avoids placing off-screen on first run)
                    if state.x != 0 || state.y != 0 {
                        let _ = window.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition { x: state.x, y: state.y }
                        ));
                    }
                    debug!("[WindowState] Restored: {}x{} logical at ({}, {})",
                        state.width, state.height, state.x, state.y);
                }
            }
        }
    }
}

/// Restore only window position (not size) - used when UI controls the startup size
fn restore_window_position(app: &tauri::AppHandle) {
    if let Some(path) = window_state_path(app) {
        if let Ok(json) = std::fs::read_to_string(&path) {
            if let Ok(state) = serde_json::from_str::<WindowState>(&json) {
                if let Some(window) = app.get_webview_window("main") {
                    // Apply position only (only if non-zero — avoids placing off-screen on first run)
                    if state.x != 0 || state.y != 0 {
                        let _ = window.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition { x: state.x, y: state.y }
                        ));
                        debug!("[WindowState] Restored position: ({}, {})", state.x, state.y);
                    }
                }
            }
        }
    }
}

// =============================================================================
// App Entry Point
// =============================================================================

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
            .level(if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            })
            .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
            .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: Some("ynotv".into())
            }))
            .build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Manage platform-specific MPV state
        .manage(MpvState::new())
        .setup(|app| {
            // Register secondary MPV state (Windows only)
            #[cfg(target_os = "windows")]
            app.manage(SecondaryMpvState::new());

            // Configure macOS window for proper dragging with transparent titlebar
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
                    info!("[macOS] Window configured with Overlay title bar style");
                }
            }

            // Initialize DVR system FIRST before anything else
            let app_handle = app.handle().clone();

            // Run log cleanup based on user settings
            let log_cleanup_handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Manager;
                if let Ok(log_dir) = log_cleanup_handle.path().app_log_dir() {
                    let mut retention_days = 7; // Default to 7 days
                    
                    // Read custom setting if available
                    use tauri_plugin_store::StoreExt;
                    if let Ok(store) = log_cleanup_handle.store(".settings.dat") {
                        if let Some(settings) = store.get("settings") {
                            if let Some(days) = settings.get("logRetentionDays").and_then(|v| v.as_u64()) {
                                retention_days = days;
                            }
                        }
                    }

                    // Proceed with cleanup if not keeping indefinitely (0)
                    if retention_days > 0 {
                        let cutoff = std::time::SystemTime::now()
                            - std::time::Duration::from_secs(retention_days * 24 * 3600);
                        
                        if let Ok(mut entries) = tokio::fs::read_dir(&log_dir).await {
                            while let Ok(Some(entry)) = entries.next_entry().await {
                                let path = entry.path();
                                if let Some(ext) = path.extension() {
                                    if ext == "log" || ext == "bak" || path.to_string_lossy().contains(".log") {
                                        if let Ok(metadata) = entry.metadata().await {
                                            if let Ok(modified) = metadata.modified() {
                                                if modified < cutoff {
                                                    let _ = tokio::fs::remove_file(&path).await;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });

            // For now, disable verbose logging by default (sqlx logs are too noisy)
            dvr::init_logging(false);

            match tauri::async_runtime::block_on(async move {
                info!("[DVR Setup] Starting DVR initialization...");
                DvrState::new(app_handle).await
            }) {
                Ok(dvr_state) => {
                    info!("[DVR Setup] System initialized successfully, managing state...");
                    app.manage(dvr_state);
                    info!("[DVR Setup] State managed successfully");
                }
                Err(e) => {
                    error!("[DVR Setup] WARNING: Failed to initialize full DVR: {}", e);
                    error!("[DVR Setup] DVR features (recording) will be unavailable.");
                    error!("[DVR Setup] Bulk sync operations may also be affected.");
                }
            }

            // Register TmdbCacheState as managed state so the cache is shared
            // across all TMDB commands instead of being re-created each call.
            match app.path().app_cache_dir() {
                Ok(cache_dir) => {
                    app.manage(TmdbCacheState::new(cache_dir));
                    info!("[TMDB] Cache state initialized");
                }
                Err(e) => {
                    error!("[TMDB] Failed to get cache dir for TmdbCacheState: {}", e);
                    // App can still run without TMDB (VOD matching degrades gracefully)
                }
            }
            // On macOS, initialize MPV after a short delay to ensure window is ready
            #[cfg(target_os = "macos")]
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
                    info!("[MPV macOS] Auto-initializing MPV...");
                    if let Err(e) = mpv_macos::init_mpv(app_handle).await {
                        error!("[MPV macOS] Auto-init failed: {}", e);
                    }
                });
            }

            // Restore saved window position only (not size - size is controlled by UI settings)
            // Position is restored so the window opens in the same place it was closed
            restore_window_position(app.handle());

            // Note: Window size is applied by the frontend after settings are loaded
            // to ensure the user-defined startupWidth/startupHeight from Settings -> UI is respected

            Ok(())
        })
        // Save window size/position when the window is about to close
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                save_window_state(&window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            // MPV commands
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
            mpv_set_properties,
            mpv_get_property,
            mpv_sync_window,
            mpv_set_geometry,
            mpv_kill,
            mpv_get_cache_debug,
            // Multiview secondary MPV commands
            multiview_load_slot,
            multiview_stop_slot,
            multiview_set_property_slot,
            multiview_reposition_slot,
            multiview_kill_slot,
            multiview_kill_all,
            // Optimized bulk sync commands
            sync_provider::sync_m3u_source,
            sync_provider::sync_xtream_source,
            sync_provider::sync_xtream_vod_movies,
            sync_provider::sync_xtream_vod_series,
            bulk_upsert_channels,
            bulk_upsert_categories,
            bulk_replace_programs,
            bulk_upsert_movies,
            bulk_upsert_series,
            bulk_delete_channels,
            bulk_delete_categories,
            update_source_meta,
            health_check,
            // Streaming EPG commands
            stream_parse_epg,
            parse_epg_file,
            // DVR commands
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
            // TMDB cache commands
            get_tmdb_cache_stats,
            update_tmdb_movies_cache,
            update_tmdb_series_cache,
            find_tmdb_movies,
            find_tmdb_series,
            clear_tmdb_cache,
            // TVMaze / TV Calendar commands
            search_tvmaze,
            add_tv_favorite,
            remove_tv_favorite,
            get_tracked_shows,
            get_calendar_episodes,
            sync_tvmaze_shows,
            get_show_details,
            get_show_details_with_episodes,
            set_show_channel,
            get_episode_details,
            update_show_watchlist_settings,
            get_show_watchlist_settings,
            add_show_episodes_to_watchlist,
            clear_show_watchlist_tracking,
            // Utility commands
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
