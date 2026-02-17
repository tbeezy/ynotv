use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, Manager};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
#[cfg(target_os = "windows")]
use tokio::net::windows::named_pipe::ClientOptions;
#[cfg(not(target_os = "windows"))]
use tokio::net::UnixStream;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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


// Bulk insert structures
#[derive(Debug, Deserialize)]
struct BulkInsertRequest {
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    operation: String, // "insert" or "replace"
}

// Global state for MPV
struct MpvState {
    process: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    socket_connected: Mutex<bool>,
    ipc_tx: Mutex<Option<tokio::sync::mpsc::Sender<String>>>,
    pending_requests: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>>>>,
    request_id_counter: Mutex<u64>,
    initializing: Mutex<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct MpvStatus {
    playing: bool,
    volume: f64,
    muted: bool,
    position: f64,
    duration: f64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(untagged)]
enum MpvResponse {
    Event { event: String, name: Option<String>, data: Option<serde_json::Value> },
    Response { request_id: u64, error: Option<String>, data: Option<serde_json::Value> },
}

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

// Helper to spawn MPV (extracted from init_mpv)
async fn spawn_mpv<R: Runtime>(app: &AppHandle<R>, state: &tauri::State<'_, MpvState>) -> Result<(), String> {
    // Prevent concurrent inits
    {
        let mut init = state.initializing.lock().unwrap();
        if *init {
            println!("MPV initialization already in progress");
            return Ok(());
        }

        let proc = state.process.lock().unwrap();
        if proc.is_some() {
             return Ok(());
        }
        *init = true;
    }

    let socket_path = get_socket_path();
    println!("Initializing MPV on socket: {}", socket_path);

    // Clean up existing socket/pipe if needed (Unix only)
    #[cfg(not(target_os = "windows"))]
    let _ = std::fs::remove_file(&socket_path);

    // Get the main window handle for embedding
    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            *state.initializing.lock().unwrap() = false;
            return Err("Main window not found".to_string());
        }
    };

    let hwnd = match window.window_handle() {
        Ok(h) => match h.as_raw() {
            #[cfg(target_os = "windows")]
            RawWindowHandle::Win32(h) => h.hwnd.get(),
            #[cfg(target_os = "macos")]
            RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as usize,
            #[cfg(target_os = "linux")]
            RawWindowHandle::Xlib(h) => h.window as usize,
            _ => {
                *state.initializing.lock().unwrap() = false;
                return Err("Unsupported platform/backend for window embedding".to_string());
            }
        },
        Err(e) => {
            *state.initializing.lock().unwrap() = false;
            return Err(e.to_string());
        }
    };
    println!("Embedding MPV into HWND: {:?}", hwnd);

    // Prepare arguments
    let mut args = vec![
        format!("--input-ipc-server={}", socket_path),
        format!("--wid={}", hwnd), // Embed into main window
        "--force-window=immediate".into(),
        "--idle=yes".into(),
        "--keep-open=yes".into(),
        "--no-osc".into(),
        "--no-osd-bar".into(),
        "--osd-level=0".into(),
        "--input-default-bindings=no".into(),
        "--no-input-cursor".into(),
        "--cursor-autohide=no".into(),
        "--no-terminal".into(),
    ];

    #[cfg(target_os = "macos")]
    {
        // MacOS/CoreAudio specific fixes for embedding/crashes
        args.push("--vo=libmpv".into()); // Force libmpv VO
        args.push("--hwdec=no".into()); // Disable hardware decoding
        args.push("--coreaudio-change-physical-format=no".into()); // Prevent audio switch crashes
    }

    // Launch MPV using shell plugin
    let sidecar = app.shell().sidecar("mpv");
    if let Err(e) = sidecar {
        *state.initializing.lock().unwrap() = false;
        return Err(format!("Failed to create sidecar: {}", e));
    }

    let cmd = sidecar.unwrap().args(&args);
    let spawned = cmd.spawn();

    if let Err(e) = spawned {
        *state.initializing.lock().unwrap() = false;
        return Err(format!("Failed to spawn mpv: {}", e));
    }

    let (mut rx, _) = spawned.unwrap();
    println!("MPV spawned successfully");

    // Spawn a thread to monitor the process
    {
        let mut proc_handle = state.process.lock().unwrap();
        *proc_handle = Some(tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                     CommandEvent::Stdout(line) => println!("MPV STDOUT: {}", String::from_utf8_lossy(&line)),
                     CommandEvent::Stderr(line) => println!("MPV STDERR: {}", String::from_utf8_lossy(&line)),
                     CommandEvent::Error(e) => println!("MPV ERROR: {}", e),
                     CommandEvent::Terminated(s) => println!("MPV TERMINATED: {:?}", s),
                     _ => {}
                }
            }
        }));
    }

    // Wait for internal startup
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Connect to IPC
    println!("Connecting execution IPC...");
    let connect_res = connect_ipc(app, state, &socket_path).await;

    // Reset initializing flag
    *state.initializing.lock().unwrap() = false;

    match connect_res {
        Ok(_) => {
            println!("MPV Init Complete");
            Ok(())
        },
        Err(e) => Err(e)
    }
}

