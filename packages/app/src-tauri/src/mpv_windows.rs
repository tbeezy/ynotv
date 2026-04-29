//! Windows MPV Implementation using Window Embedding
//! 
//! This module implements MPV playback on Windows by embedding MPV
//! directly into the Tauri window using the --wid flag.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, Manager};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri_plugin_shell::{ShellExt, process::{CommandEvent, CommandChild}};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use serde_json::{json, Value};

pub struct MpvState {
    pub process: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub child: Mutex<Option<CommandChild>>,
    pub pid: Mutex<u32>,
    pub socket_connected: Mutex<bool>,
    pub ipc_tx: Mutex<Option<tokio::sync::mpsc::Sender<String>>>,
    pub pending_requests: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>>>>,
    pub request_id_counter: Mutex<u64>,
    pub initializing: Mutex<bool>,
}

impl MpvState {
    pub fn new() -> Self {
        MpvState {
            process: Mutex::new(None),
            child: Mutex::new(None),
            pid: Mutex::new(0),
            socket_connected: Mutex::new(false),
            ipc_tx: Mutex::new(None),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            request_id_counter: Mutex::new(0),
            initializing: Mutex::new(false),
        }
    }
}

/// Fully reset MPV state so the next init attempt will respawn.
fn kill_and_clear_state(state: &tauri::State<'_, MpvState>) {
    log::warn!("[MPV] Clearing MPV state for respawn...");
    {
        let mut tx = state.ipc_tx.lock().unwrap();
        *tx = None;
    }
    {
        let mut connected = state.socket_connected.lock().unwrap();
        *connected = false;
    }
    {
        let mut child = state.child.lock().unwrap();
        if let Some(c) = child.take() {
            let _ = c.kill();
        }
    }
    {
        let mut proc = state.process.lock().unwrap();
        if let Some(handle) = proc.take() {
            handle.abort();
        }
    }
    {
        let mut pid = state.pid.lock().unwrap();
        *pid = 0;
    }
    {
        let mut init = state.initializing.lock().unwrap();
        *init = false;
    }
}

