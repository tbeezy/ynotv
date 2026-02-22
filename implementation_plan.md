# TV Show Calendar Feature — Implementation Plan

Adds TV show tracking and a calendar view. Users right-click an EPG program or channel → search TVMaze → track the show. Future episodes appear in a Calendar page and are synced from TVMaze every 24 hours.

---

## ⚠️ Critical Codebase Context (Read This First)

> [!IMPORTANT]
> **SQLite library is `rusqlite` + `r2d2`, NOT `sqlx`.** The initial AI-generated stub used `sqlx`. Ignore it. The real codebase uses `rusqlite` with `r2d2` connection pooling. Study `dvr/database.rs` — every new DB method must follow that exact pattern: `self.pool.get()` → `conn.execute(...)` / `conn.query_row(...)` / `conn.prepare(...)?.query_map(...)`.

> [!IMPORTANT]
> **No new crates are needed in `Cargo.toml`.** `reqwest` (with `json` feature) and `serde`/`serde_json` are already present. Do **not** add `urlencoding` — use `reqwest`'s built-in query encoding via `.query(&[("q", &query)])` on the `RequestBuilder`. If you use `format!("...?q={}", query)` directly, you must URL-encode it yourself with `percent-encoding` which is not in the tree either. The safest approach: use `.query()` on reqwest.

> [!IMPORTANT]
> **DB path is `ynotv.db`** in the app data directory. It is opened once inside `DvrDatabase::new()` and shared via `Arc<DvrDatabase>`. TVMaze tables live in the **same file** — do not open a second connection or separate DB.

> [!IMPORTANT]
> **All new Tauri commands must be placed in `lib.rs`**, not inside `tvmaze.rs`. The pattern is: `tvmaze.rs` contains public functions that take `&Arc<DvrDatabase>` directly; thin `#[tauri::command]` wrappers in `lib.rs` extract `state.db` and call into `tvmaze.rs`. Study how `bulk_upsert_channels` delegates to `db_bulk_ops::bulk_upsert_channels(&state.db, ...)`.

> [!CAUTION]
> **The `View` type is defined in two places and must be kept in sync.** `Sidebar.tsx` exports `type View` and also uses it locally. `App.tsx` imports it. Add `'calendar'` to the type in `Sidebar.tsx` — the TypeScript compiler will then flag anywhere in `App.tsx` that needs updating.

> [!NOTE]
> **Monorepo structure.** The Rust source is at `packages/app/src-tauri/src/`. React source is at `packages/ui/src/`. These are separate pnpm packages. You do not need to touch `packages/core` or `packages/local-adapter` for this feature.

---

## Absolute File Paths

| File | Action |
|------|--------|
| `packages/app/src-tauri/src/dvr/database.rs` | Modify — add schema + DB methods |
| `packages/app/src-tauri/src/tvmaze.rs` | **New** — data structs + HTTP logic + background sync |
| `packages/app/src-tauri/src/lib.rs` | Modify — `mod tvmaze;`, command wrappers, `invoke_handler![]` |
| `packages/app/src-tauri/src/dvr/mod.rs` | Modify — spawn background sync task |
| `packages/app/src-tauri/Cargo.toml` | **No changes needed** |
| `packages/ui/src/components/ProgramContextMenu.tsx` | Modify — add "Track Show" item |
| `packages/ui/src/components/ChannelContextMenu.tsx` | Modify — add "Track Show" item |
| `packages/ui/src/components/Sidebar.tsx` | Modify — add `'calendar'` to `View` type + nav button |
| `packages/ui/src/App.tsx` | Modify — handle `'calendar'` view |
| `packages/ui/src/components/TVMazeSearchModal.tsx` | **New** |
| `packages/ui/src/components/TVMazeSearchModal.css` | **New** |
| `packages/ui/src/components/TVCalendar.tsx` | **New** |
| `packages/ui/src/components/TVCalendar.css` | **New** |

---

## Part 1 — Database Schema (`dvr/database.rs`)

