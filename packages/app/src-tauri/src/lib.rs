use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, Manager};
use log::{debug, info, warn, error};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

#[cfg(target_os = "windows")]
mod pip_aspect_lock {
    use std::sync::Mutex;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{GetWindowRect, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_SIZING,
                WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT,
                WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT},
        },
    };

    const SUBCLASS_ID: usize = 0x594E_4F54;

    #[derive(Clone, Copy)]
    struct Size {
        width: i32,
        height: i32,
    }

    #[derive(Clone, Copy)]
    enum Driver {
        Width,
        Height,
    }

    struct State {
        ratio: Option<f64>,
        start_size: Option<Size>,
        corner_driver: Option<Driver>,
    }

    static STATE: Mutex<State> = Mutex::new(State {
        ratio: None,
        start_size: None,
        corner_driver: None,
    });

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        let sizing_result = if message == WM_SIZING {
            Some(DefSubclassProc(hwnd, message, wparam, lparam))
        } else {
            None
        };

        if message == WM_ENTERSIZEMOVE {
            if let Ok(mut state) = STATE.lock() {
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    state.start_size = Some(Size {
                        width: rect.right - rect.left,
                        height: rect.bottom - rect.top,
                    });
                }
                state.corner_driver = None;
            }
        } else if message == WM_EXITSIZEMOVE {
            if let Ok(mut state) = STATE.lock() {
                state.start_size = None;
                state.corner_driver = None;
            }
        } else if message == WM_SIZING {
            if let Ok(mut state) = STATE.lock() {
                if let Some(ratio) = state.ratio {
                let rect = &mut *(lparam.0 as *mut RECT);
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                let edge = wparam.0 as u32;

                if matches!(edge, WMSZ_LEFT | WMSZ_RIGHT) {
                    let target_height = (width as f64 / ratio).round() as i32;
                    rect.bottom = rect.top + target_height;
                } else if matches!(edge, WMSZ_TOP | WMSZ_BOTTOM) {
                    let target_width = (height as f64 * ratio).round() as i32;
                    rect.right = rect.left + target_width;
                } else if matches!(edge, WMSZ_TOPLEFT | WMSZ_TOPRIGHT | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT) {
                    if state.corner_driver.is_none() {
                        let start = state.start_size.unwrap_or(Size { width, height });
                        let width_change = (width - start.width).abs() as f64 / ratio;
                        let height_change = (height - start.height).abs() as f64;
                        state.corner_driver = Some(if height_change > width_change {
                            Driver::Height
                        } else {
                            Driver::Width
                        });
                    }
                    let driver = state.corner_driver.unwrap();

                    if matches!(driver, Driver::Height) {
                        let target_width = (height as f64 * ratio).round() as i32;
                        if edge == WMSZ_TOPLEFT || edge == WMSZ_BOTTOMLEFT {
                            rect.left = rect.right - target_width;
                        } else {
                            rect.right = rect.left + target_width;
                        }
                    } else {
                        let target_height = (width as f64 / ratio).round() as i32;
                        if edge == WMSZ_TOPLEFT || edge == WMSZ_TOPRIGHT {
                            rect.top = rect.bottom - target_height;
                        } else {
                            rect.bottom = rect.top + target_height;
                        }
                    }
                }
                return LRESULT(1);
                }
            }
        }
        sizing_result.unwrap_or_else(|| DefSubclassProc(hwnd, message, wparam, lparam))
    }

    pub fn set(hwnd: HWND, ratio: Option<f64>) -> Result<(), String> {
        {
            let mut state = STATE.lock().map_err(|e| e.to_string())?;
            state.ratio = ratio;
            state.start_size = None;
            state.corner_driver = None;
        }
        unsafe {
            if ratio.is_some() {
                if !SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, 0).as_bool() {
                    return Err("failed to install PiP window subclass".into());
                }
            } else {
                let _ = RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID);
            }
        }
        Ok(())
    }
}

#[tauri::command]
fn set_pip_aspect_lock(window: tauri::WebviewWindow, ratio: Option<f64>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        return pip_aspect_lock::set(
            windows::Win32::Foundation::HWND(hwnd.0),
            ratio.filter(|value| value.is_finite() && *value > 0.0),
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, ratio);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod resize_coalescing {
    use windows::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
        UI::{
            Shell::{DefSubclassProc, SetWindowSubclass},
            WindowsAndMessaging::{
                GetCursorPos, PeekMessageW, MSG, PM_REMOVE, WM_MOUSEMOVE, WM_SIZING,
                WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT, WMSZ_RIGHT,
                WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
            },
        },
    };

    const SUBCLASS_ID: usize = 0x594E_4F55;

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if message == WM_SIZING {
            let mut latest = None;
            loop {
                let mut pending = MSG::default();
                if !PeekMessageW(
                    &mut pending,
                    HWND::default(),
                    WM_MOUSEMOVE,
                    WM_MOUSEMOVE,
                    PM_REMOVE,
                ).as_bool() {
                    break;
                }
                latest = Some(pending);
            }

            if latest.is_some() {
                let mut cursor = POINT::default();
                if GetCursorPos(&mut cursor).is_ok() {
                    let rect = &mut *(lparam.0 as *mut windows::Win32::Foundation::RECT);
                    let edge = wparam.0 as u32;
                    if matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT) {
                        rect.left = cursor.x;
                    }
                    if matches!(edge, WMSZ_RIGHT | WMSZ_TOPRIGHT | WMSZ_BOTTOMRIGHT) {
                        rect.right = cursor.x;
                    }
                    if matches!(edge, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
                        rect.top = cursor.y;
                    }
                    if matches!(edge, WMSZ_BOTTOM | WMSZ_BOTTOMLEFT | WMSZ_BOTTOMRIGHT) {
                        rect.bottom = cursor.y;
                    }
                }
            }
        }

        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    pub fn install(hwnd: HWND) -> Result<(), String> {
        unsafe {
            if !SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, 0).as_bool() {
                return Err("failed to install resize coalescing handler".into());
            }
        }
        Ok(())
    }
}

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
mod mpv_popout;
mod audio_capture;

// Re-export the MPV state and functions based on platform
#[cfg(target_os = "macos")]
use mpv_macos::MpvState;
#[cfg(target_os = "windows")]
use mpv_windows::MpvState;
#[cfg(target_os = "windows")]
use mpv_secondary::SecondaryMpvState;
use mpv_popout::PopoutMpvState;

// DVR Module (Rust native implementation)
mod dvr;
use dvr::{DvrState, models::*};

// System tray + minimize-to-tray support (desktop only)
#[cfg(desktop)]
mod tray;

// Bulk database operations module
mod db_bulk_ops;
mod sync_provider;

// Stream probe / IPTV Checker module
mod stream_probe;

// Streaming EPG parser module
mod epg_streaming;

// Channel Logo Caching module
mod logo_cache;
use logo_cache::{LogoCacheManager, LogoCacheStats};

// TVMaze module for TV Calendar
mod tvmaze;

mod cast;
use cast::{
    cast_start_discovery, cast_stop_discovery, cast_get_devices, cast_connect, cast_disconnect,
    cast_load_media, cast_play, cast_pause, cast_seek, cast_set_volume, cast_toggle_mute,
    cast_resolve_url, cast_stop,
};

mod discord_rp;
mod local_lib;


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

/// Helper to read a single setting value from the store.
/// Tries nested `settings` object first (frontend format), then root-level fallback.
fn read_store_setting<R: Runtime>(app: &AppHandle<R>, key: &str) -> Option<serde_json::Value> {
    use tauri_plugin_store::StoreExt;

    let store = app.store(".settings.dat").ok()?;
    let nested = store.get("settings").and_then(|v| v.as_object().cloned());

    if let Some(ref obj) = nested {
        if let Some(v) = obj.get(key) {
            return Some(v.clone());
        }
    }
    store.get(key)
}

/// Reads SOCKS5 proxy configuration from settings store and applies them as environment variables.
pub fn apply_proxy_settings<R: Runtime>(app: &AppHandle<R>) {
    if let Some(settings_val) = read_store_setting(app, "settings") {
        if let Some(settings) = settings_val.as_object() {
            let enabled = settings.get("socks5ProxyEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
            if enabled {
                if let Some(socks5_server) = settings.get("socks5ProxyServer").and_then(|v| v.as_str()) {
                    let server = socks5_server.trim();
                    if !server.is_empty() {
                        let username = settings.get("socks5ProxyUsername").and_then(|v| v.as_str()).unwrap_or("");
                        let password = settings.get("socks5ProxyPassword").and_then(|v| v.as_str()).unwrap_or("");
                        
                        let proxy_url = if server.starts_with("socks5://") || server.starts_with("socks5h://") {
                            server.to_string()
                        } else {
                            format!("socks5h://{}", server)
                        };

                        let final_proxy = if !username.is_empty() {
                            let mut parts = proxy_url.splitn(2, "://");
                            let scheme = parts.next().unwrap_or("socks5h");
                            let rest = parts.next().unwrap_or(&proxy_url);
                            format!("{}://{}:{}@{}", scheme, username, password, rest)
                        } else {
                            proxy_url
                        };

                        info!("[Proxy] Applying SOCKS5 proxy environment variables (using user: {} on server: {})", username, server);
                        std::env::set_var("ALL_PROXY", &final_proxy);
                        std::env::set_var("http_proxy", &final_proxy);
                        std::env::set_var("https_proxy", &final_proxy);
                        std::env::set_var("NO_PROXY", "localhost,127.0.0.1,::1,github.com,githubusercontent.com");
                        std::env::set_var("no_proxy", "localhost,127.0.0.1,::1,github.com,githubusercontent.com");
                        return;
                    }
                }
            }
        }
    }
    
    info!("[Proxy] SOCKS5 proxy disabled or empty. Clearing proxy environment variables.");
    std::env::remove_var("ALL_PROXY");
    std::env::remove_var("http_proxy");
    std::env::remove_var("https_proxy");
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");
}

pub fn get_configured_proxy<R: Runtime>(app: &AppHandle<R>) -> Option<reqwest::Proxy> {
    if let Some(settings_val) = read_store_setting(app, "settings") {
        if let Some(settings) = settings_val.as_object() {
            let enabled = settings.get("socks5ProxyEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
            if enabled {
                if let Some(socks5_server) = settings.get("socks5ProxyServer").and_then(|v| v.as_str()) {
                    let server = socks5_server.trim();
                    if !server.is_empty() {
                        let username = settings.get("socks5ProxyUsername").and_then(|v| v.as_str()).unwrap_or("");
                        let password = settings.get("socks5ProxyPassword").and_then(|v| v.as_str()).unwrap_or("");
                        
                        let proxy_url = if server.starts_with("socks5://") || server.starts_with("socks5h://") {
                            server.to_string()
                        } else {
                            format!("socks5h://{}", server)
                        };

                        let final_proxy = if !username.is_empty() {
                            let mut parts = proxy_url.splitn(2, "://");
                            let scheme = parts.next().unwrap_or("socks5h");
                            let rest = parts.next().unwrap_or(&proxy_url);
                            format!("{}://{}:{}@{}", scheme, username, password, rest)
                        } else {
                            proxy_url
                        };

                        if let Ok(proxy) = reqwest::Proxy::all(&final_proxy) {
                            return Some(proxy);
                        }
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn update_proxy_settings<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    info!("[Proxy] update_proxy_settings command received");
    apply_proxy_settings(&app);
    
    // Terminate current MPV process so that any new playback starts with updated settings
    mpv_kill(app).await;
    
    Ok(())
}

#[tauri::command]
async fn test_proxy_connection<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    info!("[Proxy] test_proxy_connection command received");
    
    let mut client_builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .danger_accept_invalid_certs(true); // Accept self-signed certificates for testing

    if let Some(proxy) = get_configured_proxy(&app) {
        client_builder = client_builder.proxy(proxy);
    } else {
        return Err("Proxy is not enabled or proxy server field is empty".to_string());
    }

    let client = client_builder.build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let resp = client.get("https://api.ipify.org?format=json")
        .send()
        .await
        .map_err(|e| format!("Proxy connection test failed: {}", e))?;

    let ip_info: serde_json::Value = resp.json()
        .await
        .map_err(|e| format!("Failed to parse response from test server: {}", e))?;

    let ip = ip_info.get("ip")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "IP address not found in test response".to_string())?;

    Ok(ip.to_string())
}


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

            // Check hardware video acceleration toggle (default true)
            let mpv_hwdec = get_value("mpvHwdecEnabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            // Robust check if user explicitly supplied hwdec or vo in their custom parameters
            let has_hwdec = args.iter().any(|a| {
                let clean = a.trim_start_matches('-');
                clean == "hwdec" || clean.starts_with("hwdec=") || clean.starts_with("hwdec ")
            });

            let has_vo = args.iter().any(|a| {
                let clean = a.trim_start_matches('-');
                clean == "vo" || clean.starts_with("vo=") || clean.starts_with("vo ")
            });

            if !has_hwdec {
                if mpv_hwdec {
                    debug!("[MPV] Auto-injecting default --hwdec=auto");
                    args.insert(0, "--hwdec=auto".to_string());
                } else {
                    debug!("[MPV] Auto-injecting --hwdec=no (disabled in Playback settings)");
                    args.insert(0, "--hwdec=no".to_string());
                }
            } else {
                debug!("[MPV] User custom parameters contain explicit hwdec flag; skipping auto-injection");
            }

            if mpv_hwdec && !has_vo {
                debug!("[MPV] Auto-injecting default --vo=gpu");
                args.insert(0, "--vo=gpu".to_string());
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

pub fn sanitize_mpv_args(args: Vec<String>) -> Vec<String> {
    let mut valid_args = Vec::new();
    for arg in args {
        if !arg.starts_with("--") {
            log::warn!("Dropped malformed MPV argument (must start with --): {}", arg);
            continue;
        }

        let without_dashes = &arg[2..];
        let mut parts = without_dashes.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let value = parts.next();

        if key == "vo" && value == Some("direct3d") {
            log::warn!("Blocked incompatible MPV argument: vo=direct3d (causes embedding failure)");
            continue;
        }

        valid_args.push(arg);
    }
    valid_args
}

/// Check if MPV arguments already contain a ytdl hook path override.
/// Handles both the legacy --ytdl-path form and the MPV 0.40+ script-opts form.
pub fn args_contains_ytdl_path(args: &[String]) -> bool {
    args.iter().any(|a| {
        a.starts_with("--ytdl-path")
            || (a.starts_with("--script-opt") && a.contains("ytdl_hook-ytdl_path"))
    })
}

/// Detect bundled yt-dlp sidecar next to the current executable.
/// Tauri places sidecars in the same directory as the app binary.
fn find_bundled_ytdl() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    // Platform-specific sidecar names (Tauri externalBin naming convention)
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    let names = ["yt-dlp-x86_64-pc-windows-msvc.exe", "yt-dlp.exe"];
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    let names = ["yt-dlp-aarch64-pc-windows-msvc.exe", "yt-dlp.exe"];
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    let names = ["yt-dlp-aarch64-apple-darwin", "yt-dlp"];
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    let names = ["yt-dlp-x86_64-apple-darwin", "yt-dlp"];
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    let names = ["yt-dlp-x86_64-unknown-linux-gnu", "yt-dlp"];
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64")
    )))]
    let names = ["yt-dlp"];

    for name in names {
        let path = dir.join(name);
        if path.exists() {
            return Some(path.to_string_lossy().into_owned());
        }
    }
    None
}

/// Auto-detect yt-dlp or youtube-dl:
/// 1. Bundled sidecar next to the executable (production builds)
/// 2. System PATH (dev / user-installed)
pub fn find_ytdl_path() -> Option<String> {
    // 1. Prefer bundled sidecar
    if let Some(path) = find_bundled_ytdl() {
        return Some(path);
    }

    // 2. Fall back to system PATH
    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("where")
            .arg("yt-dlp")
            .output()
            .ok()?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()?
                .trim()
                .to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
        // Fallback to youtube-dl
        let output = std::process::Command::new("where")
            .arg("youtube-dl")
            .output()
            .ok()?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()?
                .trim()
                .to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = std::process::Command::new("which")
            .arg("yt-dlp")
            .output()
            .ok()?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()?
                .trim()
                .to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
        // Fallback to youtube-dl
        let output = std::process::Command::new("which")
            .arg("youtube-dl")
            .output()
            .ok()?;
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()?
                .trim()
                .to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }
    None
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
    if !args.is_empty() {
        debug!("[MPV] Merging {} frontend-provided args", args.len());
        for arg in &args {
            debug!("[MPV]   Frontend arg: {}", arg);
            let prefix = arg.split('=').next().unwrap_or(arg);
            custom_params.retain(|p| !p.starts_with(prefix));
            custom_params.push(arg.clone());
        }
    }

    // Apply MPV argument sanitization
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
    // Reset audio delay to 0.0 before loading the new file
    let _ = mpv_set_property(app.clone(), "audio-delay".to_string(), serde_json::json!(0.0)).await;
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
async fn mpv_add_subtitle<R: Runtime>(app: AppHandle<R>, file_path: String, flag: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::add_subtitle_file(&app, file_path, flag).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::add_subtitle_file(&app, file_path, flag).await
    }
}

#[tauri::command]
async fn mpv_remove_subtitle<R: Runtime>(app: AppHandle<R>, file_path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mpv_macos::remove_subtitle_file(&app, file_path).await
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::remove_subtitle_file(&app, file_path).await
    }
}

