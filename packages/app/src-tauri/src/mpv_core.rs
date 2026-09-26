//! Unified libmpv player core for ynotv
//! Supporting in-process playback on macOS (via AppKit OpenGL) and Windows (via HWND wid / D3D11)

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use libmpv2::events::{Event, EventContext};
use libmpv2::mpv_node::MpvNode;
use libmpv2::{Mpv, MpvInitializer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Upper bound for the in-memory libmpv log ring buffer served by `get_log`.
const MAX_LOG_LINES: usize = 8000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MpvGeometry {
    pub css_left: f64,
    pub css_top: f64,
    pub css_width: f64,
    pub css_height: f64,
    pub css_view_w: f64,
    pub css_view_h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) struct NativeMpvRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn map_css_geometry(
    css: &MpvGeometry,
    native_width: f64,
    native_height: f64,
) -> NativeMpvRect {
    let full_surface = NativeMpvRect {
        x: 0.0,
        y: 0.0,
        width: native_width,
        height: native_height,
    };
    if !css.css_left.is_finite()
        || !css.css_top.is_finite()
        || !css.css_width.is_finite()
        || !css.css_height.is_finite()
        || !css.css_view_w.is_finite()
        || !css.css_view_h.is_finite()
        || css.css_width <= 0.0
        || css.css_height <= 0.0
        || css.css_view_w <= 0.0
        || css.css_view_h <= 0.0
    {
        return full_surface;
    }

    let scale_x = native_width / css.css_view_w;
    let scale_y = native_height / css.css_view_h;
    let mut x = css.css_left * scale_x;
    let mut y = css.css_top * scale_y;
    let mut width = css.css_width * scale_x;
    let mut height = css.css_height * scale_y;

    if css.css_left.abs() <= 2.0 {
        width += x;
        x = 0.0;
    }
    if css.css_top.abs() <= 2.0 {
        height += y;
        y = 0.0;
    }
    if css.css_left + css.css_width >= css.css_view_w - 2.0 {
        width = native_width - x;
    }
    if css.css_top + css.css_height >= css.css_view_h - 2.0 {
        height = native_height - y;
    }

    x = x.clamp(0.0, (native_width - 1.0).max(0.0));
    y = y.clamp(0.0, (native_height - 1.0).max(0.0));
    width = width.clamp(1.0, (native_width - x).max(1.0));
    height = height.clamp(1.0, (native_height - y).max(1.0));

    NativeMpvRect {
        x,
        y,
        width,
        height,
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct MpvStatus {
    pub playing: bool,
    pub volume: f64,
    pub muted: bool,
    pub position: f64,
    pub duration: f64,
    #[serde(rename = "pausedForCache")]
    pub paused_for_cache: bool,
    #[serde(rename = "coreIdle")]
    pub core_idle: bool,
    #[serde(rename = "eofReached")]
    pub eof_reached: bool,
    #[serde(rename = "videoFormat")]
    pub video_format: Option<String>,
    #[serde(rename = "videoTrackId")]
    pub video_track_id: Option<Value>,
}

pub struct MpvCoreState {
    pub mpv: Arc<Mutex<Option<Arc<Mpv>>>>,
    pub current_url: Mutex<Option<String>>,
    pub is_shutting_down: Arc<std::sync::atomic::AtomicBool>,
    /// Embedded main-player HWND on Windows, cached so geometry updates stay
    /// deterministic even if the window title lookup races window creation.
    #[cfg(windows)]
    pub main_hwnd: Mutex<isize>,
    /// Ring buffer of libmpv log lines (mpv `log-message` events), served by
    /// `get_log` for the Diagnostics panel.
    pub log_lines: Arc<Mutex<VecDeque<String>>>,
}

impl MpvCoreState {
    pub fn new() -> Self {
        MpvCoreState {
            mpv: Arc::new(Mutex::new(None)),
            current_url: Mutex::new(None),
            is_shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            #[cfg(windows)]
            main_hwnd: Mutex::new(0),
            log_lines: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

fn apply_common_options(
    init: &MpvInitializer,
    custom_params: &[String],
    embed_hwnd: Option<i64>,
) -> Result<(), String> {
    let set = |k: &str, v: &str| {
        let _ = init.set_property(k, v);
    };

    set("audio-client-name", "ynotv");
    set("terminal", "no");
    set("keep-open", "yes");
    set("idle", "yes");
    set("input-default-bindings", "no");
    set("input-media-keys", "no");
    set("input-cursor", "no");
    let _ = init.set_property("osc", "no");
    set("osd-level", "0");
    set("volume-max", "600");
    let _ = init.set_property("background-color", "#000000");

    // Pass HTTP proxy if configured in environment
    if let Ok(proxy) = std::env::var("ALL_PROXY") {
        set("http-proxy", &proxy);
    }

    #[cfg(target_os = "macos")]
    {
        set("hwdec", "videotoolbox-copy");
        set("force-window", "no");
        set("video-timing-offset", "0");
        set("vo", "libmpv");
    }

    #[cfg(windows)]
    {
        set("hwdec", "auto");
        set("force-window", "immediate");
        set("gpu-api", "d3d11");
        set("vo", "gpu-next");
        set("title", "YNOTV_MPV_MAIN");

        if let Some(hwnd) = embed_hwnd {
            init.set_property("wid", hwnd)
                .map_err(|e| format!("set wid={}: {}", hwnd, e))?;
        }
    }

    // Apply custom parameters passed from settings
    for param in custom_params {
        let trimmed = param.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let clean = trimmed.trim_start_matches('-');
        if let Some((k, v)) = clean.split_once('=') {
            let _ = init.set_property(k.trim(), v.trim());
        } else if let Some((k, v)) = clean.split_once(' ') {
            let _ = init.set_property(k.trim(), v.trim());
        } else {
            let _ = init.set_property(clean, "yes");
        }
    }

    // Re-assert engine-critical options AFTER custom params. The shared param
    // builder auto-injects --vo=gpu when HW accel is on, and users may pass
    // arbitrary flags; overriding vo/gpu-api/wid/title here would break the
    // embedded render path (macOS requires vo=libmpv) and the window-title
    // based HWND discovery used by multiview geometry.
    #[cfg(target_os = "macos")]
    {
        set("vo", "libmpv");
        set("force-window", "no");
    }

    #[cfg(windows)]
    {
        set("force-window", "immediate");
        set("gpu-api", "d3d11");
        set("vo", "gpu-next");
        set("title", "YNOTV_MPV_MAIN");
        if let Some(hwnd) = embed_hwnd {
            let _ = init.set_property("wid", hwnd);
        }
    }

    Ok(())
}

pub async fn init_mpv_with_params<R: Runtime>(
    app: AppHandle<R>,
    custom_params: Vec<String>,
) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();

    // Stop and teardown any existing MPV session
    kill_mpv(&app).await;

    // If the user switched engines in settings without restarting, a stale
    // sidecar mpv.exe may still be embedded in the window. Tear it down too so
    // we never have two players drawing over each other.
    #[cfg(windows)]
    {
        if app
            .state::<crate::mpv_windows::MpvState>()
            .process
            .lock()
            .unwrap()
            .is_some()
        {
            crate::mpv_windows::kill_mpv(&app).await;
        }
    }

    let mut embed_hwnd: Option<i64> = None;
    #[cfg(windows)]
    {
        if let Some(window) = app.get_window("main") {
            if let Ok(hwnd) = window.hwnd() {
                embed_hwnd = Some(hwnd.0 as i64);
            }
        }
    }

    let custom_params_clone = custom_params.clone();
    let init_err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let init_err_cap = init_err.clone();

    let mpv = Mpv::with_initializer(move |init| {
        if let Err(e) = apply_common_options(&init, &custom_params_clone, embed_hwnd) {
            log::error!("[ynotv::mpv_core] pre-init error: {}", e);
            if let Ok(mut g) = init_err_cap.lock() {
                *g = Some(e);
            }
            return Err(libmpv2::Error::Raw(-1));
        }
        Ok(())
    })
    .map_err(|e| {
        if let Ok(g) = init_err.lock() {
            g.clone().unwrap_or_else(|| format!("mpv init: {}", e))
        } else {
            format!("mpv init: {}", e)
        }
    })?;

    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_window("main")
            .ok_or_else(|| "main window missing for render API install".to_string())?;
        let ns_window_ptr = window
            .ns_window()
            .map_err(|e| format!("ns_window: {:?}", e))? as i64;
        let mpv_ctx_addr: usize = mpv.ctx.as_ptr() as usize;
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        let _ = app.run_on_main_thread(move || {
            let res = match std::ptr::NonNull::new(mpv_ctx_addr as *mut libmpv2_sys::mpv_handle) {
                Some(p) => crate::mpv_render_mac::install(p, ns_window_ptr, false),
                None => Err("null mpv ctx".into()),
            };
            let _ = tx.send(res);
        });
        match rx.recv_timeout(Duration::from_millis(3000)) {
            Ok(Ok(())) => log::info!("[ynotv::mpv_core] macOS render installed OK"),
            Ok(Err(e)) => {
                log::error!("[ynotv::mpv_core] macOS render install failed: {}", e);
                return Err(format!("mac render install: {}", e));
            }
            Err(e) => {
                log::error!("[ynotv::mpv_core] macOS render install timeout: {:?}", e);
                return Err("mac render install timeout".into());
            }
        }
    }

    let mpv_arc = Arc::new(mpv);
    {
        let mut guard = state.mpv.lock().unwrap();
        *guard = Some(mpv_arc.clone());
    }

    // Capture libmpv log-message events for the Diagnostics panel
    spawn_log_capture(
        app.clone(),
        mpv_arc.clone(),
        state.is_shutting_down.clone(),
        state.log_lines.clone(),
    );

    // Start background status and event monitor
    spawn_status_monitor(app.clone(), mpv_arc, state.is_shutting_down.clone());

    #[cfg(windows)]
    {
        if let Some(audio_state) = app.try_state::<crate::audio_capture::AudioCaptureState>() {
            audio_state.start(app.clone(), std::process::id());
        }
    }

    let _ = app.emit("mpv-ready", true);

    log::info!("[ynotv::mpv_core] libmpv initialized successfully");
    Ok(())
}

/// Read the selected video track in the same shape the standalone sidecar
/// reports it.
///
/// mpv answers the *node* form of `vid` with `false` when no video track is
/// selected (`1`, `2`, ... when one is), but a typed int64 read of the same
/// property fails outright in that case — so the previous
/// `get_property::<i64>("vid").ok()` produced `null` for every audio-only
/// stream, leaving the UI unable to tell "no video" from "not reported" and
/// hiding the audio visualiser on the embedded engine. The int64 read stays as
/// a fallback for engines that don't answer the node form.
fn read_video_track_id(mpv: &Mpv) -> Option<Value> {
    match mpv.get_property::<MpvNode>("vid") {
        Ok(MpvNode::Flag(flag)) => Some(Value::Bool(flag)),
        Ok(MpvNode::Int64(id)) => Some(Value::from(id)),
        Ok(MpvNode::Double(id)) => Some(Value::from(id)),
        Ok(MpvNode::String(id)) => Some(Value::from(id)),
        _ => mpv.get_property::<i64>("vid").ok().map(Value::from),
    }
}

fn spawn_status_monitor<R: Runtime>(
    app: AppHandle<R>,
    mpv: Arc<Mpv>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    tauri::async_runtime::spawn(async move {
        let mut last_eof_reached = false;
        let mut was_idle = true;
        let mut last_position: f64 = 0.0;

        while !shutdown.load(std::sync::atomic::Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(250)).await;

            let pause: bool = mpv.get_property("pause").unwrap_or(true);
            let volume: f64 = mpv.get_property("volume").unwrap_or(100.0);
            let mute: bool = mpv.get_property("mute").unwrap_or(false);
            let position: f64 = mpv.get_property("time-pos").unwrap_or(0.0);
            let duration: f64 = mpv.get_property("duration").unwrap_or(0.0);
            let paused_for_cache: bool = mpv.get_property("paused-for-cache").unwrap_or(false);
            let core_idle: bool = mpv.get_property("core-idle").unwrap_or(true);
            let eof_reached: bool = mpv.get_property("eof-reached").unwrap_or(false);
            let video_format: Option<String> = mpv.get_property("video-format").ok();
            let video_track_id = read_video_track_id(&mpv);

            // Emit playback-restart on transition from idle to active. The
            // mpv-file-loaded event is emitted by the event loop at the real
            // FileLoaded event (which also suppresses mpv's auto-selected
            // subtitle tracks), so it is not duplicated here.
            if was_idle && !core_idle {
                let _ = app.emit("mpv-playback-restart", true);
            }
            was_idle = core_idle;

            // Detect seek (jump in position larger than 2 seconds not accounted for by elapsed time)
            if (position - last_position).abs() > 2.0 && !core_idle {
                let _ = app.emit("mpv-seek", true);
            }
            last_position = position;

            // End-of-file & stream ended events
            if eof_reached && !last_eof_reached {
                let _ = app.emit("mpv-end-file", json!({
                    "reason": "eof",
                    "position": position,
                    "duration": duration,
                }));
                let _ = app.emit("mpv-stream-ended", ());
            }
            last_eof_reached = eof_reached;

            // Timeshift / Live buffer updates
            if let Ok(demuxer_cache) = mpv.get_property::<f64>("demuxer-cache-duration") {
                let cache_start: f64 = mpv.get_property("demuxer-cache-state/cache-start").unwrap_or(0.0);
                let cache_end: f64 = mpv.get_property("demuxer-cache-state/cache-end").unwrap_or(position + demuxer_cache);
                let cached_duration = (cache_end - cache_start).max(demuxer_cache);
                let behind_live = (cache_end - position).max(0.0);
                if cached_duration > 0.0 {
                    let ts_state = json!({
                        "cacheStart": cache_start,
                        "cacheEnd": cache_end,
                        "timePos": position,
                        "behindLive": behind_live,
                        "cachedDuration": cached_duration,
                    });
                    let _ = app.emit("timeshift-update", ts_state);
                }
            }

            let status = MpvStatus {
                playing: !pause,
                volume,
                muted: mute,
                position,
                duration,
                paused_for_cache,
                core_idle,
                eof_reached,
                video_format,
                video_track_id,
            };

            let _ = app.emit("mpv-status", status);
        }
    });
}

/// Drain mpv `log-message` events into a bounded ring buffer so the
/// Diagnostics panel can show in-process libmpv logs, and handle file lifecycle
/// events (subtitle suppression on load). Stops on the same `is_shutting_down`
/// flag as the status monitor; `mpv_destroy` also wakes the waiter with a
/// `Shutdown` event, which exits the drain early.
fn spawn_log_capture<R: Runtime>(
    app: AppHandle<R>,
    mpv: Arc<Mpv>,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    log_lines: Arc<Mutex<VecDeque<String>>>,
) {
    tauri::async_runtime::spawn(async move {
        let mut ec = EventContext::new(mpv.ctx);
        // Default verbosity matches the sidecar engine's --msg-level=all=warn;
        // mpv_set_verbose_logging raises it to "v" on demand.
        if let Ok(level) = std::ffi::CString::new("warn") {
            unsafe {
                libmpv2_sys::mpv_request_log_messages(mpv.ctx.as_ptr(), level.as_ptr());
            }
        }
        // The HTTP failure reported for the file that is currently loaded. Kept so
        // the same failure is announced once (mpv/ffmpeg can log the line several
        // times) and so the generic end-file error below can't replace it.
        let mut current_http_error: Option<String> = None;

        while !shutdown.load(std::sync::atomic::Ordering::Relaxed) {
            while let Some(ev) = ec.wait_event(0.0) {
                match ev {
                    Ok(Event::LogMessage {
                        prefix,
                        level,
                        text,
                        ..
                    }) => {
                        // The sidecar engine reads these lines off the mpv process's
                        // stdout. The embedded engine gets them as log messages, and
                        // they are the only place libmpv says *why* a stream failed:
                        // its EndFile event carries a reason but no error text.
                        if let Some(error_msg) = crate::mpv_error_parse::http_error_message(text) {
                            if current_http_error.as_deref() != Some(error_msg.as_str()) {
                                // Record the status in ynoTV.log too: the frontend may
                                // be suppressing the event, and the raw line names the
                                // component that failed (ffmpeg vs the ytdl hook).
                                log::warn!(
                                    "[MPV] HTTP error report: {} | {}",
                                    error_msg,
                                    text.trim().chars().take(160).collect::<String>()
                                );
                                let _ = app.emit("mpv-http-error", error_msg.clone());
                                current_http_error = Some(error_msg);
                            }
                        }
                        let line = format!("[{}:{}] {}", prefix, level, text.trim_end());
                        let mut buf = log_lines.lock().unwrap();
                        if buf.len() >= MAX_LOG_LINES {
                            buf.pop_front();
                        }
                        buf.push_back(line);
                    }
                    Ok(Event::StartFile) => {
                        // A new file: the previous file's failure no longer applies.
                        current_http_error = None;
                    }
                    Ok(Event::EndFile(reason)) => {
                        // mpv stopped on its own with an error (a failed load, a dead
                        // live stream, a mid-playback HTTP failure). The sidecar engine
                        // surfaces these from its JSON IPC end-file event; without this
                        // the embedded engine reported nothing at all, so a VOD title
                        // whose provider returned 403/404 just went quiet.
                        if reason == libmpv2::mpv_end_file_reason::Error {
                            let position: f64 = mpv.get_property("time-pos").unwrap_or(0.0);
                            let duration: f64 = mpv.get_property("duration").unwrap_or(0.0);

                            // Only add the generic message when no HTTP status was
                            // reported for this file — the specific one is the useful
                            // one, and the frontend overlay keys its title off it.
                            if current_http_error.is_none() {
                                if let Some(error_msg) =
                                    crate::mpv_error_parse::end_file_error_message("error", "")
                                {
                                    let _ = app.emit("mpv-end-file-error", error_msg);
                                }
                            }

                            let _ = app.emit(
                                "mpv-end-file",
                                json!({
                                    "reason": "error",
                                    "fileError": "",
                                    "position": position,
                                    "duration": duration,
                                }),
                            );
                            let _ = app.emit("mpv-stream-ended", ());
                        }
                    }
                    Ok(Event::FileLoaded) => {
                        // mpv auto-selects subtitle tracks when a file finishes
                        // loading. On live TV that can activate several CEA-608
                        // closed-caption services and/or a soft WebVTT track at
                        // once, rendering the same captions stacked 3-5 times.
                        // Disable all subtitle display here so the frontend's
                        // autoSelectSubtitle logic can cleanly re-enable exactly
                        // the right track (mirrors the old sidecar engine's
                        // file-loaded handler, lost in the libmpv refactor).
                        let _ = mpv.set_property("sid", "no");
                        let _ = app.emit("mpv-file-loaded", true);
                    }
                    Ok(Event::Shutdown) => break,
                    _ => {}
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
}

/// Toggle libmpv client log verbosity ("v" / "warn") for the Diagnostics panel.
pub async fn set_verbose_logging<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        let level = if enabled { "v" } else { "warn" };
        if let Ok(c) = std::ffi::CString::new(level) {
            unsafe {
                libmpv2_sys::mpv_request_log_messages(mpv.ctx.as_ptr(), c.as_ptr());
            }
        }
    }
    Ok(())
}

/// Return the tail of the in-memory libmpv log, filtered to diagnostics-relevant
/// lines, in the same shape as the sidecar engine's log.
pub async fn get_log<R: Runtime>(app: &AppHandle<R>, tail: usize) -> Result<Value, String> {
    let state = app.state::<MpvCoreState>();
    let lines: Vec<String> = {
        let buf = state.log_lines.lock().unwrap();
        buf.iter().cloned().collect()
    };
    let scan = tail.max(MAX_LOG_LINES);
    let start = lines.len().saturating_sub(scan);
    let keywords = [
        "sub", "sid", "ass", "osd", "track", "refresh", "fontselect", "srt", "vtt", "subrip",
        "mov_text",
    ];
    let mut kept: Vec<String> = lines[start..]
        .iter()
        .filter(|line| keywords.iter().any(|k| line.to_ascii_lowercase().contains(k)))
        .cloned()
        .collect();
    if kept.len() > 2000 {
        kept = kept[kept.len() - 2000..].to_vec();
    }
    Ok(json!({
        "log": kept.join("\n"),
        "path": "libmpv (in-process)",
        "filtered": true,
    }))
}

pub async fn load_file<R: Runtime>(app: &AppHandle<R>, url: String) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    let mpv = match mpv {
        Some(m) => m,
        None => {
            log::info!("[ynotv::mpv_core] MPV not initialized on load_file, auto-initializing with stored settings...");
            let params = crate::get_mpv_params_from_store(app).await;
            let safe_params = crate::sanitize_mpv_args(params);
            init_mpv_with_params(app.clone(), safe_params).await?;
            let guard = state.mpv.lock().unwrap();
            guard.clone().ok_or("Failed to auto-initialize MPV")?
        }
    };

    mpv.command("loadfile", &[&url])
        .map_err(|e| format!("loadfile error: {:?}", e))?;

    let mut current = state.current_url.lock().unwrap();
    *current = Some(url);
    Ok(())
}

pub async fn play<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.set_property("pause", false)
            .map_err(|e| format!("set pause error: {:?}", e))?;
    }
    Ok(())
}

pub async fn pause<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.set_property("pause", true)
            .map_err(|e| format!("set pause error: {:?}", e))?;
    }
    Ok(())
}

pub async fn resume<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    play(app).await
}

