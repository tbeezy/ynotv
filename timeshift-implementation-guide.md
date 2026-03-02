# IPTV Time-Shift Implementation Guide
## Tauri + Rust + MPV (Approach 1: MPV Back-Buffer)

---

## Overview

This guide covers implementing time-shift (pause, rewind, catch-up) for a live IPTV stream using MPV's built-in demuxer back-buffer. No temporary files or external proxies are required. Everything is in-memory.

**What we're building:**
- MPV back-buffer configuration to cache the live stream
- A Rust polling loop that reads cache state from MPV's IPC socket
- A frontend timeline UI showing the buffered window and current playhead
- A "Catch Up" button to jump back to the live edge
- A settings panel to enable/disable time-shift and configure cache size

---

## How It Works

MPV's `--demuxer-max-back-bytes` flag instructs MPV to keep a rolling in-memory buffer of already-decoded stream data. Once active:

- The user can seek backwards within the buffered window
- `demuxer-cache-state` exposes the exact cached time range in seconds
- Seeking forward returns to live automatically

The trade-off: the buffer lives only in RAM and is lost if MPV exits.

### Cache Size vs. Time Reference

| Cache Size | ~4 Mbps (SD) | ~8 Mbps (HD) | ~20 Mbps (4K) |
|------------|--------------|--------------|----------------|
| 256 MB     | ~8 min       | ~4 min       | ~1.5 min       |
| 512 MB     | ~17 min      | ~8 min       | ~3 min         |
| 1 GB       | ~35 min      | ~17 min      | ~6 min         |
| 2 GB       | ~70 min      | ~35 min      | ~13 min        |
| 4 GB       | ~140 min     | ~70 min      | ~26 min        |

> **Note:** The actual cached duration is always available precisely at runtime via `demuxer-cache-state`. Use this for your UI rather than estimating from the table above.

---

## Settings Model

Before touching MPV or the UI, define the settings structure that drives everything.

### `src-tauri/src/timeshift.rs`

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeshiftSettings {
    /// Whether time-shift is enabled at all
    pub enabled: bool,
    /// Back-buffer size in bytes (default: 1 GB)
    pub cache_bytes: u64,
}

impl Default for TimeshiftSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            cache_bytes: 1_073_741_824, // 1 GB
        }
    }
}

impl TimeshiftSettings {
    /// Human-readable cache size for display (e.g. "1.0 GB")
    pub fn cache_label(&self) -> String {
        let gb = self.cache_bytes as f64 / 1_073_741_824.0;
        if gb >= 1.0 {
            format!("{:.1} GB", gb)
        } else {
            format!("{:.0} MB", gb / 1_048_576.0)
        }
    }
}
```

Persist these settings however you currently handle app config (e.g. `tauri-plugin-store`, a JSON file, etc.).

---

## MPV Launch Flags

When spawning MPV (or configuring it via your existing IPC setup), conditionally pass the back-buffer flag based on settings.

```rust
pub fn build_mpv_args(url: &str, settings: &TimeshiftSettings) -> Vec<String> {
    let mut args = vec![
        url.to_string(),
        "--no-terminal".to_string(),
        "--input-ipc-server=/tmp/mpv-socket".to_string(),
    ];

    if settings.enabled {
        args.push(format!(
            "--demuxer-max-back-bytes={}",
            settings.cache_bytes
        ));
        // Allow MPV to keep playing at end of cached content
        args.push("--keep-open=yes".to_string());
    }

    args
}
```

> **Important:** `--demuxer-max-back-bytes` must be set at launch. You cannot change it via IPC while MPV is running. If the user toggles time-shift in settings, the change takes effect the next time a channel is opened.

---

## MPV IPC: Reading Cache State

MPV exposes cache state via its JSON IPC socket. You'll query two properties:

- `demuxer-cache-state` — object containing `cache-start`, `cache-end`, and `seekable-ranges`
- `time-pos` — current playback position in seconds

### IPC Request Format

```json
{ "command": ["get_property", "demuxer-cache-state"] }
{ "command": ["get_property", "time-pos"] }
```

### Example `demuxer-cache-state` Response

```json
{
  "data": {
    "seekable-ranges": [{ "start": 45.2, "end": 1089.7 }],
    "cache-end": 1089.7,
    "cache-start": 45.2,
    "total-bytes": 1073741824,
    "fw-bytes": 2097152
  }
}
```

- `cache-start` — earliest seekable position (moves forward as old data is evicted)
- `cache-end` — latest buffered position (== live edge)
- `time-pos` — where playback currently is within that range

---

## Rust Polling Loop

Poll both properties every 500ms and emit a Tauri event to the frontend.

### `src-tauri/src/timeshift.rs` (continued)

```rust
use tauri::{AppHandle, Manager};
use tokio::time::{interval, Duration};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct TimeshiftState {
    pub enabled: bool,
    pub cache_start: f64,   // seconds
    pub cache_end: f64,     // seconds
    pub time_pos: f64,      // seconds
    pub behind_live: f64,   // cache_end - time_pos
    pub cached_duration: f64, // cache_end - cache_start
}