#[tauri::command]
async fn mpv_get_log<R: Runtime>(app: AppHandle<R>, tail: Option<usize>) -> Result<serde_json::Value, String> {
    let tail = tail.unwrap_or(400);
    #[cfg(target_os = "macos")]
    {
        Ok(serde_json::json!({ "log": "", "path": "(mpv log not available on macOS)" }))
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::get_mpv_log(&app, tail).await
    }
}

#[tauri::command]
async fn mpv_set_verbose_logging<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let _ = enabled;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        mpv_windows::set_verbose_logging(&app, enabled).await
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

/// Debug command to get cache-related MPV properties
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

/// Debug command to get the custom MPV parameters loaded from store
#[tauri::command]
async fn mpv_get_params_debug<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    use serde_json::json;

    let raw_params = get_mpv_params_from_store(&app).await;
    let safe_params = sanitize_mpv_args(raw_params.clone());

    let result = json!({
        "raw_loaded": raw_params,
        "sanitized": safe_params,
        "dropped_count": raw_params.len().saturating_sub(safe_params.len()),
    });

    debug!("[MPV Debug] Params debug: {:?}", result);
    Ok(result)
}

#[tauri::command]
async fn mpv_toggle_fullscreen<R: Runtime>(
    app: AppHandle<R>,
    restore_to_maximized: Option<bool>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
        let should_restore_maximized = is_fullscreen && restore_to_maximized.unwrap_or(false);

        #[cfg(target_os = "windows")]
        if !is_fullscreen {
            let is_maximized = window.is_maximized().map_err(|e| e.to_string())?;
            if is_maximized {
                window.unmaximize().map_err(|e| e.to_string())?;
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            // Capture the true windowed geometry BEFORE the OS resizes the window
            // to the screen. Relying on Resized/Moved events for this is racy: the
            // fullscreen resize event can arrive while is_fullscreen() still reports
            // false, which would poison last_unmaximized with the fullscreen size
            // and make exit-fullscreen restore the wrong window size.
            let tracker = app.state::<WindowStateTracker>();
            if let Ok(mut guard) = tracker.last_non_fullscreen_maximized.lock() {
                *guard = is_maximized;
            }
            if let (Ok(physical_size), Ok(pos)) = (window.inner_size(), window.outer_position()) {
                let scale_factor = window.scale_factor().unwrap_or(1.0);
                let logical_size = physical_size.to_logical::<f64>(scale_factor);
                if physical_size.width >= 400
                    && physical_size.height >= 300
                    && is_valid_saved_window_position(pos.x, pos.y)
                {
                    if let Ok(mut guard) = tracker.last_unmaximized.lock() {
                        *guard = Some(WindowState {
                            width: logical_size.width.round() as u32,
                            height: logical_size.height.round() as u32,
                            x: pos.x,
                            y: pos.y,
                            maximized: false,
                            fullscreen: false,
                        });
                    }
                }
            }
        }

        #[cfg(target_os = "windows")]
        if should_restore_maximized {
            let _ = window.hide();
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        window.set_fullscreen(!is_fullscreen).map_err(|e| e.to_string())?;

        // Windows: exiting fullscreen from a windowed (non-maximized) state.
        // Explicitly re-apply the last known windowed geometry instead of trusting
        // the OS restore bounds, which can be stale/corrupt when the app reopened
        // directly into fullscreen from a saved state (would otherwise collapse to
        // the minimum window size).
        #[cfg(target_os = "windows")]
        if is_fullscreen && !should_restore_maximized {
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;
            if let Some(geo) = last_windowed_geometry(&app) {
                let _ = window.set_size(tauri::Size::Logical(
                    tauri::LogicalSize { width: geo.width as f64, height: geo.height as f64 }
                ));
                let _ = window.set_position(tauri::Position::Physical(
                    tauri::PhysicalPosition { x: geo.x, y: geo.y }
                ));
            }
        }

        #[cfg(target_os = "windows")]
        if should_restore_maximized {
            window.maximize().map_err(|e| e.to_string())?;
        }
        
        // On Windows, trigger a geometry refresh after entering fullscreen
        // to ensure MPV fills the entire screen
        #[cfg(target_os = "windows")]
        {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let _ = mpv_windows::mpv_set_geometry(&app, 0, 0, 0, 0).await;
            if should_restore_maximized {
                let _ = window.show();
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
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
// Popout MPV Commands
// ============================================================================

#[tauri::command]
async fn popout_open<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    always_on_top: bool,
    custom_params: String,
) -> Result<(), String> {
    // Parse custom params string into lines
    let mut raw_params: Vec<String> = custom_params
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|s| s.to_string())
        .collect();

    // Check popout hardware video acceleration toggle (default true)
    let popout_hwdec = read_store_setting(&app, "popoutHwdecEnabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let has_hwdec = raw_params.iter().any(|a| {
        let clean = a.trim_start_matches('-');
        clean == "hwdec" || clean.starts_with("hwdec=") || clean.starts_with("hwdec ")
    });

    let has_vo = raw_params.iter().any(|a| {
        let clean = a.trim_start_matches('-');
        clean == "vo" || clean.starts_with("vo=") || clean.starts_with("vo ")
    });

    if !has_hwdec {
        if popout_hwdec {
            debug!("[Popout MPV] Auto-injecting default --hwdec=auto");
            raw_params.insert(0, "--hwdec=auto".to_string());
        } else {
            debug!("[Popout MPV] Auto-injecting --hwdec=no (disabled in settings)");
            raw_params.insert(0, "--hwdec=no".to_string());
        }
    } else {
        debug!("[Popout MPV] User custom parameters contain explicit hwdec flag; skipping auto-injection");
    }

    if popout_hwdec && !has_vo {
        debug!("[Popout MPV] Auto-injecting default --vo=gpu");
        raw_params.insert(0, "--vo=gpu".to_string());
    }

    let safe_params = sanitize_mpv_args(raw_params);
    mpv_popout::spawn_and_load(&app, url, always_on_top, safe_params).await
}

#[tauri::command]
async fn popout_load<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    mpv_popout::load_url(&app, url).await
}

#[tauri::command]
async fn popout_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv_popout::stop(&app).await
}

#[tauri::command]
async fn popout_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    mpv_popout::kill_popout(&app).await;
    Ok(())
}

#[tauri::command]
async fn popout_set_property<R: Runtime>(
    app: AppHandle<R>,
    property: String,
    value: serde_json::Value,
) -> Result<(), String> {
    mpv_popout::set_property(&app, &property, value).await
}

#[tauri::command]
async fn popout_set_always_on_top<R: Runtime>(
    app: AppHandle<R>,
    on_top: bool,
) -> Result<(), String> {
    mpv_popout::set_always_on_top_cmd(&app, on_top).await
}

#[tauri::command]
fn popout_is_running<R: Runtime>(app: AppHandle<R>) -> bool {
    mpv_popout::is_running(&app)
}

#[tauri::command]
async fn popout_toggle_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let tx = {
        let state = app.state::<PopoutMpvState>();
        let inst = state.instance.lock().unwrap();
        inst.as_ref().and_then(|i| i.ipc_tx.clone())
    };
    if let Some(tx) = tx {
        mpv_popout::send_ipc(&tx, "cycle", vec![serde_json::json!("pause")]).await;
    }
    Ok(())
}

#[tauri::command]
async fn popout_toggle_fullscreen<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let tx = {
        let state = app.state::<PopoutMpvState>();
        let inst = state.instance.lock().unwrap();
        inst.as_ref().and_then(|i| i.ipc_tx.clone())
    };
    if let Some(tx) = tx {
        mpv_popout::send_ipc(&tx, "cycle", vec![serde_json::json!("fullscreen")]).await;
    }
    Ok(())
}