Append to `initialize_schema()`, after the existing table/index creates:

```rust
conn.execute(
    "CREATE TABLE IF NOT EXISTS tv_favorites (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        tvmaze_id    INTEGER UNIQUE NOT NULL,
        show_name    TEXT NOT NULL,
        show_image   TEXT,
        channel_name TEXT,
        channel_id   TEXT,
        status       TEXT,
        last_synced  TEXT,
        added_at     TEXT DEFAULT (datetime('now'))
    )",
    [],
)?;

conn.execute(
    "CREATE TABLE IF NOT EXISTS tv_episodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        tvmaze_id    INTEGER NOT NULL,
        season       INTEGER,
        episode      INTEGER,
        episode_name TEXT,
        airdate      TEXT,
        airtime      TEXT,
        runtime      INTEGER,
        FOREIGN KEY (tvmaze_id) REFERENCES tv_favorites(tvmaze_id)
    )",
    [],
)?;

conn.execute(
    "CREATE INDEX IF NOT EXISTS idx_tv_episodes_tvmaze ON tv_episodes(tvmaze_id)",
    [],
)?;

conn.execute(
    "CREATE INDEX IF NOT EXISTS idx_tv_episodes_airdate ON tv_episodes(airdate)",
    [],
)?;
```

Add these `pub` methods to `impl DvrDatabase`:

```rust
pub fn tvmaze_add_favorite(
    &self, tvmaze_id: i64, show_name: &str, show_image: Option<&str>,
    channel_name: Option<&str>, channel_id: Option<&str>, status: Option<&str>,
) -> Result<()> {
    let conn = self.get_conn()?;
    conn.execute(
        "INSERT OR IGNORE INTO tv_favorites
         (tvmaze_id, show_name, show_image, channel_name, channel_id, status, last_synced)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
        params![tvmaze_id, show_name, show_image, channel_name, channel_id, status],
    )?;
    Ok(())
}

pub fn tvmaze_remove_favorite(&self, tvmaze_id: i64) -> Result<()> {
    let conn = self.get_conn()?;
    conn.execute("DELETE FROM tv_episodes WHERE tvmaze_id = ?1", params![tvmaze_id])?;
    conn.execute("DELETE FROM tv_favorites WHERE tvmaze_id = ?1", params![tvmaze_id])?;
    Ok(())
}

pub fn tvmaze_get_favorites(&self) -> Result<Vec<crate::tvmaze::TrackedShow>> {
    let conn = self.get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT tvmaze_id, show_name, show_image, channel_name, channel_id, status, last_synced
         FROM tv_favorites ORDER BY show_name ASC"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(crate::tvmaze::TrackedShow {
            tvmaze_id:    row.get(0)?,
            show_name:    row.get(1)?,
            show_image:   row.get(2)?,
            channel_name: row.get(3)?,
            channel_id:   row.get(4)?,
            status:       row.get(5)?,
            last_synced:  row.get(6)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(anyhow::Error::from)
}

pub fn tvmaze_upsert_episodes(
    &self, tvmaze_id: i64,
    episodes: &[crate::tvmaze::EpisodeRow],
) -> Result<()> {
    let conn = self.get_conn()?;
    conn.execute("DELETE FROM tv_episodes WHERE tvmaze_id = ?1", params![tvmaze_id])?;
    for ep in episodes {
        conn.execute(
            "INSERT INTO tv_episodes
             (tvmaze_id, season, episode, episode_name, airdate, airtime, runtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![tvmaze_id, ep.season, ep.episode, ep.episode_name, ep.airdate, ep.airtime, ep.runtime],
        )?;
    }
    Ok(())
}

pub fn tvmaze_update_last_synced(&self, tvmaze_id: i64) -> Result<()> {
    let conn = self.get_conn()?;
    conn.execute(
        "UPDATE tv_favorites SET last_synced = datetime('now') WHERE tvmaze_id = ?1",
        params![tvmaze_id],
    )?;
    Ok(())
}

pub fn tvmaze_get_calendar_episodes(
    &self, month_prefix: &str,
) -> Result<Vec<crate::tvmaze::CalendarEpisode>> {
    let conn = self.get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT e.airdate, e.airtime, e.episode_name, e.season, e.episode,
                f.show_name, f.channel_name, f.show_image
         FROM tv_episodes e
         JOIN tv_favorites f ON f.tvmaze_id = e.tvmaze_id
         WHERE e.airdate LIKE ?1
         ORDER BY e.airdate ASC, e.airtime ASC"
    )?;
    let like_pattern = format!("{}%", month_prefix);
    let rows = stmt.query_map(params![like_pattern], |row| {
        Ok(crate::tvmaze::CalendarEpisode {
            airdate:      row.get(0)?,
            airtime:      row.get(1)?,
            episode_name: row.get(2)?,
            season:       row.get(3)?,
            episode:      row.get(4)?,
            show_name:    row.get(5)?,
            channel_name: row.get(6)?,
            show_image:   row.get(7)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(anyhow::Error::from)
}

pub fn tvmaze_get_running_shows(&self) -> Result<Vec<(i64, String)>> {
    // Returns (tvmaze_id, show_name) for all shows with status = 'Running'
    let conn = self.get_conn()?;
    let mut stmt = conn.prepare(
        "SELECT tvmaze_id, show_name FROM tv_favorites WHERE status = 'Running'"
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(anyhow::Error::from)
}
```