/// Check if a Windows process with the given PID is still alive.
#[cfg(target_os = "windows")]
fn is_process_alive(pid: u32) -> bool {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::Foundation::CloseHandle;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if let Ok(h) = handle {
            if h.is_invalid() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = windows::Win32::System::Threading::GetExitCodeProcess(h, &mut code);
            let _ = CloseHandle(h);
            if let Ok(_) = ok {
                return code == 259; // STILL_ACTIVE
            }
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
fn is_process_alive(_pid: u32) -> bool {
    false
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MpvStatus {
    pub playing: bool,
    pub volume: f64,
    pub muted: bool,
    pub position: f64,
    pub duration: f64,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(untagged)]
enum MpvResponse {
    Event { event: String, name: Option<String>, data: Option<Value> },
    Response { request_id: u64, error: Option<String>, data: Option<Value> },
}

/// Find an MPV child HWND by exact Window Title using Win32 EnumChildWindows
pub fn find_mpv_hwnd_by_title(parent_hwnd_raw: isize, target_title: &str) -> Option<isize> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetWindowTextW, GetWindowTextLengthW};
    use std::os::windows::ffi::OsStrExt;

    let parent = HWND(parent_hwnd_raw as _);
    
    // Convert target title to UTF-16
    let target_utf16: Vec<u16> = std::ffi::OsStr::new(target_title)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    struct SearchData { 
        target: Vec<u16>, 
        result: isize 
    }
    
    let mut data = SearchData { 
        target: target_utf16, 
        result: 0 
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let data = &mut *(lparam.0 as *mut SearchData);
        
        let len = GetWindowTextLengthW(hwnd);
        if len > 0 {
            // Include space for null terminator
            let mut buf = vec![0u16; (len + 1) as usize];
            let actual_len = GetWindowTextW(hwnd, &mut buf);
            
            if actual_len > 0 {
                // Compare excluding null terminators
                let text = &buf[..actual_len as usize];
                let target = &data.target[..data.target.len() - 1]; // strip null
                
                if text == target {
                    data.result = hwnd.0 as isize;
                    return BOOL(0);
                }
            }
        }
        BOOL(1)
    }

    unsafe {
        let _ = EnumChildWindows(
            parent,
            Some(enum_proc),
            LPARAM(&mut data as *mut SearchData as isize),
        );
    }

    if data.result == 0 { None } else { Some(data.result) }
}

fn get_socket_path() -> String {
    format!(r"\\.\pipe\mpv-socket-{}", std::process::id())
}

/// Spawn MPV embedded in the Tauri window.
/// If spawn fails and the ytdl-hook script-opts were auto-injected, retries once without them.
async fn spawn_mpv<R: Runtime>(app: &AppHandle<R>, state: &tauri::State<'_, MpvState>, custom_params: Vec<String>) -> Result<(), String> {
    match try_spawn_mpv(app, state, custom_params.clone(), true).await {
        Ok(()) => Ok(()),
        Err(e) => {
            // If the first attempt failed, check if we auto-injected the ytdl hook path.
            // Retry without it so we can isolate whether yt-dlp is the culprit.
            if crate::find_ytdl_path().is_some() && !crate::args_contains_ytdl_path(&custom_params) {
                log::warn!("[MPV] First spawn failed ({}). Retrying WITHOUT ytdl-hook path...", e);
                kill_and_clear_state(state);
                try_spawn_mpv(app, state, custom_params, false).await
            } else {
                Err(e)
            }
        }
    }
}

async fn try_spawn_mpv<R: Runtime>(app: &AppHandle<R>, state: &tauri::State<'_, MpvState>, custom_params: Vec<String>, inject_ytdl: bool) -> Result<(), String> {
    // Prevent concurrent inits
    {
        let mut init = state.initializing.lock().unwrap();
        if *init {
            return Ok(());
        }

        let proc = state.process.lock().unwrap();
        if proc.is_some() {
            return Ok(());
        }
        *init = true;
    }

    let socket_path = get_socket_path();

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
            RawWindowHandle::Win32(h) => h.hwnd.get(),
            _ => {
                *state.initializing.lock().unwrap() = false;
                return Err("Unsupported window handle type".to_string());
            }
        },
        Err(e) => {
            *state.initializing.lock().unwrap() = false;
            return Err(e.to_string());
        }
    };

    // Prepare arguments
    let mut args = vec![
        format!("--input-ipc-server={}", socket_path),
        format!("--wid={}", hwnd),
        "--title=YNOTV_MPV_MAIN".into(),
        "--force-window=immediate".into(),
        "--idle=yes".into(),
        "--keep-open=yes".into(),
        "--cache=yes".into(),
        "--no-osc".into(),
        "--no-osd-bar".into(),
        "--osd-level=0".into(),
        "--input-default-bindings=no".into(),
        "--no-input-cursor".into(),
        "--cursor-autohide=no".into(),
    ];

    // Add custom parameters from settings
    for param in &custom_params {
        args.push(param.clone());
    }

    // Auto-detect yt-dlp / youtube-dl if user hasn't already specified it via script-opts.
    // MPV 0.40+ removed --ytdl-path; the correct option is now:
    //   --script-opts=ytdl_hook-ytdl_path=<path>
    if inject_ytdl && !crate::args_contains_ytdl_path(&args) {
        if let Some(ytdl) = crate::find_ytdl_path() {
            log::info!("[MPV] Auto-detected yt-dlp at: {}", ytdl);
            // Escape backslashes in the path for the script-opts value
            let escaped = ytdl.replace('\\', "\\\\");
            args.push(format!("--script-opts=ytdl_hook-ytdl_path={}", escaped));
        } else {
            log::info!("[MPV] No yt-dlp/youtube-dl found; YouTube URLs may fail");
        }
    }

    log::info!("[MPV] Spawning mpv with {} args: {:?}", args.len(), args);

    // Launch MPV using shell plugin
    let sidecar = app.shell().sidecar("mpv")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?;

    let cmd = sidecar.args(&args);
    let (mut rx, child) = cmd.spawn()
        .map_err(|e| format!("Failed to spawn mpv: {}", e))?;

    let pid = child.pid();
    log::info!("[MPV] mpv spawned with pid={}", pid);
    *state.pid.lock().unwrap() = pid;
    *state.child.lock().unwrap() = Some(child);

    // Spawn a thread to monitor the process
    {
        let mut proc_handle = state.process.lock().unwrap();
        let app_handle_for_stderr = app.clone();
        *proc_handle = Some(tauri::async_runtime::spawn(async move {
            let parse_and_emit = |line_str: &str, app_handle: &tauri::AppHandle<R>| {
                let lower = line_str.to_lowercase();
                let http_error_code: Option<u16> = if lower.contains("http error") || lower.contains("http error ") {
                    lower.find("http error")
                        .and_then(|pos| {
                            let after = &lower[pos + "http error".len()..];
                            after.split_whitespace()
                                .find_map(|part| {
                                    let clean = part.trim_matches(':').trim_matches(',');
                                    clean.parse::<u16>().ok().filter(|&c| c >= 400 && c < 600)
                                })
                        })
                } else {
                    None
                };

                if let Some(code) = http_error_code {
                    let error_msg = match code {
                        401 => "Access Denied (401): Authentication required".to_string(),
                        403 => "Access Denied (403): Stream blocked by server".to_string(),
                        404 => "Stream Not Found (404)".to_string(),
                        _ => format!("HTTP Error ({}): Unable to load stream", code),
                    };
                    let _ = app_handle.emit("mpv-http-error", error_msg);
                }
            };

            while let Some(event) = rx.recv().await {
                let event: CommandEvent = event;
                match event {
                    CommandEvent::Stdout(line) => {
                        let stdout_str = String::from_utf8_lossy(&line).to_string();
                        parse_and_emit(&stdout_str, &app_handle_for_stderr);
                    },
                    CommandEvent::Stderr(line) => {
                        let stderr_str = String::from_utf8_lossy(&line).to_string();
                        parse_and_emit(&stderr_str, &app_handle_for_stderr);
                    },
                    CommandEvent::Error(e) => {
                        log::error!("[MPV] Process error: {}", e);
                    }
                    CommandEvent::Terminated(payload) => {
                        log::warn!("[MPV] Process terminated. code={:?} signal={:?}", payload.code, payload.signal);
                        let _ = app_handle_for_stderr.emit("mpv-terminated", "MPV process terminated unexpectedly");
                    }
                    _ => {}
                }
            }
            log::warn!("[MPV] Monitor task ended (process output channel closed)");
        }));
    }

    // Wait for startup
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Verify process is still alive before trying IPC
    if !is_process_alive(pid) {
        log::error!("[MPV] mpv process (pid={}) died during startup", pid);
        kill_and_clear_state(state);
        return Err(format!("mpv process (pid={}) died during startup. Check that target/debug/mpv.exe is valid and not blocked by antivirus.", pid));
    }

    // Connect to IPC
    let connect_res = connect_ipc(app, state, &socket_path).await;

    if connect_res.is_err() {
        log::error!("[MPV] IPC connection failed: {:?}", connect_res);
        kill_and_clear_state(state);
    }

    *state.initializing.lock().unwrap() = false;

    connect_res
}

