//! macOS MPV Implementation using Hole Punch Pattern
//! 
//! This module implements MPV playback on macOS by:
//! 1. Launching MPV as a sidecar process with no border, positioned behind the Tauri window
//! 2. Making the Tauri window transparent with a "hole" cut out where video shows
//! 3. Controlling MPV via its JSON IPC socket
//! 4. Keeping MPV's window position/size in sync with the Tauri window

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;
use std::time::Duration;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

const IPC_SOCKET: &str = "/tmp/ynotv-mpv.sock";

pub struct MpvState {
    pub process: Mutex<Option<CommandChild>>,
    pub socket: Mutex<Option<UnixStream>>,
    pub current_url: Mutex<Option<String>>,
}

impl MpvState {
    pub fn new() -> Self {
        MpvState {
            process: Mutex::new(None),
            socket: Mutex::new(None),
            current_url: Mutex::new(None),
        }
    }
}

/// Spawn MPV behind the Tauri window at a given position/size
pub async fn launch_mpv<R: Runtime>(
    app: &AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Clean up any existing socket
    let _ = std::fs::remove_file(IPC_SOCKET);

    // Kill any existing MPV process
    kill_mpv_internal(app);

    let geometry = format!("{}x{}+{}+{}", width, height, x, y);

    // Get the sidecar command
    let sidecar = app.shell().sidecar("mpv")
        .map_err(|e| format!("Failed to create sidecar: {}", e))?;

    let cmd = sidecar.args(&[
        "--no-terminal",
        "--no-osc",
        "--no-input-default-bindings",
        "--keep-open=yes",
        "--idle=yes",
        "--force-window=yes",
        "--ontop=no",
        "--no-border",
        &format!("--geometry={}", geometry),
        &format!("--input-ipc-server={}", IPC_SOCKET),
        "--vo=libmpv",
        "--hwdec=no",
    ]);

    let (mut rx, child) = cmd.spawn()
        .map_err(|e| format!("Failed to spawn mpv: {}", e))?;

    println!("[MPV macOS] MPV spawned successfully");

    // Store the process handle
    {
        let state = app.state::<MpvState>();
        let mut proc = state.process.lock().unwrap();
        *proc = Some(child);
    }

    // Spawn a task to monitor MPV output
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let event: CommandEvent = event;
            match event {
                CommandEvent::Stdout(line) => println!("[MPV] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => println!("[MPV stderr] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Error(e) => println!("[MPV error] {}", e),
                CommandEvent::Terminated(s) => println!("[MPV] Terminated: {:?}", s),
                _ => {}
            }
        }
    });

    // Wait for socket to be created
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Connect to IPC socket
    match connect_ipc(app).await {
        Ok(_) => {
            println!("[MPV macOS] IPC connected successfully");
            // Reload the current URL if there was one
            let state = app.state::<MpvState>();
            let url = state.current_url.lock().unwrap().clone();
            if let Some(url) = url {
                let _ = load_file_internal(app, &url).await;
            }
            Ok(())
        }
        Err(e) => {
            eprintln!("[MPV macOS] Failed to connect IPC: {}", e);
            Err(e)
        }
    }
}

async fn connect_ipc<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let mut retries = 10;
    let stream = loop {
        match UnixStream::connect(IPC_SOCKET) {
            Ok(s) => break Ok(s),
            Err(_) if retries > 0 => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                retries -= 1;
            }
            Err(e) => break Err(format!("Failed to connect to unix socket: {}", e)),
        }
    }?;

    stream.set_read_timeout(Some(Duration::from_millis(100))).ok();

    let state = app.state::<MpvState>();
    let mut socket = state.socket.lock().unwrap();
    *socket = Some(stream);

    // Start status monitoring
    start_status_monitor(app.clone());

    Ok(())
}

fn start_status_monitor<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut last_status = MpvStatus {
            playing: false,
            volume: 100.0,
            muted: false,
            position: 0.0,
            duration: 0.0,
        };

        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;

            // Check if we should stop monitoring
            let should_stop = {
                let state = app.state::<MpvState>();
                let socket = state.socket.lock().unwrap();
                socket.is_none()
            };

            if should_stop {
                break;
            }

            // Poll properties
            let properties = ["pause", "volume", "mute", "time-pos", "duration"];
            for prop in &properties {
                let result = get_property_internal(&app, prop).await;
                match (*prop, result) {
                    ("pause", Ok(Value::Bool(p))) => last_status.playing = !p,
                    ("volume", Ok(Value::Number(v))) => last_status.volume = v.as_f64().unwrap_or(100.0),
                    ("mute", Ok(Value::Bool(m))) => last_status.muted = m,
                    ("time-pos", Ok(Value::Number(t))) => last_status.position = t.as_f64().unwrap_or(0.0),
                    ("duration", Ok(Value::Number(d))) => last_status.duration = d.as_f64().unwrap_or(0.0),
                    _ => {}
                }
            }

            let _ = app.emit("mpv-status", last_status.clone());
        }
    });
}

#[derive(Clone, serde::Serialize)]
struct MpvStatus {
    playing: bool,
    volume: f64,
    muted: bool,
    position: f64,
    duration: f64,
}