---

## Part 2 — New File `tvmaze.rs`

```rust
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::dvr::database::DvrDatabase;

// ── TVMaze API response types ──────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeShowResult {
    pub score: f64,
    pub show:  TvMazeShow,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeShow {
    pub id:      i64,
    pub name:    String,
    pub status:  Option<String>,
    pub network: Option<TvMazeNetwork>,
    pub image:   Option<TvMazeImage>,
    pub summary: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeNetwork {
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeImage {
    pub medium: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeEpisode {
    pub id:      i64,
    pub name:    Option<String>,
    pub season:  Option<i64>,
    pub number:  Option<i64>,
    pub airdate: Option<String>,
    pub airtime: Option<String>,
    pub runtime: Option<i64>,
}

// ── DB-facing types (returned to frontend) ────────────────────────────────

#[derive(Debug, Serialize)]
pub struct TrackedShow {
    pub tvmaze_id:    i64,
    pub show_name:    String,
    pub show_image:   Option<String>,
    pub channel_name: Option<String>,
    pub channel_id:   Option<String>,
    pub status:       Option<String>,
    pub last_synced:  Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CalendarEpisode {
    pub airdate:      Option<String>,
    pub airtime:      Option<String>,
    pub episode_name: Option<String>,
    pub season:       Option<i64>,
    pub episode:      Option<i64>,
    pub show_name:    String,
    pub channel_name: Option<String>,
    pub show_image:   Option<String>,
}

// Intermediate struct for DB inserts
pub struct EpisodeRow {
    pub season:       Option<i64>,
    pub episode:      Option<i64>,
    pub episode_name: Option<String>,
    pub airdate:      Option<String>,
    pub airtime:      Option<String>,
    pub runtime:      Option<i64>,
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

pub async fn fetch_show_search(query: &str) -> Result<Vec<TvMazeShowResult>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.tvmaze.com/search/shows")
        .query(&[("q", query)])          // ← reqwest handles URL encoding
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Vec<TvMazeShowResult>>()
        .await
        .map_err(|e| e.to_string())
}

pub async fn fetch_episodes(tvmaze_id: i64) -> Result<Vec<EpisodeRow>, String> {
    let client = reqwest::Client::new();
    let url = format!("https://api.tvmaze.com/shows/{}/episodes", tvmaze_id);
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let raw: Vec<TvMazeEpisode> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(raw.into_iter().map(|ep| EpisodeRow {
        season:       ep.season,
        episode:      ep.number,
        episode_name: ep.name,
        airdate:      ep.airdate,
        airtime:      ep.airtime,
        runtime:      ep.runtime,
    }).collect())
}

// ── Background sync ────────────────────────────────────────────────────────

pub async fn run_background_sync(db: Arc<DvrDatabase>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
        println!("[TVMaze Sync] Starting 24h episode refresh...");
        
        let shows = match db.tvmaze_get_running_shows() {
            Ok(s) => s,
            Err(e) => { eprintln!("[TVMaze Sync] Failed to get shows: {}", e); continue; }
        };
        
        let mut refreshed = 0u32;
        for (tvmaze_id, show_name) in shows {
            match fetch_episodes(tvmaze_id).await {
                Ok(episodes) => {
                    let _ = db.tvmaze_upsert_episodes(tvmaze_id, &episodes);
                    let _ = db.tvmaze_update_last_synced(tvmaze_id);
                    refreshed += 1;
                    println!("[TVMaze Sync] Refreshed: {}", show_name);
                }
                Err(e) => eprintln!("[TVMaze Sync] Error for {}: {}", show_name, e),
            }
            // Be polite to the public API
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        println!("[TVMaze Sync] Done. Refreshed {} shows.", refreshed);
    }
}
```