async fn connect_ipc<R: Runtime>(
    app: &AppHandle<R>,
    state: &tauri::State<'_, MpvState>,
    socket_path: &str,
) -> Result<(), String> {
    let stream = {
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
    }?;

    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf_reader = BufReader::new(reader);

    // Channel for sending commands
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
                Ok(0) => break,
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
                                            "demuxer-cache-state" => {
                                                // Emit timeshift-update event for frontend scrubber
                                                if let Some(obj) = data.as_object() {
                                                    let cache_start = obj.get("cache-start").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                                    let cache_end = obj.get("cache-end").and_then(|v| v.as_f64()).unwrap_or(0.0);
                                                    let cached_duration = (cache_end - cache_start).max(0.0);
                                                    let behind_live = (cache_end - status.position).max(0.0);
                                                    if cached_duration > 0.0 {
                                                        let ts_state = serde_json::json!({
                                                            "cacheStart": cache_start,
                                                            "cacheEnd": cache_end,
                                                            "timePos": status.position,
                                                            "behindLive": behind_live,
                                                            "cachedDuration": cached_duration,
                                                        });
                                                        let _ = app_handle.emit("timeshift-update", ts_state);
                                                    }
                                                }
                                            }
                                            _ => {}
                                        }
                                        let _ = app_handle.emit("mpv-status", status.clone());
                                    }
                                } else if event == "end-file" {
                                    // Parse fallback errors if stderr didn't catch them
                                    let reason = data.clone().and_then(|d| d.get("reason").and_then(|r| r.as_str().map(|s| s.to_string())));
                                    let file_error = data.and_then(|d| d.get("file_error").and_then(|e| e.as_str().map(|s| s.to_string())));
                                    
                                    if reason.as_deref() == Some("error") {
                                        let error_msg = match file_error.as_deref() {
                                            Some(e) if e.to_lowercase().contains("403") || e.to_lowercase().contains("forbidden") =>
                                                "Access Denied (403): Stream blocked by server".to_string(),
                                            Some(e) if e.to_lowercase().contains("401") || e.to_lowercase().contains("unauthorized") =>
                                                "Access Denied (401): Authentication required".to_string(),
                                            Some(e) if e.to_lowercase().contains("404") =>
                                                "Stream Not Found (404)".to_string(),
                                            Some(e) if e.to_lowercase().contains("demuxer") || e.to_lowercase().contains("unsupported") =>
                                                "Stream Unavailable: Server returned invalid content".to_string(),
                                            Some(e) => format!("Stream Error: {}", e),
                                            None => "Stream Error: Unknown playback error".to_string(),
                                        };
                                        let _ = app_handle.emit("mpv-end-file-error", error_msg);
                                    }
                                }
                            }
                            MpvResponse::Response { request_id, error, data } => {
                                let mut pending = pending_requests.lock().unwrap();
                                if let Some(sender) = pending.remove(&request_id) {
                                    if let Some(err) = error {
                                        if err != "success" {
                                            let _ = sender.send(Err(err));
                                            continue;
                                        }
                                    }
                                    let _ = sender.send(Ok(data.unwrap_or(Value::Null)));
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
    let _ = send_command_internal(state, "observe_property", vec![json!(1), json!("pause")]).await;
    let _ = send_command_internal(state, "observe_property", vec![json!(2), json!("volume")]).await;
    let _ = send_command_internal(state, "observe_property", vec![json!(3), json!("mute")]).await;
    let _ = send_command_internal(state, "observe_property", vec![json!(4), json!("time-pos")]).await;
    let _ = send_command_internal(state, "observe_property", vec![json!(5), json!("duration")]).await;
    let _ = send_command_internal(state, "observe_property", vec![json!(6), json!("demuxer-cache-state")]).await;

    let _ = app.emit("mpv-ready", true);
    Ok(())
}

async fn send_command_internal(
    state: &tauri::State<'_, MpvState>,
    command: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let request_id = {
        let mut counter = state.request_id_counter.lock().unwrap();
        *counter += 1;
        *counter
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        state.pending_requests.lock().unwrap().insert(request_id, tx);
    }

    let mut cmd_args = vec![Value::String(command.to_string())];
    cmd_args.extend(args);

    let cmd_json = json!({
        "command": cmd_args,
        "request_id": request_id
    });

    let tx_channel = state.ipc_tx.lock().unwrap().clone();
    if let Some(sender) = tx_channel {
        sender.send(cmd_json.to_string()).await.map_err(|e| e.to_string())?;
    } else {
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

pub async fn send_command<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    args: Vec<Value>,
) -> Result<Value, String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, command, args).await
}