pub async fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("stop", &[])
            .map_err(|e| format!("stop error: {:?}", e))?;
    }
    Ok(())
}

pub async fn seek<R: Runtime>(app: &AppHandle<R>, seconds: f64) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("seek", &[&seconds.to_string(), "absolute"])
            .map_err(|e| format!("seek error: {:?}", e))?;
    }
    Ok(())
}

pub async fn set_volume<R: Runtime>(app: &AppHandle<R>, volume: f64) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.set_property("volume", volume)
            .map_err(|e| format!("set volume error: {:?}", e))?;
    }
    Ok(())
}

pub async fn toggle_mute<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("cycle", &["mute"])
            .map_err(|e| format!("toggle mute error: {:?}", e))?;
    }
    Ok(())
}

pub async fn cycle_audio<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("cycle", &["audio"])
            .map_err(|e| format!("cycle audio error: {:?}", e))?;
    }
    Ok(())
}

pub async fn cycle_sub<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        mpv.command("cycle", &["sub"])
            .map_err(|e| format!("cycle sub error: {:?}", e))?;
    }
    Ok(())
}

pub async fn get_track_list<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    let res = get_property(app, "track-list".to_string()).await?;
    if res.is_null() {
        Ok(json!([]))
    } else {
        Ok(res)
    }
}

