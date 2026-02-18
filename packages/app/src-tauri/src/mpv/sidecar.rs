// MPV Sidecar Implementation (Windows/Linux)
//
// Uses MPV as a separate process controlled via JSON IPC over socket/named pipe.
// Video is embedded into the window using the --wid flag.

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

// MPV State for sidecar approach
pub struct MpvState {
    pub process: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    pub socket_connected: Mutex<bool>,
    pub ipc_tx: Mutex<Option<tokio::sync::mpsc::Sender<String>>>,
    pub pending_requests: Arc<Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>>>>,
    pub request_id_counter: Mutex<u64>,
    pub initializing: Mutex<bool>,
}

impl MpvState {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
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
pub enum MpvResponse {
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

// Helper to spawn MPV process
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
            RawWindowHandle::Win32(h) => h.hwnd.get() as usize,
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
    let args = vec![
        format!("--input-ipc-server={}", socket_path),
        format!("--wid={}", hwnd),
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
                }
            }
        }));
    }

    // Wait for socket to be ready
    println!("Waiting for MPV socket...");
    let mut connected = false;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;

        #[cfg(target_os = "windows")]
        {
            if let Ok(_) = ClientOptions::new().path(&socket_path).connect() {
                connected = true;
                break;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if UnixStream::connect(&socket_path).await.is_ok() {
                connected = true;
                break;
            }
        }
    }

    if !connected {
        *state.initializing.lock().unwrap() = false;
        return Err("Timeout waiting for MPV socket".to_string());
    }

    *state.socket_connected.lock().unwrap() = true;
    *state.initializing.lock().unwrap() = false;
    println!("MPV Init Complete");

    Ok(())
}

// Helper to send command and receive response
async fn send_command(
    state: &tauri::State<'_, MpvState>,
    command: &str,
    args: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let request_id = {
        let mut counter = state.request_id_counter.lock().unwrap();
        *counter += 1;
        *counter
    };

    let request = serde_json::json!({
        "command": [command].into_iter().chain(args.into_iter()).collect::<Vec<_>>(),
        "request_id": request_id,
    });

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut pending = state.pending_requests.lock().unwrap();
        pending.insert(request_id, tx);
    }

    // Send command
    {
        let ipc_tx = state.ipc_tx.lock().unwrap();
        if let Some(sender) = ipc_tx.as_ref() {
            let msg = format!("{}\n", request.to_string());
            if let Err(e) = sender.send(msg).await {
                return Err(format!("Failed to send command: {}", e));
            }
        } else {
            return Err("IPC not connected".to_string());
        }
    }

    // Wait for response with timeout
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(result) => result.map_err(|_| "Response channel closed".to_string())?,
        Err(_) => Err("Timeout".to_string())
    }
}

// Start IPC listener
async fn start_ipc_listener<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, MpvState>,
) -> Result<(), String> {
    let socket_path = get_socket_path();

    #[cfg(target_os = "windows")]
    let stream = ClientOptions::new().path(&socket_path).connect()
        .map_err(|e| format!("Failed to connect to MPV socket: {}", e))?;

    #[cfg(not(target_os = "windows"))]
    let stream = UnixStream::connect(&socket_path).await
        .map_err(|e| format!("Failed to connect to MPV socket: {}", e))?;

    let (reader, mut writer) = stream.into_split();
    let reader = BufReader::new(reader);

    // Create channel for sending commands
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);
    {
        let mut ipc_tx = state.ipc_tx.lock().unwrap();
        *ipc_tx = Some(tx);
    }

    let app_handle = app.clone();
    let pending = state.pending_requests.clone();

    // Spawn reader task
    tauri::async_runtime::spawn(async move {
        let mut lines = reader.lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    // Parse response
                    if let Ok(response) = serde_json::from_str::<MpvResponse>(&line) {
                        match response {
                            MpvResponse::Event { event, name, data } => {
                                // Emit event to frontend
                                if event == "property-change" {
                                    if let (Some(prop_name), Some(value)) = (name, data) {
                                        let status = MpvStatus {
                                            playing: prop_name == "pause" && value == false,
                                            volume: if prop_name == "volume" { value.as_f64().unwrap_or(100.0) } else { 100.0 },
                                            muted: if prop_name == "mute" { value.as_bool().unwrap_or(false) } else { false },
                                            position: if prop_name == "time-pos" { value.as_f64().unwrap_or(0.0) } else { 0.0 },
                                            duration: if prop_name == "duration" { value.as_f64().unwrap_or(0.0) } else { 0.0 },
                                        };
                                        let _ = app_handle.emit("mpv-status", status.clone());
                                    }
                                }
                            }
                            MpvResponse::Response { request_id, error, data } => {
                                let mut pending_lock = pending.lock().unwrap();
                                if let Some(tx) = pending_lock.remove(&request_id) {
                                    let result = if let Some(err) = error {
                                        Err(err)
                                    } else {
                                        Ok(data.unwrap_or(serde_json::Value::Null))
                                    };
                                    let _ = tx.send(result);
                                }
                            }
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("MPV IPC read error: {}", e);
                    break;
                }
            }
        }
        let _ = app_handle.emit("mpv-error", "IPC connection lost");
    });

    // Spawn writer task
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Err(e) = writer.write_all(msg.as_bytes()).await {
                eprintln!("MPV IPC write error: {}", e);
            }
        }
    });

    Ok(())
}

