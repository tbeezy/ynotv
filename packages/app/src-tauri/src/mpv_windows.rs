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
use tauri_plugin_shell::{ShellExt, process::CommandEvent};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use serde_json::{json, Value};

pub struct MpvState {
    pub process: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
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
            pid: Mutex::new(0),
            socket_connected: Mutex::new(false),
            ipc_tx: Mutex::new(None),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            request_id_counter: Mutex::new(0),
            initializing: Mutex::new(false),
        }
    }
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

/// Spawn MPV embedded in the Tauri window
async fn spawn_mpv<R: Runtime>(app: &AppHandle<R>, state: &tauri::State<'_, MpvState>) -> Result<(), String> {
    // Prevent concurrent inits
    {
        let mut init = state.initializing.lock().unwrap();
        if *init {
            println!("[MPV Windows] Initialization already in progress");
            return Ok(());
        }

        let proc = state.process.lock().unwrap();
        if proc.is_some() {
            return Ok(());
        }
        *init = true;
    }

    let socket_path = get_socket_path();
    println!("[MPV Windows] Initializing MPV on socket: {}", socket_path);

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
    println!("[MPV Windows] Embedding MPV into HWND: {:?}", hwnd);

    // Prepare arguments
    let args = vec![
        format!("--input-ipc-server={}", socket_path),
        format!("--wid={}", hwnd),
        "--title=YNOTV_MPV_MAIN".into(),
        "--force-window=immediate".into(),
        "--idle=yes".into(),
        "--keep-open=yes".into(),
        "--no-osc".into(),
        "--no-osd-bar".into(),
        "--osd-level=0".into(),
        "--input-default-bindings=no".into(),
        "--no-input-cursor".into(),
        "--cursor-autohide=no".into(),
    ];

    // Launch MPV using shell plugin
    let sidecar = app.shell().sidecar("mpv")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?;

    let cmd = sidecar.args(&args);
    let (mut rx, child) = cmd.spawn()
        .map_err(|e| format!("Failed to spawn mpv: {}", e))?;

    let pid = child.pid();
    *state.pid.lock().unwrap() = pid;

    println!("[MPV Windows] MPV spawned successfully with PID: {}", pid);

    // Spawn a thread to monitor the process
    {
        let mut proc_handle = state.process.lock().unwrap();
        let app_handle_for_stderr = app.clone();
        *proc_handle = Some(tauri::async_runtime::spawn(async move {
            let mut parse_and_emit = |line_str: &str, app_handle: &tauri::AppHandle<R>| {
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
                    println!("[MPV] Emitting HTTP error: {}", error_msg);
                    let _ = app_handle.emit("mpv-http-error", error_msg);
                }
            };

            while let Some(event) = rx.recv().await {
                let event: CommandEvent = event;
                match event {
                    CommandEvent::Stdout(line) => {
                        let stdout_str = String::from_utf8_lossy(&line).to_string();
                        // println!("[MPV] {}", stdout_str); // uncomment for local debugging
                        parse_and_emit(&stdout_str, &app_handle_for_stderr);
                    },
                    CommandEvent::Stderr(line) => {
                        let stderr_str = String::from_utf8_lossy(&line).to_string();
                        // println!("[MPV stderr] {}", stderr_str); // uncomment for local debugging
                        parse_and_emit(&stderr_str, &app_handle_for_stderr);
                    },
                    CommandEvent::Error(e) => println!("[MPV error] {}", e),
                    CommandEvent::Terminated(s) => println!("[MPV] Terminated: {:?}", s),
                    _ => {}
                }
            }
        }));
    }

    // Wait for startup
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Connect to IPC
    println!("[MPV Windows] Connecting IPC...");
    let connect_res = connect_ipc(app, state, &socket_path).await;

    *state.initializing.lock().unwrap() = false;

    match connect_res {
        Ok(_) => {
            println!("[MPV Windows] Init Complete");
            Ok(())
        }
        Err(e) => Err(e)
    }
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
                                        println!("[MPV] end-file error: {}", error_msg);
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
    let is_running = {
        let proc = state.process.lock().unwrap();
        proc.is_some()
    };

    if is_running {
        println!("[MPV Windows] Already running, reconnecting IPC");
        let socket_path = get_socket_path();
        return connect_ipc(&app, &state, &socket_path).await;
    }

    spawn_mpv(&app, &state).await
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
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, SetWindowPos, SWP_NOZORDER, SWP_NOACTIVATE,
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
        println!("[MPV Windows] MPV child window not found after retries, skipping SetWindowPos");
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

    println!("[MPV Windows] MPV HWND repositioned successfully");
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
        let mut proc = state.process.lock().unwrap();
        if let Some(handle) = proc.take() {
            handle.abort();
        }
    }
}