pub async fn set_audio_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        if id == 0 {
            mpv.set_property("aid", "no")
        } else {
            mpv.set_property("aid", id)
        }
        .map_err(|e| format!("set aid error: {:?}", e))?;
    }
    Ok(())
}

pub async fn set_subtitle_track<R: Runtime>(app: &AppHandle<R>, id: i64) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        if id == 0 {
            mpv.set_property("sid", "no")
        } else {
            mpv.set_property("sid", id)
        }
        .map_err(|e| format!("set sid error: {:?}", e))?;
    }
    Ok(())
}

/// Jellyfin serves subtitles from `/Videos/.../Subtitles/.../Stream.vtt?api_key=...`.
/// The HTTP URL itself is valid (the server returns real WebVTT), but mpv's
/// runtime `sub-add` cannot detect the format when the URL ends in a query
/// string — its ffmpeg probe misfires on the `?api_key=` suffix (startup
/// `--sub-file` handles it, `sub-add` does not). Download such URLs to a local
/// temp file (keeping the extension) so mpv always gets a clean path it can
/// identify. Returns the path that was actually handed to mpv.
pub async fn resolve_external_subtitle(file_path: &str) -> String {
    let lower = file_path.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://"))
        || !lower.contains("/subtitles/")
    {
        return file_path.to_string();
    }
    // Keep the URL's extension (Stream.vtt -> .vtt) so mpv's demuxer picks the
    // right subtitle format; default to .vtt.
    let ext = file_path
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('.')
        .next()
        .filter(|e| (2..=5).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|e| format!(".{}", e.to_ascii_lowercase()))
        .unwrap_or_else(|| ".vtt".to_string());

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(_) => return file_path.to_string(),
    };
    let resp = match client.get(file_path).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return file_path.to_string(),
    };
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => return file_path.to_string(),
    };

    let dir = std::env::temp_dir().join("ynotv-jellyfin-subs");
    if std::fs::create_dir_all(&dir).is_err() {
        return file_path.to_string();
    }
    // Best-effort sweep of stale downloads (>24h) so temp files don't pile up.
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            if let Ok(md) = entry.metadata() {
                if md.is_file()
                    && md
                        .modified()
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .map(|a| a > std::time::Duration::from_secs(86_400))
                        .unwrap_or(false)
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hasher::write(&mut hasher, file_path.as_bytes());
    let name = format!("jf-{}-{:x}{}", std::process::id(), std::hash::Hasher::finish(&hasher), ext);
    let dest = dir.join(name);
    let content = normalize_subtitle_bytes(&bytes);
    match std::fs::write(&dest, &content) {
        Ok(_) => dest.to_string_lossy().into_owned(),
        Err(_) => file_path.to_string(),
    }
}