pub async fn start_polling(app: AppHandle) {
    let mut ticker = interval(Duration::from_millis(500));

    loop {
        ticker.tick().await;

        let cache_state = mpv_get_property("demuxer-cache-state").await;
        let time_pos = mpv_get_property("time-pos").await;

        if let (Some(cache), Some(pos)) = (cache_state, time_pos) {
            let cache_start = cache["data"]["cache-start"]
                .as_f64()
                .unwrap_or(0.0);
            let cache_end = cache["data"]["cache-end"]
                .as_f64()
                .unwrap_or(0.0);
            let time_pos = pos["data"].as_f64().unwrap_or(0.0);

            let state = TimeshiftState {
                enabled: true,
                cache_start,
                cache_end,
                time_pos,
                behind_live: (cache_end - time_pos).max(0.0),
                cached_duration: (cache_end - cache_start).max(0.0),
            };

            let _ = app.emit("timeshift-update", &state);
        }

        ticker.tick().await;
    }
}

// Generic MPV IPC helper (adapt to your existing IPC implementation)
async fn mpv_get_property(property: &str) -> Option<Value> {
    let request = serde_json::json!({
        "command": ["get_property", property]
    });
    // Send via your existing Unix socket / named pipe connection
    // and return the parsed JSON response
    todo!("wire to your existing MPV IPC")
}
```

### Tauri Command: Seek

```rust
#[tauri::command]
pub async fn timeshift_seek(position: f64) -> Result<(), String> {
    let cmd = serde_json::json!({
        "command": ["set_property", "time-pos", position]
    });
    mpv_send_command(cmd).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn timeshift_catch_up(cache_end: f64) -> Result<(), String> {
    // Seek 2 seconds before the live edge to avoid a buffer stall
    let target = (cache_end - 2.0).max(0.0);
    let cmd = serde_json::json!({
        "command": ["set_property", "time-pos", target]
    });
    mpv_send_command(cmd).await.map_err(|e| e.to_string())
}
```

Register both commands in your Tauri builder:

```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
        timeshift_seek,
        timeshift_catch_up,
        // ... your other commands
    ])