---

## Part 3 — Modifications to `lib.rs`

### 3a — Add module declaration (near the top with the other modules)
```rust
mod tvmaze;
```

### 3b — Add command functions (anywhere in the command section)
```rust
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
    state.db.tvmaze_add_favorite(
        tvmaze_id, &show_name,
        show_image.as_deref(), channel_name.as_deref(),
        channel_id.as_deref(), status.as_deref(),
    ).map_err(|e| e.to_string())?;

    // Fetch and store episodes immediately
    let episodes = tvmaze::fetch_episodes(tvmaze_id).await?;
    state.db.tvmaze_upsert_episodes(tvmaze_id, &episodes)
        .map_err(|e| e.to_string())?;
    state.db.tvmaze_update_last_synced(tvmaze_id)
        .map_err(|e| e.to_string())?;
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
    month: String,  // "2026-03"
) -> Result<Vec<tvmaze::CalendarEpisode>, String> {
    state.db.tvmaze_get_calendar_episodes(&month).map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_tvmaze_shows(
    state: tauri::State<'_, DvrState>,
) -> Result<u32, String> {
    let shows = state.db.tvmaze_get_running_shows().map_err(|e| e.to_string())?;
    let mut count = 0u32;
    for (tvmaze_id, _) in shows {
        if let Ok(eps) = tvmaze::fetch_episodes(tvmaze_id).await {
            let _ = state.db.tvmaze_upsert_episodes(tvmaze_id, &eps);
            let _ = state.db.tvmaze_update_last_synced(tvmaze_id);
            count += 1;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Ok(count)
}
```

### 3c — Register in `invoke_handler![]`
Add these 6 names to the existing list:
```rust
search_tvmaze,
add_tv_favorite,
remove_tv_favorite,
get_tracked_shows,
get_calendar_episodes,
sync_tvmaze_shows,
```

---

## Part 4 — Modifications to `dvr/mod.rs`

In `start_background_tasks()`, after the cleanup task is started, add:
```rust
// Start TVMaze 24h background sync
let tvmaze_db = self.db.clone();
tokio::spawn(async move {
    crate::tvmaze::run_background_sync(tvmaze_db).await;
});
info!("TVMaze background sync task started");
```

---

## Part 5 — React UI

### 5a — `Sidebar.tsx` changes

**Add to the `View` type (line 82):**
```ts
type View = 'none' | 'guide' | 'movies' | 'series' | 'dvr' | 'sports' | 'calendar' | 'settings';
```

**Add a calendar SVG icon to the `Icons` object** (after the sports icon):
```tsx
calendar: (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z" />
    <path d="M16 3v4" /><path d="M8 3v4" /><path d="M4 11h16" />
    <path d="M11 15h1" /><path d="M12 15v3" />
  </svg>
),
```