/// Debug command to preview popout MPV parameters (raw vs sanitized)
#[tauri::command]
async fn popout_get_params_debug<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    use serde_json::json;

    let settings = read_store_setting(&app, "settings").and_then(|v| v.as_object().cloned());

    let enabled = settings.as_ref()
        .and_then(|s| s.get("popoutMpvParamsEnabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let raw_str = settings.as_ref()
        .and_then(|s| s.get("popoutMpvParams"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let raw_params: Vec<String> = raw_str
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|s| s.to_string())
        .collect();

    let safe_params = if enabled {
        sanitize_mpv_args(raw_params.clone())
    } else {
        vec![]
    };

    let result = json!({
        "enabled": enabled,
        "raw_loaded": raw_params,
        "sanitized": safe_params,
        "dropped_count": if enabled { raw_params.len().saturating_sub(safe_params.len()) } else { 0 },
    });

    debug!("[Popout Debug] Params debug: {:?}", result);
    Ok(result)
}

#[tauri::command]
async fn popout_seek<R: Runtime>(app: AppHandle<R>, seconds: f64) -> Result<(), String> {
    let tx = {
        let state = app.state::<PopoutMpvState>();
        let inst = state.instance.lock().unwrap();
        inst.as_ref().and_then(|i| i.ipc_tx.clone())
    };
    if let Some(tx) = tx {
        mpv_popout::send_ipc(&tx, "seek", vec![serde_json::json!(seconds), serde_json::json!("absolute")]).await;
    }
    Ok(())
}

// ============================================================================
// DVR Commands (Rust Native Implementation)
// ============================================================================

/// Initialize the DVR system
///
/// DVR state is managed asynchronously after setup (so the main thread is never
/// blocked opening a large database), so wait briefly for it to be ready rather
/// than failing the frontend's startup call with "state not managed".
#[tauri::command]
async fn init_dvr(app: AppHandle) -> Result<(), String> {
    info!("[DVR Command] init_dvr called");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let state = loop {
        if let Some(state) = app.try_state::<DvrState>() {
            break state.inner().clone();
        }
        if std::time::Instant::now() >= deadline {
            return Err("DVR failed to initialize in time".to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    };

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

    // If the recording is scheduled to start immediately (actual start <= now), trigger it now
    if let Some(schedule) = state.db.get_schedule(id).map_err(|e| e.to_string())? {
        let now = chrono::Utc::now().timestamp();
        if schedule.actual_start() <= now {
            info!("[DVR Command] Triggering instant recording for schedule {}", id);
            crate::dvr::scheduler::start_recording(&state.db, &state.recorder, schedule).await
                .map_err(|e| {
                    error!("[DVR Command] Failed to start instant recording: {}", e);
                    format!("Failed to start instant recording: {}", e)
                })?;
        }
    }

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

/// Update schedule settings including paddings and recurrence
#[tauri::command]
async fn update_schedule_settings(
    state: tauri::State<'_, DvrState>,
    id: i64,
    #[allow(non_snake_case)] startPaddingSec: i64,
    #[allow(non_snake_case)] endPaddingSec: i64,
    recurrence: Option<String>,
) -> Result<(), String> {
    debug!("[DVR Command] Updating settings for schedule {}: start={}, end={}, recurrence={:?}", id, startPaddingSec, endPaddingSec, recurrence);

    state.db.update_schedule_settings(id, startPaddingSec, endPaddingSec, recurrence)
        .map_err(|e| format!("Failed to update schedule settings: {}", e))?;

    debug!("[DVR Command] Schedule {} settings updated successfully", id);
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

/// Update recording program title
#[tauri::command]
async fn update_recording_title(
    state: tauri::State<'_, DvrState>,
    id: i64,
    program_title: String,
) -> Result<(), String> {
    state
        .db
        .update_recording_title(id, &program_title)
        .map_err(|e| format!("Failed to update recording title: {}", e))
}

/// Manual convert recording
#[tauri::command]
async fn convert_recording(
    app: AppHandle,
    state: tauri::State<'_, DvrState>,
    recording_id: i64,
    target_format: String,
) -> Result<(), String> {
    info!("[DVR Command] convert_recording called: id={}, format={}", recording_id, target_format);
    crate::dvr::recorder::convert_recording_to_format(&app, &state.db, recording_id, &target_format)
        .await
        .map_err(|e| format!("Failed to convert recording: {}", e))?;
    info!("[DVR Command] convert_recording completed: id={}", recording_id);
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

/// Bulk upsert channel metadata (resolution, fps, audio layout, quality label)
#[tauri::command]
async fn bulk_upsert_channel_metadata(
    state: tauri::State<'_, DvrState>,
    items: Vec<db_bulk_ops::BulkChannelMetadata>,
) -> Result<db_bulk_ops::BulkResult, String> {
    db_bulk_ops::bulk_upsert_channel_metadata(&state.db, items)
        .map_err(|e| format!("Bulk upsert channel metadata failed: {}", e))
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
    clear_existing: bool,
    user_agent: Option<String>,
) -> Result<epg_streaming::EpgParseResult, String> {
    epg_streaming::stream_parse_epg(app, &state.db, source_id, source_name, epg_url, channel_mappings, advanced_epg_matching, timeshift_hours.unwrap_or(0.0), clear_existing, user_agent)
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
    clear_existing: bool,
) -> Result<epg_streaming::EpgParseResult, String> {
    epg_streaming::parse_epg_file(app, &state.db, source_id, file_path, channel_mappings, advanced_epg_matching, timeshift_hours.unwrap_or(0.0), clear_existing)
        .await
        .map_err(|e| format!("Parse EPG file failed: {}", e))
}

/// Stream parse EPG for multiple sources with a single download
#[tauri::command]
async fn stream_parse_epg_multi(
    app: AppHandle,
    state: tauri::State<'_, DvrState>,
    epg_url: String,
    source_configs: Vec<epg_streaming::SourceEpgConfig>,
    user_agent: Option<String>,
) -> Result<Vec<epg_streaming::EpgParseResult>, String> {
    epg_streaming::stream_parse_epg_multi(app, &state.db, epg_url, source_configs, user_agent)
        .await
        .map_err(|e| format!("Stream parse EPG multi failed: {}", e))
}

/// Sync and save all EPG channels and programs to a separate database cache file
#[tauri::command]
async fn cache_entire_epg_db(
    app: AppHandle,
    epg_url: String,
    epg_link_id: String,
    user_agent: Option<String>,
) -> Result<(), String> {
    epg_streaming::cache_entire_epg_db(app, epg_url, epg_link_id, user_agent)
        .await
        .map_err(|e| format!("Cache entire EPG failed: {}", e))
}

// =============================================================================
// Logo Cache State & Commands
// =============================================================================

pub struct LogoCacheState(pub tokio::sync::Mutex<LogoCacheManager>);

impl LogoCacheState {
    pub fn new(cache_dir: std::path::PathBuf) -> Self {
        Self(tokio::sync::Mutex::new(LogoCacheManager::new(cache_dir)))
    }
}

#[tauri::command]
async fn get_cached_logo_path(
    state: tauri::State<'_, LogoCacheState>,
    url: String,
) -> Result<String, String> {
    let mgr = state.0.lock().await;
    mgr.get_or_cache_logo_data(&url)
        .await
        .map_err(|e| format!("Failed to cache logo: {}", e))
}

#[tauri::command]
async fn get_logo_cache_stats(
    state: tauri::State<'_, LogoCacheState>,
    enabled: bool,
    max_bytes: u64,
    ttl_days: u32,
) -> Result<LogoCacheStats, String> {
    let mgr = state.0.lock().await;
    mgr.get_stats(enabled, max_bytes, ttl_days)
        .await
        .map_err(|e| format!("Failed to get logo cache stats: {}", e))
}

#[tauri::command]
async fn clear_logo_cache(
    state: tauri::State<'_, LogoCacheState>,
) -> Result<(), String> {
    let mgr = state.0.lock().await;
    mgr.clear_cache()
        .await
        .map_err(|e| format!("Failed to clear logo cache: {}", e))
}

#[tauri::command]
async fn prune_logo_cache(
    state: tauri::State<'_, LogoCacheState>,
    max_bytes: u64,
    ttl_days: u32,
) -> Result<(), String> {
    let mgr = state.0.lock().await;
    mgr.prune(max_bytes, ttl_days)
        .await
        .map_err(|e| format!("Failed to prune logo cache: {}", e))
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

// ─── VOD and Stream Downloader ───────────────────────────────────────────────

#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct DownloadRequest {
    id: String,
    title: String,
    url: String,
    save_path: String,
    user_agent: Option<String>,
    duration_secs: Option<u64>,
    resume: Option<bool>,
    extract_subtitles: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
struct DownloadProgressEvent {
    id: String,
    title: String,
    status: String, // "downloading" | "completed" | "failed" | "canceled" | "paused"
    progress: f64,
    bytes_written: u64,
    total_bytes: Option<u64>,
    speed_bytes: u64,
    file_path: String,
    error: Option<String>,
    status_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DownloadControl {
    Cancel,
    Pause,
}

enum DownloadError {
    Canceled { bytes_written: u64, total_bytes: Option<u64>, progress: f64 },
    Paused { bytes_written: u64, total_bytes: Option<u64>, progress: f64 },
    Failed(String),
}

static ACTIVE_DOWNLOADS: once_cell::sync::Lazy<Arc<parking_lot::Mutex<HashMap<String, tokio::sync::watch::Sender<Option<DownloadControl>>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(parking_lot::Mutex::new(HashMap::new())));

#[tauri::command]
async fn cancel_download(id: String) -> Result<(), String> {
    debug!("[Downloader] cancel_download called for id={}", id);
    if let Some(cancel_tx) = ACTIVE_DOWNLOADS.lock().get(&id) {
        let _ = cancel_tx.send(Some(DownloadControl::Cancel));
        Ok(())
    } else {
        Err("Download not found or already finished".to_string())
    }
}

#[tauri::command]
async fn pause_download(id: String) -> Result<(), String> {
    debug!("[Downloader] pause_download called for id={}", id);
    if let Some(cancel_tx) = ACTIVE_DOWNLOADS.lock().get(&id) {
        let _ = cancel_tx.send(Some(DownloadControl::Pause));
        Ok(())
    } else {
        Err("Download not found or already finished".to_string())
    }
}

#[tauri::command]
async fn delete_download_file(path: String) -> Result<(), String> {
    debug!("[Downloader] delete_download_file called for path={}", path);
    let _ = tokio::fs::remove_file(&path).await;
    let _ = tokio::fs::remove_file(format!("{}.ytdl", path)).await;

    // Also clean up HLS temp paths
    let temp_ts = format!("{}.temp.ts", path);
    let _ = tokio::fs::remove_file(&temp_ts).await;
    let _ = tokio::fs::remove_file(format!("{}.ytdl", temp_ts)).await;
    Ok(())
}

/// Probe a transport stream file and return the "start:" time reported by FFmpeg.
/// For HLS-sourced streams downloaded with `--downloader ffmpeg`, this is the absolute
/// HLS programme clock time of the first video frame - the correct value to use as
/// the subtitle timestamp shift so that SRT timecodes line up with normalised video.
///
/// Returns 0.0 when the value cannot be determined.
async fn probe_ts_video_start_secs(ffmpeg_path: &std::path::Path, ts_path: &std::path::Path) -> f64 {
    use tokio::process::Command;

    // Run `ffmpeg -i <file>`; it exits with error but prints stream metadata to stderr.
    let output = Command::new(ffmpeg_path)
        .arg("-i").arg(ts_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;
    let output = match output {
        Ok(o) => o,
        Err(e) => {
            debug!("[PostProcessor] probe_ts_video_start_secs: failed to run ffmpeg: {}", e);
            return 0.0;
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines() {
        if line.contains("Duration:") && line.contains("start:") {
            if let Some(pos) = line.find("start:") {
                let after = line[pos + 6..].trim_start();
                let val_str = after.split(',').next().unwrap_or("").trim();
                if let Ok(secs) = val_str.parse::<f64>() {
                    debug!("[PostProcessor] probe_ts_video_start_secs: start = {:.3}s", secs);
                    return secs;
                }
            }
        }
    }
    debug!("[PostProcessor] probe_ts_video_start_secs: could not parse start time");
    0.0
}

fn ffmpeg_hls_input_args(cmd: &mut tokio::process::Command, user_agent: Option<&str>) {
    let ua = user_agent.unwrap_or("").trim();
    if !ua.is_empty() {
        cmd.arg("-user_agent").arg(ua);
    }
}

fn count_subtitle_streams_from_ffmpeg_stderr(stderr: &str) -> usize {
    stderr
        .lines()
        .filter(|line| line.contains("Stream #") && line.contains("Subtitle:"))
        .count()
}

async fn probe_hls_subtitle_stream_count(
    ffmpeg_path: &std::path::Path,
    source_url: &str,
    user_agent: Option<&str>,
) -> usize {
    use tokio::process::Command;

    let mut cmd = Command::new(ffmpeg_path);
    cmd.arg("-hide_banner");
    ffmpeg_hls_input_args(&mut cmd, user_agent);
    cmd.arg("-i").arg(source_url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    match cmd.output().await {
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let count = count_subtitle_streams_from_ffmpeg_stderr(&stderr);
            debug!("[PostProcessor] HLS probe found {} subtitle stream(s)", count);
            count
        }
        Err(e) => {
            debug!("[PostProcessor] HLS subtitle probe failed: {}", e);
            0
        }
    }
}

async fn probe_file_subtitle_stream_count(
    ffmpeg_path: &std::path::Path,
    path: &std::path::Path,
) -> usize {
    use tokio::process::Command;

    let mut cmd = Command::new(ffmpeg_path);
    cmd.arg("-hide_banner")
        .arg("-i").arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    match cmd.output().await {
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            count_subtitle_streams_from_ffmpeg_stderr(&stderr)
        }
        Err(_) => 0,
    }
}

fn parse_ffmpeg_stderr_line(line: &str) -> (Option<f64>, Option<f64>, Option<u64>) {
    let mut time_secs = None;
    let mut speed_mult = None;
    let mut speed_bytes = None;

    if let Some(pos) = line.find("time=") {
        let after = &line[pos + 5..];
        let token = after.split_whitespace().next().unwrap_or("");
        let parts: Vec<&str> = token.split(':').collect();
        if parts.len() == 3 {
            if let (Ok(h), Ok(m), Ok(s)) = (
                parts[0].parse::<f64>(),
                parts[1].parse::<f64>(),
                parts[2].parse::<f64>(),
            ) {
                time_secs = Some(h * 3600.0 + m * 60.0 + s);
            }
        } else if parts.len() == 1 {
            if let Ok(s) = parts[0].parse::<f64>() {
                time_secs = Some(s);
            }
        }
    }

    if let Some(pos) = line.find("speed=") {
        let after = &line[pos + 6..];
        let token = after.split_whitespace().next().unwrap_or("").trim_end_matches('x');
        if let Ok(sp) = token.parse::<f64>() {
            if sp > 0.0 {
                speed_mult = Some(sp);
            }
        }
    }

    if let Some(pos) = line.find("bitrate=") {
        let after = &line[pos + 8..];
        let token = after.split_whitespace().next().unwrap_or("");
        if token.ends_with("kbits/s") {
            if let Ok(kbps) = token.trim_end_matches("kbits/s").parse::<f64>() {
                speed_bytes = Some((kbps * 1000.0 / 8.0) as u64);
            }
        }
    }

    (time_secs, speed_mult, speed_bytes)
}

async fn extract_hls_subtitle_container(
    app_handle: Option<&tauri::AppHandle>,
    id: Option<&str>,
    title: Option<&str>,
    ffmpeg_path: &std::path::Path,
    source_url: &str,
    user_agent: Option<&str>,
    dest_path: &std::path::Path,
    subtitle_count: usize,
    duration_secs: Option<u64>,
    final_mkv_path: &std::path::Path,
) -> usize {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;

    let mut cmd = Command::new(ffmpeg_path);
    cmd.arg("-hide_banner").arg("-nostdin");
    ffmpeg_hls_input_args(&mut cmd, user_agent);
    cmd.arg("-i").arg(source_url)
        .arg("-map").arg("0:s?")
        .arg("-c:s").arg("srt")
        .arg("-f").arg("matroska")
        .arg("-y").arg(dest_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            debug!("[PostProcessor] HLS subtitle extraction failed to spawn: {}", e);
            return 0;
        }
    };

    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.wait().await;
            return 0;
        }
    };

    let mut reader = tokio::io::BufReader::new(stderr).lines();
    let mut last_emit = std::time::Instant::now();

    while let Ok(Some(line)) = reader.next_line().await {
        if let (Some(app_handle), Some(id), Some(title)) = (app_handle, id, title) {
            if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                last_emit = std::time::Instant::now();

                let (time_secs, speed_mult, speed_bytes) = parse_ffmpeg_stderr_line(&line);
                if time_secs.is_some() || speed_mult.is_some() {
                    let total_dur = duration_secs.unwrap_or(0) as f64;
                    let sub_pct = if total_dur > 0.0 {
                        time_secs.map(|t| (t / total_dur * 100.0).min(100.0)).unwrap_or(0.0)
                    } else {
                        0.0
                    };

                    let progress = 98.0 + (sub_pct * 0.015);

                    let speed_str = if let Some(sp) = speed_mult {
                        format!(" @ {:.1}x speed", sp)
                    } else {
                        "".to_string()
                    };

                    let stream_str = if subtitle_count > 1 {
                        format!(" (Extracting {} subtitle streams{})", subtitle_count, speed_str)
                    } else {
                        format!(" (Extracting 1 subtitle stream{})", speed_str)
                    };

                    let status_text = format!("Video finished downloading. Extracting subtitles{}", stream_str);

                    let event = DownloadProgressEvent {
                        id: id.to_string(),
                        title: title.to_string(),
                        status: "downloading".to_string(),
                        progress,
                        bytes_written: 0,
                        total_bytes: None,
                        speed_bytes: speed_bytes.unwrap_or(0),
                        file_path: final_mkv_path.to_string_lossy().to_string(),
                        error: None,
                        status_text: Some(status_text),
                    };
                    let _ = app_handle.emit("download:event", &event);
                }
            }
        }
    }

    let status = match child.wait().await {
        Ok(s) => s,
        Err(e) => {
            warn!("[PostProcessor] HLS subtitle extraction wait failed: {}", e);
            let _ = tokio::fs::remove_file(dest_path).await;
            return 0;
        }
    };

    if !status.success() {
        warn!("[PostProcessor] HLS subtitle extraction process failed");
        let _ = tokio::fs::remove_file(dest_path).await;
        return 0;
    }

    let count = probe_file_subtitle_stream_count(ffmpeg_path, dest_path).await;
    if count == 0 {
        let _ = tokio::fs::remove_file(dest_path).await;
    }
    debug!("[PostProcessor] Extracted {} HLS subtitle stream(s)", count);
    count
}

async fn post_process_mkv(
    app_handle: tauri::AppHandle,
    id: String,
    title: String,
    temp_ts_path: std::path::PathBuf,
    final_mkv_path: std::path::PathBuf,
    source_url: Option<String>,
    user_agent: Option<String>,
    duration_secs: Option<u64>,
    extract_subtitles: Option<bool>,
) -> Result<(), String> {
    use tokio::process::Command;

    let ffmpeg_path = crate::dvr::recorder::find_ffmpeg(&app_handle)
        .map_err(|e| format!("FFmpeg not found: {}", e))?;

    let parent_dir = temp_ts_path.parent().ok_or("Invalid temp file path")?;
    let ts_filename_str = temp_ts_path
        .file_name()
        .ok_or("Invalid temp filename")?
        .to_string_lossy()
        .to_string();

    let mut subtitle_paths = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(parent_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.is_file() && path != temp_ts_path {
                let filename = path.file_name().unwrap_or_default().to_string_lossy();
                if filename.starts_with(&*ts_filename_str)
                    && filename[ts_filename_str.len()..].starts_with('.')
                {
                    let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
                    if ext == "vtt" || ext == "srt" || ext == "ass" {
                        let file_size = tokio::fs::metadata(&path).await
                            .map(|m| m.len())
                            .unwrap_or(0);
                        if file_size > 0 {
                            subtitle_paths.push(path);
                        }
                    }
                }
            }
        }
    }
    subtitle_paths.sort();

    debug!(
        "[PostProcessor] Found {} subtitle sidecar file(s) for remux into MKV",
        subtitle_paths.len()
    );

    let mut hls_subtitle_container: Option<(std::path::PathBuf, usize)> = None;
    let should_extract = extract_subtitles.unwrap_or(true);
    if should_extract {
        if let Some(source_url) = source_url.as_deref() {
            let hls_subtitle_count = probe_hls_subtitle_stream_count(
                &ffmpeg_path,
                source_url,
                user_agent.as_deref(),
            ).await;

            if hls_subtitle_count > 0 {
                let initial_status_text = format!(
                    "Video finished downloading. Extracting subtitles ({} stream(s) found)...",
                    hls_subtitle_count
                );

                let event = DownloadProgressEvent {
                    id: id.clone(),
                    title: title.clone(),
                    status: "downloading".to_string(),
                    progress: 98.0,
                    bytes_written: 0,
                    total_bytes: None,
                    speed_bytes: 0,
                    file_path: final_mkv_path.to_string_lossy().to_string(),
                    error: None,
                    status_text: Some(initial_status_text),
                };
                let _ = app_handle.emit("download:event", &event);

                let hls_subs_path = temp_ts_path.with_extension("hls-subs.mkv");
                let extracted_count = extract_hls_subtitle_container(
                    Some(&app_handle),
                    Some(&id),
                    Some(&title),
                    &ffmpeg_path,
                    source_url,
                    user_agent.as_deref(),
                    &hls_subs_path,
                    hls_subtitle_count,
                    duration_secs,
                    &final_mkv_path,
                ).await;

                if extracted_count > 0 {
                    debug!(
                        "[PostProcessor] Using FFmpeg-extracted HLS subtitle container with {} stream(s); ignoring yt-dlp subtitle sidecars",
                        extracted_count
                    );
                    hls_subtitle_container = Some((hls_subs_path, extracted_count));
                }
            }
        }
    } else {
        debug!("[PostProcessor] Skipping subtitle extraction per user choice");
    }

    let using_hls_subtitle_container = hls_subtitle_container.is_some();
    let ts_video_start_secs = if !subtitle_paths.is_empty() && !using_hls_subtitle_container {
        probe_ts_video_start_secs(&ffmpeg_path, &temp_ts_path).await
    } else {
        0.0
    };
    let subtitle_offset_secs = if ts_video_start_secs > 2.0 {
        debug!(
            "[PostProcessor] Using .ts probe start ({:.3}s) for subtitle offset",
            ts_video_start_secs
        );
        ts_video_start_secs
    } else {
        if !subtitle_paths.is_empty() && !using_hls_subtitle_container {
            debug!(
                "[PostProcessor] .ts start = {:.3}s; leaving subtitle timestamps unchanged",
                ts_video_start_secs
            );
        }
        0.0
    };
    let apply_offset = subtitle_offset_secs > 2.0;
    if apply_offset {
        debug!(
            "[PostProcessor] HLS subtitle offset: {:.3}s - applying -itsoffset correction",
            subtitle_offset_secs
        );
    }

    let event = DownloadProgressEvent {
        id: id.clone(),
        title: title.clone(),
        status: "downloading".to_string(),
        progress: 99.0,
        bytes_written: 0,
        total_bytes: None,
        speed_bytes: 0,
        file_path: final_mkv_path.to_string_lossy().to_string(),
        error: None,
        status_text: Some("Remuxing into MKV...".to_string()),
    };
    let _ = app_handle.emit("download:event", &event);

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.arg("-i").arg(&temp_ts_path);

    if !using_hls_subtitle_container {
        for sub in &subtitle_paths {
            if apply_offset {
                cmd.arg("-itsoffset").arg(format!("-{:.3}", subtitle_offset_secs));
            }
            cmd.arg("-i").arg(sub);
        }
    }

    let hls_subtitle_input_index = if let Some((path, _)) = hls_subtitle_container.as_ref() {
        let input_index = if using_hls_subtitle_container && !subtitle_paths.is_empty() {
            1
        } else {
            subtitle_paths.len() + 1
        };
        cmd.arg("-i").arg(path);
        Some(input_index)
    } else {
        None
    };

    let map_media_subtitles = subtitle_paths.is_empty() && !using_hls_subtitle_container;
    cmd.arg("-map").arg("0:v?");
    cmd.arg("-map").arg("0:a?");
    if map_media_subtitles {
        cmd.arg("-map").arg("0:s?");
    }

    if !using_hls_subtitle_container {
        for (i, sub) in subtitle_paths.iter().enumerate() {
            cmd.arg("-map").arg(format!("{}", i + 1));

            if let Some(filename) = sub.file_name() {
                let name_str = filename.to_string_lossy();
                let remainder = &name_str[ts_filename_str.len() + 1..];
                let lang_part = remainder.split('.').next().unwrap_or("");
                let lang = lang_part.split('-').next().unwrap_or(lang_part);
                if lang.len() == 2 || lang.len() == 3 {
                    cmd.arg(format!("-metadata:s:s:{}", i))
                       .arg(format!("language={}", lang));
                }
            }
        }
    }

    if let Some(input_index) = hls_subtitle_input_index {
        cmd.arg("-map").arg(format!("{}:s?", input_index));
    }

    cmd.arg("-c:v").arg("copy");
    cmd.arg("-c:a").arg("copy");
    if !subtitle_paths.is_empty() || using_hls_subtitle_container || map_media_subtitles {
        cmd.arg("-c:s").arg("srt");
    }
    cmd.arg("-y").arg(&final_mkv_path);

    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    debug!("[PostProcessor] Running FFmpeg remux command: {:?}", cmd);
    let output = cmd.output().await
        .map_err(|e| format!("Failed to run FFmpeg post-processor: {}", e))?;
    if !output.status.success() {
        let err_msg = String::from_utf8_lossy(&output.stderr);
        error!("[PostProcessor] FFmpeg conversion failed: {}", err_msg);
        return Err(format!("FFmpeg remux failed: {}", err_msg));
    }

    let _ = tokio::fs::remove_file(&temp_ts_path).await;
    for sub in subtitle_paths {
        let _ = tokio::fs::remove_file(&sub).await;
    }

    if let Some((path, _)) = hls_subtitle_container {
        let _ = tokio::fs::remove_file(path).await;
    }

    Ok(())
}

#[tauri::command]
async fn download_media(
    app_handle: tauri::AppHandle,
    request: DownloadRequest,
) -> Result<(), String> {
    debug!("[Downloader] download_media called for title={} to={} resume={:?}", request.title, request.save_path, request.resume);
    let id = request.id.clone();
    let title = request.title.clone();
    let url = request.url.clone();
    let save_path = request.save_path.clone();
    let user_agent = request.user_agent.clone();
    let duration_secs = request.duration_secs;
    let resume = request.resume;

    let extract_subtitles = request.extract_subtitles;

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(None);
    ACTIVE_DOWNLOADS.lock().insert(id.clone(), cancel_tx);

    let app_handle_clone = app_handle.clone();
    
    tokio::spawn(async move {
        // Ensure parent directory exists (e.g. Movies, Series, Recordings subfolders)
        if let Some(parent) = std::path::Path::new(&save_path).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }

        // Use a temporary TS path for HLS-to-MKV so subtitles can be remuxed cleanly.
        let is_hls = url.contains(".m3u8") || url.contains("/mono.m3u8");
        let use_temp_ts = is_hls && save_path.ends_with(".mkv");
        let active_save_path = if use_temp_ts {
            format!("{}.temp.ts", save_path)
        } else {
            save_path.clone()
        };

        let res = do_download(
            app_handle_clone.clone(),
            id.clone(),
            title.clone(),
            url.clone(),
            active_save_path.clone(),
            user_agent.clone(),
            duration_secs,
            resume,
            &mut cancel_rx,
        ).await;

        ACTIVE_DOWNLOADS.lock().remove(&id);

        let final_event = match res {
            Ok(()) => {
                let post_res = if use_temp_ts {
                    post_process_mkv(
                        app_handle_clone.clone(),
                        id.clone(),
                        title.clone(),
                        std::path::PathBuf::from(&active_save_path),
                        std::path::PathBuf::from(&save_path),
                        Some(url.clone()),
                        user_agent.clone(),
                        duration_secs,
                        extract_subtitles,
                    ).await
                } else {
                    Ok(())
                };

                match post_res {
                    Ok(()) => {
                        DownloadProgressEvent {
                            id,
                            title,
                            status: "completed".to_string(),
                            progress: 100.0,
                            bytes_written: 0,
                            total_bytes: None,
                            speed_bytes: 0,
                            file_path: save_path,
                            error: None,
                            status_text: None,
                        }
                    }
                    Err(post_err) => {
                        let _ = tokio::fs::remove_file(&save_path).await;
                        let _ = tokio::fs::remove_file(&active_save_path).await;
                        let _ = tokio::fs::remove_file(format!("{}.ytdl", active_save_path)).await;

                        DownloadProgressEvent {
                            id,
                            title,
                            status: "failed".to_string(),
                            progress: 0.0,
                            bytes_written: 0,
                            total_bytes: None,
                            speed_bytes: 0,
                            file_path: save_path,
                            error: Some(format!("Post-processing failed: {}", post_err)),
                            status_text: None,
                        }
                    }
                }
            }
            Err(DownloadError::Canceled { bytes_written, total_bytes, progress }) => {
                // Try to clean up partial file and sidecar
                let _ = tokio::fs::remove_file(&active_save_path).await;
                let _ = tokio::fs::remove_file(format!("{}.ytdl", active_save_path)).await;

                DownloadProgressEvent {
                    id,
                    title,
                    status: "canceled".to_string(),
                    progress,
                    bytes_written,
                    total_bytes,
                    speed_bytes: 0,
                    file_path: save_path,
                    error: None,
                    status_text: None,
                }
            }
            Err(DownloadError::Paused { bytes_written, total_bytes, progress }) => {
                DownloadProgressEvent {
                    id,
                    title,
                    status: "paused".to_string(),
                    progress,
                    bytes_written,
                    total_bytes,
                    speed_bytes: 0,
                    file_path: save_path,
                    error: None,
                    status_text: None,
                }
            }
            Err(DownloadError::Failed(e)) => {
                // Clean up partial file on failure to avoid corruption
                let _ = tokio::fs::remove_file(&active_save_path).await;
                let _ = tokio::fs::remove_file(format!("{}.ytdl", active_save_path)).await;

                DownloadProgressEvent {
                    id,
                    title,
                    status: "failed".to_string(),
                    progress: 0.0,
                    bytes_written: 0,
                    total_bytes: None,
                    speed_bytes: 0,
                    file_path: save_path,
                    error: Some(e),
                    status_text: None,
                }
            }
        };

        let _ = app_handle_clone.emit("download:event", final_event);
    });

    Ok(())
}

fn parse_ytdlp_line(line: &str) -> (Option<f64>, Option<u64>, Option<u64>) {
    let mut progress = None;
    let mut speed_bytes = None;
    let mut total_bytes = None;

    if let Some(pos) = line.rfind("[download]") {
        let download_part = &line[pos + 10..];
        
        // 1. Parse progress percentage
        if let Some(pct_pos) = download_part.find('%') {
            let pct_part = &download_part[..pct_pos].trim();
            if let Some(num_str) = pct_part.split_whitespace().last() {
                if let Ok(pct) = num_str.parse::<f64>() {
                    progress = Some(pct);
                }
            }
        }

        // 2. Parse total bytes estimate if present (e.g. "of ~ 793.78MiB" or "of 150.00MiB")
        if let Some(of_pos) = download_part.find("of ") {
            let of_part = &download_part[of_pos + 3..];
            let words: Vec<&str> = of_part.split_whitespace().collect();
            let mut val_str = "";
            if !words.is_empty() {
                if words[0] == "~" && words.len() > 1 {
                    val_str = words[1];
                } else {
                    val_str = words[0];
                }
            }
            let clean_val = val_str.trim_start_matches('~').trim();
            
            let multiplier = if clean_val.ends_with("GiB") {
                Some(1024.0 * 1024.0 * 1024.0)
            } else if clean_val.ends_with("MiB") {
                Some(1024.0 * 1024.0)
            } else if clean_val.ends_with("KiB") {
                Some(1024.0)
            } else if clean_val.ends_with("B") {
                Some(1.0)
            } else {
                None
            };

            if let Some(m) = multiplier {
                let num_part = clean_val.trim_end_matches("GiB")
                                         .trim_end_matches("MiB")
                                         .trim_end_matches("KiB")
                                         .trim_end_matches("B")
                                         .trim();
                if let Ok(val) = num_part.parse::<f64>() {
                    total_bytes = Some((val * m) as u64);
                }
            }
        }

        // 3. Parse speed (e.g. "at 4.14MiB/s" or "at 350.00KiB/s")
        if let Some(at_pos) = download_part.find("at ") {
            let at_part = &download_part[at_pos + 3..];
            let val_str = at_part.split_whitespace().next().unwrap_or("").trim();
            
            let multiplier = if val_str.ends_with("GiB/s") {
                Some(1024.0 * 1024.0 * 1024.0)
            } else if val_str.ends_with("MiB/s") {
                Some(1024.0 * 1024.0)
            } else if val_str.ends_with("KiB/s") {
                Some(1024.0)
            } else if val_str.ends_with("B/s") {
                Some(1.0)
            } else {
                None
            };

            if let Some(m) = multiplier {
                let num_part = val_str.trim_end_matches("GiB/s")
                                      .trim_end_matches("MiB/s")
                                      .trim_end_matches("KiB/s")
                                      .trim_end_matches("B/s")
                                      .trim();
                if let Ok(val) = num_part.parse::<f64>() {
                    speed_bytes = Some((val * m) as u64);
                }
            }
        }
    }

    (progress, speed_bytes, total_bytes)
}

async fn do_download(
    app_handle: tauri::AppHandle,
    id: String,
    title: String,
    url: String,
    save_path: String,
    user_agent: Option<String>,
    duration_secs: Option<u64>,
    resume: Option<bool>,
    cancel_rx: &mut tokio::sync::watch::Receiver<Option<DownloadControl>>,
) -> Result<(), DownloadError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    use futures_util::StreamExt;

    let is_hls = url.contains(".m3u8") || url.contains("/mono.m3u8");

    if is_hls {
        if let Some(ytdl_path) = find_ytdl_path() {
            debug!("[Downloader] Using yt-dlp sidecar for HLS download: {}", ytdl_path);
            let mut cmd = tokio::process::Command::new(ytdl_path);
            
            let ua = user_agent.as_deref().unwrap_or("");
            let effective_ua = if ua.trim().is_empty() { "VLC/3.0.18 LibVLC/3.0.18" } else { ua };
            cmd.arg("--user-agent").arg(effective_ua);
            cmd.arg("--newline");
            cmd.arg("--progress");

            // Preserve HLS timestamps/container details; subtitles are extracted
            // from the manifest by the FFmpeg post-processor.
            cmd.arg("--hls-use-mpegts");
            cmd.arg("--no-check-formats");
            cmd.arg("--ignore-errors");
            if let Ok(ffmpeg_path) = crate::dvr::recorder::find_ffmpeg(&app_handle) {
                if let Some(parent) = ffmpeg_path.parent() {
                    cmd.arg("--ffmpeg-location").arg(parent);
                } else {
                    cmd.arg("--ffmpeg-location").arg(&ffmpeg_path);
                }
            }

            cmd.arg("-o").arg(&save_path)
               .arg(&url)
               .stdout(std::process::Stdio::piped())
               .stderr(std::process::Stdio::piped());

            #[cfg(windows)]
            cmd.creation_flags(0x08000000);

            let mut child = cmd.spawn().map_err(|e| DownloadError::Failed(format!("Failed to spawn yt-dlp: {}", e)))?;
            let stdout = child.stdout.take().ok_or_else(|| DownloadError::Failed("Failed to open yt-dlp stdout".to_string()))?;
            let mut reader = tokio::io::BufReader::new(stdout).lines();

            if let Some(stderr) = child.stderr.take() {
                tokio::spawn(async move {
                    let mut err_reader = tokio::io::BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = err_reader.next_line().await {
                        warn!("[yt-dlp stderr] {}", line);
                    }
                });
            }

            let mut last_emit = std::time::Instant::now();
            let mut last_progress = 0.0;
            let mut last_bytes = 0u64;
            let mut last_total = None;

            loop {
                tokio::select! {
                    line_res = reader.next_line() => {
                        match line_res {
                            Ok(Some(line)) => {
                                if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                                    let (progress_pct, speed, total) = parse_ytdlp_line(&line);
                                    
                                    if let Some(progress) = progress_pct {
                                        let written = if let Some(tot) = total {
                                            ((progress / 100.0) * tot as f64) as u64
                                        } else {
                                            0
                                        };
                                        let display_progress = if save_path.ends_with(".temp.ts") {
                                            progress * 0.98
                                        } else {
                                            progress
                                        };
                                        last_progress = progress;
                                        last_bytes = written;
                                        last_total = total;

                                        let event = DownloadProgressEvent {
                                            id: id.clone(),
                                            title: title.clone(),
                                            status: "downloading".to_string(),
                                            progress: display_progress,
                                            bytes_written: written,
                                            total_bytes: total,
                                            speed_bytes: speed.unwrap_or(0),
                                            file_path: save_path.clone(),
                                            error: None,
                                            status_text: None,
                                        };
                                        let _ = app_handle.emit("download:event", event);
                                        last_emit = std::time::Instant::now();
                                    }
                                }
                            }
                            Ok(None) => break,
                            Err(_) => break,
                        }
                    }
                    _ = cancel_rx.changed() => {
                        let ctrl = { *cancel_rx.borrow() };
                        if let Some(c) = ctrl {
                            let _ = child.kill().await;
                            match c {
                                DownloadControl::Cancel => {
                                    return Err(DownloadError::Canceled {
                                        bytes_written: last_bytes,
                                        total_bytes: last_total,
                                        progress: last_progress,
                                    });
                                }
                                DownloadControl::Pause => {
                                    return Err(DownloadError::Paused {
                                        bytes_written: last_bytes,
                                        total_bytes: last_total,
                                        progress: last_progress,
                                    });
                                }
                            }
                        }
                    }
                }
            }

            let status = child.wait().await.map_err(|e| DownloadError::Failed(format!("yt-dlp wait error: {}", e)))?;
            if status.success() {
                return Ok(());
            } else {
                return Err(DownloadError::Failed("yt-dlp process failed".to_string()));
            }
        }

        // Fallback to FFmpeg if yt-dlp is not available
        let ffmpeg_path = match crate::dvr::recorder::find_ffmpeg(&app_handle) {
            Ok(p) => p,
            Err(e) => return Err(DownloadError::Failed(format!("FFmpeg not found: {}", e))),
        };

        let mut cmd = tokio::process::Command::new(ffmpeg_path);
        
        let ua = user_agent.as_deref().unwrap_or("");
        let effective_ua = if ua.trim().is_empty() { "VLC/3.0.18 LibVLC/3.0.18" } else { ua };
        cmd.arg("-user_agent").arg(effective_ua);
        cmd.arg("-stats");

        cmd.arg("-i").arg(&url)
           .arg("-c").arg("copy")
           .arg("-y")
           .arg(&save_path)
           .stdout(std::process::Stdio::piped())
           .stderr(std::process::Stdio::piped());

        #[cfg(windows)]
        cmd.creation_flags(0x08000000);

        let mut child = cmd.spawn().map_err(|e| DownloadError::Failed(format!("Failed to spawn FFmpeg: {}", e)))?;
        let stderr = child.stderr.take().ok_or_else(|| DownloadError::Failed("Failed to open FFmpeg stderr".to_string()))?;
        let mut reader = tokio::io::BufReader::new(stderr).lines();

        let start_time = std::time::Instant::now();
        let mut last_emit = std::time::Instant::now();
        let mut resolved_duration_secs = duration_secs;
        let mut last_progress = 0.0;
        let mut last_bytes = 0u64;

        loop {
            tokio::select! {
                line_res = reader.next_line() => {
                    match line_res {
                        Ok(Some(line)) => {
                            // Try to parse "Duration: hh:mm:ss" if we don't have a duration yet
                            if resolved_duration_secs.is_none() || resolved_duration_secs == Some(0) {
                                if let Some(pos) = line.find("Duration: ") {
                                    let dur_part = &line[pos + 10..];
                                    let val_str = dur_part.split(',').next().unwrap_or("").trim();
                                    let parts: Vec<&str> = val_str.split(':').collect();
                                    if parts.len() == 3 {
                                        if let (Ok(h), Ok(m), Ok(s)) = (
                                            parts[0].parse::<f64>(),
                                            parts[1].parse::<f64>(),
                                            parts[2].parse::<f64>(),
                                        ) {
                                            let total_secs = h * 3600.0 + m * 60.0 + s;
                                            if total_secs > 0.0 {
                                                resolved_duration_secs = Some(total_secs as u64);
                                                debug!("[Downloader] Parsed duration from FFmpeg: {}s", total_secs);
                                            }
                                        }
                                    }
                                }
                            }

                            if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                                let (secs, size_bytes) = parse_ffmpeg_line(&line);
                                
                                let progress = if let (Some(s), Some(dur)) = (secs, resolved_duration_secs) {
                                    if dur > 0 {
                                        ((s / dur as f64) * 100.0).min(100.0).max(0.0)
                                    } else {
                                        0.0
                                    }
                                } else {
                                    0.0
                                };

                                let speed_bytes = if start_time.elapsed().as_secs_f64() > 0.0 {
                                    (size_bytes.unwrap_or(0) as f64 / start_time.elapsed().as_secs_f64()) as u64
                                } else {
                                    0
                                };

                                 let display_progress = if save_path.ends_with(".temp.ts") {
                                    progress * 0.98
                                } else {
                                    progress
                                };
                                last_progress = progress;
                                last_bytes = size_bytes.unwrap_or(0);

                                let event = DownloadProgressEvent {
                                    id: id.clone(),
                                    title: title.clone(),
                                    status: "downloading".to_string(),
                                    progress: display_progress,
                                    bytes_written: size_bytes.unwrap_or(0),
                                    total_bytes: None,
                                    speed_bytes,
                                    file_path: save_path.clone(),
                                    error: None,
                                    status_text: None,
                                };
                                let _ = app_handle.emit("download:event", event);
                                last_emit = std::time::Instant::now();
                            }
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    let ctrl = { *cancel_rx.borrow() };
                    if let Some(c) = ctrl {
                        let _ = child.kill().await;
                        match c {
                            DownloadControl::Cancel => {
                                return Err(DownloadError::Canceled {
                                    bytes_written: last_bytes,
                                    total_bytes: None,
                                    progress: last_progress,
                                });
                            }
                            DownloadControl::Pause => {
                                return Err(DownloadError::Paused {
                                    bytes_written: last_bytes,
                                    total_bytes: None,
                                    progress: last_progress,
                                });
                            }
                        }
                    }
                }
            }
        }

        let status = child.wait().await.map_err(|e| DownloadError::Failed(format!("FFmpeg wait error: {}", e)))?;
        if status.success() {
            Ok(())
        } else {
            Err(DownloadError::Failed("FFmpeg process failed".to_string()))
        }
    } else {
        let ua = user_agent.unwrap_or_else(|| "VLC/3.0.18 LibVLC/3.0.18".to_string());
        let client = reqwest::Client::builder()
            .user_agent(ua)
            .build()
            .map_err(|e| DownloadError::Failed(format!("Failed to build client: {}", e)))?;

        let mut req = client.get(&url);

        let mut file_exists = false;
        let mut bytes_written = 0u64;
        let mut open_options = tokio::fs::OpenOptions::new();

        if resume == Some(true) {
            if let Ok(metadata) = tokio::fs::metadata(&save_path).await {
                if metadata.is_file() {
                    let file_len = metadata.len();
                    if file_len > 0 {
                        bytes_written = file_len;
                        file_exists = true;
                    }
                }
            }
        }

        if file_exists {
            req = req.header(reqwest::header::RANGE, format!("bytes={}-", bytes_written));
            open_options.write(true).append(true);
        } else {
            if let Some(parent) = std::path::Path::new(&save_path).parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            open_options.write(true).create(true).truncate(true);
        }

        let res = req.send().await.map_err(|e| DownloadError::Failed(format!("HTTP request failed: {}", e)))?;
        if !res.status().is_success() {
            return Err(DownloadError::Failed(format!("Server returned HTTP status {}", res.status())));
        }

        let is_partial = res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        if !is_partial && file_exists {
            // Server did not support range or returned full content, reset to start
            bytes_written = 0;
            open_options = tokio::fs::OpenOptions::new();
            open_options.write(true).create(true).truncate(true);
        }

        let mut file = open_options.open(&save_path).await.map_err(|e| DownloadError::Failed(format!("Failed to open output file: {}", e)))?;

        let total_bytes = if is_partial {
            res.content_length().map(|len| len + bytes_written)
        } else {
            res.content_length()
        };

        let mut stream = res.bytes_stream();

        let mut last_emit = std::time::Instant::now();
        let mut last_bytes = bytes_written;
        let mut last_progress = if let Some(total) = total_bytes {
            if total > 0 {
                ((bytes_written as f64 / total as f64) * 100.0).min(100.0).max(0.0)
            } else {
                0.0
            }
        } else {
            0.0
        };

        loop {
            tokio::select! {
                item_opt = stream.next() => {
                    match item_opt {
                        Some(item) => {
                            let chunk = item.map_err(|e| DownloadError::Failed(format!("Network error: {}", e)))?;
                            file.write_all(&chunk).await.map_err(|e| DownloadError::Failed(format!("Write failed: {}", e)))?;
                            bytes_written += chunk.len() as u64;

                            if last_emit.elapsed() >= std::time::Duration::from_millis(500) {
                                let elapsed = last_emit.elapsed().as_secs_f64();
                                let speed = if elapsed > 0.0 {
                                    ((bytes_written - last_bytes) as f64 / elapsed) as u64
                                } else {
                                    0
                                };
                                last_emit = std::time::Instant::now();
                                last_bytes = bytes_written;

                                let progress = if let Some(total) = total_bytes {
                                    if total > 0 {
                                        ((bytes_written as f64 / total as f64) * 100.0).min(100.0).max(0.0)
                                    } else {
                                        0.0
                                    }
                                } else {
                                    0.0
                                };
                                let display_progress = if save_path.ends_with(".temp.ts") {
                                    progress * 0.98
                                } else {
                                    progress
                                };
                                last_progress = progress;

                                let event = DownloadProgressEvent {
                                    id: id.clone(),
                                    title: title.clone(),
                                    status: "downloading".to_string(),
                                    progress: display_progress,
                                    bytes_written,
                                    total_bytes,
                                    speed_bytes: speed,
                                    file_path: save_path.clone(),
                                    error: None,
                                    status_text: None,
                                };
                                let _ = app_handle.emit("download:event", event);
                            }
                        }
                        None => break,
                    }
                }
                _ = cancel_rx.changed() => {
                    let ctrl = { *cancel_rx.borrow() };
                    if let Some(c) = ctrl {
                        match c {
                            DownloadControl::Cancel => {
                                return Err(DownloadError::Canceled {
                                    bytes_written,
                                    total_bytes,
                                    progress: last_progress,
                                });
                            }
                            DownloadControl::Pause => {
                                return Err(DownloadError::Paused {
                                    bytes_written,
                                    total_bytes,
                                    progress: last_progress,
                                });
                            }
                        }
                    }
                }
            }
        }

        file.flush().await.map_err(|e| DownloadError::Failed(e.to_string()))?;
        Ok(())
    }
}

fn parse_ffmpeg_line(line: &str) -> (Option<f64>, Option<u64>) {
    let mut secs = None;
    let mut size_bytes = None;
    
    if let Some(pos) = line.rfind("time=") {
        let time_part = &line[pos + 5..];
        let val_str = time_part.split_whitespace().next().unwrap_or("");
        let parts: Vec<&str> = val_str.split(':').collect();
        if parts.len() == 3 {
            if let (Ok(h), Ok(m), Ok(s)) = (
                parts[0].parse::<f64>(),
                parts[1].parse::<f64>(),
                parts[2].parse::<f64>(),
            ) {
                secs = Some(h * 3600.0 + m * 60.0 + s);
            }
        }
    }
    
    if let Some(pos) = line.rfind("size=") {
        let size_part = &line[pos + 5..];
        let val_str = size_part.split_whitespace().next().unwrap_or("");
        let clean_val: String = val_str.chars().filter(|c| c.is_ascii_digit()).collect();
        if let Ok(kb) = clean_val.parse::<u64>() {
            size_bytes = Some(kb * 1024);
        }
    }
    
    (secs, size_bytes)
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    debug!("[Open URL] Opening external URL: {}", url);
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn spawn_external_player(player_path: String, url: String) -> Result<(), String> {
    debug!(
        "[ExternalPlayer] Spawning: {} with URL: {}",
        player_path, url
    );
    let child = std::process::Command::new(&player_path)
        .arg(&url)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to launch external player '{}': {}",
                player_path, e
            )
        })?;
    debug!("[ExternalPlayer] Spawned PID: {}", child.id());
    Ok(())
}

#[tauri::command]
async fn kill_external_player(state: tauri::State<'_, ExternalPlayerState>) -> Result<(), String> {
    let mut pid_guard = state.pid.lock().map_err(|e| e.to_string())?;
    if let Some(pid) = pid_guard.take() {
        debug!("[ExternalPlayer] Killing previous instance PID: {}", pid);
        #[cfg(target_os = "windows")]
        {
            let kill_cmd = format!("taskkill /F /PID {}", pid);
            if let Err(e) = std::process::Command::new("cmd")
                .args(&["/C", &kill_cmd])
                .output()
            {
                warn!("[ExternalPlayer] Failed to kill PID {}: {}", pid, e);
            } else {
                debug!("[ExternalPlayer] Killed PID: {}", pid);
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Err(e) = std::process::Command::new("kill")
                .arg(&pid.to_string())
                .output()
            {
                warn!("[ExternalPlayer] Failed to kill PID {}: {}", pid, e);
            } else {
                debug!("[ExternalPlayer] Killed PID: {}", pid);
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn spawn_external_player_reuse(
    state: tauri::State<'_, ExternalPlayerState>,
    player_path: String,
    url: String,
) -> Result<(), String> {
    debug!(
        "[ExternalPlayer] Spawning (reuse): {} with URL: {}",
        player_path, url
    );

    // Kill previous instance if any
    let mut pid_guard = state.pid.lock().map_err(|e| e.to_string())?;
    if let Some(old_pid) = *pid_guard {
        debug!("[ExternalPlayer] Killing previous instance PID: {}", old_pid);
        #[cfg(target_os = "windows")]
        {
            let kill_cmd = format!("taskkill /F /PID {}", old_pid);
            let _ = std::process::Command::new("cmd")
                .args(&["/C", &kill_cmd])
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("kill")
                .arg(&old_pid.to_string())
                .output();
        }
    }

    // Spawn new instance
    let child = std::process::Command::new(&player_path)
        .arg(&url)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to launch external player '{}': {}",
                player_path, e
            )
        })?;
    let new_pid = child.id();
    debug!("[ExternalPlayer] Spawned PID: {}", new_pid);
    *pid_guard = Some(new_pid);
    Ok(())
}

#[tauri::command]
async fn spawn_external_player_with_args(
    player_path: String,
    args: Vec<String>,
) -> Result<(), String> {
    debug!(
        "[ExternalPlayer] Spawning: {} with args: {:?}",
        player_path, args
    );
    let child = std::process::Command::new(&player_path)
        .args(&args)
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to launch external player '{}': {}",
                player_path, e
            )
        })?;
    debug!("[ExternalPlayer] Spawned PID: {}", child.id());
    Ok(())
}

