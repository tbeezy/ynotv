//! Native child WebView for the embedded Jellyfin tab.
//!
//! The Jellyfin web UI is shown inside a child WebView docked below the app's
//! titlebar/toolbar. A Tauri initialization script intercepts playback at the
//! media-element level: Jellyfin 10.10 removed the `window.playbackManager` /
//! `window.playerManager` globals (the manager is now a webpack-module
//! singleton injected into plugins), but *every* Jellyfin web version still
//! ends playback in a real `<video>`/`<audio>` element with the direct-stream
//! URL. The script watches for those elements, encodes the resolved stream URL
//! into `document.title` (a `ynotv-jf:play:` prefix), and blanks Jellyfin's own
//! element so its player cannot run. Rust listens for title changes via
//! `WebviewBuilder::on_document_title_changed` (works cross-origin and needs no
//! remote-domain IPC) and forwards the stream to the frontend
//! (`jellyfin:play` event), which drives it through ynoTV's normal VOD play
//! pipeline — fullscreen transparent player view, Now Playing bar, mpv engine.
//!
//! Once playback starts the frontend **destroys** the child WebView (via
//! `jellyfin_embed_close`) so it can't cover the player surface; the frontend
//! re-creates the WebView (same Jellyfin session — the WebView2 data profile is
//! shared) when playback ends, because returning to the Jellyfin tab mounts the
//! page again. `jellyfin_confirm_playback` records the handoff so the
//! mpv-status idle listener can emit `jellyfin:playback-state { playing: false }`
//! (gated, so the buffering blip on load doesn't count as the stream ending).
//!
//! The child WebView is created with the `unstable` feature (`add_child`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, Listener, LogicalPosition, LogicalSize, Manager, Position, Runtime, Size,
    WebviewUrl,
};

/// Label used for the embedded Jellyfin child webview.
const JELLYFIN_LABEL: &str = "jellyfin-embed";

/// Prefix used to signal a play request from the injected page script. The
/// title itself only carries this tiny marker — the full payload lives in the
/// page (window + localStorage), because the browser truncates document.title
/// at ~4096 chars and large payloads (episode lists, chapters, track URLs) get
/// cut mid-JSON, killing the handoff. Rust responds to the marker by starting
/// a chunked stop-and-wait flush: each payload chunk is written to the title,
/// Rust acks it by evaling the next chunk out, and the last chunk triggers the
/// normal play forwarding.
const PLAY_PREFIX: &str = "ynotv-jf:play:";

/// Prefix of the per-chunk title writes (`ynotv-jf:chunk:<i>/<total>:<data>`).
const CHUNK_PREFIX: &str = "ynotv-jf:chunk:";

/// Max payload bytes per title write (document.title caps at ~4096 chars).
const CHUNK_SIZE: usize = 3000;

/// Evaled when a play marker arrives: splits the pending payload into chunks
/// and writes chunk 0 to the title.
const PLAY_START_CHUNK_SCRIPT: &str = "(function(){var v=window.__ynotvPendingPayload;if(!v){try{v=localStorage.getItem('ynotv_jf_pending')}catch(e){}}if(!v)return;try{localStorage.removeItem('ynotv_jf_pending')}catch(e){}window.__ynotvPendingPayload=v;var c=[];for(var i=0;i<v.length;i+=3000)c.push(v.slice(i,i+3000));window.__ynotvChunks=c;window.__ynotvChunkIndex=0;document.title='ynotv-jf:chunk:0/'+c.length+':'+c[0];})();";

/// Evaled after chunk i arrives: writes chunk i+1 (if any) to the title.
const PLAY_NEXT_CHUNK_SCRIPT: &str = "(function(){var c=window.__ynotvChunks||[];var i=(window.__ynotvChunkIndex||0)+1;if(i>=c.length)return;window.__ynotvChunkIndex=i;document.title='ynotv-jf:chunk:'+i+'/'+c.length+':'+c[i];})();";

/// How long after hiding the webview to wait before an idle mpv status can
/// re-show it. Skips the brief "core idle" blip that precedes buffering of a
/// freshly loaded stream.
const RE_SHOW_COOLDOWN: Duration = Duration::from_secs(4);

/// Minimum interval between `/Sessions/Playing/Progress` reports (the Jellyfin
/// web client itself reports roughly every 10s).
const PROGRESS_INTERVAL: Duration = Duration::from_secs(8);

/// Managed state: remembers whether the Jellyfin child webview is open, when it
/// was last hidden for playback, whether the mpv-status listener is wired, and
/// the active playback-reporting session (when a Jellyfin stream plays through
/// mpv, we report position/pause/stop to the server so resume points and the
/// dashboard stay accurate).
#[derive(Default)]
pub struct JellyfinEmbedState {
    open: Mutex<bool>,
    last_hidden_at: Mutex<Option<Instant>>,
    status_listener_registered: AtomicBool,
    report: Mutex<Option<JellyfinReportSession>>,
    /// Monotonic handoff counter: bumped on every `jellyfin_confirm_playback`
    /// and on playback-ended notifications, so background tasks spawned by a
    /// specific handoff (geometry re-asserts) can detect that playback was
    /// stopped or handed off to a newer stream and bail out.
    confirm_seq: Mutex<u64>,
    /// Reassembled chunks of the in-flight play payload (chunked title flush).
    chunk_parts: Mutex<Vec<String>>,
    /// Controls whether child webview console logs and bridge events are appended
    /// to <app_log_dir>/jellyfin.log.
    debug_logging: AtomicBool,
}

/// Thread-safe helper to append log entries to <app_log_dir>/jellyfin.log
/// when Jellyfin debug logging is enabled.
pub fn append_to_jellyfin_log<R: Runtime>(app: &AppHandle<R>, bytes: &[u8]) {
    let state = app.state::<JellyfinEmbedState>();
    if !state.debug_logging.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(log_dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&log_dir);
        let log_file = log_dir.join("jellyfin.log");

        // Rotate log if it exceeds 10MB to keep disk usage bounded
        if let Ok(meta) = std::fs::metadata(&log_file) {
            if meta.len() > 10 * 1024 * 1024 {
                let bak = log_dir.join("jellyfin.log.bak");
                let _ = std::fs::rename(&log_file, bak);
            }
        }

        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_file)
        {
            use std::io::Write;
            let _ = file.write_all(bytes);
            if !bytes.ends_with(b"\n") {
                let _ = file.write_all(b"\n");
            }
        }
    }
}

/// Formats and records a Rust-side bridge event into jellyfin.log if debug logging is enabled.
pub fn log_jellyfin_bridge<R: Runtime>(app: &AppHandle<R>, level: &str, message: &str) {
    let state = app.state::<JellyfinEmbedState>();
    if !state.debug_logging.load(Ordering::Relaxed) {
        return;
    }
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{}] [BRIDGE] [{}] {}\n", now, level, message);
    append_to_jellyfin_log(app, line.as_bytes());
}

/// Live playback-reporting session for a Jellyfin stream playing through mpv.
#[derive(Clone)]
struct JellyfinReportSession {
    /// e.g. `http://localhost:8096`
    server_base: String,
    api_key: String,
    item_id: String,
    media_source_id: Option<String>,
    /// Resume position carried in by the stream URL (`startTimeTicks`).
    start_ticks: u64,
    /// Client-generated id the server uses to tie start/progress/stop together.
    play_session_id: String,
    /// Position (100ns units) of the last report we actually sent.
    last_report_ticks: u64,
    last_report_at: Instant,
    /// Playing state (as reported to the server) for pause/unpause events.
    last_was_playing: Option<bool>,
    stopped: bool,
}

/// Shared HTTP client for Jellyfin API calls (avoids building one per report).
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Jellyfin item ids are GUIDs (32 hex chars, optionally dashed). Accept any
/// hex/dash-only token with a sane minimum length so short/custom ids don't
/// regress, but reject word-like segments such as a reverse-proxy prefix named
/// "Videos" (p/r/o/x/y are not hex digits).
/// Escape a value for embedding inside a double-quoted JS string literal in the
/// injected INIT_SCRIPT (used for the client identity globals).
fn escape_js_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

fn is_plausible_jellyfin_item_id(seg: &str) -> bool {
    !seg.is_empty()
        && seg.len() >= 8
        && seg.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// Allow only the metadata providers handled by the injected bridge. The
/// page-to-Rust title channel is not trusted, so this validation is repeated
/// here before handing a URL to the system opener.
fn is_allowed_external_metadata_url(url: &str) -> bool {
    let parsed = match tauri::Url::parse(url) {
        Ok(value) => value,
        Err(_) => return false,
    };
    if parsed.scheme() != "https" {
        return false;
    }
    let host = match parsed.host_str() {
        Some(value) => value.trim_start_matches("www.").to_ascii_lowercase(),
        None => return false,
    };
    host == "imdb.com"
        || host.ends_with(".imdb.com")
        || host == "thetvdb.com"
        || host.ends_with(".thetvdb.com")
        || host == "themoviedb.org"
        || host.ends_with(".themoviedb.org")
        || host == "trakt.tv"
        || host.ends_with(".trakt.tv")
}

/// Parse a direct-stream URL like
/// `http://host:8096/Videos/{itemId}/stream.mkv?...&api_key=...&startTimeTicks=...`
/// into `(server_base, api_key, item_id, media_source_id, start_ticks)`.
fn parse_play_url(url: &str) -> Option<(String, String, String, Option<String>, u64)> {
    let u = tauri::Url::parse(url).ok()?;
    let host = u.host_str()?;
    let path = u.path();
    let segs: Vec<&str> = path.split('/').collect();

    // Locate the "Videos" or "Audio" segment dynamically to support
    // reverse-proxy subpaths. A deployment prefix could itself contain a
    // segment literally named "Videos"/"Audio" (e.g.
    // /media/Videos/proxy/Videos/{id}/stream), so only accept a media segment
    // whose following token looks like a Jellyfin item id; otherwise keep
    // scanning for the next media segment.
    let media_pos = segs.iter().enumerate().find_map(|(i, &s)| {
        let is_media = s.eq_ignore_ascii_case("Videos") || s.eq_ignore_ascii_case("Audio");
        let has_id = i + 1 < segs.len() && is_plausible_jellyfin_item_id(segs[i + 1]);
        if is_media && has_id { Some(i) } else { None }
    })?;
    let item_id = segs[media_pos + 1].replace('-', "");

    let prefix = segs[1..media_pos].join("/");
    let subpath = if prefix.is_empty() {
        String::new()
    } else {
        format!("/{}", prefix)
    };

    let server_base = match u.port() {
        Some(p) => format!("{}://{}:{}{}", u.scheme(), host, p, subpath),
        None => format!("{}://{}{}", u.scheme(), host, subpath),
    };
    let pairs: Vec<(String, String)> = u
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let api_key = pairs
        .iter()
        .find(|(k, _)| k == "api_key")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let media_source_id = pairs
        .iter()
        .find(|(k, _)| k == "mediaSourceId")
        .map(|(_, v)| v.clone());
    let start_ticks = pairs
        .iter()
        .find(|(k, _)| k == "startTimeTicks")
        .and_then(|(_, v)| v.parse::<u64>().ok())
        .unwrap_or(0);
    Some((server_base, api_key, item_id, media_source_id, start_ticks))
}

/// The machine's hostname — the same value injected into the embedded webview
/// as `__YNOTV_DEVICE_NAME__` and reported to the Jellyfin dashboard.
fn jellyfin_device_name() -> String {
    sysinfo::System::host_name()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok().filter(|s| !s.trim().is_empty()))
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "ynoTV".to_string())
}

/// MediaBrowser identity header value identifying this app as "ynoTV" on the
/// machine's hostname — mirrors exactly what the embedded webview's rewritten
/// requests carry, so server-side sessions/playback reports attribute to the
/// same "DESKTOP-XXX / ynoTV <version>" device instead of the stale
/// "Jellyfin Web" label stored on the token's device record.
fn jellyfin_identity_header(token: &str) -> String {
    let device = jellyfin_device_name().replace('"', "'");
    format!(
        "MediaBrowser Client=\"ynoTV\", Device=\"{}\", Version=\"{}\", Token=\"{}\"",
        device,
        env!("CARGO_PKG_VERSION"),
        token
    )
}

/// The machine's hostname for the frontend, so its pre-authentication call
/// (AuthenticateByName) can carry the same MediaBrowser identity the embedded
/// webview reports — the Jellyfin server rejects identity-less logins.
#[tauri::command]
pub fn jellyfin_machine_name() -> String {
    jellyfin_device_name()
}