**Add a nav button** (after the sports button, before the `{hasVodSource && ...}` block):
```tsx
<button
  className={`nav-item ${activeView === 'calendar' ? 'active' : ''}`}
  onClick={() => handleVodClick('calendar')}
  title="TV Calendar"
>
  <span className="nav-icon">{Icons.calendar}</span>
  <span className="nav-label">Calendar</span>
</button>
```

### 5b — `App.tsx` changes

Search for where `DvrDashboard` or `SportsHub` are conditionally rendered and add the calendar in the same block. The pattern in App.tsx will look something like:

```tsx
import { TVCalendar } from './components/TVCalendar';

// Inside JSX, wherever Sports/DVR views are rendered:
{activeView === 'calendar' && <TVCalendar />}
```

> [!NOTE]
> `App.tsx` is 1,245+ lines. Search for `activeView === 'dvr'` or `activeView === 'sports'` to find the right place. The calendar view should close categories/guide like those do (call `setCategoriesOpen(false)` if needed). Look at how `SportsHub` is revealed — copy that exact pattern.

### 5c — `ProgramContextMenu.tsx` changes

**Add state:**
```tsx
const [showTrackModal, setShowTrackModal] = useState(false);
```

**Add import:**
```tsx
import { TVMazeSearchModal } from './TVMazeSearchModal';
```

**Add menu item** (after the "Add to Watchlist" item, before the separator):
```tsx
<div className="context-menu-item" onClick={() => setShowTrackModal(true)}>
    📅 Track Show
</div>
```

**Add modal render** (inside the `<>` fragment, after `<WatchlistOptionsModal ...>`):
```tsx
{showTrackModal && (
    <TVMazeSearchModal
        programTitle={program.title}
        channelName={channelName}
        channelId={channelId}
        onClose={() => { setShowTrackModal(false); onClose(); }}
    />
)}
```

> [!CAUTION]
> When `showTrackModal` is true, the "click outside to close" `useEffect` must NOT close the context menu. Look at how `showWatchlistModal` is handled — the existing `handleClickOutside` already has `if (showWatchlistModal) return;`. Add the same guard: `if (showWatchlistModal || showTrackModal) return;`.

### 5d — `ChannelContextMenu.tsx` changes

Same pattern as above. In the **main menu view** (the last `return createPortal(...)` block), add after the existing items:
```tsx
<div className="context-menu-item" onClick={() => setShowTrackModal(true)}>
    📅 Track Show
</div>
```
`programTitle` should be `channel.name`. `channelId` is `channel.stream_id`.

---

## Part 6 — New Components