pub async fn init_mpv<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, MpvState>) -> Result<(), String> {
    init_mpv_with_params(app, state, Vec::new()).await
}

pub async fn init_mpv_with_params<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, MpvState>,
    custom_params: Vec<String>,
) -> Result<(), String> {
    let (has_proc, pid) = {
        let proc = state.process.lock().unwrap();
        let pid = *state.pid.lock().unwrap();
        (proc.is_some(), pid)
    };

    if has_proc {
        if pid > 0 && is_process_alive(pid) {
            log::info!("[MPV] Process alive (pid={}), reconnecting IPC...", pid);
            let socket_path = get_socket_path();
            return connect_ipc(&app, &state, &socket_path).await;
        } else {
            log::warn!("[MPV] Previous process (pid={}) is dead; clearing state and respawning", pid);
            kill_and_clear_state(&state);
        }
    }

    spawn_mpv(&app, &state, custom_params).await
}

pub async fn load_file<R: Runtime>(app: &AppHandle<R>, url: String) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "loadfile", vec![Value::String(url)]).await.map(|_| ())
}

pub async fn play<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "set_property", vec![json!("pause"), json!(false)]).await.map(|_| ())
}

pub async fn pause<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "set_property", vec![json!("pause"), json!(true)]).await.map(|_| ())
}

pub async fn resume<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "set_property", vec![json!("pause"), json!(false)]).await.map(|_| ())
}

pub async fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "stop", vec![]).await.map(|_| ())
}