/// Fire-and-forget POST to the Jellyfin session API. Carries the full
/// MediaBrowser identity (not just X-Emby-Token): token-only requests resolve
/// to the device record's stored AppName ("Jellyfin Web" for tokens created
/// before the identity rewrite), which would attach playback reports to a
/// phantom "Jellyfin Web" dashboard session instead of the ynoTV one.
fn post_jellyfin(path: String, server_base: String, api_key: String, body: serde_json::Value) {
    tauri::async_runtime::spawn(async move {
        let url = format!("{}{}", server_base, path);
        let send = http_client()
            .post(&url)
            .header("X-Emby-Token", api_key.clone())
            .header("Authorization", jellyfin_identity_header(&api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;
        if let Err(e) = send {
            log::debug!("[Jellyfin] API report to {} failed: {}", url, e);
        }
    });
}

/// POST /Sessions/Playing — start a playback session (what makes the item show
/// as "now playing" on the server and seeds its resume position).
fn report_start(s: &JellyfinReportSession) {
    let body = serde_json::json!({
        "ItemId": s.item_id,
        "MediaSourceId": s.media_source_id.clone().unwrap_or_default(),
        "PositionTicks": s.start_ticks,
        "IsPaused": false,
        "PlayMethod": "DirectPlay",
        "PlaySessionId": s.play_session_id,
        "PlaybackStartTimeTicks": s.start_ticks,
        "VolumeLevel": 100,
    });
    post_jellyfin(
        "/Sessions/Playing".into(),
        s.server_base.clone(),
        s.api_key.clone(),
        body,
    );
}

/// POST /Sessions/Playing/Progress — periodic position updates + explicit
/// pause/unpause events.
fn report_progress(s: &JellyfinReportSession, pos_ticks: u64, event: &str, is_paused: bool) {
    let body = serde_json::json!({
        "ItemId": s.item_id,
        "MediaSourceId": s.media_source_id.clone().unwrap_or_default(),
        "PositionTicks": pos_ticks,
        "IsPaused": is_paused,
        "PlayMethod": "DirectPlay",
        "PlaySessionId": s.play_session_id,
        "PlaybackStartTimeTicks": s.start_ticks,
        "EventName": event,
    });
    post_jellyfin(
        "/Sessions/Playing/Progress".into(),
        s.server_base.clone(),
        s.api_key.clone(),
        body,
    );
}

/// POST /Sessions/Playing/Stopped — final position when playback ends.
fn report_stopped(s: &JellyfinReportSession, pos_ticks: u64) {
    let body = serde_json::json!({
        "ItemId": s.item_id,
        "MediaSourceId": s.media_source_id.clone().unwrap_or_default(),
        "PositionTicks": pos_ticks,
        "PlaySessionId": s.play_session_id,
        "Failed": false,
    });
    post_jellyfin(
        "/Sessions/Playing/Stopped".into(),
        s.server_base.clone(),
        s.api_key.clone(),
        body,
    );
}

/// Deserialize the play payload that the injected script writes to
/// `document.title`.
#[derive(serde::Deserialize)]
struct PlayPayload {
    url: String,
    #[allow(dead_code)]
    position_ticks: Option<u64>,
    title: Option<String>,
    item_id: Option<String>,
    media_source_id: Option<String>,
    subtitle_stream_id: Option<i64>,
    audio_stream_id: Option<i64>,
    subtitle_url: Option<String>,
    subtitle_tracks: Option<Vec<serde_json::Value>>,
    poster_url: Option<String>,
    audio_tracks: Option<Vec<serde_json::Value>>,
    /// Chapter markers from the item DTO (StartPositionTicks + Name), surfaced
    /// in the ynoTV seek bar during Jellyfin playback.
    chapters: Option<Vec<serde_json::Value>>,
    /// Series/episode context (header pill S/E info + prev/next episode list).
    server_url: Option<String>,
    api_key: Option<String>,
    series_id: Option<String>,
    series_name: Option<String>,
    /// Series-level metadata provider IDs (Imdb/Tmdb/...) captured from the
    /// series item DTO, surfaced so intro-skip can resolve the IMDb ID.
    series_provider_ids: Option<serde_json::Value>,
    series_production_year: Option<i64>,
    /// Item-level metadata provider IDs (Imdb/Tmdb/year) for movie/standalone
    /// plays that have no series — mirrors series_provider_ids so movie
    /// playback can scrobble/intro-resolve with real IDs too.
    item_provider_ids: Option<serde_json::Value>,
    item_production_year: Option<i64>,
    episode_index: Option<i64>,
    episode_parent_index: Option<i64>,
    episode_name: Option<String>,
    episodes: Option<Vec<serde_json::Value>>,
    /// The web client's own play queue at handoff ({ items, index,
    /// playlistId, playlistName }): the authoritative play order when playback
    /// started from a Jellyfin playlist (or album / "play next" queue), so
    /// prev/next and auto-play follow it instead of the series episode list.
    /// Nested field names are camelCase — the value is forwarded verbatim.
    play_queue: Option<serde_json::Value>,
    /// Current Jellyfin user id, so the frontend can resolve item details for
    /// queue entries that were never opened in the page.
    user_id: Option<String>,
    /// Remembered per-item subtitle selections (itemId -> stream index) so
    /// prev/next episodes and re-plays can start with the user's subtitle.
    subtitle_prefs: Option<serde_json::Value>,
    /// Bounded tail of recent bridge diagnostics (piggybacked so the diagnostics
    /// never race the play signal on the document.title channel).
    diags: Option<Vec<serde_json::Value>>,
}

/// Remove an existing Jellyfin embed child webview, if present.
fn close_existing<R: Runtime>(app: &AppHandle<R>) {
    if let Some(wv) = app.get_webview(JELLYFIN_LABEL) {
        let _ = wv.close();
    }
}

/// Wire the one-time app-wide listener that, while a Jellyfin stream plays
/// through mpv, (a) reports position/pause/stop to the Jellyfin API so resume
/// positions and the dashboard stay accurate, and (b) tells the frontend when
/// playback has ended so the Jellyfin page can be restored.
fn ensure_status_listener<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<JellyfinEmbedState>();
    if state
        .status_listener_registered
        .swap(true, Ordering::SeqCst)
    {
        return;
    }

    let listener_app = app.clone();
    let _ = app.listen("mpv-status", move |event| {
        let value = match serde_json::from_str::<serde_json::Value>(event.payload()) {
            Ok(v) => v,
            Err(_) => return,
        };
        let idle = value
            .get("coreIdle")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let playing = value
            .get("playing")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        // mpv reports `core-idle` as true BOTH when the user pauses and when a
        // file reaches its end (--keep-open pauses on the last frame). Only the
        // `eof-reached` property tells those apart, so it gates every "the
        // stream ended" decision below — otherwise a plain pause looks like the
        // playback finished, stops the Jellyfin reporting session and bounces
        // the user back to the Jellyfin tab.
        let eof_reached = value
            .get("eofReached")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let position = value
            .get("position")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        // ---- 1. Jellyfin API progress reporting (only for Jellyfin sessions) ----
        {
            let state = listener_app.state::<JellyfinEmbedState>();
            let mut guard = state.report.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(session) = guard.as_mut() {
                let reported_position_ticks = (position * 10_000_000.0).max(0.0) as u64;
                if reported_position_ticks > 0 {
                    session.last_report_ticks = reported_position_ticks;
                }
                let pos_ticks = session.last_report_ticks;
                if session.stopped {
                    // Stop already sent — drop the session.
                    *guard = None;
                } else if idle && !playing && eof_reached {
                    session.stopped = true;
                    let snap = session.clone();
                    drop(guard);
                    report_stopped(&snap, pos_ticks);
                } else {
                    let now = Instant::now();
                    let since = now.duration_since(session.last_report_at);
                    let was_playing = session.last_was_playing.unwrap_or(true);
                    let event = if playing && !was_playing {
                        Some(("unpause", false))
                    } else if !playing && was_playing {
                        Some(("pause", true))
                    } else if playing && since >= PROGRESS_INTERVAL {
                        Some(("timeupdate", false))
                    } else {
                        None
                    };
                    if let Some((name, is_paused)) = event {
                        session.last_report_at = now;
                        session.last_was_playing = Some(playing);
                        let snap = session.clone();
                        drop(guard);
                        report_progress(&snap, pos_ticks, name, is_paused);
                    }
                }
            }
        }

        // ---- 2. Idle -> playback-ended signal (existing re-show gating) ----
        // A paused stream (no EOF) must not be treated as finished.
        if !idle || playing || !eof_reached {
            return;
        }
        let state = listener_app.state::<JellyfinEmbedState>();
        let was_watching_jellyfin = {
            let mut last = state
                .last_hidden_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let active = match *last {
                Some(t) => t.elapsed() >= RE_SHOW_COOLDOWN,
                None => false,
            };
            if active {
                *last = None;
            }
            active
        };
        if !was_watching_jellyfin {
            return;
        }
        let _ = listener_app.emit(
            "jellyfin:playback-state",
            serde_json::json!({ "playing": false }),
        );
        if let Some(wv) = listener_app.get_webview(JELLYFIN_LABEL) {
            let _ = wv.eval("window.__ynotvOnPlaybackEnded && window.__ynotvOnPlaybackEnded();");
        }
    });
}

/// Open (or re-open) the embedded Jellyfin child WebView at the given logical
/// bounds, with the Jellyfin media-hijack init script injected.
#[tauri::command]
pub async fn jellyfin_embed_open<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    debug_logging: Option<bool>,
) -> Result<(), String> {
    close_existing(&app);

    let debug_enabled = debug_logging.unwrap_or(false);
    let state = app.state::<JellyfinEmbedState>();
    state.debug_logging.store(debug_enabled, Ordering::Relaxed);

    ensure_status_listener(&app);

    let window = app
        .get_window("main")
        .ok_or("main window not found")?;

    let parsed_url = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return Err("Jellyfin URL must use http:// or https://".into());
    }

    log_jellyfin_bridge(
        &app,
        "INFO",
        &format!(
            "Opening embedded webview: url={}, bounds=({}, {}, {}, {}), debug_logging={}",
            url, x, y, width, height, debug_enabled
        ),
    );

    // Client identity reported to the Jellyfin server. By default the embedded
    // webview shows up on the dashboard as "Edge Chromium / Jellyfin Web <web
    // version>"; rewrite the X-Emby-Authorization header in the INIT_SCRIPT so
    // it identifies as "ynoTV <app version>" on the machine's hostname instead
    // (mirroring how Jellyfin Media Player appears on the dashboard).
    let app_version = app.package_info().version.to_string();
    let device_name = jellyfin_device_name();

    let init_script = format!(
        "window.__YNOTV_DEBUG_LOGGING__ = {};\n\
         window.__YNOTV_APP_VERSION__ = \"{}\";\n\
         window.__YNOTV_DEVICE_NAME__ = \"{}\";\n\
         {}",
        debug_enabled,
        escape_js_string(&app_version),
        escape_js_string(&device_name),
        INIT_SCRIPT
    );

    let webview_builder =
        tauri::webview::WebviewBuilder::new(JELLYFIN_LABEL, WebviewUrl::External(parsed_url))
            .devtools(true)
            .initialization_script(&init_script)
            .on_document_title_changed(move |wv, title| {
                if let Some(raw) = title.strip_prefix("ynotv-jf:diag:") {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(raw.trim()) {
                        let _ = wv.app_handle().emit("jellyfin:bridge-diagnostic", payload);
                    }
                } else if let Some(raw) = title.strip_prefix("ynotv-jf:open:") {
                    // External metadata link (IMDb/TMDb/TVDb/Trakt) clicked inside
                    // the Jellyfin page — open it in the system browser instead of
                    // navigating the embed. Format: <nonce>:<url>.
                    if let Some((_, url)) = raw.split_once(':') {
                        let url = url.trim();
                        if is_allowed_external_metadata_url(url) {
                            log_jellyfin_bridge(&wv.app_handle(), "INFO", &format!("Opening external link: {}", url));
                            let _ = tauri_plugin_opener::open_url(url, None::<&str>);
                        } else {
                            log::warn!("[Jellyfin] Rejected external link with unsupported URL");
                            log_jellyfin_bridge(&wv.app_handle(), "WARN", &format!("Rejected external link with unsupported URL: {}", url));
                        }
                    }
                } else if let Some(raw) = title.strip_prefix(CHUNK_PREFIX) {
                    // `i/total:<data>` — one piece of the play payload. The
                    // title channel truncates at ~4096 chars, so the page
                    // streams the payload here in chunks; each chunk is acked
                    // by evaling the next one out, and the last chunk triggers
                    // the normal play forwarding.
                    let (meta, data) = match raw.split_once(':') {
                        Some((m, d)) => (m, d),
                        None => (raw, ""),
                    };
                    let mut parts = meta.split('/');
                    let idx: usize = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                    let total: usize = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
                    let state = wv.app_handle().state::<JellyfinEmbedState>();
                    let mut acc = state
                        .chunk_parts
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if idx == 0 {
                        acc.clear();
                    }
                    if acc.len() <= idx {
                        acc.resize(idx + 1, String::new());
                    }
                    acc[idx] = data.to_string();
                    if idx + 1 < total {
                        let _ = wv.eval(PLAY_NEXT_CHUNK_SCRIPT);
                    } else {
                        let full = acc.concat();
                        drop(acc);
                        match serde_json::from_str::<PlayPayload>(full.trim()) {
                            Ok(payload) => {
                                // Forward the captured stream URL + metadata to
                                // the frontend, which drives it through the
                                // app's normal VOD play pipeline (fullscreen
                                // player view, Now Playing bar, mpv error
                                // handling). The frontend destroys the child
                                // WebView once playback starts.
                                let app = wv.app_handle().clone();
                                let _ = app.emit(
                                    "jellyfin:play",
                                    serde_json::json!({
                                        "url": payload.url,
                                        "title": payload.title.clone().unwrap_or_default(),
                                        "itemId": payload.item_id,
                                        "mediaSourceId": payload.media_source_id,
                                        "subtitleStreamId": payload.subtitle_stream_id,
                                        "audioStreamId": payload.audio_stream_id,
                                        "subtitleUrl": payload.subtitle_url,
                                        "subtitleTracks": payload.subtitle_tracks,
                                        "posterUrl": payload.poster_url,
                                        "audioTracks": payload.audio_tracks,
                                        "chapters": payload.chapters,
                                        "serverUrl": payload.server_url,
                                        "apiKey": payload.api_key,
                                        "seriesId": payload.series_id,
                                        "seriesName": payload.series_name,
                                        "seriesProviderIds": payload.series_provider_ids,
                                        "seriesProductionYear": payload.series_production_year,
                                        "itemProviderIds": payload.item_provider_ids,
                                        "itemProductionYear": payload.item_production_year,
                                        "episodeIndex": payload.episode_index,
                                        "episodeParentIndex": payload.episode_parent_index,
                                        "episodeName": payload.episode_name,
                                        "episodes": payload.episodes,
                                        "queue": payload.play_queue,
                                        "userId": payload.user_id,
                                        "subtitlePrefs": payload.subtitle_prefs,
                                    }),
                                );
                                // Ride-along diagnostics: forward each buffered
                                // item so the main DevTools keeps its
                                // [Jellyfin bridge] log without diagnostics
                                // ever writing to the title.
                                if let Some(diags) = payload.diags {
                                    for item in diags {
                                        let _ = app.emit("jellyfin:bridge-diagnostic", item);
                                    }
                                }
                                log::info!("[Jellyfin] Play request forwarded to frontend");
                                log_jellyfin_bridge(
                                    &app,
                                    "INFO",
                                    &format!(
                                        "Play request forwarded to frontend: item_id={:?}, title={:?}",
                                        payload.item_id, payload.title
                                    ),
                                );
                            }
                            Err(e) => {
                                log::error!("[Jellyfin] Failed to parse play payload: {}", e);
                                log_jellyfin_bridge(&wv.app_handle(), "ERROR", &format!("Failed to parse play payload: {}", e));
                            }
                        }
                    }
                } else if title.starts_with(PLAY_PREFIX) {
                    // Marker only: the page kept the full payload in window +
                    // localStorage (document.title truncates at ~4096 chars,
                    // which used to cut the JSON mid-string and stall
                    // playback). Start the chunked flush.
                    log_jellyfin_bridge(&wv.app_handle(), "INFO", "Play signal detected; requesting payload chunks");
                    if let Ok(mut guard) = wv
                        .app_handle()
                        .state::<JellyfinEmbedState>()
                        .chunk_parts
                        .lock()
                    {
                        guard.clear();
                    }
                    let _ = wv.eval(PLAY_START_CHUNK_SCRIPT);
                }
            });

    let child = window
        .add_child(
            webview_builder,
            Position::Logical(LogicalPosition::new(x, y)),
            Size::Logical(LogicalSize::new(width, height)),
        )
        .map_err(|e| e.to_string())?;

    child
        .set_auto_resize(false)
        .map_err(|e| e.to_string())?;

    if let Ok(mut guard) = app.state::<JellyfinEmbedState>().open.lock() {
        *guard = true;
    }

    log::info!(
        "[Jellyfin] Embed opened at {}x{} @ ({}, {})",
        width,
        height,
        x,
        y
    );
    Ok(())
}

/// Reposition / resize the embedded Jellyfin child WebView (e.g. on window
/// resize or when the toolbar height changes).
#[tauri::command]
pub async fn jellyfin_embed_resize<R: Runtime>(
    app: AppHandle<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let child = app
        .get_webview(JELLYFIN_LABEL)
        .ok_or("Jellyfin embed not open")?;

    child
        .set_position(Position::Logical(LogicalPosition::new(x, y)))
        .map_err(|e| e.to_string())?;
    child
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close the embedded Jellyfin child WebView.
#[tauri::command]
pub async fn jellyfin_embed_close<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    close_existing(&app);
    if let Ok(mut guard) = app.state::<JellyfinEmbedState>().open.lock() {
        *guard = false;
    }
    log_jellyfin_bridge(&app, "INFO", "Embedded webview closed");
    Ok(())
}

/// Hide or reveal the embedded Jellyfin child WebView without destroying it.
#[tauri::command]
pub async fn jellyfin_embed_set_visible<R: Runtime>(
    app: AppHandle<R>,
    visible: bool,
) -> Result<(), String> {
    if let Some(child) = app.get_webview(JELLYFIN_LABEL) {
        if visible {
            child.show().map_err(|e| e.to_string())?;
        } else {
            child.hide().map_err(|e| e.to_string())?;
            if let Some(main_win) = app.get_window("main") {
                let _ = main_win.set_focus();
            }
        }
    }
    Ok(())
}

/// True when the embedded Jellyfin child WebView currently exists.
#[tauri::command]
pub async fn jellyfin_embed_is_open<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    Ok(app.get_webview(JELLYFIN_LABEL).is_some())
}

/// Called by the frontend after it has driven the handed-off stream into mpv
/// (via the app's normal play pipeline). Records the handoff time so the
/// mpv-status idle listener can gate its "playback ended" signal, starts a
/// Jellyfin playback-reporting session for the stream (resume positions +
/// dashboard), and re-asserts the full-window video surface geometry so the
/// freshly loaded stream is guaranteed sized/positioned.
#[tauri::command]
pub async fn jellyfin_confirm_playback<R: Runtime>(
    app: AppHandle<R>,
    url: String,
) -> Result<(), String> {
    let state = app.state::<JellyfinEmbedState>();
    *state
        .last_hidden_at
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    log_jellyfin_bridge(&app, "INFO", &format!("Playback confirmed for URL: {}", url));
    if let Some(main_win) = app.get_window("main") {
        let _ = main_win.set_focus();
    }

    // Each handoff gets a fresh sequence number so the geometry re-asserts
    // below can tell when playback was stopped or replaced by a newer stream.
    // Bumped unconditionally (before URL parsing) — the geometry retries must
    // not depend on whether the URL parses for server progress reporting, or
    // streams with unparseable URLs (Jellyfin Live TV, some proxies) would
    // silently lose the retries.
    let seq = {
        let mut guard = state.confirm_seq.lock().unwrap_or_else(|e| e.into_inner());
        *guard = guard.wrapping_add(1);
        *guard
    };

    match parse_play_url(&url) {
        Some((server_base, api_key, item_id, media_source_id, start_ticks)) => {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let session = JellyfinReportSession {
                server_base,
                api_key,
                item_id: item_id.clone(),
                media_source_id,
                start_ticks,
                play_session_id: format!("ynotv-{}", now_ms),
                last_report_ticks: start_ticks,
                last_report_at: Instant::now(),
                last_was_playing: Some(true),
                stopped: false,
            };

            // Close out any previous unreported session first.
            let mut guard = state.report.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = guard.take() {
                if !prev.stopped {
                    let prev_snap = prev.clone();
                    drop(guard);
                    report_stopped(&prev_snap, prev_snap.last_report_ticks);
                    guard = state.report.lock().unwrap_or_else(|e| e.into_inner());
                }
            }
            *guard = Some(session.clone());
            drop(guard);

            report_start(&session);
            log::info!("[Jellyfin] Reporting playback for item {}", item_id);
        }
        None => {
            log::warn!("[Jellyfin] Could not parse play URL — skipping server progress reporting");
        }
    }

    // The embedded mpv window is physically resized (SetWindowPos) to the pane
    // that was showing video last — e.g. the EPG 3-column preview box — and mpv
    // re-fits that child window asynchronously once the new stream's first
    // frame lands. A single reset here can race that re-fit (or run before the
    // mpv window exists on a cold start), leaving the freshly handed-off video
    // confined to the old pane until some later resize event re-asserts it
    // (the user dragging the window). Re-assert full-window geometry on delayed
    // passes that outlast mpv's async re-fit, mirroring the multiview swap
    // flow. Each pass bails once the Jellyfin playback session is gone
    // (stopped / replaced), so late passes can't resize unrelated playback.
    let _ = crate::mpv_set_geometry(app.clone(), 0, 0, 0, 0).await;
    let retry_app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Sleep *deltas*, so the passes fire at ~0.2s / 0.6s / 1.4s / 3.0s
        // after the handoff (a cumulative loop would drift to 5.2s and keep
        // asserting geometry long after the stream settled). Each pass bails
        // the moment the confirm sequence moves — playback stopped, or a newer
        // stream (next episode / different video) took over.
        for delay_ms in [200u64, 400, 800, 1600] {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let state = retry_app.state::<JellyfinEmbedState>();
            let seq_now = *state.confirm_seq.lock().unwrap_or_else(|e| e.into_inner());
            if seq_now != seq {
                return;
            }
            let _ = crate::mpv_set_geometry(retry_app.clone(), 0, 0, 0, 0).await;
        }
    });
    Ok(())
}

/// Tell the injected page script to un-hijack its media elements and let
/// Jellyfin's own web player take over (used when the mpv handoff failed, so
/// the page stays fully usable).
#[tauri::command]
pub async fn jellyfin_embed_reenable<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(wv) = app.get_webview(JELLYFIN_LABEL) {
        let _ = wv.eval("window.__ynotvJfReenable && window.__ynotvJfReenable()");
    }
    Ok(())
}

/// Forward a spatial navigation action ('up', 'down', 'left', 'right', 'select', 'back', 'enter', 'blur')
/// from the main window into the embedded Jellyfin child WebView.
#[tauri::command]
pub async fn jellyfin_embed_nav<R: Runtime>(app: AppHandle<R>, action: String) -> Result<bool, String> {
    if let Some(wv) = app.get_webview(JELLYFIN_LABEL) {
        let script = format!(
            "window.__ynotvJfNav && window.__ynotvJfNav({});",
            serde_json::to_string(&action).unwrap_or_else(|_| "\"\"".into())
        );
        let _ = wv.eval(&script);
        return Ok(true);
    }
    Ok(false)
}

/// Forward a focus/blur signal from the embedded Jellyfin child WebView to the
/// main window (spatial-navigation bridge). Routed over IPC rather than
/// document.title so it can never interleave with the chunked play-payload
/// stream — WebView2 coalesces rapid title changes, and any competing title
/// write can clobber a chunk and stall the playback handoff.
#[tauri::command]
pub async fn jellyfin_embed_focus_signal<R: Runtime>(
    app: AppHandle<R>,
    kind: String,
    direction: Option<String>,
) -> Result<(), String> {
    let main_win = app.get_window("main").ok_or("Main window not found")?;
    match kind.as_str() {
        "blur" => {
            let _ = main_win.set_focus();
            let _ = main_win.emit("jellyfin:nav-blur", direction.unwrap_or_default());
        }
        "focus" => {
            let _ = main_win.emit("jellyfin:nav-focus-child", ());
        }
        _ => {}
    }
    Ok(())
}