// Initialize MPV process
#[tauri::command]
async fn init_mpv<R: Runtime>(app: AppHandle<R>, _args: Vec<String>, state: tauri::State<'_, MpvState>) -> Result<(), String> {

    // Check if running
    let is_running = {
        let proc = state.process.lock().unwrap();
        proc.is_some()
    };

    if is_running {
         println!("MPV already running, connecting IPC only");
         let socket_path = get_socket_path();
         let _ = connect_ipc(&app, &state, &socket_path).await;
         return Ok(());
    }

    // If not running, try to spawn
    spawn_mpv(&app, &state).await
}

async fn connect_ipc<R: Runtime>(app: &AppHandle<R>, state: &tauri::State<'_, MpvState>, socket_path: &str) -> Result<(), String> {
    let stream = {
        #[cfg(target_os = "windows")]
        {
            let mut retries = 5;
            loop {
                 match ClientOptions::new().open(socket_path) {
                     Ok(s) => break Ok(s),
                     Err(_) if retries > 0 => {
                         tokio::time::sleep(Duration::from_millis(500)).await;
                         retries -= 1;
                     }
                     Err(e) => break Err(format!("Failed to connect to named pipe: {}", e)),
                 }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
             let mut retries = 5;
             loop {
                  match UnixStream::connect(socket_path).await {
                      Ok(s) => break Ok(s),
                      Err(_) if retries > 0 => {
                          tokio::time::sleep(Duration::from_millis(500)).await;
                          retries -= 1;
                      }
                      Err(e) => break Err(format!("Failed to connect to unix socket: {}", e)),
                  }
             }
        }
    }?;


    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf_reader = BufReader::new(reader);

    // Channel for sending commands to the writer task
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(32);
    *state.ipc_tx.lock().unwrap() = Some(tx);
    *state.socket_connected.lock().unwrap() = true;

    // Spawn writer task
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let _ = writer.write_all(msg.as_bytes()).await;
            let _ = writer.write_all(b"\n").await;
            let _ = writer.flush().await;
        }
    });

    // Spawn reader task
    let app_handle = app.clone();
    let pending_requests = state.pending_requests.clone();

    tauri::async_runtime::spawn(async move {
        let mut line = String::new();
        let mut status = MpvStatus {
            playing: false,
            volume: 100.0,
            muted: false,
            position: 0.0,
            duration: 0.0,
        };

        loop {
            line.clear();
            match buf_reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    if let Ok(msg) = serde_json::from_str::<MpvResponse>(&line) {
                        match msg {
                            MpvResponse::Event { event, name, data } => {
                                if event == "property-change" {
                                    if let (Some(name), Some(data)) = (name, data) {
                                        match name.as_str() {
                                            "pause" => status.playing = !data.as_bool().unwrap_or(false),
                                            "volume" => status.volume = data.as_f64().unwrap_or(100.0),
                                            "mute" => status.muted = data.as_bool().unwrap_or(false),
                                            "time-pos" => status.position = data.as_f64().unwrap_or(0.0),
                                            "duration" => status.duration = data.as_f64().unwrap_or(0.0),
                                            _ => {}
                                        }
                                        let _ = app_handle.emit("mpv-status", status.clone());
                                    }
                                }
                            },
                            MpvResponse::Response { request_id, error, data } => {
                                let mut pending = pending_requests.lock().unwrap();
                                if let Some(sender) = pending.remove(&request_id) {
                                    if let Some(err) = error {
                                        if err != "success" {
                                            let _ = sender.send(Err(err));
                                            continue;
                                        }
                                    }
                                    let _ = sender.send(Ok(data.unwrap_or(serde_json::Value::Null)));
                                }
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit("mpv-error", "IPC connection lost");
    });

    // Observe properties
    let _ = send_command(state, "observe_property", vec![serde_json::json!(1), serde_json::json!("pause")]).await;
    let _ = send_command(state, "observe_property", vec![serde_json::json!(2), serde_json::json!("volume")]).await;
    let _ = send_command(state, "observe_property", vec![serde_json::json!(3), serde_json::json!("mute")]).await;
    let _ = send_command(state, "observe_property", vec![serde_json::json!(4), serde_json::json!("time-pos")]).await;
    let _ = send_command(state, "observe_property", vec![serde_json::json!(5), serde_json::json!("duration")]).await;

    let _ = app.emit("mpv-ready", true);
    Ok(())
}

async fn send_command(state: &tauri::State<'_, MpvState>, command: &str, args: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    let request_id = {
        let mut counter = state.request_id_counter.lock().unwrap();
        *counter += 1;
        *counter
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        state.pending_requests.lock().unwrap().insert(request_id, tx);
    }

    let mut cmd_args = vec![serde_json::Value::String(command.to_string())];
    cmd_args.extend(args);

    let cmd_json = serde_json::json!({
        "command": cmd_args,
        "request_id": request_id
    });

    let tx_channel = state.ipc_tx.lock().unwrap().clone();
    if let Some(sender) = tx_channel {
        sender.send(cmd_json.to_string()).await.map_err(|e| e.to_string())?;
    } else {
        println!("Warning: IPC not connected for command {}", command);
        return Err("IPC not connected".to_string());
    }

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(res)) => res.map_err(|e| e),
        Ok(Err(_)) => Err("Channel closed".to_string()),
        Err(_) => {
            state.pending_requests.lock().unwrap().remove(&request_id);
            Err("Timeout".to_string())
        }
    }
}