/// Normalize a downloaded subtitle so mpv's demuxer actually parses it.
///
/// Jellyfin serves external SRT tracks as WebVTT with a UTF-8 BOM, CRLF line
/// endings, a `Region:` block and `region:...` cue settings. mpv's webvtt
/// demuxer silently drops every cue that carries a `region:` setting (verified
/// against the bundled mpv: a file with `region:subtitle line:90%` cues yields
/// zero subtitle events, while the same cues without `region:` render fine).
/// The BOM/CRLF are cleaned too so the header is recognized reliably.
pub fn normalize_subtitle_bytes(bytes: &[u8]) -> Vec<u8> {
    // Strip a UTF-8 BOM if present.
    let mut bytes = bytes;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes = &bytes[3..];
    }
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return bytes.to_vec(), // non-text subtitle (e.g. ass) — leave untouched
    };
    // Only WebVTT needs the region scrubbing; other formats pass through.
    if !text.trim_start().starts_with("WEBVTT") {
        return bytes.to_vec();
    }
    let mut out = String::with_capacity(text.len() + 16);
    let mut seen_cue = false;
    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if !seen_cue && line.trim_start().to_ascii_lowercase().starts_with("region:") {
            // `Region: id:...` header block — the demuxer chokes on the region
            // reference; drop the block entirely (it is only useful with the
            // cue setting we strip below).
            continue;
        }
        if line.contains("-->") {
            seen_cue = true;
            // Strip `region:<id>` from cue settings (`start --> end region:subtitle line:90%`).
            let cleaned = if line.contains("region:") {
                let mut parts = line.splitn(2, "-->").map(|p| p.trim().to_string()).collect::<Vec<_>>();
                if parts.len() == 2 {
                    parts[1] = parts[1]
                        .split_whitespace()
                        .filter(|tok| !tok.to_ascii_lowercase().starts_with("region:"))
                        .collect::<Vec<_>>()
                        .join(" ");
                }
                parts.join(" --> ").to_string()
            } else {
                line.to_string()
            };
            out.push_str(&cleaned);
            out.push('\n');
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.into_bytes()
}

