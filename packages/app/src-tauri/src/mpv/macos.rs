// MPV libmpv Implementation (macOS)
//
// Uses tauri-plugin-libmpv for proper NSView embedding on macOS.
// Video is embedded directly into the window using the native libmpv API.

use serde::Deserialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime, Manager};
use tauri_plugin_libmpv::{MpvConfig, MpvExt};

// MPV State for libmpv approach
pub struct MpvState {
    pub initialized: Mutex<bool>,
    pub window_label: Mutex<String>,
}

impl MpvState {
    pub fn new() -> Self {
        Self {
            initialized: Mutex::new(false),
            window_label: Mutex::new("main".to_string()),
        }
    }
}

#[derive(serde::Serialize, Deserialize, Clone, Debug)]
pub struct MpvStatus {
    pub playing: bool,
    pub volume: f64,
    pub muted: bool,
    pub position: f64,
    pub duration: f64,
}

// Helper to emit status from property changes
fn emit_status_from_property(app: &AppHandle<impl Runtime>, name: &str, value: &serde_json::Value) {
    let status = match name {
        "pause" => MpvStatus {
            playing: !value.as_bool().unwrap_or(true),
            volume: 100.0,
            muted: false,
            position: 0.0,
            duration: 0.0,
        },
        "volume" => MpvStatus {
            playing: true,
            volume: value.as_f64().unwrap_or(100.0),
            muted: false,
            position: 0.0,
            duration: 0.0,
        },
        "mute" => MpvStatus {
            playing: true,
            volume: 100.0,
            muted: value.as_bool().unwrap_or(false),
            position: 0.0,
            duration: 0.0,
        },
        "time-pos" => MpvStatus {
            playing: true,
            volume: 100.0,
            muted: false,
            position: value.as_f64().unwrap_or(0.0),
            duration: 0.0,
        },
        "duration" => MpvStatus {
            playing: true,
            volume: 100.0,
            muted: false,
            position: 0.0,
            duration: value.as_f64().unwrap_or(0.0),
        },
        _ => return,
    };
    let _ = app.emit("mpv-status", status);
}

// ============================================================================
// Public API Commands
// ============================================================================

pub async fn init_mpv<R: Runtime>(app: AppHandle<R>, _args: Vec<String>, state: tauri::State<'_, MpvState>) -> Result<(), String> {
    // Check if already initialized
    {
        let initialized = state.initialized.lock().unwrap();
        if *initialized {
            println!("[MPV macOS] Already initialized");
            return Ok(());
        }
    }

    println!("[MPV macOS] Initializing libmpv...");

    // On macOS, we need to ensure libmpv-wrapper.dylib can be found
    // Tauri bundles resources to Contents/Resources/, but the plugin looks in executable dir
    // We need to copy or symlink the library to the right location
    #[cfg(target_os = "macos")]
    {
        use std::fs;
        use tauri::path::BaseDirectory;
        
        // Get resource directory path
        let resource_dir = app.path().resolve("libmpv-wrapper.dylib", BaseDirectory::Resource)
            .map_err(|e| format!("Failed to resolve resource path: {}", e))?;
        
        println!("[MPV macOS] Resource path: {:?}", resource_dir);
        
        // Get executable directory
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get executable path: {}", e))?;
        let exe_dir = exe_path.parent()
            .ok_or("Failed to get executable directory")?;
        let target_path = exe_dir.join("libmpv-wrapper.dylib");
        
        println!("[MPV macOS] Target path: {:?}", target_path);
        
        // Copy library to executable directory if not already there
        if resource_dir.exists() && !target_path.exists() {
            fs::copy(&resource_dir, &target_path)
                .map_err(|e| format!("Failed to copy libmpv-wrapper: {}", e))?;
            println!("[MPV macOS] Copied libmpv-wrapper to executable directory");
        } else if target_path.exists() {
            println!("[MPV macOS] libmpv-wrapper already in executable directory");
        } else {
            println!("[MPV macOS] WARNING: libmpv-wrapper.dylib not found in resources!");
        }
    }

    // Configure MPV with observed properties for status updates
    let mpv_config = MpvConfig {
        initial_options: [
            ("vo", serde_json::json!("gpu-next")),
            ("hwdec", serde_json::json!("auto-safe")),
            ("keep-open", serde_json::json!("yes")),
            ("force-window", serde_json::json!("yes")),
            ("no-osc", serde_json::json!("yes")),
            ("no-osd-bar", serde_json::json!("yes")),
            ("osd-level", serde_json::json!(0)),
            ("input-default-bindings", serde_json::json!("no")),
            ("no-input-cursor", serde_json::json!("yes")),
            ("cursor-autohide", serde_json::json!("no")),
            ("coreaudio-change-physical-format", serde_json::json!("no")),
        ].iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
        observed_properties: [
            ("pause", "flag"),
            ("volume", "double"),
            ("mute", "flag"),
            ("time-pos", "double"),
            ("duration", "double"),
            ("filename", "string"),
            ("media-title", "string"),
            ("aid", "int64"),
            ("sid", "int64"),
            ("track-list", "node"),
        ].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    };

    let window_label = state.window_label.lock().unwrap().clone();

    // Initialize libmpv
    app.mpv().init(mpv_config, &window_label)
        .map_err(|e| format!("Failed to initialize libmpv: {}", e))?;

    *state.initialized.lock().unwrap() = true;
    println!("[MPV macOS] libmpv initialized successfully");

    // Set up event listener to translate libmpv events to our format
    let app_handle = app.clone();
    let app_handle_for_closure = app.clone();
    
    // The plugin emits events as `mpv-event-{window_label}`
    // We need to listen and translate to `mpv-status` format
    tauri::async_runtime::spawn(async move {
        use tauri::Listener;
        
        let event_name = format!("mpv-event-{}", window_label);
        
        let _ = app_handle.listen(&event_name, move |event| {
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                if let Some(event_type) = payload.get("event").and_then(|e| e.as_str()) {
                    if event_type == "property-change" {
                        if let (Some(name), Some(data)) = (
                            payload.get("name").and_then(|n| n.as_str()),
                            payload.get("data")
                        ) {
                            emit_status_from_property(&app_handle_for_closure, name, data);
                        }
                    }
                }
            }
        });
    });

    let _ = app.emit("mpv-ready", true);
    Ok(())
}