// =============================================================================
// Window State Persistence
// =============================================================================

#[derive(Default)]
struct WindowStateTracker {
    last_unmaximized: std::sync::Mutex<Option<WindowState>>,
    last_non_fullscreen_maximized: std::sync::Mutex<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
}

/// Windows reports a minimized window with a sentinel off-screen position
/// (commonly -32000,-32000). Never persist or restore those coordinates.
fn is_valid_saved_window_position(x: i32, y: i32) -> bool {
    x > -10_000 && y > -10_000
}

fn window_state_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("window_state.json"))
}

pub(crate) fn save_window_state<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let is_fullscreen = window.is_fullscreen().unwrap_or(false);
        let is_maximized = if is_fullscreen {
            let tracker = app.state::<WindowStateTracker>();
            tracker.last_non_fullscreen_maximized.lock().map(|g| *g).unwrap_or(false)
        } else {
            window.is_maximized().unwrap_or(false)
        };
        
        let dont_save_size = should_skip_saving_window_size(app);

        let mut saved_width = 0;
        let mut saved_height = 0;
        let mut saved_x = 0;
        let mut saved_y = 0;

        if is_maximized || is_fullscreen {
            // Find the unmaximized dimensions to save
            let mut unmaximized_state = None;
            let tracker = app.state::<WindowStateTracker>();
            if let Ok(guard) = tracker.last_unmaximized.lock() {
                unmaximized_state = guard.clone();
            }
            if unmaximized_state.is_none() {
                if let Some(path) = window_state_path(app) {
                    if let Ok(json) = std::fs::read_to_string(&path) {
                        if let Ok(state) = serde_json::from_str::<WindowState>(&json) {
                            unmaximized_state = Some(state);
                        }
                    }
                }
            }

            if let Some(state) = unmaximized_state.filter(|state| {
                state.width >= 400
                    && state.height >= 300
                    && is_valid_saved_window_position(state.x, state.y)
            }) {
                saved_width = if dont_save_size { 0 } else { state.width };
                saved_height = if dont_save_size { 0 } else { state.height };
                saved_x = state.x;
                saved_y = state.y;
            } else {
                // Fallback to current size/pos
                if let (Ok(physical_size), Ok(pos)) = (window.inner_size(), window.outer_position()) {
                    let scale_factor = window.scale_factor().unwrap_or(1.0);
                    let logical_size = physical_size.to_logical::<f64>(scale_factor);
                    if !is_valid_saved_window_position(pos.x, pos.y) {
                        warn!("[WindowState] Ignoring invalid restored position: ({}, {})", pos.x, pos.y);
                        return;
                    }
                    saved_width = if dont_save_size { 0 } else { logical_size.width.round() as u32 };
                    saved_height = if dont_save_size { 0 } else { logical_size.height.round() as u32 };
                    saved_x = pos.x;
                    saved_y = pos.y;
                }
            }
        } else {
            // Normal (unmaximized) state
            if let (Ok(physical_size), Ok(pos)) = (window.inner_size(), window.outer_position()) {
                let scale_factor = window.scale_factor().unwrap_or(1.0);
                let logical_size = physical_size.to_logical::<f64>(scale_factor);
                
                // Sanity-check: ignore absurd values (minimised, off-screen, etc.)
                if physical_size.width < 400
                    || physical_size.height < 300
                    || !is_valid_saved_window_position(pos.x, pos.y)
                {
                    return;
                }

                saved_width = if dont_save_size { 0 } else { logical_size.width.round() as u32 };
                saved_height = if dont_save_size { 0 } else { logical_size.height.round() as u32 };
                saved_x = pos.x;
                saved_y = pos.y;
            } else {
                return;
            }
        }

        let state = WindowState {
            width: saved_width,
            height: saved_height,
            x: saved_x,
            y: saved_y,
            maximized: is_maximized,
            fullscreen: is_fullscreen,
        };

        if let Some(path) = window_state_path(app) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(json) = serde_json::to_string(&state) {
                let _ = std::fs::write(&path, json);
            }
        }

        // Also update the startupWidth/startupHeight in tauri-plugin-store
        if !dont_save_size {
            let store_width = if is_maximized || is_fullscreen {
                if saved_width > 0 { saved_width } else { 1920 }
            } else {
                saved_width
            };
            let store_height = if is_maximized || is_fullscreen {
                if saved_height > 0 { saved_height } else { 1080 }
            } else {
                saved_height
            };
            update_startup_size_in_store(app, store_width, store_height);
        }
    }
}