/// True when the path is one of our downloaded Jellyfin subtitle temp files.
pub fn is_jellyfin_subtitle_temp(path: &str) -> bool {
    path.to_ascii_lowercase().contains("ynotv-jellyfin-subs")
}

pub async fn add_subtitle_file<R: Runtime>(
    app: &AppHandle<R>,
    file_path: String,
    flag: Option<String>,
    title: Option<String>,
    lang: Option<String>,
) -> Result<String, String> {
    let resolved = resolve_external_subtitle(&file_path).await;
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        let f = flag.unwrap_or_else(|| "select".to_string());
        // Use mpv_command with null-terminated argv so arguments containing spaces
        // (e.g. titles like "Undefined - SUBRIP - External" or paths with spaces)
        // are not split by whitespace into extra arguments (which caused
        // MPV_ERROR_INVALID_PARAMETER (-4) in mpv_command_string).
        let cmd_c = std::ffi::CString::new("sub-add").map_err(|e| e.to_string())?;
        let resolved_c = std::ffi::CString::new(resolved.clone()).map_err(|e| e.to_string())?;
        let flag_c = std::ffi::CString::new(f).map_err(|e| e.to_string())?;

        let mut c_args: Vec<*const std::os::raw::c_char> = vec![
            cmd_c.as_ptr(),
            resolved_c.as_ptr(),
            flag_c.as_ptr(),
        ];

        let title_c = title.and_then(|t| {
            let s = t.trim();
            if s.is_empty() { None } else { std::ffi::CString::new(s).ok() }
        });
        let lang_c = lang.and_then(|l| {
            let s = l.trim();
            if s.is_empty() { None } else { std::ffi::CString::new(s).ok() }
        });

        if let Some(ref tc) = title_c {
            c_args.push(tc.as_ptr());
            if let Some(ref lc) = lang_c {
                c_args.push(lc.as_ptr());
            }
        }
        c_args.push(std::ptr::null());

        let mut err = unsafe {
            libmpv2_sys::mpv_command(mpv.ctx.as_ptr(), c_args.as_mut_ptr() as *mut *const std::os::raw::c_char)
        };
        if err < 0 && title_c.is_some() {
            // Fallback: if mpv disliked the title/lang metadata, retry with just path and flag
            let mut fallback_args: Vec<*const std::os::raw::c_char> = vec![
                cmd_c.as_ptr(),
                resolved_c.as_ptr(),
                flag_c.as_ptr(),
                std::ptr::null(),
            ];
            err = unsafe {
                libmpv2_sys::mpv_command(mpv.ctx.as_ptr(), fallback_args.as_mut_ptr() as *mut *const std::os::raw::c_char)
            };
        }
        if err < 0 {
            return Err(format!("sub-add error: {}", err));
        }
    }
    Ok(resolved)
}