#[tauri::command]
async fn mpv_load(state: tauri::State<'_, MpvState>, url: String) -> Result<(), String> {
    send_command(&state, "loadfile", vec![serde_json::Value::String(url)]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_play(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    send_command(&state, "set_property", vec![serde_json::json!("pause"), serde_json::json!(false)]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_pause(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    send_command(&state, "set_property", vec![serde_json::json!("pause"), serde_json::json!(true)]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_resume(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    send_command(&state, "set_property", vec![serde_json::json!("pause"), serde_json::json!(false)]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_stop(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    send_command(&state, "stop", vec![]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_set_volume(state: tauri::State<'_, MpvState>, volume: f64) -> Result<(), String> {
    send_command(&state, "set_property", vec![serde_json::json!("volume"), serde_json::json!(volume)]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_seek(state: tauri::State<'_, MpvState>, seconds: f64) -> Result<(), String> {
    send_command(&state, "seek", vec![serde_json::json!(seconds), serde_json::json!("absolute")]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_cycle_audio(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    send_command(&state, "cycle", vec![serde_json::json!("audio")]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_cycle_sub(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    send_command(&state, "cycle", vec![serde_json::json!("sub")]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_toggle_mute(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    send_command(&state, "cycle", vec![serde_json::json!("mute")]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_toggle_stats(state: tauri::State<'_, MpvState>) -> Result<(), String> {
    send_command(&state, "script-binding", vec![serde_json::json!("stats/display-stats-toggle")]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_toggle_fullscreen<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
        window.set_fullscreen(!is_fullscreen).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}

#[tauri::command]
async fn mpv_get_track_list(state: tauri::State<'_, MpvState>) -> Result<serde_json::Value, String> {
    send_command(&state, "get_property", vec![serde_json::json!("track-list")]).await
}

#[tauri::command]
async fn mpv_set_audio(state: tauri::State<'_, MpvState>, id: i64) -> Result<(), String> {
    send_command(&state, "set_property", vec![serde_json::json!("aid"), serde_json::json!(id)]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_set_subtitle(state: tauri::State<'_, MpvState>, id: i64) -> Result<(), String> {
    send_command(&state, "set_property", vec![serde_json::json!("sid"), serde_json::json!(id)]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_set_property(state: tauri::State<'_, MpvState>, name: String, value: serde_json::Value) -> Result<(), String> {
    send_command(&state, "set_property", vec![serde_json::json!(name), value]).await.map(|_| ())
}

#[tauri::command]
async fn mpv_get_property(state: tauri::State<'_, MpvState>, name: String) -> Result<serde_json::Value, String> {
    send_command(&state, "get_property", vec![serde_json::json!(name)]).await
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
        .manage(MpvState {
            process: Mutex::new(None),
            socket_connected: Mutex::new(false),
            ipc_tx: Mutex::new(None),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            request_id_counter: Mutex::new(0),
            initializing: Mutex::new(false),
        })
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
