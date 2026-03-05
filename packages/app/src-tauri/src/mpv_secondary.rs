//! Secondary MPV instances for multiview slots 2, 3, and 4.
//! Each slot gets its own MPV process embedded in the main HWND,
//! resized to its quadrant via SetWindowPos.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Runtime, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use tokio::io::AsyncWriteExt;
use tokio::net::windows::named_pipe::ClientOptions;
use serde_json::{json, Value};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

// ─── State ───────────────────────────────────────────────────────────────────

struct SlotInstance {
    pid: u32,
    /// Raw HWND value stored as isize so it's Send
    hwnd: isize,
    ipc_tx: Option<tokio::sync::mpsc::Sender<String>>,
}

pub struct SecondaryMpvState {
    slots: Mutex<HashMap<u8, SlotInstance>>,
}

impl SecondaryMpvState {
    pub fn new() -> Self {
        SecondaryMpvState {
            slots: Mutex::new(HashMap::new()),
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn slot_socket_path(slot_id: u8) -> String {
    format!(r"\\.\pipe\mpv-secondary-{}-{}", slot_id, std::process::id())
}

fn get_parent_hwnd<R: Runtime>(app: &AppHandle<R>) -> Result<isize, String> {
    let window = app.get_webview_window("main")
        .ok_or("Main window not found")?;
    let handle = window.window_handle().map_err(|e| e.to_string())?;
    match handle.as_raw() {
        RawWindowHandle::Win32(h) => Ok(h.hwnd.get() as isize),
        _ => Err("Unsupported window handle".to_string()),
    }
}

/// Resize an HWND (identified by raw isize) to the given rect.
/// If bring_to_front is true, brings the window to HWND_TOP so it's visible above the webview.
/// This is necessary for secondary MPV windows in multiview layouts to be visible,
/// but we must ensure they're killed when returning to 'main' layout to prevent blocking UI.
fn set_hwnd_rect(hwnd_raw: isize, x: i32, y: i32, w: u32, h: u32, bring_to_front: bool) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOZORDER, SWP_NOACTIVATE, HWND_TOP};

    let hwnd = HWND(hwnd_raw as _);
    unsafe {
        if bring_to_front {
            // Bring secondary MPV windows to front so they're visible above webview
            SetWindowPos(hwnd, HWND_TOP, x, y, w as i32, h as i32, SWP_NOACTIVATE)
                .map_err(|e| format!("SetWindowPos failed: {}", e))?;
        } else {
            // Main MPV stays behind webview (no z-order change)
            SetWindowPos(hwnd, None, x, y, w as i32, h as i32, SWP_NOZORDER | SWP_NOACTIVATE)
                .map_err(|e| format!("SetWindowPos failed: {}", e))?;
        }
    }
    Ok(())
}

async fn send_ipc(tx: &tokio::sync::mpsc::Sender<String>, command: &str, args: Vec<Value>) {
    let mut cmd_args = vec![Value::String(command.to_string())];
    cmd_args.extend(args);
    let msg = json!({ "command": cmd_args }).to_string();
    let _ = tx.send(msg).await;
}

async fn connect_ipc(socket_path: &str) -> Result<tokio::sync::mpsc::Sender<String>, String> {
    let stream = {
        let mut retries = 15;
        loop {
            match ClientOptions::new().open(socket_path) {
                Ok(s) => {
                    break Ok(s);
                },
                Err(_) if retries > 0 => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    retries -= 1;
                }
                Err(e) => {
                    break Err(format!("Secondary IPC connect failed: {}", e));
                }
            }
        }
    }?;

    let (mut reader, mut writer) = tokio::io::split(stream);
    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(16);

    // Spawn a dummy reader to continuously drain the named pipe OS buffer.
    // MPV writes JSON events continuously. If we do not read from the buffer,
    // the OS pipe fills up and blocks MPV's event loop, deadlocking the window.
    tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break, // Pipe closed or error
                Ok(_) => {} // Discard all read bytes
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let _ = writer.write_all(msg.as_bytes()).await;
            let _ = writer.write_all(b"\n").await;
            let _ = writer.flush().await;
        }
    });

    Ok(tx)
}

// ─── Public API ──────────────────────────────────────────────────────────────

/// Kill any existing secondary MPV for the given slot (synchronous, blocks briefly)
pub async fn kill_slot<R: Runtime>(app: &AppHandle<R>, slot_id: u8) {
    let state = app.state::<SecondaryMpvState>();
    let maybe_pid = {
        let mut slots = state.slots.lock().unwrap();
        if let Some(slot) = slots.remove(&slot_id) {
            drop(slot.ipc_tx); // close IPC channel
            Some(slot.pid)
        } else {
            None
        }
    };
    if let Some(pid) = maybe_pid {
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        unsafe {
            if let Ok(ph) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                let _ = TerminateProcess(ph, 0);
            }
        }
    }
}

/// Kill all secondary slots
pub async fn kill_all<R: Runtime>(app: &AppHandle<R>) {
    kill_slot(app, 2).await;
    kill_slot(app, 3).await;
    kill_slot(app, 4).await;
}