pub async fn remove_subtitle_file<R: Runtime>(
    app: &AppHandle<R>,
    file_path: String,
) -> Result<(), String> {
    let tracks = get_track_list(app).await?;
    if let Some(arr) = tracks.as_array() {
        for t in arr {
            if t.get("type").and_then(|v| v.as_str()) == Some("sub")
                && t.get("external").and_then(|v| v.as_bool()) == Some(true)
                && t.get("external-filename").and_then(|v| v.as_str()) == Some(&file_path)
            {
                if let Some(id) = t.get("id").and_then(|v| v.as_i64()) {
                    let state = app.state::<MpvCoreState>();
                    let mpv = {
                        let guard = state.mpv.lock().unwrap();
                        guard.clone()
                    };
                    if let Some(mpv) = mpv {
                        return mpv
                            .command("sub-remove", &[&id.to_string()])
                            .map_err(|e| format!("sub-remove error: {:?}", e))
                            .map(|_| {
                                // Free the temp file for downloaded Jellyfin subs.
                                if is_jellyfin_subtitle_temp(&file_path) {
                                    let _ = std::fs::remove_file(&file_path);
                                }
                            });
                    }
                }
            }
        }
    }
    Ok(())
}

pub async fn set_property<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
    value: Value,
) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    let Some(mpv) = mpv else {
        return Ok(());
    };
    match value {
        Value::Bool(b) => mpv.set_property(&name, b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                mpv.set_property(&name, i)
            } else if let Some(f) = n.as_f64() {
                mpv.set_property(&name, f)
            } else {
                mpv.set_property(&name, n.to_string().as_str())
            }
        }
        Value::String(s) => mpv.set_property(&name, s.as_str()),
        _ => mpv.set_property(&name, value.to_string().as_str()),
    }
    .map_err(|e| format!("set_property {} error: {:?}", name, e))
}