/// Check if the user has disabled saving window size on close
fn should_skip_saving_window_size<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
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
fn update_startup_size_in_store<R: tauri::Runtime>(app: &tauri::AppHandle<R>, width: u32, height: u32) {
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
fn fallback_update_store_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>, width: u32, height: u32) {
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
                    if state.maximized {
                        let _ = window.maximize();
                    }
                    if state.fullscreen {
                        let _ = window.set_fullscreen(true);
                    }
                    debug!("[WindowState] Restored: {}x{} logical at ({}, {}) (maximized: {}, fullscreen: {})",
                        state.width, state.height, state.x, state.y, state.maximized, state.fullscreen);
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
                    let valid_position = is_valid_saved_window_position(state.x, state.y);
                    let valid_size = state.width >= 400 && state.height >= 300;

                    let scale_factor = window.scale_factor().unwrap_or(1.0);
                    let monitor = window.current_monitor().ok().flatten();
                    let monitor_str = monitor
                        .map(|m| format!("{}x{}", m.size().width, m.size().height))
                        .unwrap_or_else(|| "unknown".to_string());

                    info!(
                        "[WindowState Diagnostics] SavedState: {}x{} at ({}, {}) | Maximized: {}, Fullscreen: {} | Monitor: {} | ScaleFactor: {} | Valid: {}",
                        state.width, state.height, state.x, state.y, state.maximized, state.fullscreen, monitor_str, scale_factor, valid_position && valid_size
                    );

                    // Position and size are restored independently: a state saved with
                    // dontSaveWindowSizeOnClose has width/height 0 but still carries a
                    // valid position and fullscreen/maximized flags, and those must
                    // not be discarded together.
                    if !valid_position {
                        // Recover from a state captured while Windows had the window
                        // minimized (sentinel -32000,-32000) instead of replaying the
                        // bad position on every launch. Base the replacement on the
                        // current (already visible) window geometry and never write a
                        // hardcoded 0,0 — a zeroed position makes the restore below
                        // permanently skip position restoration.
                        warn!(
                            "[WindowState] Discarding invalid saved position: ({}, {})",
                            state.x, state.y
                        );
                        let (cur_width, cur_height, cur_x, cur_y) = match (
                            window.inner_size(),
                            window.outer_position(),
                        ) {
                            (Ok(physical_size), Ok(pos)) => {
                                let sf = window.scale_factor().unwrap_or(1.0);
                                let logical = physical_size.to_logical::<f64>(sf);
                                (logical.width.round() as u32, logical.height.round() as u32, pos.x, pos.y)
                            }
                            _ => (state.width.max(400), state.height.max(300), state.x, state.y),
                        };
                        let recovered = WindowState {
                            width: cur_width.max(400),
                            height: cur_height.max(300),
                            x: if is_valid_saved_window_position(cur_x, cur_y) { cur_x } else { 0 },
                            y: if is_valid_saved_window_position(cur_x, cur_y) { cur_y } else { 0 },
                            maximized: false,
                            fullscreen: false,
                        };
                        if let Ok(recovered_json) = serde_json::to_string(&recovered) {
                            let _ = std::fs::write(&path, recovered_json);
                        }
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                        return;
                    }

                    // Apply position whenever a valid one was saved (0,0 is skipped so
                    // first-run windows keep the OS default placement).
                    if state.x != 0 || state.y != 0 {
                        let _ = window.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition { x: state.x, y: state.y }
                        ));
                        debug!("[WindowState] Restored position: ({}, {})", state.x, state.y);
                    }
                    // Apply the saved size only when we actually have one (0x0 when
                    // dontSaveWindowSizeOnClose is on) and only when we are going to
                    // maximize/fullscreen, so the OS records the correct restored
                    // (unmaximized) geometry before the mode switch.
                    if valid_size && (state.maximized || state.fullscreen) && state.width != 0 && state.height != 0 {
                        let _ = window.set_size(tauri::Size::Logical(
                            tauri::LogicalSize { width: state.width as f64, height: state.height as f64 }
                        ));
                    }
                    if state.maximized {
                        let _ = window.maximize();
                        debug!("[WindowState] Restored maximized state");
                    }
                    if state.fullscreen {
                        let _ = window.set_fullscreen(true);
                        debug!("[WindowState] Restored fullscreen state");
                    }
                    let _ = window.unminimize();
                    let _ = window.show();
                }
            }
        }
    }
}