### `TVMazeSearchModal.tsx`
```tsx
import { invoke } from '@tauri-apps/api/core';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './TVMazeSearchModal.css';

interface ShowResult {
  score: number;
  show: {
    id: number; name: string; status?: string;
    network?: { name: string };
    image?: { medium?: string };
    summary?: string;
  };
}

interface Props {
  programTitle: string;
  channelName?: string;
  channelId?: string;
  onClose: () => void;
}

export function TVMazeSearchModal({ programTitle, channelName, channelId, onClose }: Props) {
  const [query, setQuery] = useState(programTitle);
  const [results, setResults] = useState<ShowResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { handleSearch(); }, []); // auto-search on open

  async function handleSearch() {
    if (!query.trim()) return;
    setLoading(true); setError(null);
    try {
      const res = await invoke<ShowResult[]>('search_tvmaze', { query: query.trim() });
      setResults(res.slice(0, 6));
    } catch (e: any) {
      setError(e?.toString() || 'Search failed');
    } finally { setLoading(false); }
  }

  async function handleAdd(show: ShowResult['show']) {
    setAdding(show.id);
    try {
      await invoke('add_tv_favorite', {
        tvmazeId: show.id,        // ← Tauri camelCase param mapping
        showName: show.name,
        showImage: show.image?.medium ?? null,
        channelName: channelName ?? null,
        channelId: channelId ?? null,
        status: show.status ?? null,
      });
      onClose();
    } catch (e: any) {
      setError(e?.toString() || 'Failed to add show');
    } finally { setAdding(null); }
  }

  return createPortal(
    <div className="tvmaze-overlay" onClick={onClose}>
      <div className="tvmaze-modal" onClick={e => e.stopPropagation()}>
        <div className="tvmaze-header">
          <h2>Track Show</h2>
          <button className="tvmaze-close" onClick={onClose}>✕</button>
        </div>
        <div className="tvmaze-search-row">
          <input
            className="tvmaze-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            autoFocus
          />
          <button className="tvmaze-search-btn" onClick={handleSearch} disabled={loading}>
            {loading ? '…' : 'Search'}
          </button>
        </div>
        {error && <div className="tvmaze-error">{error}</div>}
        <div className="tvmaze-results">
          {results.map(r => (
            <div
              key={r.show.id}
              className={`tvmaze-result ${adding === r.show.id ? 'adding' : ''}`}
              onClick={() => adding == null && handleAdd(r.show)}
            >
              {r.show.image?.medium
                ? <img src={r.show.image.medium} alt={r.show.name} className="tvmaze-thumb" />
                : <div className="tvmaze-thumb-placeholder">📺</div>
              }
              <div className="tvmaze-result-info">
                <strong>{r.show.name}</strong>
                <span>{r.show.network?.name}{r.show.status ? ` · ${r.show.status}` : ''}</span>
              </div>
              {adding === r.show.id
                ? <span className="tvmaze-adding-spin">⏳</span>
                : <span className="tvmaze-add-btn">+ Track</span>
              }
            </div>
          ))}
          {!loading && results.length === 0 && <div className="tvmaze-empty">No results</div>}
        </div>
      </div>
    </div>,
    document.body
  );
}
```

> [!IMPORTANT]
> **Tauri parameter casing:** When calling `invoke('add_tv_favorite', { tvmazeId, showName, ... })`, Tauri v2 automatically converts camelCase JS keys to snake_case Rust parameter names. So `tvmazeId` maps to `tvmaze_id` in Rust. Use camelCase in the JS `invoke` call.