pub async fn set_properties<R: Runtime>(
    app: &AppHandle<R>,
    properties: HashMap<String, Value>,
) -> Result<(), String> {
    for (k, v) in properties {
        set_property(app, k, v).await?;
    }
    Ok(())
}

pub async fn get_property<R: Runtime>(
    app: &AppHandle<R>,
    name: String,
) -> Result<Value, String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    let Some(mpv) = mpv else {
        return Ok(Value::Null);
    };

    if let Ok(s) = mpv.get_property::<String>(&name) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&s) {
            return Ok(parsed);
        }
        return Ok(Value::String(s));
    }
    if let Ok(b) = mpv.get_property::<bool>(&name) {
        return Ok(Value::Bool(b));
    }
    if let Ok(f) = mpv.get_property::<f64>(&name) {
        return Ok(json!(f));
    }
    if let Ok(i) = mpv.get_property::<i64>(&name) {
        return Ok(json!(i));
    }

    Ok(Value::Null)
}

pub async fn toggle_stats<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<MpvCoreState>();
    let mpv = {
        let guard = state.mpv.lock().unwrap();
        guard.clone()
    };
    if let Some(mpv) = mpv {
        let _ = mpv.command("script-binding", &["stats/display-stats-toggle"]);
    }
    Ok(())
}