/// Last known windowed (non-fullscreen, non-maximized) geometry to restore after
/// exiting fullscreen: the tracker capture first, falling back to the persisted
/// state (the geometry restore_window_position applied at startup).
fn last_windowed_geometry<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<WindowState> {
    let tracker = app.state::<WindowStateTracker>();
    if let Ok(guard) = tracker.last_unmaximized.lock() {
        if let Some(state) = guard.clone() {
            if state.width >= 400
                && state.height >= 300
                && is_valid_saved_window_position(state.x, state.y)
            {
                return Some(state);
            }
        }
    }
    if let Some(path) = window_state_path(app) {
        if let Ok(json) = std::fs::read_to_string(&path) {
            if let Ok(state) = serde_json::from_str::<WindowState>(&json) {
                if state.width >= 400
                    && state.height >= 300
                    && is_valid_saved_window_position(state.x, state.y)
                {
                    return Some(state);
                }
            }
        }
    }
    None
}

// =============================================================================
// App Entry Point
// =============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ─── External Player State (for reuse / single-instance mode) ────────────────

pub struct ExternalPlayerState {
    pub pid: Mutex<Option<u32>>,
}

impl ExternalPlayerState {
    pub fn new() -> Self {
        ExternalPlayerState {
            pid: Mutex::new(None),
        }
    }
}