```

---

## Frontend: Timeline Component

This example uses React + TypeScript, but the logic applies to any framework.

### Types

```typescript
interface TimeshiftState {
  enabled: boolean;
  cache_start: number;
  cache_end: number;
  time_pos: number;
  behind_live: number;
  cached_duration: number;
}
```

### Hook: Subscribe to Polling Events

```typescript
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export function useTimeshift() {
  const [state, setState] = useState<TimeshiftState | null>(null);

  useEffect(() => {
    const unlisten = listen<TimeshiftState>("timeshift-update", (event) => {
      setState(event.payload);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  const seek = (position: number) => invoke("timeshift_seek", { position });

  const catchUp = () => {
    if (state) invoke("timeshift_catch_up", { cacheEnd: state.cache_end });
  };

  return { state, seek, catchUp };
}
```

### Timeline Component

```tsx
export function TimeshiftTimeline() {
  const { state, seek, catchUp } = useTimeshift();

  if (!state?.enabled || state.cached_duration < 1) return null;

  const { cache_start, cache_end, time_pos, behind_live, cached_duration } = state;

  // Map a position in seconds to a percentage along the timeline bar
  const toPercent = (pos: number) =>
    ((pos - cache_start) / cached_duration) * 100;

  const playheadPercent = toPercent(time_pos);
  const isLive = behind_live < 5; // within 5 seconds of live edge

  // User clicked/scrubbed on the timeline bar
  const handleBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickPercent = (e.clientX - rect.left) / rect.width;
    const targetPos = cache_start + clickPercent * cached_duration;
    // Clamp to valid range
    seek(Math.min(Math.max(targetPos, cache_start), cache_end - 1));
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="timeshift-container">

      {/* Timeline bar */}
      <div className="timeshift-bar" onClick={handleBarClick}>

        {/* Buffered range (full bar = everything cached) */}
        <div className="timeshift-buffered" style={{ width: "100%" }} />

        {/* Playhead */}
        <div
          className="timeshift-playhead"
          style={{ left: `${playheadPercent}%` }}
        />

        {/* Live edge marker */}
        <div className="timeshift-live-marker" style={{ left: "100%" }} />
      </div>

      {/* Labels */}
      <div className="timeshift-labels">
        <span className="timeshift-label-left">
          ↩ {formatDuration(cached_duration)} available
        </span>
        <span className="timeshift-label-right">
          {isLive ? (
            <span className="timeshift-live-badge">● LIVE</span>
          ) : (
            <span className="timeshift-behind">
              -{formatDuration(behind_live)} behind live
            </span>
          )}
        </span>
      </div>

      {/* Catch Up button — only shown when meaningfully behind live */}
      {behind_live > 5 && (
        <button className="timeshift-catchup-btn" onClick={catchUp}>
          ⏭ Catch Up to Live
        </button>
      )}
    </div>
  );
}
```

### CSS

```css
.timeshift-container {
  position: relative;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 6px;
  user-select: none;
}

.timeshift-bar {
  position: relative;
  height: 6px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  cursor: pointer;
}

.timeshift-buffered {
  position: absolute;
  height: 100%;
  background: rgba(255, 255, 255, 0.35);
  border-radius: 3px;
}

.timeshift-playhead {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  background: white;
  border-radius: 50%;
  pointer-events: none;
}

.timeshift-live-marker {
  position: absolute;
  top: -3px;
  transform: translateX(-50%);
  width: 3px;
  height: 12px;
  background: #ff4444;
  border-radius: 2px;
}

.timeshift-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
}

.timeshift-live-badge {
  color: #ff4444;
  font-weight: bold;
}

.timeshift-behind {
  color: #ffaa00;
}

.timeshift-catchup-btn {
  margin-top: 8px;
  width: 100%;
  padding: 5px;
  background: #ff4444;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: bold;
}

.timeshift-catchup-btn:hover {
  background: #cc2222;
}
```

---

## Settings UI

### Tauri Commands for Settings

```rust
#[tauri::command]
pub fn get_timeshift_settings(/* your state handle */) -> TimeshiftSettings {
    // return from your app state / config store
}

#[tauri::command]
pub fn save_timeshift_settings(settings: TimeshiftSettings /* , state */) {
    // persist to your config store
}
```

### Settings Component

```tsx
const CACHE_PRESETS = [
  { label: "256 MB",  bytes: 268_435_456 },
  { label: "512 MB",  bytes: 536_870_912 },
  { label: "1 GB",    bytes: 1_073_741_824 },
  { label: "2 GB",    bytes: 2_147_483_648 },
  { label: "4 GB",    bytes: 4_294_967_296 },
];

// Estimated minutes for a given byte size at a given Mbps
function estimateMinutes(bytes: number, mbps: number): number {
  return Math.round((bytes * 8) / (mbps * 1_000_000) / 60);
}

export function TimeshiftSettings() {
  const [enabled, setEnabled] = useState(false);
  const [cacheBytes, setCacheBytes] = useState(1_073_741_824);

  useEffect(() => {
    invoke<TimeshiftSettings>("get_timeshift_settings").then((s) => {
      setEnabled(s.enabled);
      setCacheBytes(s.cache_bytes);
    });
  }, []);

  const save = (newEnabled: boolean, newBytes: number) => {
    invoke("save_timeshift_settings", {
      settings: { enabled: newEnabled, cache_bytes: newBytes },
    });
  };

  const handleToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEnabled(e.target.checked);
    save(e.target.checked, cacheBytes);
  };

  const handlePreset = (bytes: number) => {
    setCacheBytes(bytes);
    save(enabled, bytes);
  };

  return (
    <div className="settings-section">
      <h3>Time-Shift / Pause Live TV</h3>

      <label className="settings-toggle">
        <input type="checkbox" checked={enabled} onChange={handleToggle} />
        Enable Time-Shift
      </label>

      {enabled && (
        <>
          <p className="settings-note">
            Changes apply the next time a channel is opened.
            Larger cache sizes use more RAM.
          </p>

          <div className="settings-presets">
            {CACHE_PRESETS.map((preset) => (
              <button
                key={preset.bytes}
                className={`preset-btn ${cacheBytes === preset.bytes ? "active" : ""}`}
                onClick={() => handlePreset(preset.bytes)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <table className="settings-estimate-table">
            <thead>
              <tr>
                <th>Stream Quality</th>
                <th>Estimated Time-Shift Window</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>SD (~4 Mbps)</td>
                <td>~{estimateMinutes(cacheBytes, 4)} min</td>
              </tr>
              <tr>
                <td>HD (~8 Mbps)</td>
                <td>~{estimateMinutes(cacheBytes, 8)} min</td>
              </tr>
              <tr>
                <td>4K (~20 Mbps)</td>
                <td>~{estimateMinutes(cacheBytes, 20)} min</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
```

---

## Edge Cases & Gotchas

**Sliding `cache-start`:** As MPV fills the buffer to the `--demuxer-max-back-bytes` limit, it evicts the oldest data, causing `cache-start` to advance forward. Always clamp seek targets to `>= cache-start` or the seek will be silently ignored or fail.

**Seeking too close to `cache-end`:** The live edge has very little buffer ahead of it. Seeking to exactly `cache-end` can cause a brief stall. Offset by 1–2 seconds in your catch-up command.

**No cache data yet:** For the first few seconds after opening a channel, `demuxer-cache-state` may return null or zero values. Guard against this in your polling loop — only emit the event once `cached_duration > 0`.

**HLS vs MPEG-TS:** The back-buffer works best with direct MPEG-TS streams. HLS streams can work but segment boundaries may cause less smooth rewinding. If your streams are HLS, test carefully.

**Stream type without seek support:** Some streams explicitly mark themselves as non-seekable. In that case, MPV will buffer data but seeking may not work. You can detect this from `demuxer-cache-state`'s `seekable-ranges` — if it's empty even when cache is populated, seeking isn't available for that stream.

**RAM usage:** The back-buffer is held in RAM. On lower-end devices, 2–4 GB cache presets may cause memory pressure. Consider capping your largest preset based on your target hardware.

---

## Summary of Changes Required

| Area | What to add |
|------|-------------|
| `timeshift.rs` | `TimeshiftSettings` struct, polling loop, seek commands |
| MPV launch | Conditionally pass `--demuxer-max-back-bytes` |
| Tauri commands | `timeshift_seek`, `timeshift_catch_up`, `get/save_timeshift_settings` |
| Frontend hook | `useTimeshift()` listening to `timeshift-update` events |
| Frontend UI | `<TimeshiftTimeline />` component with bar + catch-up button |
| Settings UI | `<TimeshiftSettings />` toggle + cache size presets |

Total estimated new code: ~300–400 lines across Rust and frontend, assuming you already have MPV IPC plumbing in place.