pub async fn sync_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_window("main") {
            let size = window.inner_size().map_err(|e| e.to_string())?;
            let geom = MpvGeometry {
                css_left: 0.0,
                css_top: 0.0,
                css_width: size.width as f64,
                css_height: size.height as f64,
                css_view_w: size.width as f64,
                css_view_h: size.height as f64,
            };
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let _ = app.run_on_main_thread(move || {
                let _ = tx.send(crate::mpv_render_mac::resize_to(geom));
            });
            let _ = rx.recv_timeout(Duration::from_millis(300));
        }
    }
    #[cfg(windows)]
    {
        set_geometry(app, 0, 0, 0, 0).await?;
    }
    Ok(())
}

pub async fn set_geometry<R: Runtime>(
    app: &AppHandle<R>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_window("main") {
            let size = window.inner_size().map_err(|e| e.to_string())?;
            let (target_x, target_y, target_w, target_h) = if width == 0 && height == 0 {
                (0.0, 0.0, size.width as f64, size.height as f64)
            } else {
                (x as f64, y as f64, width as f64, height as f64)
            };
            let geom = MpvGeometry {
                css_left: target_x,
                css_top: target_y,
                css_width: target_w,
                css_height: target_h,
                css_view_w: size.width as f64,
                css_view_h: size.height as f64,
            };
            let (tx, rx) = std::sync::mpsc::sync_channel(1);
            let _ = app.run_on_main_thread(move || {
                let _ = tx.send(crate::mpv_render_mac::resize_to(geom));
            });
            let _ = rx.recv_timeout(Duration::from_millis(300));
        }
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOZORDER, SWP_NOACTIVATE, GetClientRect};
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};

        let window = app.get_window("main")
            .ok_or("Main window not found")?;
        let handle = window.window_handle().map_err(|e| e.to_string())?;
        let parent_hwnd = match handle.as_raw() {
            RawWindowHandle::Win32(h) => HWND(h.hwnd.get() as _),
            _ => return Err("Unsupported window handle".to_string()),
        };

        let (tx, ty, tw, th) = if width == 0 && height == 0 {
            let mut rect = windows::Win32::Foundation::RECT::default();
            unsafe { let _ = GetClientRect(parent_hwnd, &mut rect); }
            (0i32, 0i32, (rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32)
        } else {
            (x, y, width, height)
        };

        // Prefer the cached main-player HWND (validated below), and only fall
        // back to a child-window search when the cache is empty or stale. This
        // keeps main geometry deterministic in multiview: the title/class search
        // is only used when there is exactly one mpv window, so it can never
        // grab a secondary slot.
        let state = app.state::<MpvCoreState>();
        let cached = *state.main_hwnd.lock().unwrap();
        let mut target_hwnd = if cached != 0 && is_valid_mpv_hwnd(cached) {
            Some(HWND(cached as _))
        } else {
            if cached != 0 {
                *state.main_hwnd.lock().unwrap() = 0;
            }
            None
        };

        if target_hwnd.is_none() {
            if let Some(found) = crate::mpv_windows::find_mpv_hwnd_by_title(parent_hwnd.0 as isize, "YNOTV_MPV_MAIN") {
                *state.main_hwnd.lock().unwrap() = found;
                target_hwnd = Some(HWND(found as _));
            }
        }

        if let Some(target) = target_hwnd {
            unsafe {
                let _ = SetWindowPos(
                    target,
                    None,
                    tx,
                    ty,
                    tw as i32,
                    th as i32,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
        }
    }
    Ok(())
}

/// True if `hwnd_raw` still points at a live mpv window (class "mpv").
#[cfg(windows)]
fn is_valid_mpv_hwnd(hwnd_raw: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    unsafe {
        let mut class_buf = [0u16; 64];
        let class_len = GetClassNameW(HWND(hwnd_raw as _), &mut class_buf);
        if class_len == 0 {
            return false;
        }
        let class_str = String::from_utf16_lossy(&class_buf[..class_len as usize]);
        class_str.eq_ignore_ascii_case("mpv")
    }
}

pub async fn kill_mpv<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<MpvCoreState>();
    state.is_shutting_down.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("mpv-ready", false);

    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::sync_channel::<()>(1);
        let _ = app.run_on_main_thread(move || {
            let _ = crate::mpv_render_mac::uninstall();
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(Duration::from_millis(1000));
    }

    let prev = {
        let mut guard = state.mpv.lock().unwrap();
        guard.take()
    };

    if let Some(mpv) = prev {
        let _ = mpv.command("quit", &[]);
    }

    #[cfg(windows)]
    {
        if let Some(audio_state) = app.try_state::<crate::audio_capture::AudioCaptureState>() {
            audio_state.stop();
        }
        // The embedded window is destroyed with the mpv instance; drop the
        // cached HWND so the next init re-discovers it.
        *state.main_hwnd.lock().unwrap() = 0;
    }

    state.is_shutting_down.store(false, std::sync::atomic::Ordering::Relaxed);
}