pub async fn mpv_load<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let window_label = "main";
    let args: Vec<serde_json::Value> = vec![serde_json::json!(url)];
    app.mpv().command("loadfile", &args, window_label)
        .map_err(|e| format!("Failed to load file: {}", e))
}

pub async fn mpv_play<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window_label = "main";
    app.mpv().set_property("pause", &serde_json::json!(false), window_label)
        .map_err(|e| format!("Failed to play: {}", e))
}

pub async fn mpv_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window_label = "main";
    app.mpv().set_property("pause", &serde_json::json!(true), window_label)
        .map_err(|e| format!("Failed to pause: {}", e))
}

pub async fn mpv_resume<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window_label = "main";
    app.mpv().set_property("pause", &serde_json::json!(false), window_label)
        .map_err(|e| format!("Failed to resume: {}", e))
}

pub async fn mpv_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window_label = "main";
    let args: Vec<serde_json::Value> = vec![];
    app.mpv().command("stop", &args, window_label)
        .map_err(|e| format!("Failed to stop: {}", e))
}

pub async fn mpv_set_volume<R: Runtime>(app: AppHandle<R>, volume: f64) -> Result<(), String> {
    let window_label = "main";
    app.mpv().set_property("volume", &serde_json::json!(volume), window_label)
        .map_err(|e| format!("Failed to set volume: {}", e))
}

pub async fn mpv_seek<R: Runtime>(app: AppHandle<R>, seconds: f64) -> Result<(), String> {
    let window_label = "main";
    let args: Vec<serde_json::Value> = vec![serde_json::json!(seconds), serde_json::json!("absolute")];
    app.mpv().command("seek", &args, window_label)
        .map_err(|e| format!("Failed to seek: {}", e))
}

pub async fn mpv_cycle_audio<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window_label = "main";
    let args: Vec<serde_json::Value> = vec![serde_json::json!("audio")];
    app.mpv().command("cycle", &args, window_label)
        .map_err(|e| format!("Failed to cycle audio: {}", e))
}

pub async fn mpv_cycle_sub<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window_label = "main";
    let args: Vec<serde_json::Value> = vec![serde_json::json!("sub")];
    app.mpv().command("cycle", &args, window_label)
        .map_err(|e| format!("Failed to cycle subtitles: {}", e))
}

pub async fn mpv_toggle_mute<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window_label = "main";
    let args: Vec<serde_json::Value> = vec![serde_json::json!("mute")];
    app.mpv().command("cycle", &args, window_label)
        .map_err(|e| format!("Failed to toggle mute: {}", e))
}

pub async fn mpv_toggle_stats<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let window_label = "main";
    let args: Vec<serde_json::Value> = vec![serde_json::json!("stats/display-stats-toggle")];
    app.mpv().command("script-binding", &args, window_label)
        .map_err(|e| format!("Failed to toggle stats: {}", e))
}

pub async fn mpv_get_track_list<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let window_label = "main";
    app.mpv().get_property("track-list".to_string(), "node".to_string(), window_label)
        .map_err(|e| format!("Failed to get track list: {}", e))
}

pub async fn mpv_set_audio<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<(), String> {
    let window_label = "main";
    app.mpv().set_property("aid", &serde_json::json!(id), window_label)
        .map_err(|e| format!("Failed to set audio: {}", e))
}

pub async fn mpv_set_subtitle<R: Runtime>(app: AppHandle<R>, id: i64) -> Result<(), String> {
    let window_label = "main";
    app.mpv().set_property("sid", &serde_json::json!(id), window_label)
        .map_err(|e| format!("Failed to set subtitle: {}", e))
}

pub async fn mpv_set_property<R: Runtime>(app: AppHandle<R>, name: String, value: serde_json::Value) -> Result<(), String> {
    let window_label = "main";
    app.mpv().set_property(&name, &value, window_label)
        .map_err(|e| format!("Failed to set property: {}", e))
}

pub async fn mpv_get_property<R: Runtime>(app: AppHandle<R>, name: String) -> Result<serde_json::Value, String> {
    let window_label = "main";
    app.mpv().get_property(name, "node".to_string(), window_label)
        .map_err(|e| format!("Failed to get property: {}", e))
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

// Video margin control for EPG preview resizing
pub async fn mpv_set_video_margins<R: Runtime>(
    app: AppHandle<R>,
    left: Option<f64>,
    right: Option<f64>,
    top: Option<f64>,
    bottom: Option<f64>,
) -> Result<(), String> {
    let window_label = "main";
    let margins = [
        ("video-margin-ratio-left", left),
        ("video-margin-ratio-right", right),
        ("video-margin-ratio-top", top),
        ("video-margin-ratio-bottom", bottom),
    ];

    for (property, value) in margins {
        if let Some(v) = value {
            app.mpv().set_property(property, &serde_json::json!(v), window_label)
                .map_err(|e| format!("Failed to set {}: {}", property, e))?;
        }
    }
    Ok(())
}