pub async fn set_volume<R: Runtime>(app: &AppHandle<R>, volume: f64) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "set_property", vec![json!("volume"), json!(volume)]).await.map(|_| ())
}

pub async fn seek<R: Runtime>(app: &AppHandle<R>, seconds: f64) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "seek", vec![json!(seconds), json!("absolute")]).await.map(|_| ())
}

pub async fn toggle_mute<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "cycle", vec![json!("mute")]).await.map(|_| ())
}

pub async fn cycle_audio<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "cycle", vec![json!("audio")]).await.map(|_| ())
}

pub async fn cycle_sub<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "cycle", vec![json!("sub")]).await.map(|_| ())
}

pub async fn get_track_list<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "get_property", vec![json!("track-list")]).await
}

pub async fn set_audio_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "set_property", vec![json!("aid"), json!(id)]).await.map(|_| ())
}

pub async fn set_subtitle_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "set_property", vec![json!("sid"), json!(id)]).await.map(|_| ())
}

pub async fn set_property<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
    value: Value,
) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "set_property", vec![json!(name), value]).await.map(|_| ())
}

pub async fn get_property<R: Runtime>(app: &AppHandle<R>, name: String) -> Result<Value, String> {
    let state = app.state::<MpvState>();
    send_command_internal(&state, "get_property", vec![json!(name)]).await
}

pub async fn sync_window<R: Runtime>(
    _app: &AppHandle<R>,
    _x: i32,
    _y: i32,
    _width: u32,
    _height: u32,
) -> Result<(), String> {
    // On Windows, MPV is embedded so no sync needed
    Ok(())
}


/// Physically resize the MPV embedded child window to a specific rect.
/// When all args are 0, restores MPV to fill the parent window.
///
/// On Windows, MPV is spawned with --wid=HWND which makes it a child window
/// that normally fills the entire parent. IPC video-zoom/align properties only
/// affect the video content *inside* the MPV window — the black MPV surface still
/// covers everything. The only way to expose the HTML cells underneath is to
/// resize the MPV child HWND to the intended quadrant via SetWindowPos.
pub async fn mpv_set_geometry<R: Runtime>(
    app: &AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    use windows::Win32::Foundation::{HWND};
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOZORDER, SWP_NOACTIVATE,
    };

    // Get the Tauri window's HWND
    let window = app.get_webview_window("main")
        .ok_or("Main window not found")?;
    let handle = window.window_handle().map_err(|e| e.to_string())?;
    let parent_hwnd = match handle.as_raw() {
        raw_window_handle::RawWindowHandle::Win32(h) => HWND(h.hwnd.get() as _),
        _ => return Err("Unsupported window handle".to_string()),
    };

    // Determine the target rect
    let (tx, ty, tw, th) = if width == 0 && height == 0 {
        // Restore: fill entire parent window
        use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
        let mut rect = windows::Win32::Foundation::RECT::default();
        unsafe { let _ = GetClientRect(parent_hwnd, &mut rect); }
        (0i32, 0i32, (rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32)
    } else {
        (x, y, width, height)
    };

    let pid = { *app.state::<MpvState>().pid.lock().unwrap() };

    let target_hwnd = if pid > 0 {
        find_mpv_hwnd_by_title(parent_hwnd.0 as isize, "YNOTV_MPV_MAIN").map(|h| HWND(h as _))
    } else {
        None
    };

    if target_hwnd.is_none() {
        // MPV window not found — fall back to IPC zoom/align
        return Ok(());
    }

    unsafe {
        SetWindowPos(
            target_hwnd.unwrap(),
            None,
            tx,
            ty,
            tw as i32,
            th as i32,
            SWP_NOZORDER | SWP_NOACTIVATE,
        ).map_err(|e| format!("SetWindowPos failed: {}", e))?;
    }

    Ok(())
}

pub async fn kill_mpv<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<MpvState>();
    
    {
        let mut tx = state.ipc_tx.lock().unwrap();
        *tx = None;
    }
    {
        let mut connected = state.socket_connected.lock().unwrap();
        *connected = false;
    }
    {
        let mut child = state.child.lock().unwrap();
        if let Some(c) = child.take() {
            let _ = c.kill();
        }
    }
    {
        let mut proc = state.process.lock().unwrap();
        if let Some(handle) = proc.take() {
            handle.abort();
        }
    }
    {
        let mut pid = state.pid.lock().unwrap();
        *pid = 0;
    }
}