### `TVCalendar.tsx`
```tsx
import { invoke } from '@tauri-apps/api/core';
import { useState, useEffect } from 'react';
import './TVCalendar.css';

interface CalendarEpisode {
  airdate: string; airtime?: string; episode_name?: string;
  season?: number; episode?: number;
  show_name: string; channel_name?: string; show_image?: string;
}
interface TrackedShow {
  tvmaze_id: number; show_name: string; show_image?: string;
  channel_name?: string; status?: string; last_synced?: string;
}

export function TVCalendar() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-based
  const [episodes, setEpisodes] = useState<CalendarEpisode[]>([]);
  const [tracked, setTracked] = useState<TrackedShow[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const monthStr = `${year}-${String(month).padStart(2, '0')}`;

  useEffect(() => {
    setLoading(true);
    Promise.all([
      invoke<CalendarEpisode[]>('get_calendar_episodes', { month: monthStr }),
      invoke<TrackedShow[]>('get_tracked_shows'),
    ]).then(([eps, shows]) => {
      setEpisodes(eps); setTracked(shows);
    }).finally(() => setLoading(false));
  }, [monthStr]);

  function prevMonth() { if (month === 1) { setYear(y => y - 1); setMonth(12); } else setMonth(m => m - 1); }
  function nextMonth() { if (month === 12) { setYear(y => y + 1); setMonth(1); } else setMonth(m => m + 1); }

  async function handleUntrack(tvmazeId: number) {
    await invoke('remove_tv_favorite', { tvmazeId });
    setTracked(t => t.filter(s => s.tvmaze_id !== tvmazeId));
    setEpisodes(e => e.filter(ep => {
      const show = tracked.find(s => s.tvmaze_id === tvmazeId);
      return !show || ep.show_name !== show.show_name;
    }));
  }

  // Build calendar grid
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month, 0).getDate();
  const byDate: Record<string, CalendarEpisode[]> = {};
  episodes.forEach(ep => { if (ep.airdate) { byDate[ep.airdate] = [...(byDate[ep.airdate] || []), ep]; } });

  const selectedEps = selectedDay ? (byDate[selectedDay] || []) : [];
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];

  return (
    <div className="tv-calendar">
      <div className="tv-cal-header">
        <button onClick={prevMonth}>‹</button>
        <h2>{MONTHS[month - 1]} {year}</h2>
        <button onClick={nextMonth}>›</button>
      </div>

      {loading && <div className="tv-cal-loading">Loading…</div>}

      <div className="tv-cal-grid">
        {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
          <div key={d} className="tv-cal-dow">{d}</div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => <div key={`blank-${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const dateStr = `${monthStr}-${String(day).padStart(2, '0')}`;
          const eps = byDate[dateStr] || [];
          const isSelected = selectedDay === dateStr;
          const isToday = dateStr === new Date().toISOString().slice(0, 10);
          return (
            <div
              key={dateStr}
              className={`tv-cal-day ${eps.length ? 'has-episodes' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}`}
              onClick={() => setSelectedDay(isSelected ? null : dateStr)}
            >
              <span className="tv-cal-day-num">{day}</span>
              {eps.slice(0, 3).map((ep, j) => (
                <div key={j} className="tv-cal-dot" title={ep.show_name} />
              ))}
              {eps.length > 3 && <div className="tv-cal-more">+{eps.length - 3}</div>}
            </div>
          );
        })}
      </div>

      {selectedDay && selectedEps.length > 0 && (
        <div className="tv-cal-detail">
          <h3>{selectedDay}</h3>
          {selectedEps.map((ep, i) => (
            <div key={i} className="tv-cal-episode">
              {ep.show_image && <img src={ep.show_image} className="tv-cal-ep-img" alt={ep.show_name} />}
              <div>
                <strong>{ep.show_name}</strong>
                {ep.season != null && ep.episode != null && <span> S{String(ep.season).padStart(2,'0')}E{String(ep.episode).padStart(2,'0')}</span>}
                {ep.episode_name && <div>{ep.episode_name}</div>}
                {ep.airtime && <div>🕐 {ep.airtime}{ep.channel_name ? ` · ${ep.channel_name}` : ''}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="tv-cal-tracked">
        <h3>Tracked Shows ({tracked.length})</h3>
        {tracked.map(show => (
          <div key={show.tvmaze_id} className="tv-cal-tracked-row">
            {show.show_image && <img src={show.show_image} className="tv-cal-tracked-img" alt={show.show_name} />}
            <div className="tv-cal-tracked-info">
              <strong>{show.show_name}</strong>
              <span>{show.status}{show.channel_name ? ` · ${show.channel_name}` : ''}</span>
            </div>
            <button className="tv-cal-untrack-btn" onClick={() => handleUntrack(show.tvmaze_id)}>Untrack</button>
          </div>
        ))}
        {tracked.length === 0 && <p className="tv-cal-empty">No shows tracked yet. Right-click a program in the EPG to add one.</p>}
      </div>
    </div>
  );
}
```

---

## Verification Plan

### Build
```powershell
cd c:\ynotvbuild
pnpm --filter @ynotv/app tauri build
# OR for dev:
pnpm --filter @ynotv/app tauri dev
```

### Manual Test Flow
1. Launch app → EPG → right-click any program → confirm **"📅 Track Show"** item appears
2. Click it → confirm modal opens with the program title pre-loaded and results already loading
3. Click a result → confirm no error, modal closes
4. Click **"Calendar"** in the sidebar → confirm page loads
5. Confirm episode dots appear on the correct days for the current month
6. Click a day → confirm episode detail shows show name, S/E, time, channel
7. Confirm the "Tracked Shows" section lists the show with the correct channel name
8. Click **Untrack** → confirm show and its dots disappear
9. Right-click a **channel** in the EPG channel list → confirm "📅 Track Show" also appears