/// Notify the child WebView that playback in ynoTV has stopped or ended,
/// dismissing any pending loading spinner/overlay and returning the page to the
/// active item view.
#[tauri::command]
pub async fn jellyfin_embed_notify_playback_ended<R: Runtime>(
    app: AppHandle<R>,
    position_ticks: Option<u64>,
    target_item_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<JellyfinEmbedState>();
    // Cancel any in-flight geometry re-asserts spawned by this handoff, and
    // clear the re-show gate timestamp so a stale value can't later re-trigger
    // the "playback ended" signal.
    {
        let mut seq = state.confirm_seq.lock().unwrap_or_else(|e| e.into_inner());
        *seq = seq.wrapping_add(1);
    }
    *state
        .last_hidden_at
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = None;
    let session_to_stop = {
        let mut guard = state.report.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(session) = guard.as_mut() {
            if let Some(ticks) = position_ticks {
                if ticks > 0 {
                    session.last_report_ticks = ticks;
                }
            }
            if !session.stopped {
                session.stopped = true;
                let snap = session.clone();
                let pos = session.last_report_ticks;
                Some((snap, pos))
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some((snap, pos)) = session_to_stop {
        let url = format!("{}{}", snap.server_base, "/Sessions/Playing/Stopped");
        let body = serde_json::json!({
            "ItemId": snap.item_id,
            "MediaSourceId": snap.media_source_id.clone().unwrap_or_default(),
            "PositionTicks": pos,
            "PlaySessionId": snap.play_session_id,
            "Failed": false,
        });
        let _ = http_client()
            .post(&url)
            .header("X-Emby-Token", snap.api_key.clone())
            .header("Authorization", jellyfin_identity_header(&snap.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;
    }

    if let Some(wv) = app.get_webview(JELLYFIN_LABEL) {
        let script = match target_item_id {
            Some(ref id) if !id.trim().is_empty() => {
                let clean = id.trim().replace('\'', "\\'");
                format!("window.__ynotvOnPlaybackEnded && window.__ynotvOnPlaybackEnded('{}');", clean)
            }
            _ => "window.__ynotvOnPlaybackEnded && window.__ynotvOnPlaybackEnded();".to_string(),
        };
        let _ = wv.eval(&script);
    }
    log_jellyfin_bridge(
        &app,
        "INFO",
        &format!(
            "Playback ended notification processed: ticks={:?}, target_item_id={:?}",
            position_ticks, target_item_id
        ),
    );
    Ok(())
}

/// Dynamically toggle Jellyfin debug logging while the child webview is running.
#[tauri::command]
pub async fn jellyfin_set_debug_logging<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<(), String> {
    let state = app.state::<JellyfinEmbedState>();
    state.debug_logging.store(enabled, Ordering::Relaxed);
    log_jellyfin_bridge(&app, "INFO", &format!("Debug logging changed: {}", enabled));
    if let Some(child) = app.get_webview(JELLYFIN_LABEL) {
        let script = format!("window.__ynotvSetDebugLogging && window.__ynotvSetDebugLogging({});", enabled);
        let _ = child.eval(&script);
    }
    Ok(())
}

/// Append a batch of webview log lines (formatted by the embedded page) to
/// jellyfin.log. The page batches and bounds its queue; this only writes when
/// debug logging is enabled.
#[tauri::command]
pub async fn jellyfin_append_logs<R: Runtime>(
    app: AppHandle<R>,
    lines: Vec<String>,
) -> Result<(), String> {
    let state = app.state::<JellyfinEmbedState>();
    if !state.debug_logging.load(Ordering::Relaxed) {
        return Ok(());
    }
    let mut out = String::new();
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    append_to_jellyfin_log(&app, out.as_bytes());
    Ok(())
}

/// Open DevTools for the embedded Jellyfin child webview.
#[tauri::command]
pub async fn jellyfin_embed_open_devtools<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    if let Some(child) = app.get_webview(JELLYFIN_LABEL) {
        child.open_devtools();
        log_jellyfin_bridge(&app, "INFO", "DevTools opened via command");
        Ok(())
    } else {
        Err("Jellyfin window is not open".into())
    }
}

/// Open jellyfin.log in the system's default text viewer.
#[tauri::command]
pub async fn jellyfin_open_log_file<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&log_dir);
    let log_file = log_dir.join("jellyfin.log");
    if !log_file.exists() {
        let _ = std::fs::File::create(&log_file);
    }
    tauri_plugin_opener::open_path(log_file.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Open the directory containing jellyfin.log in the file manager.
#[tauri::command]
pub async fn jellyfin_open_log_dir<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&log_dir);
    tauri_plugin_opener::open_path(log_dir.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Clear the contents of jellyfin.log.
#[tauri::command]
pub async fn jellyfin_clear_log_file<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let log_file = log_dir.join("jellyfin.log");
    if log_file.exists() {
        std::fs::write(&log_file, b"").map_err(|e| e.to_string())?;
    }
    log_jellyfin_bridge(&app, "INFO", "Log file cleared by user");
    Ok(())
}

/// The init script injected into the Jellyfin page before it boots.
///
/// Jellyfin 10.10 removed the `window.playbackManager` / `window.playerManager`
/// globals (the manager is a webpack-module singleton now), so the old
/// manager-hook approach no longer intercepts anything. Instead we hook at the
/// media-element level — the one choke point every Jellyfin web version has:
///
///  1. Patch `HTMLMediaElement.prototype.play` and watch the DOM (MutationObserver
///     + polling) for `<video>` / `<audio>` elements.
///  2. When an element's `currentSrc` points at the Jellyfin server
///     (`/Videos/...` / `/Audio/...` direct stream), capture the URL, write it
///     to `document.title` (with our `ynotv-jf:play:` prefix), pause + blank the
///     element, and keep it paused via a guard interval so Jellyfin's own
///     player cannot actually play.
///  3. `play()` on a hijacked element returns a pending promise so Jellyfin's
///     player waits forever instead of surfacing a playback error.
///
/// Non-Jellyfin media (e.g. YouTube trailers in embeds, blob:/MSE sources) is
/// left untouched. If the Rust side fails to load the stream in mpv it calls
/// `window.__ynotvJfReenable()` to un-hijack elements for the next attempt.
const INIT_SCRIPT: &str = r##"
(function () {
    if (window.__ynotvJfHooked) return;
    window.__ynotvJfHooked = true;

    // -------------------------------------------------------------------------
    // Debug Logging & DevTools Hotkeys
    // -------------------------------------------------------------------------
    var debugLoggingActive = !!(typeof window !== 'undefined' && window.__YNOTV_DEBUG_LOGGING__);
    var logQueue = [];
    var logFlushTimer = null;

    function formatLogArg(arg) {
        if (arg === null) return 'null';
        if (arg === undefined) return 'undefined';
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return arg.stack || arg.message || String(arg);
        try {
            return JSON.stringify(arg);
        } catch (e) {
            return String(arg);
        }
    }

    function pushLog(level, args) {
        if (!debugLoggingActive) return;
        var parts = [];
        for (var i = 0; i < args.length; i++) {
            parts.push(formatLogArg(args[i]));
        }
        var msg = parts.join(' ');
        var now = new Date();
        var y = now.getFullYear();
        var mo = String(now.getMonth() + 1);
        if (mo.length < 2) mo = '0' + mo;
        var d = String(now.getDate());
        if (d.length < 2) d = '0' + d;
        var h = String(now.getHours());
        if (h.length < 2) h = '0' + h;
        var mi = String(now.getMinutes());
        if (mi.length < 2) mi = '0' + mi;
        var s = String(now.getSeconds());
        if (s.length < 2) s = '0' + s;
        var ms = String(now.getMilliseconds());
        while (ms.length < 3) ms = '0' + ms;
        var ts = y + '-' + mo + '-' + d + ' ' + h + ':' + mi + ':' + s + '.' + ms;
        var line = '[' + ts + '] [WEB] [' + level + '] ' + msg;
        logQueue.push(line);
        if (logQueue.length > 500) {
            logQueue.shift();
        }
        if (!logFlushTimer && typeof setTimeout === 'function') {
            logFlushTimer = setTimeout(flushLogs, 250);
        }
    }

    function flushLogs() {
        logFlushTimer = null;
        if (!debugLoggingActive || !logQueue.length) return;
        var batch = logQueue.slice();
        logQueue = [];
        try {
            if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
                window.__TAURI_INTERNALS__.invoke('jellyfin_append_logs', { lines: batch }).catch(function () {});
            }
        } catch (e) {}
    }

    // Hook console methods
    if (typeof console !== 'undefined') {
        var origLog = console.log;
        var origInfo = console.info;
        var origWarn = console.warn;
        var origError = console.error;
        var origDebug = console.debug;

        console.log = function () {
            pushLog('INFO', arguments);
            if (origLog) { try { origLog.apply(console, arguments); } catch (e) {} }
        };
        console.info = function () {
            pushLog('INFO', arguments);
            if (origInfo) { try { origInfo.apply(console, arguments); } catch (e) {} }
        };
        console.warn = function () {
            pushLog('WARN', arguments);
            if (origWarn) { try { origWarn.apply(console, arguments); } catch (e) {} }
        };
        console.error = function () {
            pushLog('ERROR', arguments);
            if (origError) { try { origError.apply(console, arguments); } catch (e) {} }
        };
        console.debug = function () {
            pushLog('DEBUG', arguments);
            if (origDebug) { try { origDebug.apply(console, arguments); } catch (e) {} }
        };
    }

    // Capture uncaught window errors and unhandled promise rejections
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('error', function (e) {
            if (!debugLoggingActive) return;
            var err = (e && (e.error || e.message)) || 'Unknown Error';
            var file = (e && e.filename) || '';
            var line = (e && e.lineno) || 0;
            var col = (e && e.colno) || 0;
            pushLog('ERROR', ['Uncaught exception:', err, 'at', file + ':' + line + ':' + col]);
        });
        window.addEventListener('unhandledrejection', function (e) {
            if (!debugLoggingActive) return;
            var reason = (e && e.reason) || 'Unknown Rejection';
            pushLog('ERROR', ['Unhandled promise rejection:', reason]);
        });

        // F12 or Ctrl+Shift+I hotkey to open devtools — only when debug
        // logging is enabled. The Settings -> Jellyfin "Inspect with DevTools"
        // button calls the Rust command directly and stays available always.
        window.addEventListener('keydown', function (e) {
            if (!debugLoggingActive) return;
            if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i'))) {
                try {
                    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
                        window.__TAURI_INTERNALS__.invoke('jellyfin_embed_open_devtools').catch(function () {});
                    }
                } catch (err) {}
            }
        });
    }

    // Expose dynamic toggle so frontend settings change can enable/disable logging without reload
    if (typeof window !== 'undefined') {
        window.__ynotvSetDebugLogging = function (enabled) {
            debugLoggingActive = !!enabled;
            window.__YNOTV_DEBUG_LOGGING__ = debugLoggingActive;
            if (debugLoggingActive) {
                pushLog('INFO', ['[Jellyfin Embed] Debug logging enabled']);
            }
        };
    }

    var SIGNAL = "ynotv-jf:play:";
    var lastSignalKey = null;
    var diagSeq = 0;
    var diagBuf = [];          // bounded; flushed inside the next play payload
    var DIAG_BUF_MAX = 400;
    var playbackInfo = null;   // latest PlaybackInfo response body
    var playbackInfoByItem = {}; // cleanItemId -> PlaybackInfo response body
    var lastPlaybackInfoAt = 0;
    var lastHlsStream = null;  // { url: string, itemId: string, at: number } captured from HLS request
    var playQueueCapture = null;  // { items: [{id, rawId, playlistItemId}], itemId, at } the page reported as playing
    var playlistCapture = null;   // { id, name, items, byPlaylistItemId, at } from Playlists/{id}/Items
    // The queue-capture writers live in the network-patch closure (that is where
    // the page's session reports and playlist responses pass through); it hands
    // them over here so the test-only internals seam can drive them.
    var rememberPlayQueueRef = null;
    var rememberPlaylistItemsRef = null;

    // ---------------------------------------------------------------------
    // Play-queue capture
    // ---------------------------------------------------------------------
    // A Jellyfin playlist (or an album, or "play next" additions) is played by
    // handing the whole list to the web client's playback manager, so only the
    // page knows the real play order. The page reports that queue to the server
    // on every playback start/progress update (`NowPlayingQueue` plus the
    // current `PlaylistItemId`); this bridge reads those reports on their way
    // past (it suppresses them, ynoTV does its own reporting) so the handoff
    // can carry the queue. Without it the app can only guess "next episode in
    // this series", which is exactly wrong when the queue is a playlist that
    // mixes series, movies and episodes.
    function normalizeQueueItem(it) {
        try {
            if (!it) return null;
            var id = String(it.Id || '').replace(/-/g, '');
            if (!id) return null;
            return {
                id: id,
                rawId: it.Id || '',
                playlistItemId: it.PlaylistItemId || '',
                name: it.Name || '',
                type: it.Type || '',
                mediaType: it.MediaType || '',
                seriesId: it.SeriesId || '',
                seriesName: it.SeriesName || '',
                indexNumber: it.IndexNumber != null ? it.IndexNumber : null,
                parentIndexNumber: it.ParentIndexNumber != null ? it.ParentIndexNumber : null,
                runTimeTicks: it.RunTimeTicks != null ? it.RunTimeTicks : null
            };
        } catch (e) { return null; }
    }

    // Enrich one queued entry with whatever the bridge already knows: the item
    // DTO cache (every item DTO the page fetched) and, when the queue is a real
    // playlist, that playlist's own item list (full DTOs with names/S-E).
    function describeQueueEntry(entry, playlist) {
        var dto = itemById[entry.id] || null;
        var listItem = (playlist && playlist.byPlaylistItemId && entry.playlistItemId)
            ? playlist.byPlaylistItemId[entry.playlistItemId] || null
            : null;
        var src = listItem || dto || null;
        return {
            id: entry.id,
            rawId: entry.rawId,
            playlistItemId: entry.playlistItemId,
            name: (src && src.name) || '',
            type: (src && src.type) || '',
            mediaType: (src && src.mediaType) || '',
            seriesId: (src && src.seriesId) || '',
            seriesName: (src && src.seriesName) || '',
            indexNumber: src && src.indexNumber != null ? src.indexNumber : null,
            parentIndexNumber: src && src.parentIndexNumber != null ? src.parentIndexNumber : null,
            runTimeTicks: src && src.runTimeTicks != null ? src.runTimeTicks : (entry.runTimeTicks != null ? entry.runTimeTicks : null)
        };
    }

    // The playlist whose items the page most recently loaded, but only when the
    // reported queue really is that playlist: every playlist entry carries its
    // own server-side PlaylistItemId, and client-built queues use synthetic
    // "playlistItemN" ids, so a genuine match hits most of the queue.
    function matchCapturedPlaylist(queueItems) {
        try {
            if (!playlistCapture || !playlistCapture.byPlaylistItemId) return null;
            var hits = 0;
            for (var i = 0; i < queueItems.length; i++) {
                var pid = queueItems[i].playlistItemId;
                if (pid && playlistCapture.byPlaylistItemId[pid]) hits++;
            }
            return hits >= Math.min(2, queueItems.length) ? playlistCapture : null;
        } catch (e) { return null; }
    }

    // The play queue for the item being handed off, or null when the page is
    // playing a single item / no queue is known (the caller then falls back to
    // the series episode list as before). The queue the page reported wins; the
    // playlist it loaded is the fallback for the very first play, before that
    // report has been seen.
    // How long a playlist the page loaded is still assumed to be what the next
    // play comes from. The page hands the whole playlist to its player when a
    // playlist item is started, so this covers the first play after the queue
    // report itself has been read (and any play the page did not report at all).
    var PLAYLIST_TRUST_MS = 30 * 60 * 1000;

    // Fallback queue: the playlist whose items the page loaded, when the item
    // being played is one of them.
    function playlistAsQueue(itemId) {
        try {
            if (!playlistCapture || !playlistCapture.items || playlistCapture.items.length < 2) return null;
            if (Date.now() - (playlistCapture.at || 0) > PLAYLIST_TRUST_MS) return null;
            var clean = itemId ? String(itemId).replace(/-/g, '') : '';
            if (!clean) return null;
            var idx = -1;
            for (var i = 0; i < playlistCapture.items.length; i++) {
                if (playlistCapture.items[i].id === clean) { idx = i; break; }
            }
            if (idx < 0) return null;
            var items = [];
            for (var j = 0; j < playlistCapture.items.length; j++) {
                items.push(describeQueueEntry(playlistCapture.items[j], playlistCapture));
            }
            return {
                items: items,
                index: idx,
                playlistId: playlistCapture.id,
                playlistName: playlistCapture.name || ''
            };
        } catch (e) { return null; }
    }

    function readPlayQueue(itemId) {
        try {
            var fromPlaylist = playlistAsQueue(itemId);
            var capture = playQueueCapture;
            if (!capture || !capture.items || capture.items.length < 2) return fromPlaylist;
            if (Date.now() - (capture.at || 0) > 6 * 60 * 60 * 1000) return fromPlaylist;
            var clean = itemId ? String(itemId).replace(/-/g, '') : '';
            var idx = -1;
            for (var i = 0; i < capture.items.length; i++) {
                if (clean && capture.items[i].id === clean) { idx = i; break; }
            }
            // The report's own ItemId is only a fallback for a handoff with no
            // id at all: matching the item being played is what proves the queue
            // belongs to THIS playback.
            if (idx < 0 && !clean && capture.itemId) {
                for (var k = 0; k < capture.items.length; k++) {
                    if (capture.items[k].id === capture.itemId) { idx = k; break; }
                }
            }
            if (idx < 0) return fromPlaylist;
            var playlist = matchCapturedPlaylist(capture.items);
            var items = [];
            for (var j = 0; j < capture.items.length; j++) {
                items.push(describeQueueEntry(capture.items[j], playlist));
            }
            return {
                items: items,
                index: idx,
                playlistId: playlist ? playlist.id : null,
                playlistName: playlist ? (playlist.name || '') : ''
            };
        } catch (e) { return null; }
    }

    function playbackInfoFor(targetItemId) {
        try {
            if (targetItemId) {
                var clean = String(targetItemId).replace(/-/g, '');
                if (playbackInfoByItem[clean]) return playbackInfoByItem[clean];
                // A requested item with no cached PlaybackInfo response must NOT
                // fall through to the latest global response — that can belong to
                // a different item and misroute MediaSources/stream selection.
                return null;
            }
        } catch (e) {}
        return playbackInfo;
    }

    // Mirrors the Rust parse_play_url: scan the path for a "Videos"/"Audio"
    // segment whose following token looks like a Jellyfin item id
    // (hex/dash-only, >= 8 chars), so a reverse-proxy prefix that itself
    // contains a segment named "Videos"/"Audio" (e.g.
    // /media/Videos/proxy/Videos/{id}/stream) is skipped in favor of the real
    // media segment. Returns { type, itemId } (itemId dash-stripped) or null.
    function findMediaSegment(url) {
        try {
            var s = String(url || '').split(/[?#]/)[0];
            var segs = s.split('/');
            for (var i = 0; i < segs.length - 1; i++) {
                var seg = segs[i];
                if (!seg) continue;
                var lower = seg.toLowerCase();
                if (lower !== 'videos' && lower !== 'audio') continue;
                var idSeg = segs[i + 1] || '';
                if (idSeg.length >= 8 && /^[0-9a-fA-F-]+$/.test(idSeg)) {
                    return { type: lower === 'audio' ? 'Audio' : 'Videos', itemId: idSeg.replace(/-/g, '') };
                }
            }
        } catch (e) {}
        return null;
    }

    function extractMediaItemId(url) {
        var m = findMediaSegment(url);
        return m ? m.itemId : null;
    }

    // Diagnostics NEVER touch document.title — that is the *signal* channel,
    // and WebView2 coalesces rapid title changes, so any competing title write
    // (diag fires on every media event / 300ms poll / matching fetch) can
    // clobber the play payload before Rust's on_document_title_changed fires.
    // diag() logs to the page console and keeps a bounded in-page buffer that
    // is piggybacked onto the next play payload, so the native/frontend side
    // still sees the diagnostics that matter (the ones leading to a handoff).
    function diag(kind, data) {
        try {
            console.log('[ynoTV Jellyfin bridge]', kind, data || '');
            diagBuf.push({ kind: kind, at: Date.now(), data: data || null });
            if (diagBuf.length > DIAG_BUF_MAX) diagBuf.splice(0, diagBuf.length - DIAG_BUF_MAX);
        } catch (e) {}
    }

    // Compact tail of recent diagnostics for the play payload (bounded so the
    // title signal stays small; oversized entries are dropped until it fits).
    function diagTail() {
        var out = [];
        var budget = 2500;
        for (var i = Math.max(0, diagBuf.length - 14); i < diagBuf.length; i++) {
            var item = diagBuf[i];
            var copy = { kind: item.kind, at: item.at };
            var raw = item.data;
            if (raw !== null && raw !== undefined) {
                var s;
                try { s = typeof raw === 'string' ? raw : JSON.stringify(raw); } catch (e) { s = String(raw); }
                if (s && s.length > 300) s = s.slice(0, 300);
                if (s) copy.data = s;
            }
            var len = JSON.stringify(copy).length;
            if (len > budget) continue;
            budget -= len;
            out.push(copy);
        }
        return out;
    }

    try {
        console.log('[ynoTV Jellyfin bridge] injected');
        window.dispatchEvent(new CustomEvent('ynotv-jellyfin-bridge-ready'));
        diag('injected');
    } catch (e) {}
    var lastSignalAt = 0;
    var warned = false;

    function warn(msg) {
        if (!warned && window.console && console.warn) {
            warned = true;
            console.warn("[ynotv-jf]", msg);
        }
    }

    function itemTitle() {
        try {
            var t = (document.title || "").replace(/\s*-\s*Jellyfin\s*$/i, "");
            return (t || "").trim();
        } catch (e) {
            return "";
        }
    }

    function signal(payload) {
        try {
            console.log('[ynoTV Jellyfin bridge] candidate stream', payload);
            // document.title is truncated at ~4096 chars by the browser, which
            // used to cut large payloads (episode lists, chapters, track URLs)
            // mid-JSON and stall playback. Keep the full payload in the page
            // (window + localStorage) and write a tiny marker; Rust streams it
            // out in chunks, acking each one via eval.
            var json;
            try { json = JSON.stringify(payload); } catch (e) { return; }
            try { localStorage.setItem('ynotv_jf_pending', json); } catch (e) {}
            window.__ynotvPendingPayload = json;
            // Playback is now owned by ynoTV: stop remembering SPA routes until
            // the page is recreated fresh.
            window.__ynotvPlaybackActive = true;
            document.title = SIGNAL;
        } catch (e) {}
    }



    // Remember the subtitle the user actually watched with per Jellyfin item
    // (stream index keyed by item id, persisted in this webview's own
    // Subtitle stream preferences are persisted across reloads and pages
    // (keyed in localStorage) so a later play/restart of the same item or series
    // starts with the same subtitle language/track.
    var SUBPREF_KEY = 'ynotv_jf_subprefs';
    var SUBPREF_DETAIL_KEY = 'ynotv_jf_subprefs_detail';
    var LAST_SUBPREF_KEY = 'ynotv_jf_last_subpref';

    function readSubPref(itemId) {
        try {
            if (!itemId) return null;
            var raw = localStorage.getItem(SUBPREF_KEY);
            if (!raw) return null;
            var map = JSON.parse(raw);
            var v = map && map[itemId];
            return typeof v === 'number' ? v : null;
        } catch (e) { return null; }
    }

    function readAllSubPrefs() {
        try {
            var raw = localStorage.getItem(SUBPREF_KEY);
            if (!raw) return {};
            var map = JSON.parse(raw);
            return map && typeof map === 'object' ? map : {};
        } catch (e) { return {}; }
    }

    function rememberSubPref(itemId, streamIndex) {
        try {
            if (!itemId || streamIndex == null) return;
            var map = {};
            var raw = localStorage.getItem(SUBPREF_KEY);
            if (raw) { try { var parsed = JSON.parse(raw); if (parsed && typeof parsed === 'object') map = parsed; } catch (e) {} }
            map[itemId] = streamIndex;
            try { localStorage.setItem(SUBPREF_KEY, JSON.stringify(map)); } catch (e) {}
        } catch (e) {}
    }

    function cleanSubLabel(label) {
        if (!label || typeof label !== 'string') return '';
        return label
            .replace(/\[.*?\]|\(.*?\)/g, '')
            .replace(/\b(default|forced|subrip|vtt|ass|pgs|embedded|external)\b/gi, '')
            .replace(/[-_–—]/g, ' ')
            .trim()
            .toLowerCase();
    }

    function makePrefKey(itemId, pref) {
        if (!pref) return '';
        return (itemId || '') + '_' + (pref.isOff ? 'off' : (pref.cleanLabel || pref.label || pref.streamIndex || ''));
    }

    function rememberSubPrefDetailed(itemId, seriesId, streamIndex, label) {
        try {
            if (itemId && streamIndex != null) rememberSubPref(itemId, streamIndex);
            var isOff = (streamIndex === -1);
            var clean = isOff ? 'off' : cleanSubLabel(label);
            var detail = {
                streamIndex: streamIndex,
                isOff: isOff,
                label: label || '',
                cleanLabel: clean,
                exactItemId: itemId || '',
                seriesId: seriesId || '',
                savedAt: Date.now()
            };
            var map = {};
            var raw = localStorage.getItem(SUBPREF_DETAIL_KEY);
            if (raw) { try { var p = JSON.parse(raw); if (p && typeof p === 'object') map = p; } catch (e) {} }
            if (itemId) map[itemId] = detail;
            if (seriesId) map['series_' + seriesId] = detail;
            try { localStorage.setItem(SUBPREF_DETAIL_KEY, JSON.stringify(map)); } catch (e) {}
            try { localStorage.setItem(LAST_SUBPREF_KEY, JSON.stringify(detail)); } catch (e) {}
        } catch (e) {}
    }

    function getRememberedSubPref(itemId, seriesId) {
        try {
            var raw = localStorage.getItem(SUBPREF_DETAIL_KEY);
            var map = raw ? JSON.parse(raw) : null;
            if (map) {
                if (itemId && map[itemId]) return map[itemId];
                if (seriesId && map['series_' + seriesId]) return map['series_' + seriesId];
            }
            var lastRaw = localStorage.getItem(LAST_SUBPREF_KEY);
            if (lastRaw) {
                var last = JSON.parse(lastRaw);
                if (last && typeof last === 'object') return last;
            }
            if (itemId) {
                var simple = readSubPref(itemId);
                if (simple !== null) return { streamIndex: simple, isOff: simple === -1, label: '', cleanLabel: '', exactItemId: itemId };
            }
        } catch (e) {}
        return null;
    }

    // Resolve an item's series id via a bounded fetch. The item details page
    // carries no data-seriesid, and itemById may not be populated yet on a
    // cold deep link, so the dropdown change handler uses this to attach the
    // remembered subtitle track to the series (next-episode carry-over).
    function fetchSeriesId(itemId, cb) {
        try {
            var uid = currentUserId();
            if (!itemId || !uid) { if (cb) cb(null); return; }
            var origin = serverBase();
            var url = origin + "/Users/" + encodeURIComponent(uid) + "/Items/" + encodeURIComponent(itemId);
            var tok = accessToken();
            if (tok) url += "?api_key=" + encodeURIComponent(tok);
            fetch(url).then(function (r) { if (!r.ok) return null; return r.json(); }).then(function (b) {
                if (b && b.Id) { rememberItemDto(b); if (cb) cb(b.SeriesId || null); }
                else if (cb) cb(null);
            }).catch(function () { if (cb) cb(null); });
        } catch (e) { if (cb) cb(null); }
    }

    // Active subtitle choices made by the user in the Jellyfin web UI (dropdowns / selects)
    var activeSubChoiceByItem = {};
    var lastPlaybackInfoReq = null; // { itemId, subtitleStreamIndex, audioStreamIndex, mediaSourceId, at }

    function recordPlaybackInfoReq(url, body) {
        try {
            var u = String(url || '');
            if (!/PlaybackInfo/i.test(u)) return;
            var itemId = null;
            var m = u.match(/\/Items\/([^/?#]+)/i);
            if (m) itemId = m[1];
            var subIdx = null;
            var audioIdx = null;
            var mediaSourceId = null;

            var qm = u.match(/[?&]SubtitleStreamIndex=(-?\d+)/i);
            if (qm && qm[1] !== '') subIdx = parseInt(qm[1], 10);
            var qma = u.match(/[?&]AudioStreamIndex=(-?\d+)/i);
            if (qma && qma[1] !== '') audioIdx = parseInt(qma[1], 10);
            var qms = u.match(/[?&]MediaSourceId=([^&]+)/i);
            if (qms) mediaSourceId = decodeURIComponent(qms[1]);

            if (body) {
                var parsed = null;
                if (typeof body === 'string') {
                    try { parsed = JSON.parse(body); } catch (e) {}
                } else if (typeof body === 'object') {
                    parsed = body;
                }
                if (parsed) {
                    if (parsed.Id && !itemId) itemId = String(parsed.Id);
                    if (parsed.ItemId && !itemId) itemId = String(parsed.ItemId);
                    if (parsed.SubtitleStreamIndex !== undefined && parsed.SubtitleStreamIndex !== null) {
                        var si = parseInt(parsed.SubtitleStreamIndex, 10);
                        if (!isNaN(si)) subIdx = si;
                    }
                    if (parsed.AudioStreamIndex !== undefined && parsed.AudioStreamIndex !== null) {
                        var ai = parseInt(parsed.AudioStreamIndex, 10);
                        if (!isNaN(ai)) audioIdx = ai;
                    }
                    if (parsed.MediaSourceId) mediaSourceId = String(parsed.MediaSourceId);
                }
            }
            lastPlaybackInfoReq = {
                itemId: itemId,
                subtitleStreamIndex: subIdx,
                audioStreamIndex: audioIdx,
                mediaSourceId: mediaSourceId,
                at: Date.now()
            };
            // NOTE: this request is NOT persisted as a remembered preference.
            // jellyfin-web re-populates the subtitle dropdown with the server
            // default on every load, so a PlaybackInfo request reflects the web
            // default as often as a real user pick. Persisting here clobbered the
            // user's remembered track with the default on the next play. The
            // dropdown `change` listener (a genuine user interaction) is the
            // only writer of remembered preferences, and this request is only
            // used as a transient hint for the current play.
            diag('playback-info-request', lastPlaybackInfoReq);
        } catch (e) {}
    }

    function restoreSubSelect(sel) {
        try {
            if (!sel || !sel.options) return;
            // jellyfin-web (re)builds the <option> list with innerHTML on every
            // media load, so track the option count: when it changes the select
            // was repopulated with the server defaults and the applied marker
            // must be cleared so the remembered track is re-applied.
            var optCount = sel.options.length;
            if (sel.__ynotvOptionCount !== optCount) {
                sel.__ynotvOptionCount = optCount;
                sel.__ynotvAppliedKey = null;
            }
            if (optCount === 0) {
                // Options arrive async after the select node is inserted — wait
                // for a later pass instead of marking the select as applied.
                sel.__ynotvRestorePending = true;
                return;
            }
            sel.__ynotvRestorePending = false;
            // Never overwrite a dropdown the user has manually clicked / touched on this page
            if (sel.__ynotvUserInteracted) return;

            var page = sel.closest ? sel.closest('[data-role="page"], .page') : null;
            var itemId = resolveContextItemId(sel);
            var item = itemId ? (itemById[itemId] || null) : null;
            var seriesId = (item && item.seriesId) || (page && (page.getAttribute('data-seriesid') || (page.dataset && page.dataset.seriesid))) || null;

            var pref = getRememberedSubPref(itemId, seriesId);
            if (!pref) return;

            var prefKey = makePrefKey(itemId, pref);
            if (sel.__ynotvAppliedKey === prefKey) return;

            var matchIdx = -1;
            if (pref.isOff) {
                for (var i = 0; i < sel.options.length; i++) {
                    var v = parseInt(sel.options[i].value, 10);
                    if (v === -1 || /off|none|desactivad|desligad|aus/i.test(sel.options[i].textContent || '')) {
                        matchIdx = i;
                        break;
                    }
                }
            } else {
                // 1. Exact index match if same item
                if (pref.streamIndex != null && pref.streamIndex >= 0 && itemId && pref.exactItemId === itemId) {
                    for (var j = 0; j < sel.options.length; j++) {
                        if (parseInt(sel.options[j].value, 10) === pref.streamIndex) {
                            matchIdx = j;
                            break;
                        }
                    }
                }
                // 2. Clean label / title match
                if (matchIdx === -1 && (pref.cleanLabel || pref.label)) {
                    var targetClean = (pref.cleanLabel || '').toLowerCase().trim();
                    var targetFull = (pref.label || '').toLowerCase().trim();
                    for (var k = 0; k < sel.options.length; k++) {
                        var optRaw = sel.options[k].textContent || '';
                        var optClean = cleanSubLabel(optRaw);
                        var optFull = optRaw.toLowerCase().trim();
                        if (targetClean && optClean && (optClean === targetClean || optClean.indexOf(targetClean) >= 0 || targetClean.indexOf(optClean) >= 0)) {
                            matchIdx = k;
                            break;
                        } else if (targetFull && (optFull === targetFull || optFull.indexOf(targetFull) >= 0 || targetFull.indexOf(optFull) >= 0)) {
                            matchIdx = k;
                            break;
                        }
                    }
                }
            }

            if (matchIdx >= 0) {
                sel.__ynotvAppliedKey = prefKey;
                if (sel.selectedIndex !== matchIdx) {
                    sel.__ynotvProgrammatic = true;
                    sel.selectedIndex = matchIdx;
                    var chosenVal = parseInt(sel.options[matchIdx].value, 10);
                    if (itemId && !isNaN(chosenVal)) {
                        activeSubChoiceByItem[itemId] = chosenVal;
                    }
                    sel.__ynotvProgrammatic = false;
                }
            }
        } catch (e) {}
    }

    function checkAndRestoreAllSubSelects() {
        try {
            var selects = document.querySelectorAll('select.selectSubtitles, select#selectSubtitles, select[data-track="subtitle"], .selectSubtitles select');
            for (var i = 0; i < selects.length; i++) {
                restoreSubSelect(selects[i]);
            }
        } catch (e) {}
    }

    try {
        var markUserTouch = function (e) {
            try {
                var target = e.target;
                if (!target || target.tagName !== 'SELECT') return;
                var isSub = (target.className && /\bselectSubtitles\b/i.test(target.className)) ||
                            target.id === 'selectSubtitles' ||
                            target.getAttribute('data-track') === 'subtitle' ||
                            target.name === 'selectSubtitles' ||
                            (target.closest && target.closest('.selectSubtitles'));
                if (isSub) {
                    target.__ynotvUserInteracted = true;
                }
            } catch (err) {}
        };

        document.addEventListener('pointerdown', markUserTouch, true);
        document.addEventListener('mousedown', markUserTouch, true);
        document.addEventListener('keydown', markUserTouch, true);

        document.addEventListener('change', function (e) {
            try {
                var target = e.target;
                if (!target || target.tagName !== 'SELECT' || target.__ynotvProgrammatic) return;
                var isSub = (target.className && /\bselectSubtitles\b/i.test(target.className)) ||
                            target.id === 'selectSubtitles' ||
                            target.getAttribute('data-track') === 'subtitle' ||
                            target.name === 'selectSubtitles' ||
                            (target.closest && target.closest('.selectSubtitles'));
                if (isSub) {
                    target.__ynotvUserInteracted = true;
                    var val = parseInt(target.value, 10);
                    if (!isNaN(val)) {
                        var selectedOpt = target.options[target.selectedIndex];
                        var optText = selectedOpt ? (selectedOpt.textContent || '') : '';
                        var page = target.closest ? target.closest('[data-role="page"], .page') : null;
                        var itemId = resolveContextItemId(target);
                        var item = itemId ? (itemById[itemId] || null) : null;
                        var seriesId = (item && item.seriesId) || (page && (page.getAttribute('data-seriesid') || (page.dataset && page.dataset.seriesid))) || null;
                        if (itemId) {
                            activeSubChoiceByItem[itemId] = val;
                            rememberSubPrefDetailed(itemId, seriesId, val, optText);
                            if (!seriesId) {
                                // Details page has no data-seriesid and itemById
                                // may be cold; resolve the series so the next
                                // episode of the same show inherits this track.
                                fetchSeriesId(itemId, function (sid) {
                                    if (!sid || sid === seriesId) return;
                                    var cur = getRememberedSubPref(itemId, null);
                                    if (cur && cur.streamIndex === val && (cur.isOff === (val === -1))) {
                                        rememberSubPrefDetailed(itemId, sid, val, optText);
                                    }
                                });
                            }
                        } else {
                            rememberSubPrefDetailed(null, seriesId, val, optText);
                        }
                        var pref = getRememberedSubPref(itemId, seriesId);
                        target.__ynotvAppliedKey = makePrefKey(itemId, pref);
                        diag('in-page-sub-select-change', { itemId: itemId, seriesId: seriesId, val: val, text: optText });
                    }
                }
            } catch (err) {}
        }, true);

        var subObserver = new MutationObserver(function (mutations) {
            for (var m = 0; m < mutations.length; m++) {
                var mut = mutations[m];
                if (mut.addedNodes && mut.addedNodes.length) {
                    for (var n = 0; n < mut.addedNodes.length; n++) {
                        var node = mut.addedNodes[n];
                        if (node.nodeType === 1) {
                            if (node.tagName === 'SELECT' || (node.querySelector && node.querySelector('select.selectSubtitles, select#selectSubtitles, select[data-track="subtitle"]'))) {
                                checkAndRestoreAllSubSelects();
                                return;
                            }
                        }
                    }
                }
            }
        });
        subObserver.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener('hashchange', function () {
            setTimeout(checkAndRestoreAllSubSelects, 150);
            setTimeout(checkAndRestoreAllSubSelects, 500);
        });
        document.addEventListener('viewshow', function () {
            setTimeout(checkAndRestoreAllSubSelects, 100);
            setTimeout(checkAndRestoreAllSubSelects, 400);
        });
        // jellyfin-web inserts the subtitle <select> node first and fills in its
        // <option>s a moment later (innerHTML), so a single run at insertion time
        // can never restore. Re-check periodically while a subtitle select is in
        // the DOM; restoreSubSelect self-retires (option-count change + pending
        // flag) and stops as soon as it applies or the user touches the select.
        setInterval(function () { checkAndRestoreAllSubSelects(); }, 400);
    } catch (e) {}

    // Resolve the Jellyfin item id a subtitle select belongs to. The dropdowns
    // live on pages that carry no data-itemid attribute, so fall back through
    // the URL hash, the currently-playing stream URL, and the last known
    // PlaybackInfo request — in that order.
    function resolveContextItemId(target) {
        try {
            var page = target && target.closest ? target.closest('[data-role="page"], .page') : null;
            if (page) {
                var pid = page.getAttribute('data-itemid') || (page.dataset && page.dataset.itemid) ||
                          page.getAttribute('data-id') || (page.dataset && page.dataset.id);
                if (pid) return String(pid).replace(/-/g, '').toLowerCase();
            }
            var hm = (location.hash || '').match(/[?&]id=([^&]+)/i);
            if (hm && hm[1]) {
                try { return decodeURIComponent(hm[1]).replace(/-/g, '').toLowerCase(); }
                catch (e) { return String(hm[1]).replace(/-/g, '').toLowerCase(); }
            }
            var vids = document.querySelectorAll ? document.querySelectorAll('video,audio') : [];
            for (var i = 0; i < vids.length; i++) {
                var s = (vids[i].currentSrc || vids[i].getAttribute('src') || '') || '';
                var mid = extractMediaItemId(s);
                if (mid) return String(mid).replace(/-/g, '').toLowerCase();
            }
            if (lastPlaybackInfoReq && lastPlaybackInfoReq.itemId) {
                return String(lastPlaybackInfoReq.itemId).replace(/-/g, '').toLowerCase();
            }
        } catch (e) {}
        return null;
    }

    function getInPageSubtitleSelection(itemId) {
        try {
            if (itemId && activeSubChoiceByItem[itemId] !== undefined) {
                return activeSubChoiceByItem[itemId];
            }
            var selects = document.querySelectorAll('select.selectSubtitles, select#selectSubtitles, select[data-track="subtitle"], .selectSubtitles select');
            for (var i = 0; i < selects.length; i++) {
                var sel = selects[i];
                var val = parseInt(sel.value, 10);
                if (!isNaN(val)) return val;
            }
        } catch (e) {}
        return null;
    }

    function describeMedia(elem, event) {
        try {
            return {
                event: event,
                tag: elem.tagName,
                src: elem.src || '',
                currentSrc: elem.currentSrc || '',
                attrSrc: elem.getAttribute('src') || '',
                readyState: elem.readyState,
                networkState: elem.networkState,
                currentTime: elem.currentTime
            };
        } catch (e) { return { event: event }; }
    }

    function pickApiClient() {
        return window.ApiClient ||
            window.apiClient ||
            (window.connectionManager && window.connectionManager.apiClient) ||
            null;
    }

    function serverOrigin() {
        try {
            var api = pickApiClient();
            if (api && typeof api.serverAddress === "function") {
                var a = api.serverAddress();
                if (a) { try { return new URL(a).origin; } catch (e) {} }
            }
        } catch (e) {}
        try { return new URL(window.location.origin).origin; } catch (e) {}
        return window.location.origin;
    }

    function serverBase() {
        try {
            var api = pickApiClient();
            if (api && typeof api.serverAddress === "function") {
                var a = api.serverAddress();
                if (a) return a.replace(/\/+$/, '');
            }
        } catch (e) {}
        try {
            var loc = window.location;
            if (loc && loc.origin) {
                var p = loc.pathname || '';
                var m = p.match(/^(.*?)\/(?:web|index\.html)/i);
                if (m && m[1]) return (loc.origin + m[1]).replace(/\/+$/, '');
                return loc.origin.replace(/\/+$/, '');
            }
        } catch (e) {}
        return window.location.origin;
    }

    function subtitleStreamInfo(elem, src) {
        try {
            var api = pickApiClient();
            diag('subtitle-metadata-scan', { hasApi: !!api, trackCount: elem && elem.textTracks ? elem.textTracks.length : 0 });
            var itemId = null;
            var mediaSourceId = null;
            var selected = null;
            // Jellyfin exposes the playback options on the media element in
            // some versions; use them when available, otherwise derive the
            // external subtitle URL from the selected track's src.
            var tracks = elem && elem.textTracks ? elem.textTracks : [];
            for (var i = 0; i < tracks.length; i++) {
                if (tracks[i].mode === 'showing' && tracks[i].src) {
                    selected = tracks[i];
                    break;
                }
            }
            if (!selected && tracks.length) selected = tracks[0];
            var subtitleUrl = selected && selected.src ? selected.src : null;
            // `src` is the URL captured before blankMedia() wiped the element,
            // so the item/mediaSource can always be derived from it.
            var raw = src || (elem && (elem.currentSrc || elem.src || '')) || '';
            if (raw.indexOf('blob:') === 0 && lastHlsStream) raw = lastHlsStream.url;
            itemId = extractMediaItemId(raw);
            var sourceMatch = raw.match(/[?&]mediaSourceId=([^&]+)/i);
            if (!itemId && lastPlaybackInfoReq && lastPlaybackInfoReq.itemId) {
                itemId = String(lastPlaybackInfoReq.itemId).replace(/-/g, '');
            }
            if (!itemId) {
                var ctxId = resolveContextItemId(elem);
                if (ctxId) itemId = String(ctxId).replace(/-/g, '');
            }
            var pInfo1 = playbackInfoFor(itemId);
            if (!mediaSourceId && pInfo1 && pInfo1.MediaSources && pInfo1.MediaSources[0]) {
                mediaSourceId = pInfo1.MediaSources[0].Id || null;
            }
            if (!mediaSourceId && itemId) mediaSourceId = itemId;
            var subtitleTracks = [];
            // Jellyfin renders external tracks as <track> elements. Preserve
            // every track so the native MPV selector can expose them later.
            var nodes = elem && elem.querySelectorAll ? elem.querySelectorAll('track') : [];
            for (var j = 0; j < nodes.length; j++) {
                var node = nodes[j];
                var kind = (node.kind || '').toLowerCase();
                if (kind && kind !== 'subtitles' && kind !== 'captions') continue;
                var delivery = node.src || '';
                if (delivery && delivery.indexOf('api_key=') === -1) {
                    var token = accessToken();
                    if (token) delivery += (delivery.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(token);
                }
                subtitleTracks.push({
                    index: j,
                    title: node.label || '',
                    lang: node.srclang || '',
                    isExternal: true,
                    deliveryUrl: delivery,
                    selected: node.default === true,
                    default: node.default === true
                });
            }
            return { itemId: itemId, mediaSourceId: mediaSourceId, subtitleUrl: subtitleUrl, subtitleStreamId: null, subtitleTracks: subtitleTracks };
        } catch (e) { return {}; }
    }

    // Metadata derived from the captured PlaybackInfo response — the same data
    // Jellyfin's web player uses, and what jellyfin-desktop feeds into its mpv
    // player: poster URL (derived from the item), audio stream list, and the
    // authoritative subtitle track list (absolute delivery URLs + api_key).
    function playbackInfoMeta(elem, capturedSrc) {
        var meta = { posterUrl: null, audioTracks: [], subtitleTracks: [], subtitleStreamId: null, audioStreamId: null };
        try {
            var itemId = null;
            var raw = capturedSrc || (elem && (elem.currentSrc || elem.src || '')) || '';
            if (raw.indexOf('blob:') === 0 && lastHlsStream) raw = lastHlsStream.url;
            itemId = extractMediaItemId(raw);
            if (!itemId && lastPlaybackInfoReq && lastPlaybackInfoReq.itemId) {
                itemId = String(lastPlaybackInfoReq.itemId).replace(/-/g, '');
            }
            if (!itemId) {
                var ctxId2 = resolveContextItemId(elem);
                if (ctxId2) itemId = String(ctxId2).replace(/-/g, '');
            }
            var pInfo2 = playbackInfoFor(itemId);
            var src = null;
            if (pInfo2 && pInfo2.MediaSources && pInfo2.MediaSources.length) {
                src = pInfo2.MediaSources[0];
            }
            if (itemId) {
                var token = accessToken();
                var base = serverBase();
                meta.posterUrl = base + '/Items/' + itemId + '/Images/Primary?maxWidth=400&quality=90' + (token ? '&api_key=' + encodeURIComponent(token) : '');
            }
            if (src && Array.isArray(src.MediaStreams)) {
                for (var i = 0; i < src.MediaStreams.length; i++) {
                    var st = src.MediaStreams[i];
                    if (!st || !st.Type) continue;
                    if (st.Type === 'Audio') {
                        meta.audioTracks.push({
                            index: st.Index != null ? st.Index : i,
                            title: st.DisplayTitle || st.Title || '',
                            lang: st.Language || '',
                            codec: st.Codec || '',
                            isDefault: st.IsDefault === true
                        });
                    } else if (st.Type === 'Subtitle') {
                        var isExt = st.IsExternal === true;
                        var delivery = (st.DeliveryUrl || '').trim();
                        if (delivery && delivery.indexOf('://') === -1) delivery = serverBase() + (delivery.charAt(0) === '/' ? '' : '/') + delivery;
                        if (delivery && delivery.indexOf('api_key=') === -1) {
                            var t2 = accessToken();
                            if (t2) delivery += (delivery.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(t2);
                        }
                        meta.subtitleTracks.push({
                            index: st.Index != null ? st.Index : i,
                            title: st.DisplayTitle || st.Title || '',
                            lang: st.Language || '',
                            codec: st.Codec || '',
                            isExternal: isExt,
                            deliveryUrl: isExt ? delivery : '',
                            selected: false,
                            default: false
                        });
                    }
                }

                // Determine the authoritative target subtitle stream index
                var targetSubIdx = null;

                // 1. Explicit in-memory choice recorded by a user `change` event
                //    on a subtitle dropdown during THIS page session. Highest
                //    priority — it is always a genuine user pick.
                if (itemId && activeSubChoiceByItem[itemId] !== undefined && activeSubChoiceByItem[itemId] !== null) {
                    targetSubIdx = activeSubChoiceByItem[itemId];
                }

                // 2. In-page live dropdown value right on the screen. If the user
                //    is looking at a page where a subtitle is visibly selected,
                //    that takes precedence over old remembered preferences from
                //    unrelated media.
                if (targetSubIdx === null) {
                    var inPageChoice = getInPageSubtitleSelection(itemId);
                    if (inPageChoice !== null && inPageChoice !== undefined) {
                        targetSubIdx = inPageChoice;
                    }
                }

                // 3. Remembered preference for this exact item, then series, then
                //    the most recent pick.
                if (targetSubIdx === null) {
                    var itMeta = itemId ? (itemById[itemId] || null) : null;
                    var sId = itMeta && itMeta.seriesId ? itMeta.seriesId : null;
                    var rem = getRememberedSubPref(itemId, sId);
                    if (rem) {
                        if (rem.isOff) {
                            targetSubIdx = -1;
                        } else if (rem.streamIndex != null && rem.streamIndex >= 0 && itemId && rem.exactItemId === itemId) {
                            targetSubIdx = rem.streamIndex;
                        } else if (rem.cleanLabel || rem.label) {
                            var tTargetClean = (rem.cleanLabel || '').toLowerCase().trim();
                            var tTargetFull = (rem.label || '').toLowerCase().trim();
                            for (var stI = 0; stI < meta.subtitleTracks.length; stI++) {
                                var track = meta.subtitleTracks[stI];
                                var trackTitle = (track.title || '').toLowerCase().trim();
                                var trackClean = trackTitle.replace(/\[.*?\]|\(.*?\)/g, '').trim();
                                var trackLang = (track.lang || '').toLowerCase().trim();
                                if ((tTargetClean && (trackClean === tTargetClean || trackClean.indexOf(tTargetClean) >= 0 || tTargetClean.indexOf(trackClean) >= 0)) ||
                                    (tTargetFull && (trackTitle === tTargetFull || trackTitle.indexOf(tTargetFull) >= 0 || tTargetFull.indexOf(trackTitle) >= 0)) ||
                                    (trackLang && tTargetClean && (trackLang === tTargetClean || tTargetClean.indexOf(trackLang) >= 0))) {
                                    targetSubIdx = track.index;
                                    break;
                                }
                            }
                        }
                    }
                }

                // 4. PlaybackInfo request (if recent < 15s and matches itemId).
                //    lastPlaybackInfoReq.itemId is stored unstripped (GUID from
                //    the request URL/body), so normalize it the same way
                //    playbackInfoMeta's itemId is derived before comparing.
                if (targetSubIdx === null && lastPlaybackInfoReq && (Date.now() - lastPlaybackInfoReq.at < 15000)) {
                    var reqItem = lastPlaybackInfoReq.itemId ? String(lastPlaybackInfoReq.itemId).replace(/-/g, '') : null;
                    if (reqItem ? (!itemId || reqItem === itemId) : (!itemId || Date.now() - lastPlaybackInfoReq.at < 5000)) {
                        if (lastPlaybackInfoReq.subtitleStreamIndex !== null && lastPlaybackInfoReq.subtitleStreamIndex !== undefined) {
                            targetSubIdx = lastPlaybackInfoReq.subtitleStreamIndex;
                        }
                    }
                }

                // 5. Query param on stream URL (SubtitleStreamIndex)
                if (targetSubIdx === null) {
                    var smTxt = String(capturedSrc || '');
                    var sm = smTxt.match(/[?&]SubtitleStreamIndex=(-?\d+)/i);
                    if (sm && sm[1] !== '') {
                        var smIdx = parseInt(sm[1], 10);
                        if (!isNaN(smIdx)) targetSubIdx = smIdx;
                    }
                }

                // 6. Active textTrack on element
                if (targetSubIdx === null && elem && elem.textTracks) {
                    for (var tt = 0; tt < elem.textTracks.length; tt++) {
                        if (elem.textTracks[tt].mode === 'showing') {
                            var tUrl = elem.textTracks[tt].src;
                            for (var stIdx = 0; stIdx < meta.subtitleTracks.length; stIdx++) {
                                if (meta.subtitleTracks[stIdx].isExternal && meta.subtitleTracks[stIdx].deliveryUrl && tUrl && meta.subtitleTracks[stIdx].deliveryUrl.indexOf(tUrl) >= 0) {
                                    targetSubIdx = meta.subtitleTracks[stIdx].index;
                                    break;
                                }
                            }
                            break;
                        }
                    }
                }

                // 7. Server's DefaultSubtitleStreamIndex from PlaybackInfo response
                if (targetSubIdx === null && src.DefaultSubtitleStreamIndex != null) {
                    targetSubIdx = src.DefaultSubtitleStreamIndex;
                }

                // Apply the resolved subtitle index
                if (targetSubIdx !== null && targetSubIdx !== undefined) {
                    meta.subtitleStreamId = targetSubIdx;
                    var matchedLabel = '';
                    if (targetSubIdx === -1) {
                        // Explicitly None / off
                        for (var k = 0; k < meta.subtitleTracks.length; k++) {
                            meta.subtitleTracks[k].selected = false;
                            meta.subtitleTracks[k].default = false;
                        }
                    } else {
                        for (var kk = 0; kk < meta.subtitleTracks.length; kk++) {
                            var isMatch = (meta.subtitleTracks[kk].index === targetSubIdx);
                            meta.subtitleTracks[kk].selected = isMatch;
                            meta.subtitleTracks[kk].default = isMatch;
                            if (isMatch) {
                                matchedLabel = meta.subtitleTracks[kk].title || '';
                                if (meta.subtitleTracks[kk].isExternal && meta.subtitleTracks[kk].deliveryUrl) {
                                    meta.subtitleUrl = meta.subtitleTracks[kk].deliveryUrl;
                                }
                            }
                        }
                    }
                    if (itemId) {
                        var itm = itemById[itemId] || null;
                        var sId2 = itm && itm.seriesId ? itm.seriesId : null;
                        rememberSubPrefDetailed(itemId, sId2, targetSubIdx, matchedLabel);
                    }
                }
            }
            var targetAudioIdx = null;
            // Same item-scoping as the subtitle selection above: only use the
            // request-derived audio index when it is fresh and (when both item
            // ids are known) belongs to the item being played. The request's
            // itemId is normalized (dash-stripped) like itemId above.
            if (lastPlaybackInfoReq && (Date.now() - lastPlaybackInfoReq.at < 15000)) {
                var audioReqItem = lastPlaybackInfoReq.itemId ? String(lastPlaybackInfoReq.itemId).replace(/-/g, '') : null;
                if (audioReqItem ? (!itemId || audioReqItem === itemId) : (!itemId || Date.now() - lastPlaybackInfoReq.at < 5000)) {
                    if (lastPlaybackInfoReq.audioStreamIndex !== null && lastPlaybackInfoReq.audioStreamIndex !== undefined) {
                        targetAudioIdx = lastPlaybackInfoReq.audioStreamIndex;
                    }
                }
            }
            if (targetAudioIdx === null && src && src.DefaultAudioStreamIndex != null) {
                targetAudioIdx = src.DefaultAudioStreamIndex;
            }
            if (targetAudioIdx === null) {
                var amTxt = String(capturedSrc || '');
                var am = amTxt.match(/[?&]AudioStreamIndex=(-?\d+)/i);
                if (am && am[1] !== '') {
                    var amIdx = parseInt(am[1], 10);
                    if (!isNaN(amIdx)) targetAudioIdx = amIdx;
                }
            }
            meta.audioStreamId = targetAudioIdx;
        } catch (e) {}
        return meta;
    }

    function accessToken() {
        try {
            var api = pickApiClient();
            if (api && typeof api.accessToken === "function") {
                var t = api.accessToken();
                if (t) return t;
            }
        } catch (e) {}
        try {
            var raw = localStorage.getItem("jellyfin_credentials");
            if (raw) {
                var list = JSON.parse(raw);
                if (Array.isArray(list) && list[0]) return list[0].AccessToken || list[0].accessToken || "";
            }
        } catch (e) {}
        return "";
    }

    // Chapter markers live on the item DTO (the web client requests
    // Fields=Chapters when it loads playable items), not on the PlaybackInfo
    // response — so remember chapters-bearing item responses and expose a
    // bounded fallback fetch, guaranteeing the handoff payload carries
    // chapter markers for the seek bar even on a cold handoff.
    var chaptersByItem = {};
    var itemById = {};
    var episodesBySeries = {};
    function rememberItemDto(body) {
        try {
            if (!body || typeof body !== "object") return;
            var cleanId = body.Id ? String(body.Id).replace(/-/g, '') : null;
            if (Array.isArray(body.Chapters) && body.Id) {
                if (cleanId) chaptersByItem[cleanId] = body.Chapters;
                chaptersByItem[body.Id] = body.Chapters;
            }
            if (body.Id && (body.Name || body.SeriesId || body.IndexNumber != null || body.ParentIndexNumber != null || (body.UserData && body.UserData.PlaybackPositionTicks))) {
                var cleanSeriesId = body.SeriesId ? String(body.SeriesId).replace(/-/g, '') : null;
                var info = {
                    name: body.Name || "",
                    seriesId: cleanSeriesId || body.SeriesId || null,
                    seriesName: body.SeriesName || null,
                    indexNumber: body.IndexNumber != null ? body.IndexNumber : null,
                    parentIndexNumber: body.ParentIndexNumber != null ? body.ParentIndexNumber : null,
                    positionTicks: (body.UserData && body.UserData.PlaybackPositionTicks) ? body.UserData.PlaybackPositionTicks : 0,
                    type: body.Type || "",
                    // Metadata provider IDs (Imdb/Tmdb/Tvdb/Trakt) + release year
                    // from the item DTO, surfaced so intro-skip (IntroDB is keyed
                    // by IMDb ID) can resolve without an extra API round-trip.
                    providerIds: body.ProviderIds || null,
                    productionYear: body.ProductionYear != null ? body.ProductionYear : null
                };
                if (cleanId) itemById[cleanId] = info;
                itemById[body.Id] = info;
            }
            if (Array.isArray(body.Items)) {
                for (var i = 0; i < body.Items.length; i++) rememberItemDto(body.Items[i]);
            }
        } catch (e) {}
    }
    function chaptersFor(itemId) {
        try {
            if (!itemId) return null;
            var clean = String(itemId).replace(/-/g, '');
            var list = chaptersByItem[clean] || chaptersByItem[itemId];
            return Array.isArray(list) && list.length ? list : null;
        } catch (e) { return null; }
    }
    function episodesFor(seriesId) {
        try {
            if (!seriesId) return null;
            var clean = String(seriesId).replace(/-/g, '');
            var list = episodesBySeries[clean] || episodesBySeries[seriesId];
            return Array.isArray(list) && list.length ? list : null;
        } catch (e) { return null; }
    }
    // Episode lists arrive as /Shows/{seriesId}/Episodes responses when the
    // user opens a series; compact them so prev/next playback can rebuild
    // direct-play URLs for adjacent episodes.
    function rememberSeriesEpisodes(body) {
        try {
            if (!body || !Array.isArray(body.Items)) return;
            var rawSeriesId = body.SeriesId || null;
            var cleanSeriesId = rawSeriesId ? String(rawSeriesId).replace(/-/g, '') : null;
            var list = [];
            for (var i = 0; i < body.Items.length && list.length < 150; i++) {
                var it = body.Items[i];
                if (!it || !it.Id) continue;
                if (!rawSeriesId) {
                    rawSeriesId = it.SeriesId || null;
                    if (rawSeriesId) cleanSeriesId = String(rawSeriesId).replace(/-/g, '');
                }
                var cleanItemId = String(it.Id).replace(/-/g, '');
                list.push({
                    id: cleanItemId,
                    rawId: it.Id,
                    indexNumber: it.IndexNumber != null ? it.IndexNumber : null,
                    parentIndexNumber: it.ParentIndexNumber != null ? it.ParentIndexNumber : null,
                    name: it.Name || "",
                    positionTicks: it.UserData && it.UserData.PlaybackPositionTicks ? it.UserData.PlaybackPositionTicks : 0,
                    overview: it.Overview || "",
                    communityRating: it.CommunityRating != null ? it.CommunityRating : null,
                    premiereDate: it.PremiereDate || ""
                });
                rememberItemDto(it);
            }
            if (cleanSeriesId && list.length) episodesBySeries[cleanSeriesId] = list;
            if (rawSeriesId && list.length) episodesBySeries[rawSeriesId] = list;
        } catch (e) {}
    }
    function currentUserId() {
        try {
            var api = pickApiClient();
            if (api && typeof api.getCurrentUserId === "function") {
                var u = api.getCurrentUserId();
                if (u) return u;
            }
        } catch (e) {}
        try {
            var raw = localStorage.getItem("jellyfin_credentials");
            if (raw) {
                var list = JSON.parse(raw);
                if (Array.isArray(list) && list[0] && list[0].UserId) return list[0].UserId;
            }
        } catch (e) {}
        return "";
    }
    // Authoritative fallback: fetch the item DTO (Fields=Chapters) and, when it
    // is a series episode and no episode list is cached yet, the series'
    // episode list — bounded, so handoff is never blocked for long. cb receives
    // (chapters, itemInfo, episodes); any of them may be null.
    function gatherMetadata(itemId, cb, timeoutMs) {
        var uid = currentUserId();
        if (!itemId || !uid) { cb(null, null, null); return; }
        var item = itemById[itemId] || null;
        var chapters = chaptersFor(itemId);
        var episodes = item && item.seriesId ? episodesFor(item.seriesId) : null;
        var token = accessToken();
        var origin = serverBase();
        var settled = false;
        var done = function (ch, it, eps) {
            if (!settled) { settled = true; if (typeof cb === "function") cb(ch, it, eps); }
        };
        var timer = setTimeout(function () { done(chapters, item, episodes); }, timeoutMs || 1100);
        var itemUrl = origin + "/Users/" + encodeURIComponent(uid) + "/Items/" + encodeURIComponent(itemId) + "?Fields=Chapters";
        if (token) itemUrl += "&api_key=" + encodeURIComponent(token);
        fetch(itemUrl).then(function (r) {
            if (!r.ok) { clearTimeout(timer); done(chapters, item, episodes); return; }
            return r.json();
        }).then(function (b) {
            if (b && b.Id) {
                rememberItemDto(b);
                item = itemById[b.Id] || item;
                chapters = chaptersFor(b.Id) || chapters;
            }
            if (item && item.seriesId) {
                // Best-effort: also remember the series item DTO so the play
                // payload can carry the series-level ProviderIds (IMDb/TMDb)
                // for intro skip. Non-blocking — the bounded timer still
                // decides when playback metadata is delivered; if this lands
                // late it simply benefits the next play.
                (function () {
                    var sClean = String(item.seriesId).replace(/-/g, '');
                    if (itemById[sClean] || itemById[item.seriesId]) return;
                    var sUrl = origin + "/Items/" + encodeURIComponent(item.seriesId);
                    if (token) sUrl += "?api_key=" + encodeURIComponent(token);
                    fetch(sUrl).then(function (r3) {
                        if (!r3.ok) return null;
                        return r3.json();
                    }).then(function (b3) {
                        if (b3 && b3.Id) rememberItemDto(b3);
                    }).catch(function () {});
                })();
                var eps = episodesFor(item.seriesId) || episodes;
                if (!eps) {
                    var epsUrl = origin + "/Shows/" + encodeURIComponent(item.seriesId) + "/Episodes?UserId=" + encodeURIComponent(uid) + "&Fields=Chapters";
                    if (token) epsUrl += "&api_key=" + encodeURIComponent(token);
                    fetch(epsUrl).then(function (r2) {
                        if (!r2.ok) { clearTimeout(timer); done(chapters, item, episodes); return; }
                        return r2.json();
                    }).then(function (b2) {
                        clearTimeout(timer);
                        rememberSeriesEpisodes(b2);
                        done(chapters, item, episodesFor(item.seriesId));
                    }).catch(function () { clearTimeout(timer); done(chapters, item, episodes); });
                    return;
                }
                episodes = eps;
            }
            clearTimeout(timer);
            done(chapters, item, episodes);
        }).catch(function () { clearTimeout(timer); done(chapters, item, episodes); });
    }

    function isJellyfinStreamUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== "string") return false;
        if (rawUrl.indexOf("data:") === 0) return false;
        if (rawUrl.indexOf("blob:") === 0) {
            try {
                var blobOrigin = new URL(rawUrl.slice(5)).origin;
                var svrOrigin = new URL(serverOrigin()).origin;
                if (blobOrigin !== svrOrigin) return false;
            } catch (e) { return false; }
            var hasRecentSession = (playbackInfo && (Date.now() - (lastPlaybackInfoAt || 0) < 30000)) ||
                                   (lastHlsStream && (Date.now() - lastHlsStream.at < 30000)) ||
                                   (lastPlaybackInfoReq && (Date.now() - lastPlaybackInfoReq.at < 30000));
            return Boolean(hasRecentSession);
        }
        var u;
        try { u = new URL(rawUrl); } catch (e) { return false; }
        if (u.protocol !== "http:" && u.protocol !== "https:") return false;
        if (!/\/(?:Videos|Audio)\//i.test(u.pathname)) return false;
        try {
            return u.origin === new URL(serverOrigin()).origin;
        } catch (e) { return false; }
    }

    // Jellyfin normally applies a saved resume point by seeking the media
    // element; it is not always encoded in the stream URL. Capture the
    // element's currentTime at the play() boundary and carry it to mpv as
    // startTimeTicks. A URL/hash value wins when the server already supplied
    // one, while currentTime is the fallback for the normal web-client path.
    function buildPlayableUrl(rawUrl, elem) {
        // Media element URLs are normally absolute, but callers and test seams
        // may provide a relative stream URL directly. Normalize it before any
        // URL parsing so reverse-proxy bases and bare paths are preserved.
        if (rawUrl && typeof rawUrl === 'string' && rawUrl.indexOf('blob:') !== 0 && rawUrl.indexOf('://') === -1) {
            rawUrl = resolveCapturedHlsUrl(rawUrl);
        }
        var startTicks = 0;
        var urlItemId = null;
        if (rawUrl && typeof rawUrl === 'string') {
            urlItemId = extractMediaItemId(rawUrl);
        }

        var candidateItemId = urlItemId || (lastPlaybackInfoReq && lastPlaybackInfoReq.itemId ? String(lastPlaybackInfoReq.itemId).replace(/-/g, '') : null);
        if (!candidateItemId) {
            var ctx = resolveContextItemId(elem);
            if (ctx) candidateItemId = String(ctx).replace(/-/g, '');
        }

        // If the media element's src is a blob (e.g. hls.js / MediaSource), recover
        // the true Jellyfin stream URL from the captured HLS request or PlaybackInfo.
        if (rawUrl && rawUrl.indexOf("blob:") === 0) {
            if (lastHlsStream && (!candidateItemId || !lastHlsStream.itemId || lastHlsStream.itemId === candidateItemId) && (Date.now() - lastHlsStream.at < 30000)) {
                rawUrl = lastHlsStream.url;
                urlItemId = extractMediaItemId(rawUrl);
                if (urlItemId) {
                    candidateItemId = urlItemId;
                }
            } else {
                var pInfo = playbackInfoFor(candidateItemId);
                if (pInfo && pInfo.MediaSources && pInfo.MediaSources.length) {
                    var ms0 = pInfo.MediaSources[0];
                    var effectiveItemId = candidateItemId || (ms0.Id ? String(ms0.Id).replace(/-/g, '') : '');
                    var candidate = ms0.TranscodingUrl || ms0.DirectStreamUrl || ('/Videos/' + encodeURIComponent(effectiveItemId) + '/stream?Static=true&mediaSourceId=' + encodeURIComponent(ms0.Id));
                    if (candidate.indexOf("://") === -1) {
                        candidate = serverBase() + (candidate.charAt(0) === '/' ? '' : '/') + candidate;
                    }
                    rawUrl = candidate;
                    urlItemId = effectiveItemId;
                    candidateItemId = effectiveItemId;
                }
            }
        }

        var u = new URL(rawUrl);
        var existingTicks = parseInt(u.searchParams.get("startTimeTicks") || "0", 10);
        if (isFinite(existingTicks) && existingTicks > 0) {
            startTicks = existingTicks;
        } else if (u.hash && u.hash.indexOf("#t=") === 0) {
            var secs = parseFloat(u.hash.slice(3));
            if (isFinite(secs) && secs > 0) startTicks = Math.round(secs * 10000000);
        } else {
            try {
                var currentTime = Number(elem && elem.currentTime);
                if (isFinite(currentTime) && currentTime > 0) {
                    startTicks = Math.round(currentTime * 10000000);
                }
            } catch (e) {}
        }
        u.hash = "";

        // Check whether this stream is a Live TV / infinite stream.
        // Ensure playbackInfo corresponds to the current item being played.
        var isLive = false;
        var effectiveItem = urlItemId || candidateItemId;
        var pInfoCurrent = playbackInfoFor(effectiveItem);
        if (pInfoCurrent && pInfoCurrent.MediaSources && pInfoCurrent.MediaSources.length) {
            var pms = pInfoCurrent.MediaSources[0];
            if (pms.IsInfiniteStream === true || pms.LiveStreamId) isLive = true;
        }
        if (/live\.m3u8/i.test(u.pathname)) isLive = true;

        // If this is a VOD HLS transcode/remux stream (e.g. /videos/{id}/master.m3u8), rewrite
        // it to Jellyfin's direct static stream (/Videos/{id}/stream?Static=true).
        // mpv/libmpv supports MKV, DTS, TrueHD, etc. natively, so the server never
        // needs to burn CPU/GPU transcoding a stream just because the web browser's
        // HTML5 <video> profile didn't support the container.
        var m = findMediaSegment(u.pathname);
        var isHlsPlaylist = /\/(?:master|main)\.m3u8/i.test(u.pathname);
        if (m && isHlsPlaylist && !isLive) {
            var type = m.type;
            var streamItemId = m.itemId || urlItemId || candidateItemId;
            var mediaSourceId = u.searchParams.get('MediaSourceId') || u.searchParams.get('mediaSourceId') ||
                                (pInfoCurrent && pInfoCurrent.MediaSources && pInfoCurrent.MediaSources[0] && pInfoCurrent.MediaSources[0].Id) ||
                                streamItemId;
            var origin = serverBase();
            var direct = new URL(origin + '/' + type + '/' + streamItemId + '/stream');

            // Clone all existing query parameters from the HLS URL (DeviceId, PlaySessionId, Tag, AudioStreamIndex, etc.)
            u.searchParams.forEach(function (val, key) {
                direct.searchParams.set(key, val);
            });

            // Strip server-transcoder-specific parameters that mpv does not need
            // Note: AudioStreamIndex is intentionally preserved in direct query parameters.
            var transcodeParams = [
                'VideoCodec', 'AudioCodec', 'VideoBitrate', 'AudioBitrate', 'AudioSampleRate',
                'MaxFramerate', 'TranscodingMaxAudioChannels', 'RequireAvc', 'EnableAudioVbrEncoding',
                'SegmentContainer', 'MinSegments', 'BreakOnNonKeyFrames', 'TranscodeReasons',
                'SubtitleStreamIndex'
            ];
            for (var ti = 0; ti < transcodeParams.length; ti++) {
                direct.searchParams.delete(transcodeParams[ti]);
                direct.searchParams.delete(transcodeParams[ti].toLowerCase());
            }
            var keysToDelete = [];
            direct.searchParams.forEach(function (v, k) {
                if (/^(?:h264|h265|hevc|av1|vp9)-/i.test(k)) keysToDelete.push(k);
            });
            for (var ki = 0; ki < keysToDelete.length; ki++) {
                direct.searchParams.delete(keysToDelete[ki]);
            }

            direct.searchParams.set('Static', 'true');
            if (mediaSourceId) direct.searchParams.set('mediaSourceId', mediaSourceId);
            if (startTicks > 0) direct.searchParams.set('startTimeTicks', String(startTicks));
            var token = accessToken() || direct.searchParams.get('api_key') || '';
            if (token) direct.searchParams.set('api_key', token);

            return { url: direct.toString(), position_ticks: startTicks > 0 ? startTicks : null };
        }

        if (startTicks > 0 && (!u.searchParams.has("startTimeTicks") || existingTicks <= 0)) {
            u.searchParams.set("startTimeTicks", String(startTicks));
        }
        if (!u.searchParams.has("api_key")) {
            var token2 = accessToken();
            if (token2) u.searchParams.append("api_key", token2);
        }
        return { url: u.toString(), position_ticks: startTicks > 0 ? startTicks : null };
    }

    function blankMedia(elem) {
        try { elem.pause(); } catch (e) {}
        try { elem.removeAttribute("src"); if (elem.load) elem.load(); } catch (e) {}
        if (elem.__ynotvGuardTimer) return;
        // htmlVideoPlayer may re-assign src after 'emptied' — keep it paused
        // until the element leaves the DOM.
        var guard = setInterval(function () {
            try { elem.pause(); } catch (e) {}
            if (!elem.isConnected) clearInterval(guard);
        }, 200);
        setTimeout(function () { clearInterval(guard); }, 600000);
        elem.__ynotvGuardTimer = guard;
    }

    function releaseMedia(elem) {
        elem.__ynotvHandled = false;
        elem.__ynotvLastSrc = null;
        elem.__ynotvSignaled = false;
        if (elem.__ynotvGuardTimer) {
            clearInterval(elem.__ynotvGuardTimer);
            elem.__ynotvGuardTimer = null;
        }
    }

    function captureMedia(elem, fromPlay) {
        if (!elem) return false;
        diag('media-observed', describeMedia(elem, fromPlay ? 'play' : 'scan'));
        var src;
        try { src = elem.currentSrc || elem.src || ""; } catch (e) { src = ""; }

        if (!isJellyfinStreamUrl(src)) {
            // Switched away from a Jellyfin stream on a hijacked element
            // (e.g. trailer or next-item edge) — let it play normally.
            if (elem.__ynotvHandled) releaseMedia(elem);
            return false;
        }

        var sameHandled = elem.__ynotvHandled && elem.__ynotvLastSrc === src;
        // DOM scans can see the URL before Jellyfin has applied its saved
        // currentTime. Do not signal or blank during a scan; wait for the
        // patched play() call, where the resume seek has normally completed.
        if (sameHandled && (!fromPlay || (elem.__ynotvSignaled && window.__ynotvPlaybackActive))) return true;
        if (elem.__ynotvHandled && !sameHandled) releaseMedia(elem);

        if (!elem.__ynotvHandled) {
            elem.__ynotvHandled = true;
            elem.__ynotvLastSrc = src;
            elem.__ynotvSignaled = false;
        }
        if (!fromPlay) return true;

        var built;
        try { built = buildPlayableUrl(src, elem); } catch (e) { return false; }

        // Capture stream metadata from the element BEFORE blankMedia() wipes
        // its src/currentSrc — after blanking, itemId/mediaSourceId can no
        // longer be derived from the element, which silently dropped the
        // handoff payload's title, series, poster and chapter context.
        var subtitle = subtitleStreamInfo(elem, src);
        var meta = playbackInfoMeta(elem, src);

        blankMedia(elem);

        var key = built.url + "|" + built.position_ticks;
        var now = Date.now();
        if (window.__ynotvPlaybackActive && key === lastSignalKey && now - lastSignalAt < 800) {
            elem.__ynotvSignaled = true;
            return true;
        }
        lastSignalKey = key;
        lastSignalAt = now;
        elem.__ynotvSignaled = true;

        // Merge PlaybackInfo-derived metadata (poster, audio/subtitle streams,
        // default subtitle index) over the <track>-element fallback scrape, and
        // ride the last diagnostics along so native console gets them without
        // ever touching the title channel. Chapter markers come from the item
        // DTO: prefer the in-page cache (the client prefetched Fields=Chapters
        // when it loaded the item), falling back to a bounded authoritative
        // fetch so the seek bar shows chapters even on a cold handoff. The
        // element is already blanked and play() returns a pending promise, so
        // Jellyfin's own player waits while we finish gathering metadata.
        diag('metadata', {
            itemId: subtitle.itemId || null,
            uid: !!currentUserId(),
            token: !!accessToken(),
            cachedItem: !!itemById[subtitle.itemId || ''],
            cachedChapters: !!chaptersFor(subtitle.itemId || '')
        });
        function finish(chapters, itemInfo, episodes) {
            // The element may have moved on to another stream while the
            // metadata fetch was in flight (e.g. next episode) — never signal
            // a stale handoff for an abandoned element. IMPORTANT: blankMedia()
            // wipes src/currentSrc, so the live element can never be compared
            // against the captured URL; use the handled URL we recorded on the
            // element instead.
            var cur = elem.__ynotvLastSrc || "";
            if (cur !== src || !elem.isConnected) return;
            var startPos = built.position_ticks;
            if (!startPos || startPos <= 0) {
                // Scope the PlaybackInfo resume point to THIS item — the global
                // latest response can belong to a different item and leak its
                // position into the next stream.
                var pInfoResume = playbackInfoFor(subtitle.itemId);
                var resumeTicks = (itemInfo && itemInfo.positionTicks) ||
                                  (pInfoResume && pInfoResume.PlaybackPositionTicks) ||
                                  (pInfoResume && pInfoResume.MediaSources && pInfoResume.MediaSources[0] && pInfoResume.MediaSources[0].PlaybackPositionTicks) ||
                                  0;
                if (resumeTicks > 0) {
                    startPos = resumeTicks;
                    try {
                        var u2 = new URL(built.url);
                        if (!u2.searchParams.has('startTimeTicks') || u2.searchParams.get('startTimeTicks') === '0') {
                            u2.searchParams.set('startTimeTicks', String(resumeTicks));
                            built.url = u2.toString();
                        }
                    } catch (e) {}
                }
            }
            var diags = diagTail();
            signal({
                url: built.url,
                position_ticks: startPos > 0 ? startPos : null,
                // The item DTO (gathered via the item's own API) carries the
                // real title; document.title on the player screen is generic.
                title: (itemInfo && itemInfo.name) || itemTitle(),
                item_id: subtitle.itemId,
                media_source_id: subtitle.mediaSourceId,
                subtitle_stream_id: meta.subtitleStreamId != null ? meta.subtitleStreamId : subtitle.subtitleStreamId,
                audio_stream_id: meta.audioStreamId,
                subtitle_url: meta.subtitleUrl || subtitle.subtitleUrl,
                subtitle_tracks: meta.subtitleTracks.length ? meta.subtitleTracks : subtitle.subtitleTracks,
                poster_url: meta.posterUrl,
                audio_tracks: meta.audioTracks,
                chapters: Array.isArray(chapters) ? chapters : [],
                // Series/episode context so the frontend can show proper
                // S/E info in the header pill and play prev/next episodes.
                server_url: serverBase(),
                user_id: currentUserId(),
                api_key: accessToken(),
                series_id: itemInfo && itemInfo.seriesId ? itemInfo.seriesId : null,
                series_name: (itemInfo && itemInfo.seriesName) || null,
                // Series-level metadata IDs (Imdb/Tmdb + year) captured from the
                // series item DTO, so intro skip can resolve without a fetch.
                series_provider_ids: (function () {
                    if (!itemInfo || !itemInfo.seriesId) return null;
                    var sClean = String(itemInfo.seriesId).replace(/-/g, '');
                    var seriesItem = itemById[sClean] || itemById[itemInfo.seriesId] || null;
                    return seriesItem && seriesItem.providerIds ? seriesItem.providerIds : null;
                })(),
                series_production_year: (function () {
                    if (!itemInfo || !itemInfo.seriesId) return null;
                    var sClean = String(itemInfo.seriesId).replace(/-/g, '');
                    var seriesItem = itemById[sClean] || itemById[itemInfo.seriesId] || null;
                    return seriesItem && seriesItem.productionYear != null ? seriesItem.productionYear : null;
                })(),
                // Movie/standalone plays have no series — fall back to the played
                // item's own DTO ProviderIds (Imdb/Tmdb + year) so movie
                // playback can scrobble and intro-resolve with real IDs too.
                item_provider_ids: (function () {
                    if (!itemInfo || itemInfo.seriesId) return null;
                    return itemInfo.providerIds ? itemInfo.providerIds : null;
                })(),
                item_production_year: (function () {
                    if (!itemInfo || itemInfo.seriesId) return null;
                    return itemInfo.productionYear != null ? itemInfo.productionYear : null;
                })(),
                episode_index: itemInfo ? itemInfo.indexNumber : null,
                episode_parent_index: itemInfo ? itemInfo.parentIndexNumber : null,
                episode_name: (itemInfo && itemInfo.name) || null,
                episodes: Array.isArray(episodes) ? episodes : null,
                // The page's own play queue (playlist/album/queue-next). When
                // present, prev/next and auto-play follow THIS order instead of
                // the series episode list above.
                play_queue: readPlayQueue(subtitle.itemId),
                subtitle_prefs: readAllSubPrefs(),
                diags: diags
            });
        }
        gatherMetadata(subtitle.itemId, finish);
        return true;
    }

    function scanMedia(root) {
        var list;
        try { list = root.querySelectorAll ? root.querySelectorAll("video,audio") : []; } catch (e) { return; }
        for (var i = 0; i < list.length; i++) { watchMediaElement(list[i]); captureMedia(list[i], false); }
    }

    function watchMediaElement(elem) {
        if (!elem || elem.__ynotvObserved) return;
        elem.__ynotvObserved = true;
        var report = function (event) { diag('media-state', describeMedia(elem, event)); };
        ['loadstart', 'loadedmetadata', 'durationchange', 'canplay', 'playing', 'pause', 'emptied', 'error'].forEach(function (name) {
            try { elem.addEventListener(name, function () { report(name); }, { passive: true }); } catch (e) {}
        });
        try {
            var desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
            if (desc && desc.set && !desc.set.__ynotvPatched) {
                var originalSet = desc.set;
                var wrappedSet = function (value) {
                    diag('src-setter', { value: String(value || '') });
                    return originalSet.call(this, value);
                };
                wrappedSet.__ynotvPatched = true;
                Object.defineProperty(HTMLMediaElement.prototype, 'src', { configurable: desc.configurable, enumerable: desc.enumerable, get: desc.get, set: wrappedSet });
            }
        } catch (e) {}
    }

    function installDomWatcher() {
        diag('dom-watcher-installed');
        scanMedia(document);
        var mo = null;
        try {
            mo = new MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    var m = muts[i];
                    if (m.type === "attributes") {
                        var t = m.target;
                        if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO")) { watchMediaElement(t); captureMedia(t, false); }
                        continue;
                    }
                    var nodes = m.addedNodes || [];
                    for (var j = 0; j < nodes.length; j++) {
                        var n = nodes[j];
                        if (!n || n.nodeType !== 1) continue;
                        if (n.tagName === "VIDEO" || n.tagName === "AUDIO") { watchMediaElement(n); captureMedia(n, false); }
                        scanMedia(n);
                    }
                }
            });
        } catch (e) {}
        if (mo) {
            mo.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["src"]
            });
        }
        // Property-set src doesn't change the attribute, so poll as a fallback.
        setInterval(function () { scanMedia(document); }, 300);
    }

    // Dismiss visual loading indicators, spinners, and backdrop covers at handoff
    function dismissPlaybackOverlay() {
        try {
            if (window.loading && typeof window.loading.hide === 'function') {
                try { window.loading.hide(); } catch (e) {}
            }
            if (window.Loading && typeof window.Loading.hide === 'function') {
                try { window.Loading.hide(); } catch (e) {}
            }
            var overlays = document.querySelectorAll('.docspinner, .loading-spinner, .itemLoading, .videoPlayerContainer, .mdl-spinner');
            for (var i = 0; i < overlays.length; i++) {
                var el = overlays[i];
                if (el.classList.contains('videoPlayerContainer') || el.classList.contains('docspinner')) {
                    try { el.remove(); } catch (e) {}
                } else if (el.style) {
                    el.style.display = 'none';
                }
            }
            document.body.classList.remove('hide-scroll');
        } catch (e) {}
    }

    // The play() choke point: htmlVideoPlayer assigns src then calls play().
    // Resolve immediately so Jellyfin's own web player cleans up its loading
    // state, and dismiss any active loading spinners/overlays.
    (function patchPlay() {
        try {
            var orig = HTMLMediaElement.prototype.play;
            if (!orig || orig.__ynotvPatched) return;
            var wrapper = function () {
                diag('play-intercept', describeMedia(this, 'play-called'));
                if (captureMedia(this, true)) {
                    this.__ynotvHandled = true;
                    setTimeout(dismissPlaybackOverlay, 80);
                    setTimeout(dismissPlaybackOverlay, 350);
                    return Promise.resolve();
                }
                return orig.apply(this, arguments);
            };
            wrapper.__ynotvPatched = true;
            HTMLMediaElement.prototype.play = wrapper;
        } catch (e) {}
    })();

    // Intercept capability probes so jellyfin-web's client-side detection (browserDeviceProfile.js)
    // treats this environment as fully capable of direct playback for all common codecs/containers.
    (function patchCanPlayType() {
        try {
            var origCanPlay = HTMLMediaElement.prototype.canPlayType;
            if (!origCanPlay || origCanPlay.__ynotvPatched) return;
            var wrapper = function (type) {
                if (typeof type === 'string') {
                    var lower = type.toLowerCase();
                    if (/video\/(?:x-matroska|mkv|mp4|webm|avi|quicktime|x-msvideo|x-ms-wmv|mpeg|mp2t)/i.test(lower) ||
                        /audio\/(?:x-matroska|mkv|mp4|webm|aac|mp3|opus|ogg|flac|wav|vnd\.dlna\.adts|ac3|eac3|dts|truehd)/i.test(lower) ||
                        /codecs=["']?[^"']*(?:hevc|hvc1|hev1|av01|vp9|vp8|h264|avc1|dts|truehd|ac-3|ec-3|opus|flac)/i.test(lower)) {
                        return 'probably';
                    }
                }
                return origCanPlay.apply(this, arguments);
            };
            wrapper.__ynotvPatched = true;
            HTMLMediaElement.prototype.canPlayType = wrapper;
        } catch (e) {}
    })();

    // -------------------------------------------------------------------------
    // MPV DirectPlay Profile Injection
    // -------------------------------------------------------------------------
    // jellyfin-web sends a browser DeviceProfile in /PlaybackInfo requests that
    // reflects HTML5 video constraints (often lacking MKV, HEVC, DTS, TrueHD,
    // ASS subtitles). The Jellyfin server evaluates that profile and forces
    // ffmpeg transcoding or errors out if the user has transcoding disabled.
    //
    // By augmenting the outgoing DeviceProfile to advertise full MPV capabilities
    // (matching Jellyfin Media Player / JMP's getDeviceProfile), the server
    // knows the client can DirectPlay any container, video codec, audio codec,
    // and subtitle format. The server returns DirectStreamUrl immediately with
    // no ffmpeg transcoding jobs.
    function getMpvDeviceProfile(baseProfile) {
        var profile = (baseProfile && typeof baseProfile === 'object') ? baseProfile : {};
        profile.Name = 'ynoTV (MPV)';
        profile.MaxStreamingBitrate = 1000000000;
        profile.MaxStaticBitrate = 1000000000;
        profile.MusicStreamingTranscodingBitrate = 1280000;
        profile.TimelineOffsetSeconds = 5;

        // In Jellyfin, omitting Container and Codec on { Type: 'Video' } signifies
        // that ANY container and ANY video/audio codec can be Direct Played natively.
        profile.DirectPlayProfiles = [
            { Type: 'Audio' },
            { Type: 'Photo' },
            { Type: 'Video' }
        ];

        profile.TranscodingProfiles = [
            { Type: 'Audio' },
            {
                Container: 'ts',
                Type: 'Video',
                Protocol: 'hls',
                AudioCodec: 'aac,mp3,ac3,opus,vorbis',
                VideoCodec: 'h264,h265,hevc,mpeg4,mpeg2video',
                MaxAudioChannels: '6'
            },
            { Container: 'jpeg', Type: 'Photo' }
        ];

        profile.ResponseProfiles = [];
        profile.ContainerProfiles = [];
        profile.CodecProfiles = [];

        profile.SubtitleProfiles = [
            { Format: 'srt', Method: 'External' },
            { Format: 'srt', Method: 'Embed' },
            { Format: 'ass', Method: 'External' },
            { Format: 'ass', Method: 'Embed' },
            { Format: 'sub', Method: 'Embed' },
            { Format: 'sub', Method: 'External' },
            { Format: 'ssa', Method: 'Embed' },
            { Format: 'ssa', Method: 'External' },
            { Format: 'smi', Method: 'Embed' },
            { Format: 'smi', Method: 'External' },
            { Format: 'pgssub', Method: 'Embed' },
            { Format: 'dvdsub', Method: 'Embed' },
            { Format: 'dvbsub', Method: 'Embed' },
            { Format: 'pgs', Method: 'Embed' },
            { Format: 'vtt', Method: 'Embed' },
            { Format: 'vtt', Method: 'External' },
            { Format: 'subrip', Method: 'Embed' },
            { Format: 'subrip', Method: 'External' }
        ];

        return profile;
    }

    function injectMpvDeviceProfile(body) {
        if (!body) return body;
        try {
            var isString = typeof body === 'string';
            var data = isString ? JSON.parse(body) : body;
            if (data && typeof data === 'object') {
                data.DeviceProfile = getMpvDeviceProfile(data.DeviceProfile);
                if (data.MaxStreamingBitrate == null || data.MaxStreamingBitrate < 1000000000) {
                    data.MaxStreamingBitrate = 1000000000;
                }
                if (data.EnableDirectPlay !== undefined) data.EnableDirectPlay = true;
                if (data.EnableDirectStream !== undefined) data.EnableDirectStream = true;
                return isString ? JSON.stringify(data) : data;
            }
        } catch (e) {
            diag('inject-mpv-profile-error', String(e));
        }
        return body;
    }

    // -------------------------------------------------------------------------
    // Client identity for the Jellyfin dashboard
    // -------------------------------------------------------------------------
    // The embedded webview otherwise reports itself as "Edge Chromium" /
    // "Jellyfin Web <server web version>" on the dashboard. Rewrite the
    // X-Emby-Authorization header (sent with every API request) to identify as
    // "ynoTV <app version>" on the machine's hostname — the same shape Jellyfin
    // Media Player shows ("DESKTOP-XXX / Jellyfin Media Player 1.12.0"). The
    // values are injected by Rust when the webview is created. This only changes
    // how the server labels our sessions; playback decisions still come from the
    // DeviceProfile in PlaybackInfo requests.
    var ynotvAppVersion = window.__YNOTV_APP_VERSION__ || '';
    var ynotvDeviceName = window.__YNOTV_DEVICE_NAME__ || '';

    function ynotvRewriteAuthHeader(value) {
        try {
            if (!value || typeof value !== 'string') return value;
            if (value.toLowerCase().indexOf('mediabrowser') === -1) return value;
            // Nothing to identify with (e.g. the script running standalone) —
            // keep the server default. Rust always injects both globals in the
            // real webview, so this only matters for tests / edge cases.
            if (!ynotvAppVersion && !ynotvDeviceName) return value;
            var out = value.replace(/\bClient="[^"]*"/i, 'Client="ynoTV"');
            if (ynotvDeviceName) {
                out = out.replace(/\bDevice="[^"]*"/i, function () { return 'Device="' + ynotvDeviceName + '"'; });
            }
            if (ynotvAppVersion) {
                out = out.replace(/\bVersion="[^"]*"/i, function () { return 'Version="' + ynotvAppVersion + '"'; });
            }
            return out;
        } catch (e) {
            return value;
        }
    }

    // Jellyfin's api clients send the identity header under two names across
    // versions: the legacy "X-Emby-Authorization" (10.8/10.9 era) and the modern
    // "Authorization" (jellyfin-apiclient 1.11 / web 10.11+), always with a
    // "MediaBrowser ..." value. ynotvRewriteAuthHeader bails unless the value
    // carries that prefix, so unrelated Authorization headers (e.g. Bearer)
    // pass through untouched.
    function ynotvIsAuthHeaderName(name) {
        var lower = String(name || '').toLowerCase();
        return lower === 'x-emby-authorization' || lower === 'authorization';
    }

    // Patch outgoing fetch headers before the request leaves the webview.
    // Handles a Headers instance, a plain object, and a [name, value][] array.
    function ynotvPatchFetchHeaders(init) {
        try {
            if (!init) return;
            var h = init.headers;
            if (!h) return;
            if (typeof Headers !== 'undefined' && h instanceof Headers) {
                if (h.has('X-Emby-Authorization')) {
                    h.set('X-Emby-Authorization', ynotvRewriteAuthHeader(h.get('X-Emby-Authorization')));
                }
                if (h.has('Authorization')) {
                    h.set('Authorization', ynotvRewriteAuthHeader(h.get('Authorization')));
                }
            } else if (Array.isArray(h)) {
                for (var i = 0; i < h.length; i++) {
                    var pair = h[i];
                    if (pair && pair[0] && ynotvIsAuthHeaderName(pair[0])) {
                        pair[1] = ynotvRewriteAuthHeader(pair[1]);
                    }
                }
            } else if (typeof h === 'object') {
                for (var k in h) {
                    if (Object.prototype.hasOwnProperty.call(h, k) && ynotvIsAuthHeaderName(k)) {
                        h[k] = ynotvRewriteAuthHeader(h[k]);
                    }
                }
            }
        } catch (e) {}
    }

    // Observe network calls used by Jellyfin to obtain PlaybackInfo/MediaStreams.
    // This captures the requested subtitle/audio stream choices from PlaybackInfo requests.
    function resolveCapturedHlsUrl(targetUrl) {
        var resolved = String(targetUrl || '');
        if (!resolved || resolved.indexOf('://') !== -1) return resolved;

        // Preserve a configured reverse-proxy prefix for root-relative paths.
        if (resolved.charAt(0) === '/' && resolved.charAt(1) !== '/') return serverBase() + resolved;

        // Bare-relative and protocol-relative URLs still need a URL base.
        return new URL(resolved, serverBase() + '/').toString();
    }

    (function patchNetwork() {
        // The latest PlaybackInfo response is stored (not just logged) so the
        // handoff payload can carry the authoritative stream metadata.
        function rememberPlaybackInfo(body, reqUrl) {
            try {
                if (!body || !body.MediaSources) return;
                var reqItemId = null;
                if (reqUrl) {
                    var m = String(reqUrl).match(/\/Items\/([^/?#]+)\/PlaybackInfo/i);
                    if (m) reqItemId = m[1].replace(/-/g, '');
                }
                if (!reqItemId && lastPlaybackInfoReq && lastPlaybackInfoReq.itemId) {
                    reqItemId = String(lastPlaybackInfoReq.itemId).replace(/-/g, '');
                }
                playbackInfo = body;
                lastPlaybackInfoAt = Date.now();
                if (reqItemId) {
                    playbackInfoByItem[reqItemId] = body;
                }
                diag('playback-info-response', {
                    itemId: reqItemId,
                    sources: body.MediaSources.length,
                    session: String(body.PlaySessionId || '').slice(0, 12)
                });
            } catch (e) {}
        }
        function recordHlsRequest(targetUrl) {
            try {
                // Browser fetch/XHR can be called with a relative URL; the
                // bridge later parses the captured URL with new URL(), which
                // requires a base. Resolve it against the configured Jellyfin base
                // so a relative master.m3u8 request never aborts the handoff.
                var resolved = resolveCapturedHlsUrl(targetUrl);
                var m = resolved && findMediaSegment(resolved);
                if (m && /\/(?:master|main)\.m3u8/i.test(resolved)) {
                    lastHlsStream = { url: resolved, itemId: m.itemId, at: Date.now() };
                }
            } catch (e) {}
        }
        try {
            // The page reports what it is playing (and its whole queue) to
            // /Sessions/Playing*; the bridge suppresses those reports but reads them
            // first, which is how the play queue reaches the handoff payload.
            function rememberPlayQueue(body) {
                try {
                    var parsed = body;
                    if (typeof parsed === 'string') {
                        if (parsed.charAt(0) !== '{') return;
                        parsed = JSON.parse(parsed);
                    }
                    if (!parsed || typeof parsed !== 'object') return;
                    var raw = parsed.NowPlayingQueue;
                    if (!Array.isArray(raw) || raw.length < 2) return;
                    var items = [];
                    for (var i = 0; i < raw.length; i++) {
                        var entry = normalizeQueueItem(raw[i]);
                        if (entry) items.push({ id: entry.id, rawId: entry.rawId, playlistItemId: entry.playlistItemId });
                    }
                    if (items.length < 2) return;
                    playQueueCapture = {
                        items: items,
                        itemId: parsed.ItemId ? String(parsed.ItemId).replace(/-/g, '') : null,
                        playlistItemId: parsed.PlaylistItemId || null,
                        at: Date.now()
                    };
                    diag('play-queue-captured', {
                        count: items.length,
                        playlistItemId: !!parsed.PlaylistItemId
                    });
                } catch (e) {}
            }

            // Playlists/{id}/Items responses carry the playlist's ordered items
            // (each with its server-side PlaylistItemId), which both recognises the
            // captured queue as that playlist and supplies the entries' real names
            // and S/E numbers for the queue list.
            function rememberPlaylistItems(reqUrl, body) {
                try {
                    var m = String(reqUrl || '').match(/\/Playlists\/([^/?#]+)\/Items/i);
                    if (!m || !body) return;
                    var list = body;
                    if (typeof list === 'string') {
                        if (list.charAt(0) !== '{' && list.charAt(0) !== '[') return;
                        list = JSON.parse(list);
                    }
                    var raw = Array.isArray(list) ? list : (list && Array.isArray(list.Items) ? list.Items : null);
                    if (!raw || !raw.length) return;
                    var items = [];
                    var byPlaylistItemId = {};
                    for (var i = 0; i < raw.length && items.length < 1000; i++) {
                        var entry = normalizeQueueItem(raw[i]);
                        if (!entry) continue;
                        items.push(entry);
                        if (entry.playlistItemId) byPlaylistItemId[entry.playlistItemId] = entry;
                        rememberItemDto(raw[i]);
                    }
                    if (!items.length) return;
                    playlistCapture = {
                        id: m[1],
                        name: '',
                        items: items,
                        byPlaylistItemId: byPlaylistItemId,
                        at: Date.now()
                    };
                    rememberPlaylistName(m[1]);
                } catch (e) {}
            }

            // Best-effort playlist name for the "from playlist" badge; failure just
            // leaves the queue labelled generically.
            function rememberPlaylistName(playlistId) {
                try {
                    var uid = currentUserId();
                    if (!uid) return;
                    var url = serverBase() + '/Users/' + encodeURIComponent(uid) + '/Items/' + encodeURIComponent(playlistId);
                    var token = accessToken();
                    if (token) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'api_key=' + encodeURIComponent(token);
                    fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
                        if (playlistCapture && playlistCapture.id === playlistId && d && d.Name) {
                            playlistCapture.name = String(d.Name);
                        }
                    }).catch(function () {});
                } catch (e) {}
            }

            rememberPlayQueueRef = rememberPlayQueue;
            rememberPlaylistItemsRef = rememberPlaylistItems;

            var originalFetch = window.fetch;
            if (originalFetch && !originalFetch.__ynotvPatched) {
                var wrappedFetch = function () {
                    var request = arguments[0];
                    var init = arguments[1];
                    var url = typeof request === 'string' ? request : (request && request.url) || '';
                    var reqBody = (init && init.body) || (request && request.body) || null;
                    ynotvPatchFetchHeaders(init);
                    if (!init && request && typeof request === 'object' && request.headers) {
                        ynotvPatchFetchHeaders(request);
                    }
                    if (/PlaybackInfo/i.test(url)) {
                        if (init && init.body) {
                            init.body = injectMpvDeviceProfile(init.body);
                            reqBody = init.body;
                        }
                        recordPlaybackInfoReq(url, reqBody);
                    }
                    recordHlsRequest(url);
                    if (/\/Sessions\/Playing(\/Progress|\/Stopped)?(?:\?|$)/i.test(url)) {
                        rememberPlayQueue(reqBody);
                        diag('suppressed-web-session-report', { url: url });
                        return Promise.resolve(new Response(null, { status: 204, statusText: 'No Content' }));
                    }
                    if (/PlaybackInfo|(?:Videos|Audio)\/[^/]+\/(?:stream|master\.m3u8)/i.test(url)) diag('fetch', { url: url });
                    return originalFetch.apply(this, arguments).then(function (response) {
                        if (/PlaybackInfo/i.test(url)) {
                            try {
                                var pUrl = url;
                                response.clone().json().then(function (body) {
                                    rememberPlaybackInfo(body, pUrl);
                                }).catch(function () {});
                            } catch (e) {}
                        } else if (/\/Playlists\/[^/?#]+\/Items/i.test(url)) {
                            // Playlist contents: powers the "from playlist" badge
                            // and gives the queue entries real names.
                            try { response.clone().json().then(function (b) { rememberPlaylistItems(url, b); }).catch(function () {}); } catch (e) {}
                        } else if (/\/Items\/[^?/]+(?:\?|$)|[?&]Ids=/i.test(url)) {
                            // Item DTO responses can carry the Chapters array
                            // (Fields=Chapters is requested for playable items)
                            // — remember them for the handoff payload.
                            try { response.clone().json().then(rememberItemDto).catch(function () {}); } catch (e) {}
                        } else if (/\/Shows\/[^?/]+\/Episodes/i.test(url)) {
                            // Series episode lists power prev/next playback.
                            try { response.clone().json().then(rememberSeriesEpisodes).catch(function () {}); } catch (e) {}
                        }
                        return response;
                    });
                };
                wrappedFetch.__ynotvPatched = true;
                window.fetch = wrappedFetch;
            }
        } catch (e) { diag('fetch-patch-error', String(e)); }
        try {
            var originalOpen = XMLHttpRequest.prototype.open;
            var originalSend = XMLHttpRequest.prototype.send;
            var originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
            if (originalSetHeader && !originalSetHeader.__ynotvPatched) {
                var wrappedSetHeader = function (name, value) {
                    if (typeof name === 'string' && ynotvIsAuthHeaderName(name)) {
                        value = ynotvRewriteAuthHeader(value);
                    }
                    return originalSetHeader.call(this, name, value);
                };
                wrappedSetHeader.__ynotvPatched = true;
                XMLHttpRequest.prototype.setRequestHeader = wrappedSetHeader;
            }
            if (originalOpen && !originalOpen.__ynotvPatched) {
                var wrappedOpen = function (method, url) {
                    this.__ynotvUrl = String(url || '');
                    this.__ynotvSuppressed = /\/Sessions\/Playing(\/Progress|\/Stopped)?(?:\?|$)/i.test(this.__ynotvUrl);
                    recordHlsRequest(this.__ynotvUrl);
                    if (/PlaybackInfo|(?:Videos|Audio)\/[^/]+\/(?:stream|master\.m3u8)/i.test(this.__ynotvUrl)) diag('xhr-open', { method: method, url: this.__ynotvUrl });
                    var result = originalOpen.apply(this, arguments);
                    if (/PlaybackInfo/i.test(this.__ynotvUrl)) {
                        try {
                            var self = this;
                            var pUrl2 = this.__ynotvUrl;
                            this.addEventListener('loadend', function () {
                                try {
                                    if (self.responseText) rememberPlaybackInfo(JSON.parse(self.responseText), pUrl2);
                                } catch (e) {}
                            });
                        } catch (e) {}
                    } else if (/\/Items\/[^?/]+(?:\?|$)|[?&]Ids=/i.test(this.__ynotvUrl)) {
                        try {
                            var self2 = this;
                            this.addEventListener('loadend', function () {
                                try {
                                    if (self2.responseText) rememberItemDto(JSON.parse(self2.responseText));
                                } catch (e) {}
                            });
                        } catch (e) {}
                    } else if (/\/Playlists\/[^/?#]+\/Items/i.test(this.__ynotvUrl)) {
                        try {
                            var selfPl = this;
                            var plUrl = this.__ynotvUrl;
                            this.addEventListener('loadend', function () {
                                try {
                                    if (selfPl.responseText) rememberPlaylistItems(plUrl, JSON.parse(selfPl.responseText));
                                } catch (e) {}
                            });
                        } catch (e) {}
                    } else if (/\/Shows\/[^?/]+\/Episodes/i.test(this.__ynotvUrl)) {
                        try {
                            var self3 = this;
                            this.addEventListener('loadend', function () {
                                try {
                                    if (self3.responseText) rememberSeriesEpisodes(JSON.parse(self3.responseText));
                                } catch (e) {}
                            });
                        } catch (e) {}
                    }
                    return result;
                };
                wrappedOpen.__ynotvPatched = true;
                XMLHttpRequest.prototype.open = wrappedOpen;
            }
            if (originalSend && !originalSend.__ynotvPatched) {
                var wrappedSend = function (body) {
                    if (this.__ynotvSuppressed) {
                        rememberPlayQueue(body);
                        diag('suppressed-web-session-xhr', { url: this.__ynotvUrl });
                        var self = this;
                        setTimeout(function () {
                            try {
                                Object.defineProperty(self, 'readyState', { value: 4, writable: true });
                                Object.defineProperty(self, 'status', { value: 204, writable: true });
                                Object.defineProperty(self, 'statusText', { value: 'No Content', writable: true });
                                Object.defineProperty(self, 'responseText', { value: '', writable: true });
                                if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
                                if (typeof self.onload === 'function') self.onload();
                                if (typeof self.onloadend === 'function') self.onloadend();
                            } catch (e) {}
                        }, 0);
                        return;
                    }
                    if (this.__ynotvUrl && /PlaybackInfo/i.test(this.__ynotvUrl)) {
                        body = injectMpvDeviceProfile(body);
                        recordPlaybackInfoReq(this.__ynotvUrl, body);
                    }
                    return originalSend.call(this, body);
                };
                wrappedSend.__ynotvPatched = true;
                XMLHttpRequest.prototype.send = wrappedSend;
            }
        } catch (e) { diag('xhr-patch-error', String(e)); }
    })();

    // External metadata links (IMDb / TMDb / TVDb / Trakt) rendered from the
    // item DTO's ExternalUrls are dead inside the child WebView (popups/new
    // windows are blocked, and navigating away would tear down the embed).
    // Intercept clicks and ask Rust to open them in the system browser via the
    // document.title channel (same mechanism as diagnostics/play chunks).
    function isKnownExternalLinkHost(host) {
        var h = String(host || '').toLowerCase().replace(/^www\./, '');
        return h === 'imdb.com' || h.endsWith('.imdb.com') ||
               h === 'thetvdb.com' || h.endsWith('.thetvdb.com') ||
               h === 'themoviedb.org' || h.endsWith('.themoviedb.org') ||
               h === 'trakt.tv' || h.endsWith('.trakt.tv');
    }
    function installExternalLinkHandler() {
        document.addEventListener('click', function (e) {
            try {
                var target = e.target;
                var a = target && target.closest ? target.closest('a[href]') : null;
                if (!a) return;
                var href = a.getAttribute('href') || '';
                if (!href || href.charAt(0) === '#') return;
                var abs;
                try { abs = new URL(href, serverBase()).href; } catch (err) { return; }
                if (!isKnownExternalLinkHost(new URL(abs).hostname)) return;
                e.preventDefault();
                e.stopPropagation();
                // Nonce keeps consecutive clicks of the same link from being
                // deduped by the title-change listener.
                document.title = 'ynotv-jf:open:' + Date.now().toString(36) + ':' + abs;
            } catch (err) {}
        }, true);
    }
    installExternalLinkHandler();

    window.__ynotvJfReenable = function () {
        try {
            window.__ynotvPlaybackActive = false;
            lastSignalKey = null;
            lastSignalAt = 0;
            lastHlsStream = null;
            lastPlaybackInfoAt = 0;
            lastPlaybackInfoReq = null;
            playbackInfo = null;
            playbackInfoByItem = {};
            var els = document.querySelectorAll("video,audio");
            for (var i = 0; i < els.length; i++) releaseMedia(els[i]);
        } catch (e) {}
        warn("re-enabled Jellyfin web player after failed mpv handoff");
    };

    window.__ynotvOnPlaybackEnded = function (targetItemId) {
        try {
            window.__ynotvPlaybackActive = false;
            lastSignalKey = null;
            lastSignalAt = 0;
            lastHlsStream = null;
            lastPlaybackInfoAt = 0;
            lastPlaybackInfoReq = null;
            itemById = {};
            chaptersByItem = {};
            episodesBySeries = {};
            playbackInfo = null;
            playbackInfoByItem = {};
            dismissPlaybackOverlay();
            if (window.playbackManager && typeof window.playbackManager.resetPlayer === 'function') {
                try { window.playbackManager.resetPlayer(); } catch (e) {}
            }
            var els = document.querySelectorAll("video,audio");
            for (var i = 0; i < els.length; i++) releaseMedia(els[i]);

            if (targetItemId) {
                var cleanTarget = String(targetItemId).replace(/-/g, '');
                var navStartedAt = Date.now();
                var navReloaded = false;
                function finishTargetNav() {
                    if (navReloaded) return;
                    navReloaded = true;
                    // Deferred like the generic stop path: give the SPA a moment
                    // to finish rendering before the hard reload that reboots the
                    // bridge cleanly on the details page.
                    setTimeout(function () {
                        try { window.location.reload(); } catch (e) {}
                    }, 60);
                }
                try {
                    // AppRouter.showItem resolves the item over the network
                    // BEFORE routing (async), so wait for the details route to
                    // actually appear in the URL before reloading — a fixed
                    // short reload can fire mid-navigation and strand the
                    // webview on the pre-playback page. Fall back to the hash
                    // route for old clients without the AppRouter global.
                    if (window.AppRouter && typeof window.AppRouter.showItem === "function") {
                        window.AppRouter.showItem(cleanTarget);
                    } else {
                        window.location.hash = '#/details?id=' + cleanTarget;
                    }
                } catch (e) {}
                var navPoll = setInterval(function () {
                    try {
                        var navUrl = ((location.pathname || '') + (location.hash || '')).toLowerCase();
                        var navCommitted = navUrl.indexOf('details') >= 0 || navUrl.indexOf(cleanTarget.toLowerCase()) >= 0;
                        // Safety cap: never leave the page frozen on the player
                        // screen; reload once even if the route never appeared.
                        if (navCommitted || Date.now() - navStartedAt > 3000) {
                            clearInterval(navPoll);
                            finishTargetNav();
                        }
                    } catch (e) {
                        clearInterval(navPoll);
                        finishTargetNav();
                    }
                }, 150);
                return;
            }

            var cur = location.hash || "";
            if (/videoosd/i.test(cur)) {
                if (window.AppRouter && typeof window.AppRouter.back === "function") {
                    try { window.AppRouter.back(); } catch (e) {}
                } else {
                    try { window.history.back(); } catch (e) {}
                }
                setTimeout(function () {
                    try { window.location.reload(); } catch (e) {}
                }, 60);
            } else {
                try { window.location.reload(); } catch (e) {}
            }
        } catch (e) {
            try { window.location.reload(); } catch (e2) {}
        }
    };

    // Test-only seam: nothing is exposed unless the hosting page opts in via
    // window.__ynotvJfTestMode (set by the vitest harness before injection), so
    // production Jellyfin pages never see these internals.
    if (window.__ynotvJfTestMode) {
        window.__ynotvJfInternals = {
            playbackInfoFor: playbackInfoFor,
            playbackInfoMeta: playbackInfoMeta,
            buildPlayableUrl: buildPlayableUrl,
            findMediaSegment: findMediaSegment,
            extractMediaItemId: extractMediaItemId,
            getMpvDeviceProfile: getMpvDeviceProfile,
            injectMpvDeviceProfile: injectMpvDeviceProfile,
            seedPlaybackInfo: function (itemId, body) {
                playbackInfo = body;
                lastPlaybackInfoAt = Date.now();
                if (itemId) playbackInfoByItem[String(itemId).replace(/-/g, '')] = body;
            },
            seedPlaybackInfoReq: function (req) { lastPlaybackInfoReq = req; },
            seedHlsStream: function (s) { lastHlsStream = s; },
            resolveCapturedHlsUrl: resolveCapturedHlsUrl,
            readPlayQueue: readPlayQueue,
            playlistAsQueue: playlistAsQueue,
            rememberPlayQueue: function (body) { return rememberPlayQueueRef && rememberPlayQueueRef(body); },
            rememberPlaylistItems: function (url, body) { return rememberPlaylistItemsRef && rememberPlaylistItemsRef(url, body); },
            seedPlayQueue: function (c) { playQueueCapture = c; },
            seedPlaylist: function (c) { playlistCapture = c; },
            resetQueueCaptures: function () { playQueueCapture = null; playlistCapture = null; }
        };
    }

    // -------------------------------------------------------------------------
    // Spatial Navigation for TV Remotes & Gamepad Controllers
    // -------------------------------------------------------------------------
    (function () {
        var currentFocused = null;
        var styleInjected = false;

        function injectStyles() {
            if (styleInjected) return;
            styleInjected = true;
            try {
                var style = document.createElement('style');
                style.id = 'ynotv-spatial-styles';
                style.textContent = [
                    '.ynotv-tv-focus {',
                    '  outline: 3px solid #00a4dc !important;',
                    '  outline-offset: 3px !important;',
                    '  box-shadow: 0 0 16px rgba(0, 164, 220, 0.7) !important;',
                    '  transform: scale(1.02) !important;',
                    '  transition: transform 0.12s ease, outline 0.12s ease !important;',
                    '  z-index: 9999 !important;',
                    '}',
                    '.ynotv-tv-focus * {',
                    '  outline: none !important;',
                    '}'
                ].join('\n');
                (document.head || document.documentElement).appendChild(style);
            } catch (e) {}
        }

        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            if (r.bottom < -100 || r.top > window.innerHeight + 100) return false;
            if (r.right < -100 || r.left > window.innerWidth + 100) return false;
            try {
                var cs = window.getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            } catch (e) {}
            return true;
        }

        function getCandidates() {
            var selectors = [
                'button',
                'a[href]',
                'input:not([type="hidden"])',
                'select',
                'textarea',
                '[tabindex]:not([tabindex="-1"])',
                '[role="button"]',
                '.card',
                '.cardBox',
                '.cardScalable',
                '.cardContent',
                '.listItem',
                '.listItem-button',
                '.emby-button',
                '.paper-icon-button-light',
                '.navMenuOption',
                '.headerButton',
                '.sectionTitleButton',
                '.emby-tab-button'
            ];
            var all = Array.from(document.querySelectorAll(selectors.join(',')));
            var result = [];
            var seen = new Set();

            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                if (el.disabled || el.getAttribute('aria-hidden') === 'true') continue;
                if (!isVisible(el)) continue;

                var card = el.closest('.card, .listItem');
                var target = card || el;

                if (!seen.has(target) && isVisible(target)) {
                    seen.add(target);
                    result.push(target);
                }
            }
            return result;
        }

        function applyFocus(el) {
            if (!el) return;
            injectStyles();
            if (currentFocused && currentFocused !== el) {
                currentFocused.classList.remove('ynotv-tv-focus');
            }
            currentFocused = el;
            el.classList.add('ynotv-tv-focus');
            try {
                el.focus({ preventScroll: true });
            } catch (e) {}
            try {
                el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
            } catch (e) {}
        }

        function clearFocus() {
            if (currentFocused) {
                currentFocused.classList.remove('ynotv-tv-focus');
                try { currentFocused.blur(); } catch (e) {}
                currentFocused = null;
            }
        }

        function signalParentFocus(kind, direction) {
            // Focus/blur signals ride over IPC (like debug logging), never over
            // document.title: the title channel carries the chunked play-payload
            // stream, and WebView2 coalesces rapid title changes, so a competing
            // title write could clobber a chunk and stall the handoff.
            try {
                if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
                    window.__TAURI_INTERNALS__.invoke('jellyfin_embed_focus_signal', { kind: kind, direction: direction || null }).catch(function () {});
                }
            } catch (e) {}
        }

        function signalBlurToParent(direction) {
            clearFocus();
            signalParentFocus('blur', direction || 'up');
        }

        function findBest(current, candidates, dir) {
            if (!current || !isVisible(current)) {
                candidates.sort(function (a, b) {
                    var ra = a.getBoundingClientRect();
                    var rb = b.getBoundingClientRect();
                    return (ra.top - rb.top) || (ra.left - rb.left);
                });
                return candidates[0] || null;
            }

            var curRect = current.getBoundingClientRect();
            var curCenter = {
                x: curRect.left + curRect.width / 2,
                y: curRect.top + curRect.height / 2
            };

            var best = null;
            var minScore = Infinity;

            for (var i = 0; i < candidates.length; i++) {
                var cand = candidates[i];
                if (cand === current) continue;

                var rect = cand.getBoundingClientRect();
                var center = {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2
                };

                var dx = center.x - curCenter.x;
                var dy = center.y - curCenter.y;
                var primary = 0;
                var secondary = 0;
                var valid = false;

                switch (dir) {
                    case 'right':
                        if (dx > 4) {
                            primary = dx;
                            secondary = Math.abs(dy);
                            valid = true;
                        }
                        break;
                    case 'left':
                        if (dx < -4) {
                            primary = -dx;
                            secondary = Math.abs(dy);
                            valid = true;
                        }
                        break;
                    case 'down':
                        if (dy > 4) {
                            primary = dy;
                            secondary = Math.abs(dx);
                            valid = true;
                        }
                        break;
                    case 'up':
                        if (dy < -4) {
                            primary = -dy;
                            secondary = Math.abs(dx);
                            valid = true;
                        }
                        break;
                }

                if (!valid) continue;

                var score = primary + secondary * 2.5;
                if (score < minScore) {
                    minScore = score;
                    best = cand;
                }
            }
            return best;
        }

        function handleDir(dir) {
            injectStyles();
            var candidates = getCandidates();
            if (!candidates.length) {
                if (dir === 'up') signalBlurToParent('up');
                return;
            }

            if (currentFocused && !document.contains(currentFocused)) {
                currentFocused = null;
            }

            var next = findBest(currentFocused, candidates, dir);
            if (next) {
                applyFocus(next);
            } else {
                if (dir === 'up') {
                    var scroller = document.scrollingElement || document.documentElement || document.body;
                    if (window.scrollY > 20 || (scroller && scroller.scrollTop > 20)) {
                        window.scrollBy({ top: -200, behavior: 'smooth' });
                    } else {
                        signalBlurToParent('up');
                    }
                } else if (dir === 'down') {
                    window.scrollBy({ top: 200, behavior: 'smooth' });
                } else if (dir === 'right') {
                    var p = currentFocused ? currentFocused.parentElement : null;
                    while (p && p !== document.body) {
                        if (p.scrollWidth > p.clientWidth + 10) {
                            p.scrollBy({ left: 200, behavior: 'smooth' });
                            break;
                        }
                        p = p.parentElement;
                    }
                } else if (dir === 'left') {
                    var p2 = currentFocused ? currentFocused.parentElement : null;
                    while (p2 && p2 !== document.body) {
                        if (p2.scrollWidth > p2.clientWidth + 10) {
                            p2.scrollBy({ left: -200, behavior: 'smooth' });
                            break;
                        }
                        p2 = p2.parentElement;
                    }
                }
            }
        }

        function handleSelect() {
            if (!currentFocused) {
                handleDir('down');
                return;
            }
            var clickTarget = currentFocused.querySelector('button, a, input, select, textarea') || currentFocused;
            var tag = (clickTarget.tagName || currentFocused.tagName || '').toLowerCase();
            var isInput = tag === 'input' || tag === 'textarea';

            try {
                clickTarget.click();
            } catch (e) {
                try { currentFocused.click(); } catch (err) {}
            }

            // Only dispatch Enter for text inputs / form fields so search or login fields
            // submit properly without double-triggering clicks on buttons, links, or cards.
            if (isInput) {
                try {
                    var evDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
                    var evUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
                    (clickTarget || currentFocused).dispatchEvent(evDown);
                    (clickTarget || currentFocused).dispatchEvent(evUp);
                } catch (e) {}
            }
        }

        function handleBack() {
            var dialog = document.querySelector('.dialogContainer:not(.hide), .actionSheet:not(.hide), .mainDrawer-open');
            if (dialog) {
                var closeBtn = dialog.querySelector('.button-close, [data-action="close"], .btnCancel');
                if (closeBtn) {
                    closeBtn.click();
                    return;
                }
            }
            var backBtn = document.querySelector('.headerBackButton:not(.hide), button[data-action="back"]');
            if (backBtn && isVisible(backBtn)) {
                backBtn.click();
                return;
            }
            if (window.history && window.history.length > 1 && window.location.hash && window.location.hash !== '#/home') {
                window.history.back();
                return;
            }
            signalBlurToParent('back');
        }

        window.__ynotvJfNav = function (action) {
            switch (action) {
                case 'enter':
                case 'down':
                    if (action === 'enter' && !currentFocused) {
                        var cands = getCandidates();
                        if (cands.length) applyFocus(cands[0]);
                    } else {
                        handleDir(action === 'enter' ? 'down' : action);
                    }
                    break;
                case 'up':
                case 'left':
                case 'right':
                    handleDir(action);
                    break;
                case 'select':
                    handleSelect();
                    break;
                case 'back':
                    handleBack();
                    break;
                case 'blur':
                    clearFocus();
                    break;
            }
        };

        document.addEventListener('focusin', function (e) {
            if (e.target && e.target !== document.body && isVisible(e.target)) {
                var card = e.target.closest('.card, .listItem');
                applyFocus(card || e.target);
            }
        }, true);

        document.addEventListener('pointerdown', function () {
            signalParentFocus('focus', null);
        }, true);
    })();

})();
"##;
#[cfg(test)]
mod tests {
    use super::{is_allowed_external_metadata_url, is_plausible_jellyfin_item_id, parse_play_url};

    const GUID: &str = "abcdef01-2345-6789-abcd-ef0123456789";
    const GUID_CLEAN: &str = "abcdef0123456789abcdef0123456789";

    fn make_url(path: &str) -> String {
        format!(
            "http://jf.example:8096{}?api_key=KEY&mediaSourceId=ms1&startTimeTicks=10000000",
            path
        )
    }

    #[test]
    fn parses_plain_video_direct_stream() {
        let (base, key, id, msid, ticks) =
            parse_play_url(&make_url(&format!("/Videos/{GUID}/stream.mkv"))).expect("parse");
        assert_eq!(base, "http://jf.example:8096");
        assert_eq!(key, "KEY");
        assert_eq!(id, GUID_CLEAN);
        assert_eq!(msid.as_deref(), Some("ms1"));
        assert_eq!(ticks, 10_000_000);
    }

    #[test]
    fn parses_plain_audio_direct_stream() {
        let (base, _, id, _, _) =
            parse_play_url(&make_url(&format!("/Audio/{GUID}/stream.flac"))).expect("parse");
        assert_eq!(base, "http://jf.example:8096");
        assert_eq!(id, GUID_CLEAN);
    }

    #[test]
    fn parses_reverse_proxy_subpath() {
        let (base, _, id, _, _) =
            parse_play_url(&make_url(&format!("/jellyfin/Videos/{GUID}/stream"))).expect("parse");
        assert_eq!(base, "http://jf.example:8096/jellyfin");
        assert_eq!(id, GUID_CLEAN);
    }

    #[test]
    fn skips_proxy_prefix_segment_named_videos() {
        // /media/Videos/proxy/Videos/{id}/stream — the first "Videos" is part of
        // the deployment prefix, not the media segment.
        let (base, _, id, _, _) = parse_play_url(&make_url(&format!(
            "/media/Videos/proxy/Videos/{GUID}/stream"
        )))
        .expect("parse");
        assert_eq!(base, "http://jf.example:8096/media/Videos/proxy");
        assert_eq!(id, GUID_CLEAN);
    }

    #[test]
    fn rejects_media_segment_without_item_id() {
        assert!(parse_play_url(&make_url("/Videos/stream.mkv")).is_none());
        assert!(parse_play_url(&make_url("/Videos/")).is_none());
    }

    #[test]
    fn rejects_word_after_media_segment() {
        // "proxy" is not hex — must not be accepted as an item id.
        assert!(parse_play_url(&make_url("/Videos/proxy/stream")).is_none());
    }

    #[test]
    fn external_metadata_url_validation() {
        assert!(is_allowed_external_metadata_url("https://www.imdb.com/title/tt1234567"));
        assert!(is_allowed_external_metadata_url("https://sub.thetvdb.com/series/1"));
        assert!(is_allowed_external_metadata_url("https://themoviedb.org/movie/1"));
        assert!(is_allowed_external_metadata_url("https://trakt.tv/movies/1"));
        assert!(!is_allowed_external_metadata_url("http://imdb.com/title/tt1234567"));
        assert!(!is_allowed_external_metadata_url("https://imdb.com.evil.example/title/1"));
        assert!(!is_allowed_external_metadata_url("https://evil.example/?next=https%3A%2F%2Fimdb.com"));
        assert!(!is_allowed_external_metadata_url("javascript:alert(1)"));
    }

    #[test]
    fn item_id_validation() {
        assert!(is_plausible_jellyfin_item_id(GUID));
        assert!(is_plausible_jellyfin_item_id(GUID_CLEAN));
        assert!(is_plausible_jellyfin_item_id("deadbeef"));
        assert!(!is_plausible_jellyfin_item_id("proxy"));
        assert!(!is_plausible_jellyfin_item_id(""));
        assert!(!is_plausible_jellyfin_item_id("abc"));
        assert!(!is_plausible_jellyfin_item_id("stream.mkv"));
    }
}