// ============================================================================
// Public API Commands
// ============================================================================

pub async fn init_mpv<R: Runtime>(app: AppHandle<R>, _args: Vec<String>, state: tauri::State<'_, MpvState>) -> Result<(), String> {
    // Check if already running
    {
        let proc = state.process.lock().unwrap();
        if proc.is_some() {
            println!("MPV already running, connecting IPC only");
            return start_ipc_listener(app, state).await;
        }
    }

    spawn_mpv(&app, &state).await?;
    start_ipc_listener(app, state).await?;

    let _ = app.emit("mpv-ready", true);
    Ok(())
}

pub async fn mpv_load<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "loadfile", vec![serde_json::Value::String(url)]).await.map(|_| ())
}

pub async fn mpv_play<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "set_property", vec![serde_json::json!("pause"), serde_json::json!(false)]).await.map(|_| ())
}

pub async fn mpv_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "set_property", vec![serde_json::json!("pause"), serde_json::json!(true)]).await.map(|_| ())
}

pub async fn mpv_resume<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "set_property", vec![serde_json::json!("pause"), serde_json::json!(false)]).await.map(|_| ())
}

pub async fn mpv_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "stop", vec![]).await.map(|_| ())
}

pub async fn mpv_set_volume<R: Runtime>(app: AppHandle<R>, volume: f64) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "set_property", vec![serde_json::json!("volume"), serde_json::json!(volume)]).await.map(|_| ())
}

pub async fn mpv_seek<R: Runtime>(app: AppHandle<R>, seconds: f64) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "seek", vec![serde_json::json!(seconds), serde_json::json!("absolute")]).await.map(|_| ())
}

pub async fn mpv_cycle_audio<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "cycle", vec![serde_json::json!("audio")]).await.map(|_| ())
}

pub async fn mpv_cycle_sub<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "cycle", vec![serde_json::json!("sub")]).await.map(|_| ())
}

pub async fn mpv_toggle_mute<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "cycle", vec![serde_json::json!("mute")]).await.map(|_| ())
}

pub async fn mpv_toggle_stats<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "script-binding", vec![serde_json::json!("stats/display-stats-toggle")]).await.map(|_| ())
}

pub async fn mpv_get_track_list<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let state = app.state::<MpvState>();
    send_command(&state, "get_property", vec![serde_json::json!("track-list")]).await
}

pub async fn mpv_set_audio<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "set_property", vec![serde_json::json!("aid"), serde_json::json!(id)]).await.map(|_| ())
}

pub async fn mpv_set_subtitle<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "set_property", vec![serde_json::json!("sid"), serde_json::json!(id)]).await.map(|_| ())
}

pub async fn mpv_set_property<R: Runtime>(app: AppHandle<R>, name: String, value: serde_json::Value) -> Result<(), String> {
    let state = app.state::<MpvState>();
    send_command(&state, "set_property", vec![serde_json::json!(name), value]).await.map(|_| ())
}

pub async fn mpv_get_property<R: Runtime>(app: AppHandle<R>, name: String) -> Result<serde_json::Value, String> {
    let state = app.state::<MpvState>();
    send_command(&state, "get_property", vec![serde_json::json!(name)]).await
}

pub async fn mpv_set_video_margins<R: Runtime>(
    app: AppHandle<R>,
    left: Option<f64>,
    right: Option<f64>,
    top: Option<f64>,
    bottom: Option<f64>,
) -> Result<(), String> {
    let state = app.state::<MpvState>();
    let margins = [
        ("video-margin-ratio-left", left),
        ("video-margin-ratio-right", right),
        ("video-margin-ratio-top", top),
        ("video-margin-ratio-bottom", bottom),
    ];

    for (property, value) in margins {
        if let Some(v) = value {
            send_command(&state, "set_property", vec![serde_json::json!(property), serde_json::json!(v)]).await?;
        }
    }
    Ok(())
}

pub fn mpv_toggle_fullscreen<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
        window.set_fullscreen(!is_fullscreen).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Main window not found".to_string())
    }
}