/// Spawn a secondary MPV for the given slot, positioned at (x, y, w, h)
pub async fn spawn_slot<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Kill any existing instance
    kill_slot(app, slot_id).await;

    // Get parent HWND before any awaits
    let parent_hwnd_raw = get_parent_hwnd(app)?;
    let socket_path = slot_socket_path(slot_id);

    // Secondary slots use default args only - custom params only apply to main MPV
    let args = vec![
        format!("--input-ipc-server={}", socket_path),
        format!("--wid={}", parent_hwnd_raw),
        format!("--title=YNOTV_MPV_SLOT_{}", slot_id),
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
        "--volume=80".into(),
        "--mute=yes".into(),
    ];

    let sidecar = app.shell().sidecar("mpv")
        .map_err(|e| format!("Sidecar error: {}", e))?;

    let (mut rx, child) = sidecar.args(&args).spawn()
        .map_err(|e| format!("Failed to spawn secondary MPV: {}", e))?;

    let pid = child.pid();

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    eprintln!("[MPV-{}] {}", slot_id, String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(_) => {
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait for MPV to create its window, then position it
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // Find the MPV child HWND by exact title and position it
    let target_title = format!("YNOTV_MPV_SLOT_{}", slot_id);
    if let Some(hwnd_raw) = crate::mpv_windows::find_mpv_hwnd_by_title(parent_hwnd_raw, &target_title) {
        let _ = set_hwnd_rect(hwnd_raw, x, y, width, height, true);
        // Store the discovered HWND so we don't need to search again
        let ipc_tx = connect_ipc(&socket_path).await.ok();
        let state = app.state::<SecondaryMpvState>();
        let mut slots = state.slots.lock().unwrap();
        slots.insert(slot_id, SlotInstance { pid, hwnd: hwnd_raw, ipc_tx });
    } else {
        let ipc_tx = connect_ipc(&socket_path).await.ok();
        let state = app.state::<SecondaryMpvState>();
        let mut slots = state.slots.lock().unwrap();
        slots.insert(slot_id, SlotInstance { pid, hwnd: 0, ipc_tx });
    }

    Ok(())
}

/// Load a URL in a secondary slot. Spawns the slot MPV if not yet running.
pub async fn load_slot<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    url: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // Check if slot is already running; extract tx clone before any await
    let existing_tx = {
        let state = app.state::<SecondaryMpvState>();
        let slots = state.slots.lock().unwrap();
        slots.get(&slot_id).and_then(|s| s.ipc_tx.clone())
    };

    if existing_tx.is_none() {
        // Note: Custom MPV params only apply to main player, not secondary slots
        spawn_slot(app, slot_id, x, y, width, height).await?;
    } else {
        // Slot already exists - reposition it to the new coordinates
        reposition_slot(app, slot_id, x, y, width, height).await?;
    }

    // Reload tx after potential spawn
    let tx = {
        let state = app.state::<SecondaryMpvState>();
        let slots = state.slots.lock().unwrap();
        slots.get(&slot_id).and_then(|s| s.ipc_tx.clone())
    };

    if let Some(tx) = tx {
        send_ipc(&tx, "loadfile", vec![json!(url.clone())]).await;
    }
    Ok(())
}

/// Stop playback in a slot (keep MPV alive)
pub async fn stop_slot<R: Runtime>(app: &AppHandle<R>, slot_id: u8) -> Result<(), String> {
    let tx = {
        let state = app.state::<SecondaryMpvState>();
        let slots = state.slots.lock().unwrap();
        slots.get(&slot_id).and_then(|s| s.ipc_tx.clone())
    };
    if let Some(tx) = tx {
        send_ipc(&tx, "stop", vec![]).await;
    }
    Ok(())
}

/// Set an MPV property (like "pause", "volume") for a specific slot
pub async fn set_property_slot<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    property: &str,
    value: Value,
) -> Result<(), String> {
    let tx = {
        let state = app.state::<SecondaryMpvState>();
        let slots = state.slots.lock().unwrap();
        slots.get(&slot_id).and_then(|s| s.ipc_tx.clone())
    };
    if let Some(tx) = tx {
        send_ipc(&tx, "set_property", vec![json!(property), value]).await;
    }
    Ok(())
}

/// Reposition a running slot's HWND
pub async fn reposition_slot<R: Runtime>(
    app: &AppHandle<R>,
    slot_id: u8,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let slot_entry = {
        let state = app.state::<SecondaryMpvState>();
        let slots = state.slots.lock().unwrap();
        slots.get(&slot_id).map(|s| (s.hwnd, s.pid))
    };

    if let Some((hwnd, pid)) = slot_entry {
        let mut effective_hwnd = hwnd;

        // If we never discovered the HWND during spawn, try to locate it now by PID
        if effective_hwnd == 0 {
            if let Ok(parent_hwnd_raw) = get_parent_hwnd(app) {
                let target_title = format!("YNOTV_MPV_SLOT_{}", slot_id);
                if let Some(found) = crate::mpv_windows::find_mpv_hwnd_by_title(parent_hwnd_raw, &target_title) {
                    effective_hwnd = found;
                    // Persist the discovered HWND so future calls don't need to search
                    {
                        let state = app.state::<SecondaryMpvState>();
                        let mut slots = state.slots.lock().unwrap();
                        if let Some(slot) = slots.get_mut(&slot_id) {
                            slot.hwnd = found;
                        }
                    }
                }
            }
        }

        if effective_hwnd != 0 {
            set_hwnd_rect(effective_hwnd, x, y, width, height, true)?;
        }
    }

    Ok(())
}