// ─── App Entry Point ─────────────────────────────────────────────────────────

pub fn run() {
    #[cfg(target_os = "windows")]
    {
        let mut enable_hw_accel = true;
        if let Some(data_dir) = dirs::data_dir() {
            let store_path = data_dir.join("com.ynotv.app").join(".settings.dat");
            if let Ok(contents) = std::fs::read_to_string(&store_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&contents) {
                    if let Some(settings) = val.get("settings") {
                        if let Some(hw) = settings.get("hardwareAcceleration").and_then(|v| v.as_bool()) {
                            enable_hw_accel = hw;
                        }
                    } else if let Some(hw) = val.get("hardwareAcceleration").and_then(|v| v.as_bool()) {
                        enable_hw_accel = hw;
                    }
                }
            }
        }

        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let target_flags = if enable_hw_accel {
            "--ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy"
        } else {
            "--disable-gpu --disable-gpu-compositing"
        };

        if !existing.contains("--ignore-gpu-blocklist") && !existing.contains("--disable-gpu") {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("{} {}", existing, target_flags).trim(),
            );
        }
    }

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
            .level_for("rustls", log::LevelFilter::Info)
            .level_for("h2", log::LevelFilter::Info)
            .level_for("hyper", log::LevelFilter::Info)
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
        .manage(audio_capture::AudioCaptureState::new())
        .manage(std::sync::Arc::new(cast::CastManager::new()))
        .setup(|app| {
            app.manage(WindowStateTracker::default());

            // Show the main window immediately and restore its saved position
            // BEFORE any potentially slow initialization (DVR database open /
            // WAL recovery) runs. The window is transparent, so until React
            // paints it has no visible content - making it visible early means
            // a slow startup shows the boot splash instead of "no window".
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // Restore saved window position only (not size - size is controlled by UI settings)
            // Position is restored so the window opens in the same place it was closed
            restore_window_position(app.handle());

            // Apply SOCKS5 proxy settings if configured
            apply_proxy_settings(app.handle());

            // Register secondary MPV state (Windows only)
            #[cfg(target_os = "windows")]
            app.manage(SecondaryMpvState::new());

            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let hwnd = window.hwnd().map_err(|e| e.to_string())?;
                resize_coalescing::install(windows::Win32::Foundation::HWND(hwnd.0))?;
            }

            // Configure macOS window for proper dragging with transparent titlebar
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
                    info!("[macOS] Window configured with Overlay title bar style");
                }
            }

            // Initialize DVR system in the background instead of blocking the
            // main thread with block_on. Opening the SQLite database (and
            // recovering a large WAL after a force-close) can take a while on a
            // big app.db; doing it off the main thread lets the window paint
            // and the frontend load immediately. State is managed once ready -
            // commands that need DVR wait for it (see init_dvr).
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

            tauri::async_runtime::spawn(async move {
                info!("[DVR Setup] Starting DVR initialization...");
                match DvrState::new(app_handle.clone()).await {
                    Ok(dvr_state) => {
                        info!("[DVR Setup] System initialized successfully, managing state...");
                        app_handle.manage(dvr_state);
                        info!("[DVR Setup] State managed successfully");
                    }
                    Err(e) => {
                        error!("[DVR Setup] WARNING: Failed to initialize full DVR: {}", e);
                        error!("[DVR Setup] DVR features (recording) will be unavailable.");
                        error!("[DVR Setup] Bulk sync operations may also be affected.");
                    }
                }
            });

            // Register PopoutMpvState for standalone popout player
            app.manage(PopoutMpvState::new());

            // Register ExternalPlayerState for single-instance reuse
            app.manage(ExternalPlayerState::new());

            // Set up the system tray + minimize-to-tray flag (desktop only)
            #[cfg(desktop)]
            if let Err(e) = tray::setup(app.handle()) {
                error!("[Tray] Failed to set up system tray: {}", e);
            }

            // Register the logo cache as managed state so it's shared across all
            // logo cache commands instead of being re-created each call.
            match app.path().app_cache_dir() {
                Ok(cache_dir) => {
                    app.manage(LogoCacheState::new(cache_dir.join("logo_cache")));
                    info!("[LogoCache] Logo cache state initialized");
                }
                Err(e) => {
                    error!("[LogoCache] Failed to get cache dir for LogoCacheState: {}", e);
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

            // Register Discord Rich Presence State
            app.manage(discord_rp::DiscordState::new());

            let discord_handle = app.handle().clone();
            std::thread::spawn(move || discord_rp::run_loop(discord_handle));

            // Note: Window size is applied by the frontend after settings are loaded
            // to ensure the user-defined startupWidth/startupHeight from Settings -> UI is respected
            // (window position was already restored at the top of setup)

            Ok(())
        })
        // Save window size/position when the window is about to close,
        // and track the last unmaximized size/position.
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // If minimize-to-tray is enabled, hide instead of closing so
                    // playback/recordings can keep running in the background.
                    #[cfg(desktop)]
                    if tray::minimize_to_tray_enabled(&window.app_handle()) {
                        api.prevent_close();
                        let _ = window.hide();
                        return;
                    }
                    discord_rp::shutdown(&window.app_handle());
                    save_window_state(&window.app_handle());
                    // Flush the WAL so the next launch doesn't have to recover a
                    // potentially huge WAL left behind by a large database.
                    checkpoint_databases(&window.app_handle());
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    if !window.is_fullscreen().unwrap_or(false) {
                        let maximized = window.is_maximized().unwrap_or(false);
                        let tracker = window.state::<WindowStateTracker>();
                        if let Ok(mut guard) = tracker.last_non_fullscreen_maximized.lock() {
                            *guard = maximized;
                        }

                        if !maximized {
                            if let (Ok(physical_size), Ok(pos)) = (window.inner_size(), window.outer_position()) {
                                let scale_factor = window.scale_factor().unwrap_or(1.0);
                                let logical_size = physical_size.to_logical::<f64>(scale_factor);
                                if physical_size.width >= 400
                                    && physical_size.height >= 300
                                    && is_valid_saved_window_position(pos.x, pos.y)
                                {
                                    let tracker = window.state::<WindowStateTracker>();
                                    let guard = tracker.last_unmaximized.lock();
                                    if let Ok(mut g) = guard {
                                        *g = Some(WindowState {
                                            width: logical_size.width.round() as u32,
                                            height: logical_size.height.round() as u32,
                                            x: pos.x,
                                            y: pos.y,
                                            maximized: false,
                                            fullscreen: false,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
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
            mpv_add_subtitle,
            mpv_remove_subtitle,
            mpv_get_log,
            mpv_set_verbose_logging,
            mpv_set_property,
            mpv_set_properties,
            mpv_get_property,
            set_pip_aspect_lock,
            mpv_sync_window,
            mpv_set_geometry,
            mpv_kill,
            mpv_get_cache_debug,
            mpv_get_params_debug,
            // Multiview secondary MPV commands
            multiview_load_slot,
            multiview_stop_slot,
            multiview_set_property_slot,
            multiview_reposition_slot,
            multiview_kill_slot,
            multiview_kill_all,
            // Popout MPV commands
            popout_open,
            popout_load,
            popout_stop,
            popout_close,
            popout_set_property,
            popout_set_always_on_top,
            popout_is_running,
            popout_toggle_pause,
            popout_toggle_fullscreen,
            popout_seek,
            popout_get_params_debug,
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
            bulk_upsert_channel_metadata,
            // Stream probe commands
            stream_probe::start_channel_probe,
            stream_probe::pause_channel_probe,
            stream_probe::resume_channel_probe,
            stream_probe::cancel_channel_probe,
            stream_probe::probe_single_stream,
            stream_probe::check_probe_ffmpeg_status,
            health_check,
            download_media,
            cancel_download,
            pause_download,
            delete_download_file,
            // Streaming EPG commands
            stream_parse_epg,
            stream_parse_epg_multi,
            parse_epg_file,
            cache_entire_epg_db,
            // DVR commands
            init_dvr,
            schedule_recording,
            cancel_recording,
            get_active_recordings,
            get_recording_thumbnail,
            update_schedule_settings,
            check_schedule_conflicts,
            update_playing_stream,
            update_dvr_stream_url,
            update_recording_title,
            convert_recording,
            open_file_location,
            open_log_folder,
            // Tray / minimize-to-tray commands
            tray::set_minimize_to_tray,
            // TVMaze / TV Calendar commands
            search_tvmaze,
            add_tv_favorite,
            remove_tv_favorite,
            get_tracked_shows,
            get_calendar_episodes,
            sync_tvmaze_shows,
            get_show_details_with_episodes,
            set_show_channel,
            get_episode_details,
            update_show_watchlist_settings,
            get_show_watchlist_settings,
            add_show_episodes_to_watchlist,
            clear_show_watchlist_tracking,
            // Utility commands
            open_external_url,
            spawn_external_player,
            spawn_external_player_reuse,
            kill_external_player,
            spawn_external_player_with_args,
            // Google Cast commands
            cast_start_discovery,
            cast_stop_discovery,
            cast_get_devices,
            cast_connect,
            cast_disconnect,
            cast_load_media,
            cast_play,
            cast_pause,
            cast_seek,
            cast_set_volume,
            cast_toggle_mute,
            cast_resolve_url,
            cast_stop,
            update_proxy_settings,
            test_proxy_connection,
            // OpenSubtitles Secure Credential commands
            save_opensubtitles_credentials,
            get_opensubtitles_credentials,
            delete_opensubtitles_credentials,
            // Discord Rich Presence commands
            discord_rp::discord_set_presence,
            discord_rp::discord_clear,
            discord_rp::discord_set_enabled,
            // Logo Cache commands
            get_cached_logo_path,
            get_logo_cache_stats,
            clear_logo_cache,
            prune_logo_cache,
            // Database health / recovery
            db_health,
            // Local folder scanner
            local_lib::scan_local_folder
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            use tauri::RunEvent;
            match event {
                RunEvent::ExitRequested { api, .. } => {
                    handle_exit_requested(app_handle, api);
                }
                _ => {}
            }
        });
}

/// Flush the SQLite WAL back into ynotv.db on a clean close/exit.
///
/// Without this, a large database that was force-closed mid-sync leaves a
/// multi-GB WAL that must be recovered on the next launch, blocking the first
/// queries and leaving the (transparent) window blank during startup.
fn checkpoint_databases(app: &tauri::AppHandle) {
    if let Some(dvr) = app.try_state::<DvrState>() {
        if let Err(e) = dvr.db.checkpoint() {
            warn!("[DB] WAL checkpoint on close failed: {}", e);
        }
    }
}

// ============================================================================
// Database Health / Recovery
// ============================================================================

#[derive(Debug, Serialize)]
struct DbHealth {
    /// Size of ynotv.db in bytes (0 if it doesn't exist yet).
    db_size: u64,
    /// Size of ynotv.db-wal in bytes (0 if absent).
    wal_size: u64,
    /// Whether the database can be opened quickly. False if it fails or times
    /// out (e.g. it is mid-recovery of a huge WAL).
    opens_ok: bool,
    /// Human-readable error when opens_ok is false.
    error: Option<String>,
}

/// Report database health so the frontend can show a recovery screen when a
/// multi-gigabyte (or unopenable) database would otherwise make the app look
/// broken on startup.
#[tauri::command]
async fn db_health(app: AppHandle) -> DbHealth {
    let data_dir = app.path().app_data_dir().ok();
    let db_path = data_dir.as_ref().map(|d| d.join("ynotv.db"));

    let file_size = |path: Option<std::path::PathBuf>| -> u64 {
        path.as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    };
    let db_size = file_size(db_path.clone());
    let wal_size = file_size(data_dir.as_ref().map(|d| d.join("ynotv.db-wal")));

    // Nothing to recover from if the database file doesn't exist yet (first run).
    let Some(db_path) = db_path else {
        return DbHealth {
            db_size: 0,
            wal_size: 0,
            opens_ok: true,
            error: None,
        };
    };
    if db_size == 0 && !db_path.exists() {
        return DbHealth {
            db_size: 0,
            wal_size: 0,
            opens_ok: true,
            error: None,
        };
    }

    // Try a quick open on a separate thread with a timeout. Opening triggers
    // WAL recovery, which is the slow/failing part on a large database.
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let conn = rusqlite::Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
            )
            .map_err(|e| format!("Failed to open database: {}", e))?;
            conn.busy_timeout(std::time::Duration::from_secs(2))
                .map_err(|e| e.to_string())?;
            let _: i64 = conn
                .query_row("SELECT 1", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        let _ = tx.send(result);
    });

    let (opens_ok, error) = match rx.recv_timeout(std::time::Duration::from_secs(4)) {
        Ok(Ok(())) => (true, None),
        Ok(Err(e)) => (false, Some(e)),
        Err(_) => (false, Some("Timed out opening database (large WAL recovery?)".into())),
    };

    DbHealth {
        db_size,
        wal_size,
        opens_ok,
        error,
    }
}

/// Ask before quitting if a recording is currently in progress.
///
/// If no recording is active we let the exit proceed normally. Otherwise we
/// prevent the exit and show a dialog so the user can either keep the app open
/// (and keep recording) or stop the recording and quit.
fn handle_exit_requested(app_handle: &tauri::AppHandle, api: tauri::ExitRequestApi) {
    // Flush the SQLite WAL back into the main DB before exiting so the next
    // launch doesn't have to recover a large WAL (which blocked startup).
    checkpoint_databases(app_handle);

    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

    let recording_active = app_handle
        .try_state::<DvrState>()
        .map(|dvr| !dvr.recorder.get_active_recordings().is_empty())
        .unwrap_or(false);

    if !recording_active {
        return;
    }

    api.prevent_exit();
    info!("[ExitGuard] Recording in progress; asking user before quitting.");

    const KEEP: &str = "Keep recording & stay open";
    const STOP: &str = "Stop recording & quit";

    let app = app_handle.clone();
    app.dialog()
        .message("A recording is currently in progress. Keep it running by staying open, or stop the recording and quit.")
        .title("Recording in progress")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(KEEP.into(), STOP.into()))
        .show_with_result(move |result| {
            let stop_and_quit = matches!(&result, MessageDialogResult::Custom(c) if c == STOP);
            if stop_and_quit {
                // The dialog callback runs on a background thread, so blocking here is fine.
                if let Some(state) = app.try_state::<DvrState>() {
                    let dvr = state.inner().clone();
                    tauri::async_runtime::block_on(dvr.stop());
                }
                let a = app.clone();
                let _ = a.run_on_main_thread(move || {
                    // app.exit(0) bypasses CloseRequested, so persist the window
                    // geometry here explicitly (same reason as the tray Quit path).
                    save_window_state(&app);
                    app.exit(0);
                });
            }
        });
}

// ============================================================================
// Secure Credentials (Keyring)
// ============================================================================

const KEYRING_SERVICE: &str = "ynotv";
const KEYRING_USER: &str = "opensubtitles_credentials";

#[tauri::command]
fn save_opensubtitles_credentials(username: String, password: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {}", e))?;
    let payload = format!("{}:{}", username.trim(), password);
    entry.set_password(&payload)
        .map_err(|e| format!("Failed to save credentials to OS vault: {}", e))?;
    Ok(())
}

#[tauri::command]
fn get_opensubtitles_credentials() -> Result<Option<(String, String)>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {}", e))?;
    match entry.get_password() {
        Ok(pwd) => {
            if let Some((user, pass)) = pwd.split_once(':') {
                Ok(Some((user.to_string(), pass.to_string())))
            } else {
                Ok(None)
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to retrieve credentials: {}", e)),
    }
}

#[tauri::command]
fn delete_opensubtitles_credentials() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("Keyring error: {}", e))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Failed to delete credentials: {}", e)),
    }
}