/// Send a JSON IPC command to MPV
pub async fn send_command<R: Runtime>(
    app: &AppHandle<R>,
    command: Value,
) -> Result<Value, String> {
    let state = app.state::<MpvState>();
    
    let mut socket = state.socket.lock().unwrap();
    let socket = socket.as_mut().ok_or("No IPC socket")?;

    let mut cmd_string = command.to_string();
    cmd_string.push('\n');

    socket.write_all(cmd_string.as_bytes())
        .map_err(|e| format!("IPC write error: {}", e))?;

    // Read response with timeout
    let mut reader = BufReader::new(socket.try_clone().unwrap());
    let mut response = String::new();
    
    // Set a read timeout
    socket.set_read_timeout(Some(Duration::from_secs(2))).ok();
    
    match reader.read_line(&mut response) {
        Ok(0) => Ok(Value::Null),
        Ok(_) => {
            serde_json::from_str(&response)
                .map_err(|e| format!("JSON parse error: {}", e))
        }
        Err(e) => Err(format!("IPC read error: {}", e)),
    }
}

async fn load_file_internal<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), String> {
    send_command(app, json!({ "command": ["loadfile", path] })).await?;
    
    // Store the current URL
    let state = app.state::<MpvState>();
    let mut url = state.current_url.lock().unwrap();
    *url = Some(path.to_string());
    
    Ok(())
}

pub async fn load_file<R: Runtime>(app: &AppHandle<R>, path: String) -> Result<(), String> {
    load_file_internal(app, &path).await
}

pub async fn play<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    send_command(app, json!({ "command": ["set_property", "pause", false] })).await?;
    Ok(())
}

pub async fn pause<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    send_command(app, json!({ "command": ["set_property", "pause", true] })).await?;
    Ok(())
}

pub async fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    send_command(app, json!({ "command": ["stop"] })).await?;
    Ok(())
}

pub async fn seek<R: Runtime>(app: &AppHandle<R>, seconds: f64) -> Result<(), String> {
    send_command(app, json!({ "command": ["seek", seconds, "absolute"] })).await?;
    Ok(())
}

pub async fn set_volume<R: Runtime>(app: &AppHandle<R>, volume: f64) -> Result<(), String> {
    send_command(app, json!({ "command": ["set_property", "volume", volume] })).await?;
    Ok(())
}

pub async fn get_property<R: Runtime>(app: &AppHandle<R>, property: &str) -> Result<Value, String> {
    send_command(app, json!({ "command": ["get_property", property] })).await
}

async fn get_property_internal<R: Runtime>(app: &AppHandle<R>, property: &str) -> Result<Value, String> {
    let response = send_command(app, json!({ "command": ["get_property", property] })).await?;
    
    // MPV returns the value directly in the "data" field for get_property
    if let Some(data) = response.get("data") {
        Ok(data.clone())
    } else {
        Ok(response)
    }
}

pub async fn toggle_mute<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    send_command(app, json!({ "command": ["cycle", "mute"] })).await?;
    Ok(())
}

pub async fn cycle_audio<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    send_command(app, json!({ "command": ["cycle", "audio"] })).await?;
    Ok(())
}

pub async fn cycle_sub<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    send_command(app, json!({ "command": ["cycle", "sub"] })).await?;
    Ok(())
}

pub async fn get_track_list<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    send_command(app, json!({ "command": ["get_property", "track-list"] })).await
}

pub async fn set_audio_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    send_command(app, json!({ "command": ["set_property", "aid", id] })).await?;
    Ok(())
}

pub async fn set_subtitle_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    send_command(app, json!({ "command": ["set_property", "sid", id] })).await?;
    Ok(())
}

pub async fn set_property<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
    value: Value,
) -> Result<(), String> {
    send_command(app, json!({ "command": ["set_property", name, value] })).await?;
    Ok(())
}

/// Relaunch MPV at a new position/size
pub async fn sync_window<R: Runtime>(
    app: &AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // For macOS, we kill and relaunch MPV at the new position
    // This is more reliable than trying to move an existing window cross-process
    let current_url = {
        let state = app.state::<MpvState>();
        let url_guard = state.current_url.lock().unwrap();
        url_guard.clone()
    };

    // Kill and relaunch
    kill_mpv_internal(app);
    tokio::time::sleep(Duration::from_millis(100)).await;
    launch_mpv(app, x, y, width, height).await?;

    // Restore the URL if there was one
    if let Some(url) = current_url {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = load_file_internal(app, &url).await;
    }

    Ok(())
}

fn kill_mpv_internal<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<MpvState>();
    
    {
        let mut socket = state.socket.lock().unwrap();
        *socket = None;
    }
    
    {
        let mut proc = state.process.lock().unwrap();
        if let Some(mut child) = proc.take() {
            let _ = child.kill();
        }
    }
    
    let _ = std::fs::remove_file(IPC_SOCKET);
}

pub async fn kill_mpv<R: Runtime>(app: &AppHandle<R>) {
    kill_mpv_internal(app);
}

/// Initialize MPV with current window position
pub async fn init_mpv<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    // Get main window position and size
    if let Some(window) = app.get_webview_window("main") {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        launch_mpv(&app, pos.x, pos.y, size.width, size.height).await
    } else {
        // Default position
        launch_mpv(&app, 0, 0, 1280, 720).await
    }
}
