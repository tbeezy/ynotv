//! Streaming EPG Parser
//!
//! This module provides high-performance streaming XMLTV parsing that:
//! - Streams the download through the (optionally gzip) decoder into a SINGLE
//!   parse pass — download and parse overlap, and the decompressed XML is
//!   never materialized as a whole. Parsed batches are spooled in memory until
//!   the download is verified (clean end + content-length satisfied + XMLTV
//!   head probe) and only then swapped in, so a bad/partial download never
//!   replaces existing data
//! - Pipelined inserts (file path) or spool-then-insert (network path)
//! - Inserts with honest timing: the insert connection runs with
//!   busy_timeout=0, lock contention is retried with measured sleeps, and
//!   lock_wait_ms is reported separately from insert_ms so queueing vs. real
//!   writing can be told apart
//! - Sends progress updates to the frontend
//! - Handles large EPG files (>50MB) efficiently
//! - Supports multiple channels sharing the same tvg-id (primary + backup streams)

use std::collections::HashMap;
use std::error::Error;
use anyhow::{Context, Result};
use chrono::DateTime;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use log::{error, info, warn};
use futures_util::StreamExt;

use crate::dvr::database::DvrDatabase;
use tauri::Emitter;

/// Retry a sync database operation with exponential backoff when "database is locked" occurs.
/// Serializes ALL EPG program writes (deletes, channel metadata, batch
/// inserts) across concurrent source syncs. SQLite allows only one writer at
/// a time; without this, N sources finishing their parses together thrash the
/// write lock — busy_timeout burns, retry budgets get exhausted, and
/// "database is locked" escapes into parse failures. With the mutex the
/// writes form one orderly queue, and the time spent queueing is exactly what
/// `lock_wait_ms` reports. A poisoned mutex (panicked holder) is recovered,
/// not propagated.
static EPG_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn with_sync_db_retry<F, T>(mut operation: F) -> Result<T>
where
    F: FnMut() -> Result<T>,
{
    let max_retries = 5;
    let mut last_error = None;

    for attempt in 1..=max_retries {
        match operation() {
            Ok(result) => return Ok(result),
            Err(e) => {
                let err_str = e.to_string().to_lowercase();
                if err_str.contains("database is locked") || err_str.contains("busy") {
                    if attempt < max_retries {
                        let delay_ms = 100 * attempt as u64;
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    }
                    last_error = Some(e);
                } else {
                    return Err(e);
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Max retries exceeded for database operation")))
}

/// Batch size for database inserts - optimized for modern NVMe SSDs
const BATCH_SIZE: usize = 25000;
/// Channel buffer size for pipelining (number of batches in flight)
const CHANNEL_BUFFER: usize = 4;
/// Progress update interval (every N batches)
const PROGRESS_INTERVAL: usize = 5;

/// Parse XMLTV date format: YYYYMMDDHHmmss +0000 -> ISO 8601
/// Returns the original string if parsing fails
fn parse_xmltv_date(date_str: &str) -> String {
    // XMLTV format: YYYYMMDDHHmmss +0000 (timezone is optional)
    // Examples: "20240223020000 +0000" or "20240223020000" or "20240223020000+0000"
    let trimmed = date_str.trim();

    // Try to parse with regex-like approach
    if trimmed.len() >= 14 {
        let year = &trimmed[0..4];
        let month = &trimmed[4..6];
        let day = &trimmed[6..8];
        let hour = &trimmed[8..10];
        let min = &trimmed[10..12];
        let sec = &trimmed[12..14];

        // Extract timezone if present (format: +0000 or -0500, with or without space)
        let tz = if trimmed.len() > 14 {
            // Look for + or - followed by 4 digits anywhere after the date part
            let remainder = &trimmed[14..];
            // Find the first + or - character
            if let Some(sign_pos) = remainder.find(|c| c == '+' || c == '-') {
                let tz_start = &remainder[sign_pos..];
                // Check if we have at least 5 chars (+/- plus 4 digits)
                if tz_start.len() >= 5 {
                    let tz_part = &tz_start[..5];
                    // Verify the format is +HHMM or -HHMM
                    if tz_part.chars().next().map(|c| c == '+' || c == '-').unwrap_or(false)
                        && tz_part[1..].chars().all(|c| c.is_ascii_digit())
                    {
                        // Convert +0000 to +00:00
                        format!("{}{}:{}", &tz_part[0..1], &tz_part[1..3], &tz_part[3..5])
                    } else {
                        "Z".to_string()
                    }
                } else {
                    "Z".to_string()
                }
            } else {
                "Z".to_string()
            }
        } else {
            "Z".to_string()
        };

        // Build ISO 8601: YYYY-MM-DDTHH:mm:ss+00:00
        format!("{}-{}-{}T{}:{}:{}{}", year, month, day, hour, min, sec, tz)
    } else {
        // Fallback: return original if it doesn't match expected format
        trimmed.to_string()
    }
}

/// An EPG program parsed from XMLTV
#[derive(Debug, Clone, Default)]
pub struct EpgProgram {
    pub channel_id: String,
    pub title: String,
    pub sub_title: Option<String>,
    pub description: Option<String>,
    pub start: String,  // ISO 8601 format
    pub stop: String,   // ISO 8601 format
}

/// Channel mapping from EPG channel ID to stream_id(s)
/// Supports multiple stream_ids for channels sharing the same tvg-id
#[derive(Debug, Clone, Deserialize)]
pub struct ChannelMapping {
    pub epg_channel_id: String,
    pub stream_id: String,
    pub channel_name: String,
}

/// Progress update sent to frontend
#[derive(Debug, Clone, Serialize)]
pub struct EpgParseProgress {
    pub source_id: String,
    pub phase: String,      // "streaming", "parsing", "inserting", "complete"
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub programs_parsed: usize,
    pub programs_matched: usize,
    pub programs_inserted: usize,
    pub estimated_remaining_seconds: Option<u64>,
}

/// Result of streaming EPG parse
#[derive(Debug, Clone, Serialize)]
pub struct EpgParseResult {
    pub source_id: String,
    pub total_programs: usize,
    pub matched_programs: usize,
    pub inserted_programs: usize,
    pub unmatched_channels: usize,
    pub matched_channels: usize,
    pub duration_ms: u64,
    pub bytes_processed: u64,
    /// Wall time spent downloading the EPG file (or reading it, for local files).
    pub download_ms: u64,
    /// Wall time spent decompressing (0 when the payload wasn't gzipped).
    pub decompress_ms: u64,
    /// Wall time spent parsing the XML (XMLTV -> matched programs).
    pub parse_ms: u64,
    /// Wall time spent inserting the parsed batches into the database
    /// (includes waiting for the SQLite write lock held by other sources).
    pub insert_ms: u64,
    /// Wall time of insert_ms that was spent waiting for the SQLite write
    /// lock (contention), not writing rows.
    pub lock_wait_ms: u64,
}

/// Configuration for one source in a multi-source EPG parse
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceEpgConfig {
    pub source_id: String,
    pub source_name: String,
    pub channel_mappings: Vec<ChannelMapping>,
    pub advanced_epg_matching: bool,
    pub timeshift_hours: f64,
    pub clear_existing: bool,
}

/// Lightweight per-source reference passed from the renderer for the
/// multi-source and cache-path EPG parses. The needing-EPG channel mappings
/// are computed in Rust from the main database (channels minus those whose
/// guide has not run out yet, with user overrides taking priority) instead of
/// being built and shipped across IPC.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpgSourceRef {
    pub source_id: String,
    pub source_name: String,
    pub advanced_epg_matching: bool,
    pub timeshift_hours: f64,
    pub clear_existing: bool,
}

/// Timestamp the gap-fill gate compares programme end times against. Stored
/// programme timestamps are RFC 3339 UTC with milliseconds
/// (`2026-09-14T08:00:00.000Z`), so a cutoff in the same format compares
/// correctly as a plain string — which is exactly what the gate relies on.
fn epg_coverage_cutoff() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Programme end times per stream id for one source (`stream_id -> MAX(end)`).
/// `None` means the stream has rows but no usable end time. Sources are gated
/// independently, so only this source's programmes are read.
fn load_stream_end_times(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> Result<HashMap<String, Option<String>>, String> {
    let mut stmt = conn
        .prepare("SELECT stream_id, MAX(end) FROM programs WHERE source_id = ?1 GROUP BY stream_id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (stream_id, max_end) = row.map_err(|e| e.to_string())?;
        out.insert(stream_id, max_end);
    }
    Ok(out)
}

/// The stream ids a gap-fill pass must leave alone: those whose guide has not
/// run out yet, i.e. that still have a programme ending at or after `cutoff`.
///
/// "Has any programmes at all" is deliberately not the test. The gap-fill paths
/// (`additional_epg_urls` and global EPG links) never re-visit a channel they
/// consider filled, so an existence-only check freezes a channel's guide at the
/// horizon of the sync that first filled it: a few days later every programme
/// has ended, the channel shows "no programme information" for good, and the
/// user has to apply an EPG override by hand to get it back. Treating those
/// channels as needing EPG again lets the next sync extend the guide.
fn covered_stream_ids(
    end_times: &HashMap<String, Option<String>>,
    cutoff: &str,
) -> std::collections::HashSet<String> {
    end_times
        .iter()
        .filter(|(_, max_end)| match max_end {
            Some(end) => end.as_str() >= cutoff,
            // Rows with no end time cannot be shown, so the channel still
            // needs EPG.
            None => false,
        })
        .map(|(stream_id, _)| stream_id.clone())
        .collect()
}

/// The name EPG matching should use for a channel.
///
/// `match_by_alias` (per channel, off by default) makes the user's rename — the
/// app's alias for the channel — *replace* the provider's name as the matching
/// key. Replacement, not a fallback: the provider name is then never turned into
/// a key, so a feed channel that happens to match the raw name can't fill the
/// channel either. That is what lets a rename fix a *wrong* match, not just an
/// empty one, which matters for Xtream/Stalker channels whose names can't be
/// corrected at the source.
///
/// A flagged channel with no alias keeps its provider name (never an empty key).
fn effective_match_name(name: &str, alias: Option<&str>, match_by_alias: bool) -> String {
    if !match_by_alias {
        return name.to_string();
    }
    match alias.map(str::trim) {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => name.to_string(),
    }
}

/// Channel → pinned feed (`epg_channel_overrides.epg_source_id`). A value of
/// `global_epg_<linkId>` pins the channel to that global EPG link; a bare
/// source id pins it to that source's own feed (its primary EPG + extra URLs).
///
/// Best-effort: the column is added by the renderer's schema migration, so on a
/// database that predates it (or if the table is missing) this returns no pins
/// and every pass behaves exactly as before.
/// Drop the pins naming a feed that no longer exists, returning how many went.
///
/// A pin reserves its channel for one feed and bars every other writer, so a pin
/// whose feed is gone would reserve the channel for nobody — blank for good. The
/// renderer resolves which feeds exist (it owns the playlist and EPG link lists)
/// and hands them over here; see `dropUnservableFeedPins` for the JS half.
fn drop_unservable_pins(
    pins: &mut HashMap<String, String>,
    unservable_feeds: &[String],
) -> usize {
    if unservable_feeds.is_empty() {
        return 0;
    }
    let dead: std::collections::HashSet<&str> = unservable_feeds
        .iter()
        .map(|feed| feed.trim())
        .filter(|feed| !feed.is_empty())
        .collect();
    let before = pins.len();
    pins.retain(|_, pin| !dead.contains(pin.as_str()));
    before - pins.len()
}

fn load_feed_pins(conn: &rusqlite::Connection) -> HashMap<String, String> {
    let mut pins = HashMap::new();
    let mut stmt = match conn.prepare(
        "SELECT stream_id, epg_source_id FROM epg_channel_overrides 
         WHERE epg_source_id IS NOT NULL AND TRIM(epg_source_id) != ''",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return pins,
    };
    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return pins,
    };
    for row in rows.flatten() {
        let (stream_id, pin) = row;
        if let Some(pin) = pin {
            if !pin.trim().is_empty() {
                pins.insert(stream_id, pin.trim().to_string());
            }
        }
    }
    pins
}

/// Stream ids whose override asks matching to use the renamed channel name
/// (`epg_channel_overrides.match_by_alias`). Best-effort for the same reason as
/// the feed pins: the column is added by the renderer's migration.
fn load_alias_matchers(conn: &rusqlite::Connection) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let mut stmt = match conn.prepare(
        "SELECT stream_id FROM epg_channel_overrides 
         WHERE match_by_alias IS NOT NULL AND match_by_alias != 0",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return out,
    };
    let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(_) => return out,
    };
    for stream_id in rows.flatten() {
        out.insert(stream_id);
    }
    out
}

/// Core needing-EPG mapping logic: given a source's channels, the set of
/// stream ids whose guide data is still current, and the user override map,
/// produce the channel mappings the parsers consume (override > epg_channel_id
/// > name, mirroring the renderer's old JS filter). Pure function so the
/// priority rules are unit-testable without a database.
///
/// A channel pinned to *this* feed is always in the pool, even when its guide
/// still has data: it is this feed's to fill, and the wipe exemption that keeps
/// its rows alive (`delete_programs_for_source`) would otherwise also freeze its
/// horizon at the first fill — the guide would only be extended once it had run
/// dry, which is the "ran out of program" symptom this rule exists to avoid.
fn build_needing_mappings(
    channels: Vec<(String, Option<String>, String)>, // stream_id, epg_channel_id, name
    covered: &std::collections::HashSet<String>,
    overrides: &HashMap<String, String>,
    pins: &HashMap<String, String>,
    feed_ref: Option<&str>,
) -> Vec<ChannelMapping> {
    let mut mappings = Vec::with_capacity(channels.len());
    for (stream_id, epg_channel_id, name) in channels {
        // Channel pinned to a specific feed: only that feed may fill it, so it
        // is left out of every other pass' needing pool. Without this a
        // higher-priority global EPG could overwrite the feed the user chose in
        // the channel editor (the override only pins the *id*, and ids are
        // shared across feeds).
        let pin = pins.get(&stream_id);
        let pinned_here = matches!(pin, Some(pin) if feed_ref == Some(pin.as_str()));
        if let Some(pin) = pin {
            if feed_ref != Some(pin.as_str()) {
                continue;
            }
        }
        if !pinned_here && covered.contains(&stream_id) {
            continue;
        }
        // Override wins, then epg_channel_id, then name (empty strings are
        // falsy, exactly like the JS `a || b || c` chain).
        let effective = overrides
            .get(&stream_id)
            .cloned()
            .or_else(|| {
                let id = epg_channel_id.as_deref().unwrap_or("");
                if id.is_empty() { None } else { Some(id.to_string()) }
            })
            .or_else(|| {
                if name.is_empty() { None } else { Some(name.clone()) }
            });
        if let Some(epg_channel_id) = effective {
            mappings.push(ChannelMapping {
                epg_channel_id,
                stream_id,
                channel_name: name,
            });
        }
    }
    mappings
}

/// Load the needing-EPG channel mappings for a set of source refs directly
/// from the main database. This moves the renderer's per-link prep (fetching
/// every channel, querying which stream ids already have programmes, applying
/// user overrides) into Rust, so ~20k-row mapping payloads no longer cross
/// IPC. Sources with nothing needing EPG are skipped.
pub fn load_channel_mappings_from_db(
    db: &DvrDatabase,
    sources: &[EpgSourceRef],
    // Identity of the feed this pass is parsing, for channel pins: a global EPG
    // link passes `global_epg_<linkId>`, a source's own feed/extra URL passes
    // the source id. `None` means "no feed identity" — pinned channels are then
    // skipped, since no feed can prove it is the pinned one.
    feed_ref: Option<&str>,
    // Feed refs a pin may name that no longer exist (a deleted playlist, a
    // deleted global EPG link). The renderer owns both lists, so it hands them
    // over; a pin naming one of these is treated as absent — nothing can serve
    // it, and honouring it would reserve the channel for nobody.
    unservable_feeds: &[String],
) -> Result<Vec<SourceEpgConfig>, String> {
    let conn = db
        .get_conn()
        .map_err(|e| format!("Failed to open DB for EPG mappings: {}", e))?;

    // User overrides are shared across all sources; load once.
    let mut overrides: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT stream_id, epg_channel_id FROM epg_channel_overrides")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (stream_id, epg_id) = row.map_err(|e| e.to_string())?;
            if let Some(id) = epg_id {
                if !id.trim().is_empty() {
                    overrides.insert(stream_id, id);
                }
            }
        }
    }

    // Feed pins (`epg_source_id`), same for every source in this pass. Read
    // best-effort: the column is added by the renderer's migration, so an older
    // database simply has no pins.
    //
    // Pins naming a feed that no longer exists are dropped here, so the same
    // channel can't be reserved by a feed that is gone in this pass while the
    // renderer's filters already treat it as unpinned (see
    // `dropUnservableFeedPins`).
    let mut pins = load_feed_pins(&conn);
    let dropped_pins = drop_unservable_pins(&mut pins, unservable_feeds);
    if dropped_pins > 0 {
        info!(
            "[EPG] Ignoring {} feed pin(s) naming a feed that no longer exists",
            dropped_pins
        );
    }

    // Channels whose guide should be matched on their renamed name instead of
    // the provider's (`match_by_alias`).
    let alias_matchers = load_alias_matchers(&conn);

    // One cutoff for the whole pass; every source is classified against it.
    let cutoff = epg_coverage_cutoff();

    let mut configs = Vec::with_capacity(sources.len());
    for src in sources {
        let channels: Vec<(String, Option<String>, String)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT stream_id, epg_channel_id, name, alias FROM channels WHERE source_id = ?",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![src.source_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for row in rows {
                let (stream_id, epg_channel_id, name, alias) = row.map_err(|e| e.to_string())?;
                let flagged = alias_matchers.contains(&stream_id);
                let name = effective_match_name(
                    &name.unwrap_or_default(),
                    alias.as_deref(),
                    flagged,
                );
                out.push((stream_id, epg_channel_id, name));
            }
            out
        };

        let end_times = load_stream_end_times(&conn, &src.source_id)?;
        let covered = covered_stream_ids(&end_times, &cutoff);
        // Stream ids whose programmes have all ended. They rejoin the needing
        // pool so the next sync extends their guide rather than freezing it at
        // whatever horizon the first fill happened to reach.
        let ran_out = end_times.len().saturating_sub(covered.len());

        let channel_mappings =
            build_needing_mappings(channels, &covered, &overrides, &pins, feed_ref);

        if channel_mappings.is_empty() {
            info!(
                "[EPG] Source {}: no channels need EPG, skipping",
                src.source_id
            );
            continue;
        }
        info!(
            "[EPG] Source {}: {} channel mappings prepared (needing EPG; {} filled stream(s) had run out and rejoined)",
            src.source_id,
            channel_mappings.len(),
            ran_out
        );
        configs.push(SourceEpgConfig {
            source_id: src.source_id.clone(),
            source_name: src.source_name.clone(),
            channel_mappings,
            advanced_epg_matching: src.advanced_epg_matching,
            timeshift_hours: src.timeshift_hours,
            clear_existing: src.clear_existing,
        });
    }
    Ok(configs)
}

/// Per-source stats accumulated during multi-source parsing
struct SourceParseStats {
    matched_programs: usize,
    unmatched_channels: std::collections::HashSet<String>,
    matched_channels: std::collections::HashSet<String>,
}

/// Normalize a channel name for fuzzy matching
/// Removes common prefixes, suffixes, and special characters
fn normalize_channel_name(name: &str) -> String {
    let name = name.trim();

    // Remove common prefixes (case insensitive)
    let prefixes = [
        "prime:", "il:", "f:", "ss:", "##", "####",
        "[", "]", "(", ")", "{", "}",
    ];
    let mut result = name.to_string();
    for prefix in &prefixes {
        if result.to_lowercase().starts_with(prefix) {
            result = result[prefix.len()..].to_string();
        }
    }

    // Remove superscript characters (ᴿᴬᵂ, ᴴᴰ, etc.)
    let superscripts = ['\u{1d3f}', '\u{1d2c}', '\u{1d42}', '\u{1d34}', '\u{1d35}', '\u{2076}', '\u{2070}', '\u{1da0}', '\u{1d56}', '\u{02e2}'];
    for ch in &superscripts {
        result = result.replace(*ch, "");
    }

    // Keep only alphanumeric characters and '+'
    result = result.chars()
        .filter(|c| c.is_alphanumeric() || *c == '+')
        .collect::<String>()
        .to_lowercase();

    result
}

/// Insert a `name -> id` entry plus its normalized form.
///
/// The normalized key is skipped only when it is byte-identical to the key that
/// was just stored. That guard matters: the raw key keeps the original casing
/// (it is also matched verbatim, so a casing-preserving key is load-bearing),
/// and the comparison used to be against `name.to_lowercase()`. For any clean
/// alphanumeric name — `TLC`, `Nickelodeon`, `ESPN2` — the normalized form
/// *equals* the lowercased name, so the normalized key was never inserted and
/// the only usable key was case-sensitive. A feed that lowercased (or
/// uppercased) the same name could then never match it.
fn insert_name_key(map: &mut HashMap<String, String>, name: &str, id: &str) {
    map.insert(name.to_string(), id.to_string());
    let normalized = normalize_channel_name(name);
    if !normalized.is_empty() && normalized != name {
        map.insert(normalized, id.to_string());
    }
}

/// Build a channel lookup map that supports multiple stream_ids per epg_channel_id
/// This allows primary + backup streams to all get the same EPG data
fn build_channel_lookup(mappings: Vec<ChannelMapping>) -> HashMap<String, Vec<String>> {
    let mut lookup: HashMap<String, Vec<String>> = HashMap::new();

    for mapping in mappings {
        let stream_id = mapping.stream_id;

        if !mapping.epg_channel_id.is_empty() {
            let epg_id = mapping.epg_channel_id.trim().to_string();
            lookup
                .entry(epg_id.clone())
                .or_default()
                .push(stream_id.clone());

            // Case-insensitive alias for the same id.
            //
            // Feeds and playlists routinely disagree on the casing of the same
            // channel id: IPTV playlists carry the canonical iptv-org form
            // (`ESPN2.us`) while some XMLTV feeds declare it lowercased
            // (`espn2.us`), because the generator bulk-lowercased the ids it
            // took from iptv-org. The programme lookup compares the raw value
            // first, so without this alias such a channel misses outright and
            // falls through to name matching — which then fails too, because
            // the feed's display names are undecorated while the provider's
            // channel names are not.
            //
            // Lowercase only, deliberately NOT `normalize_channel_name`: that
            // strips punctuation as well and would merge genuinely distinct ids
            // such as `a-b.c` and `ab.c`.
            let folded = epg_id.to_lowercase();
            if folded != epg_id {
                lookup
                    .entry(folded)
                    .or_default()
                    .push(stream_id.clone());
            }
        }

        // Also add name-based lookup for fallback
        if !mapping.channel_name.is_empty() {
            let name = mapping.channel_name.trim().to_string();
            lookup
                .entry(name.clone())
                .or_default()
                .push(stream_id.clone());

            // Also add the normalized version for fuzzy matching. Compare
            // against the raw key that was just stored, not its lowercase form:
            // otherwise a clean alphanumeric name (`TLC`) gets no normalized key
            // at all and can only ever match case-exactly.
            let normalized = normalize_channel_name(&name);
            if !normalized.is_empty() && normalized != name {
                lookup
                    .entry(normalized)
                    .or_default()
                    .push(stream_id.clone());
            }
        }
    }

    dedupe_lookup_values(lookup)
}

/// Merge channel lookup with display name mapping from EPG XML
/// This creates bidirectional mappings between M3U names and EPG channel IDs
fn merge_with_display_names(
    mut channel_lookup: HashMap<String, Vec<String>>,
    display_name_mapping: &HashMap<String, String>,
) -> HashMap<String, Vec<String>> {
    // For each M3U channel name in channel_lookup, check if it matches
    // any EPG display name, and if so, also map the EPG channel ID
    let m3u_names: Vec<String> = channel_lookup.keys().cloned().collect();

    for m3u_name in m3u_names {
        let normalized_m3u = normalize_channel_name(&m3u_name);

        // Check if this M3U name (or its normalized version) matches any EPG display name
        if let Some(epg_channel_id) = display_name_mapping.get(&m3u_name)
            .or_else(|| display_name_mapping.get(&normalized_m3u))
        {
            // Get the stream_ids for this M3U name
            if let Some(stream_ids) = channel_lookup.get(&m3u_name).cloned() {
                // Also map the EPG channel ID to these stream_ids
                channel_lookup
                    .entry(epg_channel_id.clone())
                    .or_default()
                    .extend(stream_ids.clone());
            }
        }
    }

    dedupe_lookup_values(channel_lookup)
}

/// Remove duplicate stream_ids from every lookup vector.
///
/// The display-name merge can append the same stream_id to one
/// epg_channel_id key more than once: an M3U name, its normalized alias
/// key, and a matching display name can all extend the same vector. Each
/// vector entry means "emit one program copy for this stream", so
/// duplicates are pure wasted insert work — the INSERT's ON CONFLICT(id)
/// would otherwise dedupe them only after the row has been written. The
/// final DB state is identical either way; this just avoids the redundant
/// writes (feeds with heavy raw/normalized name collisions were inserting
/// several copies per program).
fn dedupe_lookup_values(
    mut lookup: HashMap<String, Vec<String>>,
) -> HashMap<String, Vec<String>> {
    for stream_ids in lookup.values_mut() {
        stream_ids.sort_unstable();
        stream_ids.dedup();
    }
    lookup
}

/// Stream and parse EPG XML from URL with true streaming and pipelining
pub async fn stream_parse_epg<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: &DvrDatabase,
    source_id: String,
    source_name: String,
    epg_url: String,
    channel_mappings: Vec<ChannelMapping>,
    advanced_epg_matching: bool,
    timeshift_hours: f64,
    clear_existing: bool,
    user_agent: Option<String>,
) -> Result<EpgParseResult> {
    let start_time = std::time::Instant::now();
    let src_ctx = format!("{} ({})", source_name, source_id);

    info!("Starting TRUE streaming EPG parse for source {} from {} (advanced matching: {}, clear_existing: {})", src_ctx, epg_url, advanced_epg_matching, clear_existing);

    // Build channel lookup map (supports multiple stream_ids per epg_channel_id)
    let channel_lookup = build_channel_lookup(channel_mappings);

    info!("Channel lookup has {} entries", channel_lookup.len());

    // Check if URL is gzipped
    let is_gzipped = epg_url.ends_with(".gz");

    // Create HTTP client with optimized settings and TLS configuration
    // Using native-tls to handle various certificate types including self-signed
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(12))
        .timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(10)
        .danger_accept_invalid_certs(true)  // Accept self-signed/invalid certificates
        .danger_accept_invalid_hostnames(true)  // Accept invalid hostnames
        .user_agent(ua)
        .build()
        .context("Failed to create HTTP client")?;

    // Start download with streaming
    emit_progress(
        &app_handle,
        &source_id,
        EpgParseProgress {
            source_id: source_id.clone(),
            phase: "streaming".to_string(),
            bytes_downloaded: 0,
            total_bytes: None,
            programs_parsed: 0,
            programs_matched: 0,
            programs_inserted: 0,
            estimated_remaining_seconds: None,
        },
    );

    let response = match client
        .get(&epg_url)
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            // Extract detailed error information
            let err_source = e.source().map(|s| s.to_string()).unwrap_or_else(|| "unknown".to_string());
            let err_kind = format!("{:?}", e);
            
            let err_msg = format!(
                "Failed to download EPG from {}: {} (source: {}, kind: {})", 
                epg_url, e, err_source, err_kind
            );
            error!("[EPG] {}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }
    };

    let response = match response.error_for_status() {
        Ok(resp) => resp,
        Err(e) => {
            let err_msg = format!("HTTP error from EPG URL {}: {}", epg_url, e);
            error!("[EPG] {}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }
    };

    let total_bytes = response.content_length();
    info!("EPG download started, total size: {:?} bytes", total_bytes);

    // Check if response is actually gzipped (server may return gzip even if URL doesn't end with .gz)
    let is_response_gzipped = response.headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_lowercase().contains("gzip"))
        .unwrap_or(false);
    let should_decompress = is_gzipped || is_response_gzipped;
    if should_decompress {
        info!("[EPG] Will decompress response (URL gzipped: {}, Content-Encoding: {})",
            is_gzipped,
            response.headers().get("content-encoding").and_then(|v| v.to_str().ok()).unwrap_or("none")
        );
    }

    // SQLite old programs deletion is now deferred to parse_download_stream 
    // to ensure download succeeds first

    // Create channel for parse->insert pipeline
    let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);

    // Clone for parser task
    let channel_lookup_clone = channel_lookup.clone();
    let source_id_clone = source_id.clone();
    let app_handle_clone = app_handle.clone();
    let db_clone = db.clone();
    let src_ctx_clone = src_ctx.clone();

    // Spawn parser task that downloads and parses concurrently
    let parser_task = tokio::spawn(async move {
        parse_download_stream(
            response,
            channel_lookup_clone,
            batch_tx,
            app_handle_clone,
            source_id_clone,
            total_bytes,
            is_gzipped,
            advanced_epg_matching,
            db_clone,
            src_ctx_clone,
            timeshift_hours,
            clear_existing,
        ).await
    });

    // Run inserter task concurrently
    let inserter_result = insert_batches_pipeline(
        db,
        batch_rx,
        &source_id,
        app_handle.clone(),
        total_bytes,
        start_time,
    ).await;

    // Wait for parser to complete. Propagate the inner error as-is so real
    // failures (download, XMLTV probe, DB) are visible to the UI instead of
    // being hidden behind a generic "Parser task failed" wrapper.
    let parser_result = parser_task.await.context("EPG parser task panicked")??;
    // A batch that exhausted its retry budget is a data-loss event (the old
    // programs were already deleted for this source) — surface it instead of
    // reporting a silent partial insert.
    let inserter_result = inserter_result?;

    let duration_ms = start_time.elapsed().as_millis() as u64;

    let result = EpgParseResult {
        source_id: source_id.clone(),
        total_programs: parser_result.total_programs,
        matched_programs: parser_result.matched_programs,
        inserted_programs: inserter_result.inserted,
        unmatched_channels: parser_result.unmatched_channels,
        matched_channels: parser_result.matched_channels,
        duration_ms,
        bytes_processed: parser_result.bytes_processed,
        download_ms: parser_result.download_ms,
        decompress_ms: parser_result.decompress_ms,
        parse_ms: parser_result.parse_ms,
        insert_ms: inserter_result.insert_ms,
        lock_wait_ms: inserter_result.lock_wait_ms,
    };

    info!(
        "[EPG TIMING] source=\"{}\" url=\"{}\" download_ms={} decompress_ms={} parse_ms={} insert_ms={} lock_wait_ms={} total_ms={} bytes={} programs={} matched={} inserted={} unmatched_channels={}",
        src_ctx, epg_url,
        result.download_ms, result.decompress_ms, result.parse_ms, result.insert_ms,
        result.lock_wait_ms,
        result.duration_ms, result.bytes_processed,
        result.total_programs, result.matched_programs, result.inserted_programs,
        result.unmatched_channels
    );

    append_epg_timing_record(&app_handle, &source_id, &source_name, &epg_url, &result);

    Ok(result)
}

// =============================================================================
// Multi-source streaming EPG parse (download once, apply to many sources)
// =============================================================================

/// Stream and parse EPG XML from URL for multiple sources with a single download.
/// Each source gets programmes for its own channels. Waterfall-safe: clear_existing
/// is respected per source (typically false for global EPG gap-filling).
pub async fn stream_parse_epg_multi<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: &DvrDatabase,
    epg_url: String,
    sources: Vec<EpgSourceRef>,
    user_agent: Option<String>,
    // Feed identity for channel pins — see `load_channel_mappings_from_db`.
    feed_ref: Option<String>,
    // Feed refs a pin may name that no longer exist — see
    // `load_channel_mappings_from_db`.
    unservable_feeds: Vec<String>,
) -> Result<Vec<EpgParseResult>> {
    let start_time = std::time::Instant::now();

    // The needing-EPG channel mappings are computed here, from the main DB
    // (channels minus already-filled stream ids, overrides applied) — the
    // renderer no longer builds or ships the ~20k-row mapping payloads.
    let source_configs =
        load_channel_mappings_from_db(db, &sources, feed_ref.as_deref(), &unservable_feeds)
            .map_err(|e| anyhow::anyhow!(e))?;
    let source_count = source_configs.len();

    if source_configs.is_empty() {
        return Ok(Vec::new());
    }

    info!(
        "Starting multi-source EPG parse for {} source(s) from {}",
        source_count, epg_url
    );

    // Check if URL is gzipped
    let is_gzipped = epg_url.ends_with(".gz");

    // Build per-source channel lookups BEFORE the download (they depend only on
    // the channel mappings). Display-name merging for advanced matching happens
    // inside the single pass, once the <channel> elements have been seen.
    let mut per_source_lookups: Vec<(String, HashMap<String, Vec<String>>, bool)> =
        Vec::with_capacity(source_configs.len());
    for config in &source_configs {
        let lookup = build_channel_lookup(config.channel_mappings.clone());
        info!(
            "[EPG] Source {} channel lookup has {} entries",
            config.source_id, lookup.len()
        );
        per_source_lookups.push((
            config.source_id.clone(),
            lookup,
            config.advanced_epg_matching,
        ));
    }

    // Create HTTP client
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(12))
        .timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(10)
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .user_agent(ua)
        .build()
        .context("Failed to create HTTP client")?;

    // Download
    let response = match client.get(&epg_url).send().await {
        Ok(resp) => resp,
        Err(e) => {
            let err_msg = format!("Failed to download EPG from {}: {}", epg_url, e);
            error!("[EPG] {}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }
    };

    let response = match response.error_for_status() {
        Ok(resp) => resp,
        Err(e) => {
            let err_msg = format!("HTTP error from EPG URL {}: {}", epg_url, e);
            error!("[EPG] {}", err_msg);
            return Err(anyhow::anyhow!(err_msg));
        }
    };

    let total_bytes = response.content_length();
    info!("EPG download started, total size: {:?} bytes", total_bytes);

    // Read Content-Encoding before the body is consumed by the bridge (used
    // only for logging — the gzip magic bytes are the authoritative signal).
    let content_encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "none".to_string());

    // Create per-source batch channels and inserter tasks. They wait on their
    // channels — batches are only sent after the download is verified, so no
    // inserts can happen before the swap point.
    let mut batch_senders: HashMap<String, mpsc::Sender<Vec<EpgProgram>>> = HashMap::new();
    let mut inserter_handles: Vec<tokio::task::JoinHandle<anyhow::Result<InserterResult>>> = Vec::new();

    for config in &source_configs {
        let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);
        let sid = config.source_id.clone();
        let db_clone = db.clone();
        let app_clone = app_handle.clone();

        let handle = tokio::spawn(async move {
            insert_batches_pipeline(&db_clone, batch_rx, &sid, app_clone, total_bytes, start_time).await
        });

        batch_senders.insert(config.source_id.clone(), batch_tx);
        inserter_handles.push(handle);
    }

    // Bridge the async download into a synchronous byte stream so the parse
    // (a sync, CPU-bound single pass on a blocking thread) consumes chunks as
    // they arrive — download and parse now OVERLAP instead of running serially.
    // Safety is unchanged from the single-source path: nothing is deleted or
    // inserted until the download finishes cleanly (no network error,
    // content-length satisfied) AND the payload head is confirmed XMLTV.
    // Parsed batches are spooled per source in memory and only drained to the
    // inserters after that swap point.
    let (mut bridge, downloaded_total, download_finished, download_errored, download_finished_ms) =
        spawn_streaming_download(response);

    emit_progress(
        &app_handle,
        "multi",
        EpgParseProgress {
            source_id: "multi".to_string(),
            phase: "parsing".to_string(),
            bytes_downloaded: 0,
            total_bytes,
            programs_parsed: 0,
            programs_matched: 0,
            programs_inserted: 0,
            estimated_remaining_seconds: None,
        },
    );

    // Run the probe + single-pass parse on a blocking thread while the
    // download task keeps feeding the bridge. Everything that reads from
    // `bridge` must stay in this spawn_blocking task (blocking_recv parks the
    // thread; blocking a tokio worker here deadlocks once enough concurrent
    // sources park their workers).
    let app_handle_clone = app_handle.clone();
    let dl_progress = downloaded_total.clone();
    let epg_url_for_err = epg_url.clone();
    let parse_start = std::time::Instant::now();

    let blocking = tokio::task::spawn_blocking(move || -> Result<MultiSpooledParse> {
        use std::io::Read;

        // Peek the first two bytes for the gzip magic, then hand the stream to
        // the (de)compression layer. Magic bytes are the authoritative gzip
        // signal: reqwest auto-decompresses Content-Encoding: gzip and strips
        // the header, so neither the URL suffix nor the header alone means the
        // body is still compressed.
        let mut first_two = [0u8; 2];
        let mut filled = 0usize;
        while filled < 2 {
            let n = bridge.read(&mut first_two[filled..])?;
            if n == 0 {
                break; // empty body
            }
            filled += n;
        }
        let has_gzip_magic = filled == 2 && first_two[0] == 0x1f && first_two[1] == 0x8b;
        if has_gzip_magic {
            info!(
                "[EPG] Decompressing multi-source response (URL gzipped: {}, Content-Encoding: {})",
                is_gzipped, content_encoding
            );
        }

        // Decoder over the bridge: decompressed stream for gzip, passthrough
        // otherwise.
        let prefix = std::io::Cursor::new(first_two.to_vec());
        let mut dec: Box<dyn Read + Send> = if has_gzip_magic {
            let inner = std::io::BufReader::with_capacity(256 * 1024, prefix.chain(bridge));
            // MultiGzDecoder: handles concatenated gzip members (plain
            // GzDecoder silently truncates at the first member boundary).
            Box::new(flate2::bufread::MultiGzDecoder::new(inner))
        } else {
            Box::new(prefix.chain(bridge))
        };

        // Guard: verify the payload actually looks like XMLTV BEFORE any swap
        // (protects against HTTP error pages / garbage served with status 200
        // wiping the guide). Consumes up to 256KB from the stream; the bytes
        // are replayed below so nothing is lost.
        let mut head = Vec::with_capacity(256 * 1024);
        let _ = (&mut dec).take(256 * 1024).read_to_end(&mut head);
        let head_is_xmltv = {
            let s = String::from_utf8_lossy(&head);
            s.contains("<programme") || s.contains("<tv")
        };
        if !head_is_xmltv {
            return Err(anyhow::anyhow!(
                "EPG response from {} contained no XMLTV data (channels/programmes); keeping existing EPG data",
                epg_url_for_err
            ));
        }

        let reader = std::io::BufReader::with_capacity(
            256 * 1024,
            std::io::Cursor::new(head).chain(dec),
        );

        let mut last_progress_update = std::time::Instant::now();
        let mut on_progress = |parsed: usize, matched: usize| {
            if last_progress_update.elapsed().as_millis() > 100 {
                emit_progress(
                    &app_handle_clone,
                    "multi",
                    EpgParseProgress {
                        source_id: "multi".to_string(),
                        phase: "parsing".to_string(),
                        bytes_downloaded: dl_progress
                            .load(std::sync::atomic::Ordering::Relaxed),
                        total_bytes,
                        programs_parsed: parsed,
                        programs_matched: matched,
                        programs_inserted: 0,
                        estimated_remaining_seconds: estimate_remaining(
                            dl_progress.load(std::sync::atomic::Ordering::Relaxed),
                            total_bytes,
                            start_time.elapsed().as_secs(),
                        ),
                    },
                );
                last_progress_update = std::time::Instant::now();
            }
        };

        // Single pass. Per-source batches are spooled in memory until the
        // download has been verified and the swap point below is reached.
        let mut spools: HashMap<String, Vec<Vec<EpgProgram>>> = HashMap::new();
        let mut sink = |source_id: &str, batch: Vec<EpgProgram>| {
            spools.entry(source_id.to_string()).or_default().push(batch);
            true
        };
        // First successful match per stream, so the pass can record which feed
        // channel a filled channel now follows (and lock it there — see
        // `save_epg_channel_overrides`).
        let mut overrides: HashMap<String, String> = HashMap::new();
        let mut on_match = |stream_id: &str, feed_id: &str| {
            overrides
                .entry(stream_id.to_string())
                .or_insert_with(|| feed_id.to_string());
        };

        let (channels, result) = parse_and_stream_multi_once(
            reader,
            per_source_lookups,
            &mut sink,
            &mut on_progress,
            None,
            Some(&mut on_match),
        )?;

        Ok(MultiSpooledParse {
            spools,
            channels,
            result,
            overrides,
        })
    });

    let spooled = blocking.await.context("EPG parse task panicked")??;
    let parse_ms = parse_start.elapsed().as_millis() as u64;

    // The parser reads to EOF, which only happens once the download task has
    // ended, so the download wall is complete by now. Prefer the network-side
    // stamp (pure download duration); fall back to elapsed as a safety net.
    let download_ms = {
        let stamped = download_finished_ms.load(std::sync::atomic::Ordering::Relaxed);
        if stamped == 0 {
            start_time.elapsed().as_millis() as u64
        } else {
            stamped
        }
    };
    let total_bytes_downloaded = downloaded_total.load(std::sync::atomic::Ordering::Relaxed);
    let decompress_ms = 0; // overlapped with parsing in the streaming pass

    // Verify the download before swapping anything.
    if download_errored.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(anyhow::anyhow!(
            "EPG download for {} was interrupted by a network error; keeping existing EPG data",
            epg_url
        ));
    }
    if !download_finished.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(anyhow::anyhow!(
            "EPG download for {} did not complete; keeping existing EPG data",
            epg_url
        ));
    }
    if let Some(expected_len) = total_bytes {
        if total_bytes_downloaded < expected_len {
            return Err(anyhow::anyhow!(
                "Incomplete EPG download: expected {} bytes but got {}; keeping existing EPG data",
                expected_len, total_bytes_downloaded
            ));
        }
    }

    // Swap point: download verified AND payload is XMLTV (probe passed inside
    // the blocking task). Safe to touch the DB now.
    info!(
        "[EPG] EPG Download verified successful ({} bytes).",
        total_bytes_downloaded
    );

    let MultiSpooledParse {
        spools,
        channels,
        result: mut parse_result,
        overrides,
    } = spooled;
    parse_result.bytes_processed = total_bytes_downloaded;

    // Insert channel metadata for all sources, then delete old programs for
    // sources that request it (after verified download).
    for config in &source_configs {
        if let Err(e) = insert_epg_channels(db, &config.source_id, &channels) {
            warn!("[EPG] Failed to insert epg_channels for source {}: {}", config.source_id, e);
        }
    }
    for config in &source_configs {
        if config.clear_existing {
            let deleted = delete_programs_for_source(db, &config.source_id)?;
            info!("[EPG] Deleted {} old programs for source {}", deleted, config.source_id);
            log_pin_kept_programs(db, &config.source_id);
        }
    }

    // Channels locked to this feed get a replace, not a merge: they are this
    // feed's projection, so the previous owner's rows must go before the new
    // ones land (see `replace_locked_guides`).
    if let Some(feed_ref) = feed_ref.as_deref() {
        for (source_id, spool) in &spools {
            replace_locked_guides(db, source_id, feed_ref, spool.iter().flatten());
        }
    }

    // Hand the spooled batches to the per-source inserter pipelines (async
    // try_send so a busy inserter never blocks a tokio worker), then drop each
    // sender to signal EOF.
    for (source_id, spool) in spools {
        if let Some(batch_tx) = batch_senders.remove(&source_id) {
            for batch in spool {
                let mut pending = Some(batch);
                loop {
                    match batch_tx.try_send(pending.take().expect("batch present")) {
                        Ok(()) => break,
                        Err(tokio::sync::mpsc::error::TrySendError::Full(b)) => {
                            pending = Some(b);
                            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            warn!(
                                "[EPG] Inserter channel closed while draining spool for source {}",
                                source_id
                            );
                            break;
                        }
                    }
                }
            }
            drop(batch_tx);
        }
    }
    // Sources with no spooled batches: drop the sender to signal EOF.
    for (_, batch_tx) in batch_senders {
        drop(batch_tx);
    }

    // Wait for all inserters to finish
    let mut per_source_inserted: HashMap<String, usize> = HashMap::new();
    let mut per_source_insert_ms: HashMap<String, u64> = HashMap::new();
    let mut per_source_lock_wait_ms: HashMap<String, u64> = HashMap::new();
    for (i, handle) in inserter_handles.into_iter().enumerate() {
        let sid = source_configs[i].source_id.clone();
        match handle.await {
            Ok(Ok(result)) => {
                per_source_insert_ms.insert(sid.clone(), result.insert_ms);
                per_source_lock_wait_ms.insert(sid.clone(), result.lock_wait_ms);
                per_source_inserted.insert(sid, result.inserted);
            }
            Ok(Err(e)) => {
                // Per-source insert failure (e.g. a batch exhausted its retry
                // budget) — record 0 for this source so the gap is visible,
                // but don't fail the other sources in this multi-source parse.
                warn!("[EPG] Inserter failed for source {}: {}", sid, e);
                per_source_insert_ms.insert(sid.clone(), 0);
                per_source_lock_wait_ms.insert(sid.clone(), 0);
                per_source_inserted.insert(sid, 0);
            }
            Err(e) => {
                warn!("[EPG] Inserter task panicked for source {}: {}", sid, e);
                per_source_insert_ms.insert(sid.clone(), 0);
                per_source_lock_wait_ms.insert(sid, 0);
            }
        }
    }

    // Record which feed channel each filled channel now follows, and lock the
    // ones this link filled to it (same rule as the cache path — see
    // `save_epg_channel_overrides`). Written after the guides landed, so a lock
    // never points at a channel this pass filled nothing for.
    let link_lock = lockable_feed_ref(feed_ref.as_deref());
    match with_sync_db_retry(|| save_epg_channel_overrides(db, &overrides, link_lock)) {
        Ok(0) => {}
        Ok(saved) => match link_lock {
            Some(feed) => info!("[EPG] Locked {} channel(s) this link filled to {}", saved, feed),
            None => info!("[EPG] Saved {} channel override(s)", saved),
        },
        Err(e) => warn!("[EPG] Failed to save EPG channel overrides: {}", e),
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    // Build per-source results
    let mut results = Vec::with_capacity(source_configs.len());
    for config in &source_configs {
        let sid = &config.source_id;
        let stats = parse_result.source_stats.get(sid);
        let inserted = per_source_inserted.get(sid).copied().unwrap_or(0);
        let insert_ms = per_source_insert_ms.get(sid).copied().unwrap_or(0);
        let lock_wait_ms = per_source_lock_wait_ms.get(sid).copied().unwrap_or(0);

        let matched = stats.map(|s| s.matched_programs).unwrap_or(0);
        let unmatched = stats.map(|s| s.unmatched_channels.len()).unwrap_or(0);
        let matched_ch = stats.map(|s| s.matched_channels.len()).unwrap_or(0);

        let result = EpgParseResult {
            source_id: sid.clone(),
            total_programs: parse_result.total_programs,
            matched_programs: matched,
            inserted_programs: inserted,
            unmatched_channels: unmatched,
            matched_channels: matched_ch,
            duration_ms,
            bytes_processed: parse_result.bytes_processed,
            download_ms,
            decompress_ms,
            parse_ms,
            insert_ms,
            lock_wait_ms,
        };

        info!(
            "[EPG TIMING] source=\"{}\" url=\"{}\" download_ms={} decompress_ms={} parse_ms={} insert_ms={} lock_wait_ms={} total_ms={} bytes={} programs={} matched={} inserted={} unmatched_channels={}",
            sid, epg_url,
            result.download_ms, result.decompress_ms, result.parse_ms, result.insert_ms,
            result.lock_wait_ms,
            result.duration_ms, result.bytes_processed,
            result.total_programs, result.matched_programs, result.inserted_programs,
            result.unmatched_channels
        );

        append_epg_timing_record(&app_handle, sid, &config.source_name, &epg_url, &result);

        results.push(result);
    }

    info!(
        "Multi-source EPG parse complete: {} total programs, {} sources, {}ms",
        parse_result.total_programs, source_count, duration_ms
    );

    Ok(results)
}

/// Aggregated parser result from multi-source streaming parse
struct MultiSourceParserResult {
    total_programs: usize,
    bytes_processed: u64,
    source_stats: HashMap<String, SourceParseStats>,
}
struct StreamingParserResult {
    total_programs: usize,
    matched_programs: usize,
    unmatched_channels: usize,
    matched_channels: usize,
    bytes_processed: u64,
    /// Wall time spent downloading the EPG file (or reading it, for local files).
    download_ms: u64,
    /// Wall time spent decompressing (0 when the payload wasn't gzipped).
    decompress_ms: u64,
    /// Wall time spent parsing the XML into matched programmes.
    parse_ms: u64,
}

/// Result of the spooled network parse: parsed batches held in memory until
/// the download has been verified (clean end + XMLTV head), then swapped in.
struct SpooledParse {
    spool: Vec<Vec<EpgProgram>>,
    channels: Vec<EpgChannelInfo>,
    result: StreamingParserResult,
}

/// Result of the spooled multi-source parse: per-source parsed batches held in
/// memory until the download has been verified (clean end + XMLTV head), then
/// drained to the per-source inserters.
struct MultiSpooledParse {
    spools: HashMap<String, Vec<Vec<EpgProgram>>>,
    channels: Vec<EpgChannelInfo>,
    result: MultiSourceParserResult,
    /// stream_id -> first matched EPG channel id (for epg_channel_overrides).
    overrides: HashMap<String, String>,
}

/// Sync reader over an async download channel. Blocks only a blocking thread,
/// never a tokio worker: `blocking_recv` parks the calling (spawn_blocking)
/// thread until the download task delivers the next chunk, so a worker can
/// never deadlock waiting on a chunk that only another worker's download task
/// can deliver.
struct ChunkBridge {
    rx: tokio::sync::mpsc::Receiver<bytes::Bytes>,
    current: std::io::Cursor<bytes::Bytes>,
    eof: bool,
}

impl std::io::Read for ChunkBridge {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.current.position() >= self.current.get_ref().len() as u64 {
            if self.eof {
                return Ok(0);
            }
            match self.rx.blocking_recv() {
                Some(bytes) => {
                    self.current = std::io::Cursor::new(bytes);
                }
                None => {
                    // Channel closed = the download task ended.
                    self.eof = true;
                    return Ok(0);
                }
            }
        }
        self.current.read(buf)
    }
}

/// Spawn the async download task that feeds a `ChunkBridge`, plus shared
/// download-state flags for the caller to verify the download before any swap.
///
/// tokio mpsc: the download task awaits `send` when the channel is full (true
/// async backpressure — no busy-polling that would throttle the download to
/// ~one chunk per ms), and the reader side uses `blocking_recv` on the
/// blocking thread pool. The spawned task's JoinHandle is deliberately
/// dropped: the task ends itself when the stream does.
#[allow(clippy::type_complexity)]
fn spawn_streaming_download(
    response: reqwest::Response,
) -> (
    ChunkBridge,
    std::sync::Arc<std::sync::atomic::AtomicU64>,  // downloaded_total
    std::sync::Arc<std::sync::atomic::AtomicBool>, // download_finished
    std::sync::Arc<std::sync::atomic::AtomicBool>, // download_errored
    std::sync::Arc<std::sync::atomic::AtomicU64>,  // download_finished_ms
) {
    let (chunk_tx, chunk_rx) = tokio::sync::mpsc::channel::<bytes::Bytes>(16);

    let downloaded_total = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let download_finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let download_errored = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let download_finished_ms = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    let dl_total = downloaded_total.clone();
    let dl_finished = download_finished.clone();
    let dl_errored = download_errored.clone();
    let dl_finished_ms = download_finished_ms.clone();
    let dl_start = std::time::Instant::now();

    let _download_task = tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    dl_total.fetch_add(
                        chunk.len() as u64,
                        std::sync::atomic::Ordering::Relaxed,
                    );
                    // send().await yields the worker while the channel is full
                    // (the parser on the blocking pool drains it) — proper
                    // backpressure without blocking a worker or throttling.
                    if chunk_tx.send(chunk).await.is_err() {
                        // Parser is gone — stop downloading.
                        return;
                    }
                }
                Err(e) => {
                    warn!("Download error: {}", e);
                    dl_errored.store(true, std::sync::atomic::Ordering::Relaxed);
                    // Dropping chunk_tx makes the parser see a clean EOF; the
                    // errored flag below prevents any swap.
                    return;
                }
            }
        }
        dl_finished.store(true, std::sync::atomic::Ordering::Relaxed);
        dl_finished_ms.store(
            dl_start.elapsed().as_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
        // chunk_tx dropped here -> clean EOF for the parser
    });

    (
        ChunkBridge {
            rx: chunk_rx,
            current: std::io::Cursor::new(bytes::Bytes::new()),
            eof: false,
        },
        downloaded_total,
        download_finished,
        download_errored,
        download_finished_ms,
    )
}

/// Parse EPG by downloading chunks and parsing incrementally
/// Handles both plain XML and gzipped XML (.xml.gz)
async fn parse_download_stream<R: tauri::Runtime>(
    response: reqwest::Response,
    channel_lookup: HashMap<String, Vec<String>>,
    batch_tx: mpsc::Sender<Vec<EpgProgram>>,
    app_handle: tauri::AppHandle<R>,
    source_id: String,
    total_bytes: Option<u64>,
    is_gzipped: bool,
    advanced_epg_matching: bool,
    db: crate::dvr::database::DvrDatabase,
    src_ctx: String,
    timeshift_hours: f64,
    clear_existing: bool,
) -> Result<StreamingParserResult> {
    let start_time = std::time::Instant::now();

    // Check if response is actually gzipped BEFORE consuming response body
    let content_encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "none".to_string());

    // Bridge the async download into a synchronous byte stream so the parse
    // (a sync, CPU-bound single pass) consumes chunks as they arrive — download
    // and parse now OVERLAP instead of running serially.
    //
    // Safety is unchanged: nothing is deleted until the download finishes
    // cleanly (no network error, content-length satisfied) AND the head of the
    // payload is confirmed to be XMLTV. Parsed batches are spooled in memory
    // during the download and only handed to the inserter after that swap
    // point, so a bad/partial download never replaces existing programs.
    let (mut bridge, downloaded_total, download_finished, download_errored, download_finished_ms) =
        spawn_streaming_download(response);

    // NOTE: everything that reads from `bridge` (the gzip-magic peek, the
    // XMLTV head probe, the parse) happens inside the spawn_blocking task
    // below. The bridge blocks on channel recv while waiting for the next
    // download chunk, and blocking a tokio worker here deadlocks once enough
    // concurrent sources park their workers (each waits on a chunk that only
    // another worker's download task can deliver). The blocking thread pool
    // has no such coupling, so ALL bridge reads must stay in spawn_blocking.

    emit_progress(
        &app_handle,
        &source_id,
        EpgParseProgress {
            source_id: source_id.to_string(),
            phase: "parsing".to_string(),
            bytes_downloaded: 0,
            total_bytes,
            programs_parsed: 0,
            programs_matched: 0,
            programs_inserted: 0,
            estimated_remaining_seconds: None,
        },
    );

    // Run the probe + single-pass parse on a blocking thread while the
    // download task keeps feeding the bridge — download and parse overlap.
    let app_handle_clone = app_handle.clone();
    let source_id_clone = source_id.clone();
    let src_ctx_clone = src_ctx.clone();
    let dl_progress = downloaded_total.clone();
    let parse_start = std::time::Instant::now();

    let blocking = tokio::task::spawn_blocking(move || -> Result<SpooledParse> {
        use std::io::Read;

        // Peek the first two bytes for the gzip magic, then hand the stream to
        // the (de)compression layer. Magic bytes are the authoritative gzip
        // signal: reqwest auto-decompresses Content-Encoding: gzip and strips
        // the header, so neither the URL suffix nor the header alone means the
        // body is still compressed — trusting both could double-decompress and
        // hard-fail. (Runs here on a blocking thread: the peek waits for the
        // first download chunk and must never block a tokio worker.)
        let mut first_two = [0u8; 2];
        let mut filled = 0usize;
        while filled < 2 {
            let n = bridge.read(&mut first_two[filled..])?;
            if n == 0 {
                break; // empty body
            }
            filled += n;
        }
        let has_gzip_magic = filled == 2 && first_two[0] == 0x1f && first_two[1] == 0x8b;
        if has_gzip_magic {
            info!(
                "[EPG] Decompressing response (URL gzipped: {}, Content-Encoding: {})",
                is_gzipped, content_encoding
            );
        }

        // Decoder over the bridge: decompressed stream for gzip, passthrough
        // otherwise.
        let prefix = std::io::Cursor::new(first_two.to_vec());
        let mut dec: Box<dyn Read + Send> = if has_gzip_magic {
            let inner = std::io::BufReader::with_capacity(256 * 1024, prefix.chain(bridge));
            // MultiGzDecoder: handles concatenated gzip members (plain
            // GzDecoder silently truncates at the first member boundary).
            Box::new(flate2::bufread::MultiGzDecoder::new(inner))
        } else {
            Box::new(prefix.chain(bridge))
        };

        // Guard: verify the payload actually looks like XMLTV BEFORE any swap
        // (protects against HTTP error pages / garbage served with status 200
        // wiping the guide). Consumes up to 256KB from the stream; the bytes
        // are replayed below so nothing is lost.
        let mut head = Vec::with_capacity(256 * 1024);
        let _ = (&mut dec).take(256 * 1024).read_to_end(&mut head);
        let head_is_xmltv = {
            let s = String::from_utf8_lossy(&head);
            s.contains("<programme") || s.contains("<tv")
        };
        if !head_is_xmltv {
            return Err(anyhow::anyhow!(
                "EPG response from {} contained no XMLTV data (channels/programmes); keeping existing EPG data",
                src_ctx_clone
            ));
        }

        let reader = std::io::BufReader::with_capacity(
            256 * 1024,
            std::io::Cursor::new(head).chain(dec),
        );

        let mut last_progress_update = std::time::Instant::now();
        let mut on_progress = |parsed: usize, matched: usize| {
            if last_progress_update.elapsed().as_millis() > 100 {
                emit_progress(
                    &app_handle_clone,
                    &source_id_clone,
                    EpgParseProgress {
                        source_id: source_id_clone.to_string(),
                        phase: "parsing".to_string(),
                        bytes_downloaded: dl_progress
                            .load(std::sync::atomic::Ordering::Relaxed),
                        total_bytes,
                        programs_parsed: parsed,
                        programs_matched: matched,
                        programs_inserted: 0,
                        estimated_remaining_seconds: estimate_remaining(
                            dl_progress.load(std::sync::atomic::Ordering::Relaxed),
                            total_bytes,
                            start_time.elapsed().as_secs(),
                        ),
                    },
                );
                last_progress_update = std::time::Instant::now();
            }
        };

        // Single pass. Batches are spooled in memory until the download has
        // been verified and the swap point below is reached.
        let mut spool: Vec<Vec<EpgProgram>> = Vec::new();
        let mut sink = |batch: Vec<EpgProgram>| {
            spool.push(batch);
            true
        };

        let (channels, result) = parse_and_stream_epg_once(
            reader,
            channel_lookup,
            advanced_epg_matching,
            timeshift_hours,
            &mut sink,
            &mut on_progress,
        )?;

        Ok(SpooledParse {
            spool,
            channels,
            result,
        })
    });

    let spooled = blocking.await.context("EPG parse task panicked")??;
    let parse_ms = parse_start.elapsed().as_millis() as u64;

    // The parser reads to EOF, which only happens once the download task has
    // ended, so the download wall is complete by now. Prefer the network-side
    // stamp (pure download duration); fall back to elapsed as a safety net.
    let download_ms = {
        let stamped = download_finished_ms.load(std::sync::atomic::Ordering::Relaxed);
        if stamped == 0 {
            start_time.elapsed().as_millis() as u64
        } else {
            stamped
        }
    };
    let total_bytes_downloaded = downloaded_total.load(std::sync::atomic::Ordering::Relaxed);

    // Verify the download before swapping anything.
    if download_errored.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(anyhow::anyhow!(
            "EPG download for {} was interrupted by a network error; keeping existing EPG data",
            src_ctx
        ));
    }
    if !download_finished.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(anyhow::anyhow!(
            "EPG download for {} did not complete; keeping existing EPG data",
            src_ctx
        ));
    }
    if let Some(expected_len) = total_bytes {
        if total_bytes_downloaded < expected_len {
            return Err(anyhow::anyhow!(
                "Incomplete EPG download: expected {} bytes but got {}; keeping existing EPG data",
                expected_len, total_bytes_downloaded
            ));
        }
    }

    // Swap point: download verified AND payload is XMLTV (probe passed inside
    // the blocking task). Safe to replace old programs now.
    info!(
        "[EPG] EPG Download verified successful ({} bytes).",
        total_bytes_downloaded
    );
    if clear_existing {
        info!("[EPG] Deleting old programs for source {}", src_ctx);
        let deleted_count = delete_programs_for_source(&db, &source_id)?;
        info!("[EPG] Deleted {} old programs for source {}", deleted_count, src_ctx);
        log_pin_kept_programs(&db, &source_id);
    } else {
        info!("[EPG] Skipping deletion of old programs because clear_existing is false");
    }

    // Persist channel metadata for the channel editor (collected in the pass)
    if let Err(e) = insert_epg_channels(&db, &source_id, &spooled.channels) {
        warn!("[EPG] Failed to insert epg_channels for source {}: {}", source_id, e);
    }

    // Hand the spooled batches to the inserter pipeline (async try_send so a
    // busy inserter never blocks a tokio worker).
    for batch in spooled.spool {
        let mut pending = Some(batch);
        loop {
            match batch_tx.try_send(pending.take().expect("batch present")) {
                Ok(()) => break,
                Err(tokio::sync::mpsc::error::TrySendError::Full(b)) => {
                    pending = Some(b);
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    warn!(
                        "[EPG] Inserter channel closed while draining spool for source {}",
                        source_id
                    );
                    break;
                }
            }
        }
    }

    // Signal the inserter that parsing is complete
    drop(batch_tx);

    let mut result = spooled.result;
    result.download_ms = download_ms;
    result.decompress_ms = 0; // overlapped with parsing in the streaming pass
    result.parse_ms = parse_ms;
    result.bytes_processed = total_bytes_downloaded;

    let total_ms = start_time.elapsed().as_millis() as u64;
    info!(
        "[EPG Timing] Download: {}ms, Stream-Parse (incl. decompress, incl. download wait): {}ms, Total: {}ms",
        download_ms, parse_ms, total_ms
    );

    Ok(result)
}

/// Build a mapping from display names to channel IDs by parsing <channel> elements
/// This allows matching M3U channel names like "US: BET" to EPG channel id "bet.us"
///
/// Test-only since the multi-source path merged this into the single streaming
/// pass (`parse_and_stream_multi_once`); kept for the pipeline-parity tests.
#[cfg(test)]
fn build_display_name_mapping(xml_data: &[u8]) -> HashMap<String, String> {
    let mut mapping: HashMap<String, String> = HashMap::new();
    let mut reader = Reader::from_reader(xml_data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_channel_id: Option<String> = None;
    let mut current_element: Option<&'static str> = None;
    let mut current_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                match name {
                    b"channel" => {
                        // Parse channel id attribute
                        for attr in e.attributes() {
                            if let Ok(attr) = attr {
                                if attr.key.as_ref() == b"id" {
                                    let value = attr
                                        .decode_and_unescape_value(reader.decoder())
                                        .unwrap_or_default();
                                    current_channel_id = Some(value.to_string());
                                    break;
                                }
                            }
                        }
                    }
                    b"display-name" => {
                        current_element = Some("display-name");
                        current_text.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if current_element.is_some() {
                    if let Ok(text) = e.unescape() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                match name {
                    b"channel" => {
                        current_channel_id = None;
                    }
                    b"display-name" => {
                        if let Some(ref channel_id) = current_channel_id {
                            let display_name = current_text.trim().to_string();
                            if !display_name.is_empty() {
                                // Add mapping from display name to channel ID
                                // Raw key plus the normalized form (see
                                // `insert_name_key` for why the guard compares
                                // against the raw key, not the lowercased name).
                                insert_name_key(&mut mapping, &display_name, channel_id);
                            }
                        }
                        current_element = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error during display name extraction: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    info!("[EPG] Built display name mapping with {} entries", mapping.len());
    mapping
}

/// Info about an EPG channel extracted from XMLTV <channel> elements
#[derive(Debug, Clone)]
struct EpgChannelInfo {
    id: String,
    display_name: String,
    icon_url: Option<String>,
}

/// Bulk insert/replace EPG channels into the epg_channels table
fn insert_epg_channels(db: &DvrDatabase, source_id: &str, channels: &[EpgChannelInfo]) -> Result<usize> {
    with_sync_db_retry(|| {
        // Serialized with all other EPG program writes (see EPG_WRITE_LOCK).
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut conn = db.get_conn()?;
        // IMMEDIATE: this writes, so take the write lock at BEGIN — a deferred
        // tx upgrading to write can hit BUSY_SNAPSHOT when another connection
        // commits in between (busy_timeout can't fix that).
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

        // First, clear old channels for this source so we don't accumulate stale entries
        tx.execute("DELETE FROM epg_channels WHERE source_id = ?1", rusqlite::params![source_id])?;

        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO epg_channels (id, display_name, icon_url, source_id)
             VALUES (?1, ?2, ?3, ?4)"
        )?;

        let mut inserted = 0;
        for ch in channels {
            match stmt.execute(rusqlite::params![
                ch.id,
                ch.display_name,
                ch.icon_url.as_deref().unwrap_or(""),
                source_id,
            ]) {
                Ok(_) => inserted += 1,
                Err(e) => {
                    warn!("Failed to insert epg_channel {}: {}", ch.id, e);
                }
            }
        }

        stmt.finalize()?;
        tx.commit()?;

        info!("[EPG] Inserted {} epg_channels for source {}", inserted, source_id);
        Ok(inserted)
    })
}

/// Convert ISO 8601 datetime string to UTC format for storage.
/// Note: Timeshift is applied in SQL (programs_effective view), not here.
/// This ensures per-channel timeshift adjustments work immediately.
fn normalize_to_utc(date_str: &str) -> String {
    // Fast path: the canonical XMLTV form produced by parse_xmltv_date
    // ("20260223010000+00:00") contains no '-', and both chrono parsers below
    // require '-' separators — so nothing can convert. Returns an unchanged
    // copy; hot parse loops additionally guard the call itself (contains('-'))
    // to skip even this allocation.
    if !date_str.contains('-') {
        return date_str.to_string();
    }

    // Try parsing as a fixed-offset datetime (covers "+00:00", "+05:30", "Z", etc.)
    if let Ok(dt) = DateTime::parse_from_rfc3339(date_str) {
        // Convert to UTC and format with Z suffix
        return dt.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    }
    
    // Fallback: attempt manual parse
    if let Ok(dt) = DateTime::parse_from_str(date_str, "%Y-%m-%dT%H:%M:%S%z") {
        return dt.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    }
    
    // Couldn't parse, return as-is
    date_str.to_string()
}

/// Single-pass streaming parse core.
///
/// Parses <channel> metadata, incrementally merges display-name mappings
/// (advanced matching), and matches <programme> events — all in ONE pass over
/// the XML, reading from any `BufRead` (in-memory slice, gzip decoder over
/// buffered bytes, or a file). The decompressed XML is never materialized as a
/// whole; matched programmes flow out through `batch_tx` in batches.
///
/// Returns the extracted channel metadata (for the channel editor) and parse
/// stats. Phase timings are measured by the caller.
fn parse_and_stream_epg_once<R: std::io::BufRead>(
    reader: R,
    mut resolved_lookup: HashMap<String, Vec<String>>,
    advanced_epg_matching: bool,
    timeshift_hours: f64,
    // Batch sink: receives each 25k-program batch as it fills. Return false to
    // stop parsing early (e.g. the consumer went away). Kept synchronous so the
    // parse can run on a blocking thread while an async download feeds it.
    batch_sink: &mut dyn FnMut(Vec<EpgProgram>) -> bool,
    on_progress: &mut (dyn FnMut(usize, usize) + Send),
) -> Result<(Vec<EpgChannelInfo>, StreamingParserResult)> {
    // Timeshift is applied in SQL (programs_effective view), not here.
    let _timeshift_secs = (timeshift_hours * 3600.0).round() as i64;

    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);

    // <channel id="..."><display-name>..</display-name><icon src=".."/></channel>
    let mut in_channel = false;
    let mut channel_id: Option<String> = None;
    let mut channel_display_name: Option<String> = None;
    // Every <display-name> of the current channel. Feeds routinely carry several
    // (a clean name plus tagged/regional aliases); all of them are matchable,
    // and only the first is stored for display.
    let mut channel_display_names: Vec<String> = Vec::new();
    let mut channel_icon: Option<String> = None;
    let mut channel_element: Option<&'static str> = None;
    let mut channel_text = String::new();

    // <programme> element state
    let mut current_program: Option<EpgProgram> = None;
    let mut current_element: Option<&'static str> = None;
    let mut current_text = String::new();

    // Advanced matching: display name -> channel id, collected from <channel>
    // elements during the pass. XMLTV places all <channel> elements before
    // <programme> elements, so by the first programme the map is complete and
    // we can run the exact same merge as the (previously separate) full-document
    // pass — replicating `build_display_name_mapping` + `merge_with_display_names`
    // in the single pass.
    let mut display_map: HashMap<String, String> = HashMap::new();
    let mut lookup_merged = false;

    let mut channels: Vec<EpgChannelInfo> = Vec::new();
    let mut total_programs = 0usize;
    let mut matched_programs = 0usize;
    let mut unmatched_channels: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut matched_channels_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut batch: Vec<EpgProgram> = Vec::with_capacity(BATCH_SIZE);

    loop {
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                if in_channel {
                    match name {
                        b"display-name" => {
                            channel_element = Some("display-name");
                            channel_text.clear();
                        }
                        b"icon" => {
                            channel_element = Some("icon");
                            if channel_icon.is_none() {
                                for attr in e.attributes() {
                                    if let Ok(a) = attr {
                                        if a.key.as_ref() == b"src" {
                                            channel_icon = a
                                                .decode_and_unescape_value(xml.decoder())
                                                .ok()
                                                .map(|v| v.to_string());
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                } else {
                    match name {
                        b"channel" => {
                            in_channel = true;
                            channel_id = None;
                            channel_display_name = None;
                            channel_display_names.clear();
                            channel_icon = None;
                            for attr in e.attributes() {
                                if let Ok(a) = attr {
                                    if a.key.as_ref() == b"id" {
                                        channel_id = a
                                            .decode_and_unescape_value(xml.decoder())
                                            .ok()
                                            .map(|v| v.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                        b"programme" => {
                            let mut program = EpgProgram::default();
                            for attr in e.attributes() {
                                if let Ok(a) = attr {
                                    let key = a.key.as_ref();
                                    let value = a
                                        .decode_and_unescape_value(xml.decoder())
                                        .unwrap_or_default();
                                    match key {
                                        b"channel" => program.channel_id = value.to_string(),
                                        b"start" => program.start = parse_xmltv_date(&value),
                                        b"stop" => program.stop = parse_xmltv_date(&value),
                                        _ => {}
                                    }
                                }
                            }
                            current_program = Some(program);
                        }
                        b"title" | b"desc" | b"sub-title" => {
                            current_element = match name {
                                b"title" => Some("title"),
                                b"desc" => Some("desc"),
                                _ => Some("sub-title"),
                            };
                            current_text.clear();
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                // Self-closing <icon src="..."/> inside a channel
                if in_channel && channel_icon.is_none() && e.local_name().as_ref() == b"icon" {
                    for attr in e.attributes() {
                        if let Ok(a) = attr {
                            if a.key.as_ref() == b"src" {
                                channel_icon = a
                                    .decode_and_unescape_value(xml.decoder())
                                    .ok()
                                    .map(|v| v.to_string());
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if let Ok(text) = e.unescape() {
                    if in_channel && channel_element == Some("display-name") {
                        channel_text.push_str(&text);
                    } else if current_element.is_some() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::CData(e)) => {
                // CDATA-wrapped titles/descriptions were previously dropped
                // (Event::CData was never handled); treat them like text so
                // those fields populate correctly.
                if current_element.is_some() {
                    current_text.push_str(&String::from_utf8_lossy(&e));
                } else if in_channel && channel_element == Some("display-name") {
                    channel_text.push_str(&String::from_utf8_lossy(&e));
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                if in_channel {
                    match name {
                        b"display-name" => {
                            let text = channel_text.trim().to_string();
                            if !text.is_empty() {
                                // Keep the first name for display, but index
                                // every alias for matching.
                                if channel_display_name.is_none() {
                                    channel_display_name = Some(text.clone());
                                }
                                channel_display_names.push(text);
                            }
                            channel_element = None;
                        }
                        b"icon" => {
                            channel_element = None;
                        }
                        b"channel" => {
                            in_channel = false;
                            if let (Some(id), Some(display_name)) =
                                (channel_id.take(), channel_display_name.take())
                            {
                                channels.push(EpgChannelInfo {
                                    id: id.clone(),
                                    display_name: display_name.clone(),
                                    icon_url: channel_icon.take(),
                                });

                                // Collect display-name -> channel-id entries for
                                // advanced matching (same keys/conditions as
                                // build_display_name_mapping). The merge itself
                                // runs lazily at the first <programme>, once all
                                // channels (which precede programmes in XMLTV)
                                // have been seen, reusing the exact original
                                // merge algorithm.
                                if advanced_epg_matching {
                                    // Index every display name, not just the
                                    // first: the tagged/regional aliases are how
                                    // an id that a duplicate clean name would
                                    // otherwise shadow stays reachable.
                                    for display_name in &channel_display_names {
                                        insert_name_key(&mut display_map, display_name, &id);
                                    }
                                }
                            } else {
                                channel_icon.take();
                            }
                        }
                        _ => {}
                    }
                } else {
                    match name {
                        b"programme" => {
                            if let Some(mut program) = current_program.take() {
                                total_programs += 1;

                                // Lazy display-name merge: channels precede
                                // programmes in XMLTV, so by the first
                                // programme the display map is complete. Run
                                // the original merge exactly once.
                                if advanced_epg_matching && !lookup_merged {
                                    resolved_lookup =
                                        merge_with_display_names(resolved_lookup, &display_map);
                                    lookup_merged = true;
                                }

                                // Lookup: EPG channel IDs, M3U names, and
                                // normalized versions (fast O(1) lookups).
                                let stream_ids = resolved_lookup
                                    .get(&program.channel_id)
                                    .or_else(|| {
                                        resolved_lookup.get(&normalize_channel_name(
                                            &program.channel_id,
                                        ))
                                    });

                                if let Some(stream_ids) = stream_ids {
                                    matched_programs += 1; // count once, not per stream_id

                                    // Hot path (one stream_id per EPG channel —
                                    // ~650k programmes on a large feed): reuse the
                                    // programme's own Strings instead of cloning
                                    // all five per programme, which cost millions
                                    // of heap allocations per big feed. Output
                                    // is identical (same id, same fields). The
                                    // clone is only for the rare multi-stream_id
                                    // case below.
                                    if stream_ids.len() == 1 {
                                        let stream_id = &stream_ids[0];
                                        program.channel_id = stream_id.clone();
                                        // Fast path: parse_xmltv_date output
                                        // ("20260223010000+00:00") contains no
                                        // '-', so neither chrono parser below
                                        // can match it — skip the parse AND
                                        // the per-program heap allocation
                                        // (normalize_to_utc would return an
                                        // unchanged copy).
                                        if program.start.contains('-') {
                                            program.start =
                                                normalize_to_utc(&program.start);
                                        }
                                        if program.stop.contains('-') {
                                            program.stop =
                                                normalize_to_utc(&program.stop);
                                        }
                                        matched_channels_set.insert(stream_id.clone());
                                        batch.push(program);

                                        if batch.len() >= BATCH_SIZE {
                                            let batch_to_send =
                                                std::mem::take(&mut batch);
                                            batch.reserve(BATCH_SIZE);
                                            if !batch_sink(batch_to_send) {
                                                warn!("Batch sink stopped, stopping parser");
                                            }
                                        }
                                    } else {
                                        for stream_id in stream_ids {
                                            matched_channels_set.insert(stream_id.clone());
                                            let mut program_copy = program.clone();
                                            program_copy.channel_id = stream_id.clone();
                                            program_copy.start =
                                                normalize_to_utc(&program_copy.start);
                                            program_copy.stop =
                                                normalize_to_utc(&program_copy.stop);
                                            batch.push(program_copy);

                                            if batch.len() >= BATCH_SIZE {
                                                let batch_to_send =
                                                    std::mem::take(&mut batch);
                                                batch.reserve(BATCH_SIZE);
                                                if !batch_sink(batch_to_send) {
                                                    warn!("Batch sink stopped, stopping parser");
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    unmatched_channels.insert(program.channel_id);
                                }

                                if total_programs % (BATCH_SIZE * PROGRESS_INTERVAL) == 0 {
                                    on_progress(total_programs, matched_programs);
                                }
                            }
                        }
                        b"title" => {
                            if let Some(ref mut program) = current_program {
                                program.title = std::mem::take(&mut current_text);
                            }
                            current_element = None;
                        }
                        b"desc" => {
                            if let Some(ref mut program) = current_program {
                                program.description = Some(std::mem::take(&mut current_text));
                            }
                            current_element = None;
                        }
                        b"sub-title" => {
                            if let Some(ref mut program) = current_program {
                                program.sub_title = Some(std::mem::take(&mut current_text));
                            }
                            current_element = None;
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    // Send remaining programs
    if !batch.is_empty() {
        let _ = batch_sink(batch);
    }

    info!(
        "[EPG] Parser finished: {} programs, {} matched, {} unmatched channels, {} matched channels",
        total_programs,
        matched_programs,
        unmatched_channels.len(),
        matched_channels_set.len()
    );

    Ok((
        channels,
        StreamingParserResult {
            total_programs,
            matched_programs,
            unmatched_channels: unmatched_channels.len(),
            matched_channels: matched_channels_set.len(),
            bytes_processed: 0, // filled by the caller
            download_ms: 0,
            decompress_ms: 0,
            parse_ms: 0,
        },
    ))
}

/// Parse XMLTV and route matched programmes to per-source batch spools in a
/// SINGLE pass over the (possibly decompressed) stream — the multi-source
/// counterpart of `parse_and_stream_epg_once`.
///
/// A single download is shared across all sources; each source only gets
/// programmes for channels in its own channel mapping (waterfill behaviour).
/// Channels are collected during the pass, and display-name entries for
/// advanced matching are merged lazily at the first <programme> (XMLTV places
/// all <channel> elements before <programme>), then folded into a master
/// (epg_channel_id -> [(source_id, stream_id)]) lookup so routing is O(1) per
/// programme. Runs on a blocking thread while the async download feeds the
/// reader, so download and parse overlap.
fn parse_and_stream_multi_once<R: std::io::BufRead>(
    reader: R,
    mut per_source_lookups: Vec<(String, HashMap<String, Vec<String>>, bool)>,
    // Per-source batch sink: receives each 25k-program batch as it fills,
    // tagged with the target source. Return false to stop parsing early.
    batch_sink: &mut dyn FnMut(&str, Vec<EpgProgram>) -> bool,
    on_progress: &mut (dyn FnMut(usize, usize) + Send),
    // Optional: receives every parsed programme (matched or not) BEFORE
    // routing — used by the cache path to write the full feed to its cache DB
    // in the same pass, so download/parse/cache-write all overlap.
    mut on_program: Option<&mut dyn FnMut(&EpgProgram)>,
    // Optional: receives (stream_id, feed channel id) for every routed copy —
    // used by the cache path to persist channel overrides.
    mut on_match: Option<&mut dyn FnMut(&str, &str)>,
) -> Result<(Vec<EpgChannelInfo>, MultiSourceParserResult)> {
    let any_advanced = per_source_lookups.iter().any(|(_, _, adv)| *adv);

    let mut xml = Reader::from_reader(reader);
    xml.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);

    // <channel id="..."><display-name>..</display-name><icon src=".."/></channel>
    let mut in_channel = false;
    let mut channel_id: Option<String> = None;
    let mut channel_display_name: Option<String> = None;
    // Every <display-name> of the current channel. Feeds routinely carry several
    // (a clean name plus tagged/regional aliases); all of them are matchable,
    // and only the first is stored for display.
    let mut channel_display_names: Vec<String> = Vec::new();
    let mut channel_icon: Option<String> = None;
    let mut channel_element: Option<&'static str> = None;
    let mut channel_text = String::new();
    // Advanced matching: display name -> channel id, collected from <channel>
    // elements during the pass (same keys/conditions as
    // build_display_name_mapping).
    let mut display_map: HashMap<String, String> = HashMap::new();

    // <programme> element state
    let mut current_program: Option<EpgProgram> = None;
    let mut current_element: Option<&'static str> = None;
    let mut current_text = String::new();

    let mut channels: Vec<EpgChannelInfo> = Vec::new();
    // Master lookup, folded from the per-source lookups (with display names
    // merged) lazily at the first <programme>.
    let mut master_lookup: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut lookup_merged = false;

    let mut total_programs = 0usize;
    let mut global_matched = 0usize;

    // Per-source batch buffers and stats
    let mut batch_buffers: HashMap<String, Vec<EpgProgram>> = HashMap::new();
    let mut source_stats: HashMap<String, SourceParseStats> = HashMap::new();

    for (sid, _, _) in &per_source_lookups {
        batch_buffers.insert(sid.clone(), Vec::with_capacity(BATCH_SIZE));
        source_stats.insert(sid.clone(), SourceParseStats {
            matched_programs: 0,
            unmatched_channels: std::collections::HashSet::new(),
            matched_channels: std::collections::HashSet::new(),
        });
    }

    loop {
        match xml.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                if in_channel {
                    match name {
                        b"display-name" => {
                            channel_element = Some("display-name");
                            channel_text.clear();
                        }
                        b"icon" => {
                            channel_element = Some("icon");
                            if channel_icon.is_none() {
                                for attr in e.attributes() {
                                    if let Ok(a) = attr {
                                        if a.key.as_ref() == b"src" {
                                            channel_icon = a
                                                .decode_and_unescape_value(xml.decoder())
                                                .ok()
                                                .map(|v| v.to_string());
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                } else {
                    match name {
                        b"channel" => {
                            in_channel = true;
                            channel_id = None;
                            channel_display_name = None;
                            channel_display_names.clear();
                            channel_icon = None;
                            for attr in e.attributes() {
                                if let Ok(a) = attr {
                                    if a.key.as_ref() == b"id" {
                                        channel_id = a
                                            .decode_and_unescape_value(xml.decoder())
                                            .ok()
                                            .map(|v| v.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                        b"programme" => {
                            let mut program = EpgProgram::default();
                            for attr in e.attributes() {
                                if let Ok(a) = attr {
                                    let key = a.key.as_ref();
                                    let value = a
                                        .decode_and_unescape_value(xml.decoder())
                                        .unwrap_or_default();
                                    match key {
                                        b"channel" => program.channel_id = value.to_string(),
                                        b"start" => program.start = parse_xmltv_date(&value),
                                        b"stop" => program.stop = parse_xmltv_date(&value),
                                        _ => {}
                                    }
                                }
                            }
                            current_program = Some(program);
                        }
                        b"title" | b"desc" | b"sub-title" => {
                            current_element = match name {
                                b"title" => Some("title"),
                                b"desc" => Some("desc"),
                                _ => Some("sub-title"),
                            };
                            current_text.clear();
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                // Self-closing <icon src="..."/> inside a channel
                if in_channel && channel_icon.is_none() && e.local_name().as_ref() == b"icon" {
                    for attr in e.attributes() {
                        if let Ok(a) = attr {
                            if a.key.as_ref() == b"src" {
                                channel_icon = a
                                    .decode_and_unescape_value(xml.decoder())
                                    .ok()
                                    .map(|v| v.to_string());
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if let Ok(text) = e.unescape() {
                    if in_channel && channel_element == Some("display-name") {
                        channel_text.push_str(&text);
                    } else if current_element.is_some() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::CData(e)) => {
                // CDATA-wrapped titles/descriptions: treat like text.
                if current_element.is_some() {
                    current_text.push_str(&String::from_utf8_lossy(&e));
                } else if in_channel && channel_element == Some("display-name") {
                    channel_text.push_str(&String::from_utf8_lossy(&e));
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let name = name.as_ref();
                if in_channel {
                    match name {
                        b"display-name" => {
                            let text = channel_text.trim().to_string();
                            if !text.is_empty() {
                                // Keep the first name for display, but index
                                // every alias for matching.
                                if channel_display_name.is_none() {
                                    channel_display_name = Some(text.clone());
                                }
                                channel_display_names.push(text);
                            }
                            channel_element = None;
                        }
                        b"icon" => {
                            channel_element = None;
                        }
                        b"channel" => {
                            in_channel = false;
                            if let (Some(id), Some(display_name)) =
                                (channel_id.take(), channel_display_name.take())
                            {
                                channels.push(EpgChannelInfo {
                                    id: id.clone(),
                                    display_name: display_name.clone(),
                                    icon_url: channel_icon.take(),
                                });

                                // Collect display-name -> channel-id entries for
                                // advanced matching (same keys/conditions as
                                // build_display_name_mapping).
                                if any_advanced {
                                    // Index every display name, not just the
                                    // first: the tagged/regional aliases are how
                                    // an id that a duplicate clean name would
                                    // otherwise shadow stays reachable.
                                    for display_name in &channel_display_names {
                                        insert_name_key(&mut display_map, display_name, &id);
                                    }
                                }
                            } else {
                                channel_icon.take();
                            }
                        }
                        _ => {}
                    }
                } else {
                    match name {
                        b"programme" => {
                            if let Some(program) = current_program.take() {
                                total_programs += 1;

                                // Let the caller (e.g. the cache path) write
                                // the full feed while it's in hand — before
                                // routing, so unmatched programmes are seen too.
                                if let Some(cb) = on_program.as_deref_mut() {
                                    cb(&program);
                                }

                                // Lazy per-source display-name merge + master
                                // fold: channels precede programmes in XMLTV,
                                // so by the first programme the display map is
                                // complete.
                                if !lookup_merged {
                                    let lookups =
                                        std::mem::take(&mut per_source_lookups);
                                    for (sid, lookup, advanced) in lookups {
                                        let lookup = if advanced {
                                            merge_with_display_names(lookup, &display_map)
                                        } else {
                                            lookup
                                        };
                                        for (epg_id, stream_ids) in lookup {
                                            let entry = master_lookup.entry(epg_id).or_default();
                                            for stream_id in stream_ids {
                                                entry.push((sid.clone(), stream_id));
                                            }
                                        }
                                    }
                                    lookup_merged = true;
                                }

                                // Lookup: EPG channel IDs, M3U names, and
                                // normalized versions (fast O(1) lookups).
                                let pairs = master_lookup
                                    .get(&program.channel_id)
                                    .or_else(|| {
                                        master_lookup.get(&normalize_channel_name(
                                            &program.channel_id,
                                        ))
                                    });

                                if let Some(pairs) = pairs {
                                    global_matched += 1;
                                    let feed_channel_id = program.channel_id.clone();

                                    // Hot path (one target per programme — the
                                    // common case for global EPG gap-filling,
                                    // where a channel belongs to a single
                                    // source): move the programme's own Strings
                                    // instead of cloning all five per
                                    // programme. Also skip normalize_to_utc
                                    // unless the date contains '-':
                                    // parse_xmltv_date output has no '-', so
                                    // neither chrono parser can match it and
                                    // the call would just return an unchanged
                                    // copy.
                                    if pairs.len() == 1 {
                                        let (source_id, stream_id) = &pairs[0];
                                        let mut copy = program; // move, not clone
                                        copy.channel_id = stream_id.clone();
                                        if copy.start.contains('-') {
                                            copy.start = normalize_to_utc(&copy.start);
                                        }
                                        if copy.stop.contains('-') {
                                            copy.stop = normalize_to_utc(&copy.stop);
                                        }

                                        let buffer =
                                            batch_buffers.get_mut(source_id).unwrap();
                                        buffer.push(copy);

                                        if buffer.len() >= BATCH_SIZE {
                                            let batch_to_send = std::mem::take(buffer);
                                            buffer.reserve(BATCH_SIZE);
                                            if !batch_sink(source_id, batch_to_send) {
                                                warn!("Batch sink stopped for source {}, stopping parser", source_id);
                                            }
                                        }

                                        if let Some(stats) = source_stats.get_mut(source_id) {
                                            stats.matched_programs += 1;
                                            stats.matched_channels.insert(stream_id.clone());
                                        }
                                        if let Some(cb) = on_match.as_deref_mut() {
                                            cb(stream_id, &feed_channel_id);
                                        }
                                    } else {
                                        for (source_id, stream_id) in pairs {
                                            let mut copy = program.clone();
                                            copy.channel_id = stream_id.clone();
                                            if copy.start.contains('-') {
                                                copy.start = normalize_to_utc(&copy.start);
                                            }
                                            if copy.stop.contains('-') {
                                                copy.stop = normalize_to_utc(&copy.stop);
                                            }

                                            let buffer =
                                                batch_buffers.get_mut(source_id).unwrap();
                                            buffer.push(copy);

                                            if buffer.len() >= BATCH_SIZE {
                                                let batch_to_send = std::mem::take(buffer);
                                                buffer.reserve(BATCH_SIZE);
                                                if !batch_sink(source_id, batch_to_send) {
                                                    warn!("Batch sink stopped for source {}, stopping parser", source_id);
                                                }
                                            }

                                            if let Some(stats) = source_stats.get_mut(source_id) {
                                                stats.matched_programs += 1;
                                                stats.matched_channels.insert(stream_id.clone());
                                            }
                                            if let Some(cb) = on_match.as_deref_mut() {
                                                cb(stream_id, &feed_channel_id);
                                            }
                                        }
                                    }
                                }
                                // Unmatched programmes are dropped: a global
                                // EPG channel may map to zero of the enabled
                                // sources, and we don't know which source
                                // expected it.

                                if total_programs % (BATCH_SIZE * PROGRESS_INTERVAL) == 0 {
                                    on_progress(total_programs, global_matched);
                                }
                            }
                        }
                        b"title" => {
                            if let Some(ref mut program) = current_program {
                                program.title = std::mem::take(&mut current_text);
                            }
                            current_element = None;
                        }
                        b"desc" => {
                            if let Some(ref mut program) = current_program {
                                program.description = Some(std::mem::take(&mut current_text));
                            }
                            current_element = None;
                        }
                        b"sub-title" => {
                            if let Some(ref mut program) = current_program {
                                program.sub_title = Some(std::mem::take(&mut current_text));
                            }
                            current_element = None;
                        }
                        _ => {}
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    // Flush remaining per-source buffers through the sink.
    for (source_id, buffer) in batch_buffers {
        if !buffer.is_empty() {
            let _ = batch_sink(&source_id, buffer);
        }
    }

    info!(
        "[EPG] Multi-source parser finished: {} programs, {} total matched",
        total_programs, global_matched
    );

    Ok((
        channels,
        MultiSourceParserResult {
            total_programs,
            bytes_processed: 0, // filled by the caller
            source_stats,
        },
    ))
}

/// Inserter pipeline - receives batches and inserts them concurrently
struct InserterResult {
    inserted: usize,
    /// Wall time spent inserting all received batches into the database
    /// (includes waiting for the SQLite write lock held by other sources).
    insert_ms: u64,
    /// Wall time of that insert_ms that was spent waiting for the SQLite
    /// write lock (contention), not writing rows.
    lock_wait_ms: u64,
}

async fn insert_batches_pipeline<R: tauri::Runtime>(
    db: &DvrDatabase,
    mut batch_rx: mpsc::Receiver<Vec<EpgProgram>>,
    source_id: &str,
    app_handle: tauri::AppHandle<R>,
    total_bytes: Option<u64>,
    start_time: std::time::Instant,
) -> anyhow::Result<InserterResult> {
    // Timed from the FIRST received batch: for the network path the pipeline
    // starts while the download is still streaming, so insert_ms must measure
    // the insert phase, not the wait for batches to arrive.
    let mut insert_start: Option<std::time::Instant> = None;
    let mut total_inserted = 0usize;
    let mut batch_count = 0usize;

    // Emit inserting phase
    emit_progress(
        &app_handle,
        source_id,
        EpgParseProgress {
            source_id: source_id.to_string(),
            phase: "inserting".to_string(),
            bytes_downloaded: total_bytes.unwrap_or(0),
            total_bytes,
            programs_parsed: 0,
            programs_matched: 0,
            programs_inserted: 0,
            estimated_remaining_seconds: None,
        },
    );

    let mut total_lock_wait_ms = 0u64;
    // First batch that exhausted its retry budget (if any). Fail the parse
    // loudly rather than reporting a silent partial insert.
    let mut batch_error: Option<anyhow::Error> = None;

    // Process batches as they arrive
    while let Some(batch) = batch_rx.recv().await {
        let _ = insert_start.get_or_insert_with(std::time::Instant::now);
        batch_count += 1;

        match insert_programs_batch_timed(db, source_id, &batch).await {
            Ok((inserted, lock_wait_ms)) => {
                total_inserted += inserted;
                total_lock_wait_ms += lock_wait_ms;

                // Progress update every N batches
                if batch_count % PROGRESS_INTERVAL == 0 {
                    emit_progress(
                        &app_handle,
                        source_id,
                        EpgParseProgress {
                            source_id: source_id.to_string(),
                            phase: "inserting".to_string(),
                            bytes_downloaded: total_bytes.unwrap_or(0),
                            total_bytes,
                            programs_parsed: 0,
                            programs_matched: 0,
                            programs_inserted: total_inserted,
                            estimated_remaining_seconds: estimate_remaining_programs(
                                total_inserted as u64,
                                total_inserted as u64 + 100000, // rough estimate
                                start_time.elapsed().as_secs(),
                            ),
                        },
                    );
                }
            }
            Err(e) => {
                warn!("Failed to insert batch: {}", e);
                if batch_error.is_none() {
                    batch_error = Some(e);
                }
            }
        }
    }

    info!(
        "[EPG] Inserter finished: {} batches, {} programs inserted ({}ms waiting on DB lock)",
        batch_count, total_inserted, total_lock_wait_ms
    );

    if let Some(e) = batch_error {
        return Err(e);
    }

    Ok(InserterResult {
        inserted: total_inserted,
        insert_ms: insert_start
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0),
        lock_wait_ms: total_lock_wait_ms,
    })
}

/// Delete all programs for a source (called before inserting new programs).
///
/// A channel the user pinned to *another* feed is skipped: its guide belongs to
/// that feed, which replaces it on its own sync. Wiping it here would empty the
/// channel for as long as the pinned feed hadn't run yet — and the pinned feed
/// is the only writer it has, so nothing else could refill it in between. Rows
/// for channels pinned to *this* source are wiped as usual: this pass is their
/// owner.
fn delete_programs_for_source(db: &DvrDatabase, source_id: &str) -> Result<usize> {
    with_sync_db_retry(|| {
        // Serialized with all other EPG program writes (see EPG_WRITE_LOCK).
        // Re-acquired per retry so the backoff sleep never holds the mutex.
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let conn = db.get_conn()?;
        delete_programs_for_source_conn(&conn, source_id)
    })
}

/// Programs SQL: drop a source's rows, keeping those of channels the user
/// pinned to another feed. Shared with `db_bulk_ops::bulk_replace_programs`,
/// which is the same replace-the-source's-programs move on a different path.
///
/// A pinned channel's guide belongs to the feed the user chose: that feed
/// replaces those rows on its own sync, and every other feed is barred from
/// writing the channel (see `build_needing_mappings`). Wiping them here would
/// empty the channel the moment the source synced, with nothing able to refill
/// it until the pinned feed next ran. Rows for channels pinned to *this* source
/// are wiped as usual — this pass is their owner.
///
/// Expired rows are the exception: keeping them would leave this wipe (the only
/// pruning the `programs` table has) unable to remove anything for a pinned
/// channel, so its rows would grow without bound while its feed kept appending
/// new windows. Anything that ended more than a day ago is invisible in the
/// guide and gets dropped either way; `COALESCE` keeps rows with no end time
/// comparable instead of falling into the `NOT IN` NULL trap.
pub(crate) const PIN_AWARE_SOURCE_PROGRAMS_WIPE: &str =
    "DELETE FROM programs
      WHERE source_id = ?1
        AND (
          stream_id NOT IN (
            SELECT stream_id FROM epg_channel_overrides
             WHERE epg_source_id IS NOT NULL
               AND TRIM(epg_source_id) != ''
               AND epg_source_id != ?1
          )
          OR COALESCE(end, '') < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
        )";

fn delete_programs_for_source_conn(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> Result<usize> {
    let deleted = conn.execute(
        PIN_AWARE_SOURCE_PROGRAMS_WIPE,
        rusqlite::params![source_id],
    )?;
    Ok(deleted)
}

/// Channels of `source_id` whose guide the wipe above deliberately keeps, with
/// the feed each is pinned to and the rows left for it. Read *after* the wipe,
/// so the row counts are what survived rather than what was there before it.
///
/// Counts programs per pinned channel through `idx_programs_stream` — the
/// source index is dropped during a bulk EPG load, so counting by `source_id`
/// here would add a full scan of `programs` to every wipe.
pub(crate) fn pin_kept_programs_conn(
    conn: &rusqlite::Connection,
    source_id: &str,
) -> Result<Vec<(String, String, i64, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT c.name,
                eco.epg_source_id,
                (SELECT COUNT(*) FROM programs p WHERE p.stream_id = eco.stream_id),
                (SELECT MAX(p.end) FROM programs p WHERE p.stream_id = eco.stream_id)
           FROM epg_channel_overrides eco
           JOIN channels c ON c.stream_id = eco.stream_id
          WHERE c.source_id = ?1
            AND eco.epg_source_id IS NOT NULL
            AND TRIM(eco.epg_source_id) != ''
            AND eco.epg_source_id != ?1",
    )?;
    let rows = stmt
        .query_map(rusqlite::params![source_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Stream ids a parse actually filled, read from its spooled programmes. The
/// router rewrites `channel_id` to the matching channel's `stream_id` (see the
/// batch sink), so a spool holds real stream ids, not feed channel ids.
fn spooled_stream_ids<'a>(
    programs: impl IntoIterator<Item = &'a EpgProgram>,
) -> std::collections::HashSet<String> {
    programs
        .into_iter()
        .map(|program| program.channel_id.clone())
        .collect()
}

/// Replace the guide of the channels locked to `feed_ref` that this parse
/// matched: drop their rows so the incoming programmes are not merged with what
/// the previous owner (the playlist's own EPG, an earlier lock) had written.
///
/// A locked channel is supposed to be a projection of the feed the user chose,
/// and merging can't produce that: the old rows survive at every start time the
/// new feed doesn't repeat, and overlap it wherever the schedule shifted.
///
/// Only channels locked to *this* feed and matched *by this pass* are touched.
/// Everything else here is a gap-fill and must not delete, and a locked channel
/// the feed carries nothing for keeps whatever guide it has.
///
/// Programmes older than the feed's own window are not preserved: the parser
/// stores whatever the feed sends, so the channel ends up with exactly the
/// feed's coverage — the same result the playlist-pin alignment produces.
///
/// Returns (locked channels cleared, rows deleted).
pub(crate) fn replace_locked_guides_conn(
    conn: &rusqlite::Connection,
    feed_ref: &str,
    matched: &std::collections::HashSet<String>,
) -> Result<(usize, usize)> {
    if matched.is_empty() {
        return Ok((0, 0));
    }

    let locked: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT stream_id FROM epg_channel_overrides WHERE epg_source_id = ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![feed_ref], |row| row.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let mut del = conn.prepare("DELETE FROM programs WHERE stream_id = ?1")?;
    let mut channels = 0usize;
    let mut cleared = 0usize;
    for stream_id in locked {
        if !matched.contains(&stream_id) {
            continue;
        }
        cleared += del.execute(rusqlite::params![stream_id])?;
        channels += 1;
    }
    Ok((channels, cleared))
}

/// Serialized entry point for `replace_locked_guides_conn`, used by both global
/// EPG paths right after their download is verified and before the new
/// programmes are stored. Silent when nothing is locked to the feed.
fn replace_locked_guides<'a>(
    db: &DvrDatabase,
    source_id: &str,
    feed_ref: &str,
    programs: impl IntoIterator<Item = &'a EpgProgram>,
) {
    // "global_epg_<linkId>" only: a source's own feed pass replaces its rows
    // through the pin-aware wipe, and its extra-URL waterfall must stay additive.
    if !feed_ref.starts_with("global_epg_") {
        return;
    }

    let matched = spooled_stream_ids(programs);
    if matched.is_empty() {
        return;
    }

    let result = with_sync_db_retry(|| {
        // Serialized with all other EPG program writes (see EPG_WRITE_LOCK).
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let conn = db.get_conn()?;
        replace_locked_guides_conn(&conn, feed_ref, &matched)
    });

    match result {
        Ok((channels, cleared)) if channels > 0 => info!(
            "[EPG] Replaced the guide for {} feed-locked channel(s) of source {} ({} row(s) cleared before storing feed {})",
            channels, source_id, cleared, feed_ref
        ),
        Ok(_) => {}
        Err(e) => warn!(
            "[EPG] Could not replace feed-locked channel guides for source {}: {}",
            source_id,
            e
        ),
    }
}

/// How many distinct feed refs the pin-kept summary names before collapsing
/// the rest into "+N more".
const MAX_LOGGED_PIN_FEEDS: usize = 3;

/// Report what the pin-aware wipe spared, so a pinned channel's guide surviving
/// a source's sync — and which feed it is waiting on — is visible in the log
/// instead of having to be inferred from the program counts.
///
/// Totals on ONE line: a global EPG link locks every channel it fills, so a
/// heavily pinned source would otherwise write a log line per channel on every
/// sync (thousands of lines, and the I/O that goes with them). The per-channel
/// detail, including each channel's guide horizon, is what the EPG editor's
/// Programs tab lists on demand.
///
/// Three feeds named at most: which feeds hold the locks is the useful summary
/// (a source waiting on a deleted feed looks different from one waiting on its
/// own link), and the list stays short however many channels are pinned.
fn log_pin_kept_programs(db: &DvrDatabase, source_id: &str) {
    let rows = with_sync_db_retry(|| {
        let conn = db.get_conn()?;
        pin_kept_programs_conn(&conn, source_id)
    });
    match rows {
        Ok(rows) if !rows.is_empty() => {
            let total: i64 = rows.iter().map(|(_, _, count, _)| *count).sum();
            let mut feeds: Vec<&str> = rows.iter().map(|(_, feed, _, _)| feed.as_str()).collect();
            feeds.sort_unstable();
            feeds.dedup();
            let listed = feeds
                .iter()
                .take(MAX_LOGGED_PIN_FEEDS)
                .copied()
                .collect::<Vec<_>>()
                .join(", ");
            let more = feeds.len().saturating_sub(MAX_LOGGED_PIN_FEEDS);
            info!(
                "[EPG] Feed locks kept {} row(s) for {} channel(s) of source {} over the wipe (pinned to: {}{})",
                total,
                rows.len(),
                source_id,
                listed,
                if more > 0 {
                    format!(", +{} more", more)
                } else {
                    String::new()
                }
            );
        }
        Ok(_) => {}
        Err(e) => warn!(
            "[EPG] Could not count pin-kept programs for source {}: {}",
            source_id,
            e
        ),
    }
}

/// The secondary indexes on `programs` dropped during a bulk EPG load and
/// rebuilt once after it. Kept in sync with the schema in
/// packages/ui/src/db/index.ts.
///
/// `idx_programs_stream` is deliberately NOT dropped: the JS-side bulk EPG
/// alignment (per source, after its inserts) JOINs `programs` on stream_id,
/// and the guide queries the same way — without it those go from indexed
/// lookups to full scans of the ~2.5M-row table (measured: alignments ballooned
/// 2.5–5.5s to 11–52s when it was dropped in the first bulk-load run). The
/// full-scan DELETE cost of dropping `idx_programs_source` is negligible
/// (a large feed inserted 742k rows in 5.4s with it dropped).
const PROGRAMS_INDEXES_TO_DROP: [&str; 3] = [
    "idx_programs_time",
    "idx_programs_source",
    "idx_programs_title",
];

/// Drop the `programs` secondary indexes before a bulk EPG load.
///
/// Index maintenance is a large fraction of INSERT/DELETE cost (each index is
/// another B-tree updated per row). With ~1.7M programs written per sync-all
/// run, keeping 3 secondary indexes live (PK + 3 B-trees per row) vs the full
/// set measurably cuts the serialized insert queue: the first bulk-load run
/// collapsed summed insert_ms from 228s to 87s. `idx_programs_stream` stays
/// live (see PROGRAMS_INDEXES_TO_DROP) because the per-source JS alignment
/// and the guide both need it.
///
/// Serialized with all other EPG program writes (see EPG_WRITE_LOCK) so no
/// in-flight insert transaction is open when the schema changes. The pool's
/// 30s busy_timeout + with_sync_db_retry handle incidental contention from
/// non-EPG writers (channel upserts, JS-side alignment).
pub fn drop_programs_indexes(db: &DvrDatabase) -> Result<()> {
    with_sync_db_retry(|| {
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let conn = db.get_conn()?;
        let sql = PROGRAMS_INDEXES_TO_DROP
            .iter()
            .map(|name| format!("DROP INDEX IF EXISTS {}", name))
            .collect::<Vec<_>>()
            .join(";");
        conn.execute_batch(&sql)?;
        info!("[EPG] Dropped {} secondary indexes on programs for bulk load (kept idx_programs_stream)", PROGRAMS_INDEXES_TO_DROP.len());
        Ok(())
    })
}

/// Recreate the `programs` secondary indexes after a bulk EPG load.
///
/// Mirrors the definitions in packages/ui/src/db/index.ts. Safe to call when
/// the indexes already exist (IF NOT EXISTS).
pub fn recreate_programs_indexes(db: &DvrDatabase) -> Result<()> {
    with_sync_db_retry(|| {
        let _guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let conn = db.get_conn()?;
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_programs_stream ON programs(stream_id);
             CREATE INDEX IF NOT EXISTS idx_programs_time ON programs(start, end);
             CREATE INDEX IF NOT EXISTS idx_programs_source ON programs(source_id);
             CREATE INDEX IF NOT EXISTS idx_programs_title ON programs(title COLLATE NOCASE);",
        )?;
        info!("[EPG] Recreated secondary indexes on programs (all 4 present)");
        Ok(())
    })
}

/// Insert a batch of programs into the database, returning the number of
/// inserted rows and the total time spent waiting for the SQLite write lock.
///
/// The insert connection runs with busy_timeout=0 so lock contention surfaces
/// immediately as SQLITE_BUSY instead of blocking invisibly inside SQLite;
/// each retry sleep is timed and accumulated into the returned lock_wait_ms.
async fn insert_programs_batch_timed(
    db: &DvrDatabase,
    source_id: &str,
    programs: &[EpgProgram],
) -> Result<(usize, u64)> {
    // Budget: a huge feed can hold the write lock for a minute or more, so
    // keep retrying well past that before giving up.
    const MAX_LOCK_WAIT_MS: u64 = 120_000;
    const RETRY_STEP_MS: u64 = 250;

    let mut lock_wait_ms = 0u64;
    loop {
        // All EPG program writes are serialized through EPG_WRITE_LOCK (the
        // mutex IS the queue — SQLite only allows one writer at a time). Time
        // the queue wait so lock_wait_ms reports the honest total contention
        // (mutex wait + SQLITE_BUSY retry sleeps). The guard is scoped to the
        // inner call so the retry sleep below never holds it.
        let lock_acquire_start = std::time::Instant::now();
        let result = {
            let guard = EPG_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            lock_wait_ms += lock_acquire_start.elapsed().as_millis() as u64;
            let r = insert_programs_batch_inner(db, source_id, programs);
            drop(guard);
            r
        };
        match result {
            Ok(inserted) => return Ok((inserted, lock_wait_ms)),
            Err(e) if is_db_locked(&e) && lock_wait_ms < MAX_LOCK_WAIT_MS => {
                tokio::time::sleep(std::time::Duration::from_millis(RETRY_STEP_MS)).await;
                lock_wait_ms += RETRY_STEP_MS;
            }
            Err(e) => return Err(e),
        }
    }
}

/// True when the error is SQLite lock contention ("database is locked" / busy).
fn is_db_locked(e: &anyhow::Error) -> bool {
    is_db_locked_str(&e.to_string())
}

/// String-level variant for use on raw error messages (e.g. per-row insert errors).
fn is_db_locked_str(s: &str) -> bool {
    let l = s.to_lowercase();
    l.contains("database is locked") || l.contains("busy")
}

fn insert_programs_batch_inner(
    db: &DvrDatabase,
    source_id: &str,
    programs: &[EpgProgram],
) -> Result<usize> {
    let mut conn = db.get_conn()?;
    // Do not block inside SQLite on lock contention — surface SQLITE_BUSY
    // immediately so the timed retry loop above can measure the wait. The
    // timeout is restored to 30s on BOTH the Ok and Err paths below before
    // this connection returns to the pool (r2d2 will not do it for us on
    // reuse — its on_acquire customizer only runs when a connection is first
    // CREATED). Without the restore, the busy_timeout=0 would permanently
    // poison the pooled connection: every later user (update_source_meta,
    // deletes, channel upserts) would inherit busy_timeout=0 and fail
    // INSTANTLY with "database is locked" on any incidental contention.
    conn.busy_timeout(std::time::Duration::ZERO)?;
    let result = insert_programs_batch_inner_conn(&mut conn, source_id, programs);
    let _ = conn.busy_timeout(std::time::Duration::from_secs(30));
    result
}

fn insert_programs_batch_inner_conn(
    conn: &mut rusqlite::Connection,
    source_id: &str,
    programs: &[EpgProgram],
) -> Result<usize> {
    // IMMEDIATE: this writes, so take the write lock at BEGIN. A deferred tx
    // upgrading to write can hit BUSY_SNAPSHOT (which busy_timeout can't
    // fix) when another connection commits in between; with busy_timeout=0
    // that surfaces as an instant, retryable BUSY instead.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut stmt = tx.prepare(
        "INSERT INTO programs (
            id, stream_id, title, subtitle, description, start, end, source_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            subtitle = excluded.subtitle,
            description = excluded.description,
            start = excluded.start,
            end = excluded.end",
    )?;

    let inserted = insert_programs_rows(&mut stmt, programs, source_id)?;

    stmt.finalize()?;
    tx.commit()?;

    Ok(inserted)
}

/// Execute a single batch of rows against an already-prepared insert statement.
///
/// Duplicate keys are ignored (multiple channels sharing a tvg-id). Any lock
/// contention (SQLITE_BUSY, surfaced immediately because the insert connection
/// runs with busy_timeout=0) aborts the whole batch with an error so the timed
/// retry loop re-runs it — silently skipping the contended rows would lose
/// data. Other per-row failures are logged and skipped, as before.
fn insert_programs_rows(
    stmt: &mut rusqlite::Statement,
    programs: &[EpgProgram],
    source_id: &str,
) -> Result<usize> {
    use rusqlite::params;

    let mut inserted = 0;

    for program in programs {
        let stream_id = &program.channel_id;
        let id = format!("{}_{}", stream_id, &program.start);

        match stmt.execute(params![
            id,
            stream_id,
            program.title,
            program.sub_title.as_deref().unwrap_or(""),
            program.description.as_deref().unwrap_or(""),
            program.start,
            program.stop,
            source_id,
        ]) {
            Ok(_) => inserted += 1,
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("UNIQUE constraint failed") {
                    // Silently ignore duplicates - they happen when multiple channels share tvg-id
                    // and have the same program at the same time
                } else if is_db_locked_str(&msg) {
                    // Lock contention mid-batch (busy_timeout=0 surfaces it
                    // here). Abort the whole batch so the timed retry loop in
                    // insert_programs_batch_timed re-runs it (with the wait
                    // counted in lock_wait_ms) instead of silently dropping
                    // the contended rows.
                    return Err(e.into());
                } else {
                    warn!("Failed to insert program for stream {}: {}", stream_id, e);
                }
            }
        }
    }

    Ok(inserted)
}

/// Emit progress event to frontend
/// Emit progress event to frontend (Tauri's emit is synchronous).
fn emit_progress<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    _source_id: &str,
    progress: EpgParseProgress,
) {
    let _ = app_handle.emit("epg:parse_progress", progress);
}

/// Debug-only EPG timing log (`<app_data>/epg_timings.jsonl`).
/// OFF by default — enable by setting the `YNOTV_EPG_TIMING` environment
/// variable when launching the app (any value). Kept around because it is the
/// instrument used to compare sync performance across builds/runs; flipping
/// the env var back on requires no rebuild.
static EPG_TIMING_ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn epg_timing_enabled() -> bool {
    *EPG_TIMING_ENABLED.get_or_init(|| std::env::var("YNOTV_EPG_TIMING").is_ok())
}

/// Append one machine-readable timing record per source parse to
/// `<app_data>/epg_timings.jsonl` (one JSON object per line, best-effort).
/// Lets users compare EPG sync performance across builds/runs (e.g. before
/// and after a parser change) by diffing the two most recent runs.
/// No-op unless the `YNOTV_EPG_TIMING` env var is set.
fn append_epg_timing_record<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    source_id: &str,
    source_name: &str,
    url: &str,
    r: &EpgParseResult,
) {
    use tauri::Manager;

    if !epg_timing_enabled() {
        return;
    }

    let Ok(dir) = app_handle.path().app_data_dir() else {
        return;
    };
    let path = dir.join("epg_timings.jsonl");

    let line = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339(),
        "source_id": source_id,
        "source_name": source_name,
        "url": url,
        "download_ms": r.download_ms,
        "decompress_ms": r.decompress_ms,
        "parse_ms": r.parse_ms,
        "insert_ms": r.insert_ms,
        "lock_wait_ms": r.lock_wait_ms,
        "total_ms": r.duration_ms,
        "bytes_processed": r.bytes_processed,
        "total_programs": r.total_programs,
        "matched_programs": r.matched_programs,
        "inserted_programs": r.inserted_programs,
        "unmatched_channels": r.unmatched_channels,
    });

    use std::io::Write;
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "{}", line) {
                warn!("[EPG] Failed to write timing record: {}", e);
            }
        }
        Err(e) => warn!("[EPG] Failed to open timing log {}: {}", path.display(), e),
    }

    // Accumulate into the run summary (reset by `epg_timing_run_end`).
    let mut agg = EPG_RUN_TIMING.lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now();
    agg.first_ts.get_or_insert(now);
    agg.last_ts = Some(now);
    agg.sources += 1;
    agg.total_inserted += r.inserted_programs as u64;
    agg.sum_download_ms += r.download_ms;
    agg.sum_parse_ms += r.parse_ms;
    agg.sum_insert_ms += r.insert_ms;
    agg.sum_lock_wait_ms += r.lock_wait_ms;
    agg.sum_total_ms += r.duration_ms;
}

/// Per-run aggregation of per-source timing records (see `append_epg_timing_record`).
#[derive(Default)]
struct RunTimingSummary {
    first_ts: Option<chrono::DateTime<chrono::Utc>>,
    last_ts: Option<chrono::DateTime<chrono::Utc>>,
    sources: usize,
    total_inserted: u64,
    sum_download_ms: u64,
    sum_parse_ms: u64,
    sum_insert_ms: u64,
    sum_lock_wait_ms: u64,
    sum_total_ms: u64,
}

impl RunTimingSummary {
    const fn new() -> Self {
        Self {
            first_ts: None,
            last_ts: None,
            sources: 0,
            total_inserted: 0,
            sum_download_ms: 0,
            sum_parse_ms: 0,
            sum_insert_ms: 0,
            sum_lock_wait_ms: 0,
            sum_total_ms: 0,
        }
    }
}

static EPG_RUN_TIMING: std::sync::Mutex<RunTimingSummary> =
    std::sync::Mutex::new(RunTimingSummary::new());

/// Emit ONE summary row per sync-all run into `epg_timings.jsonl`
/// (`"kind": "run"`), aggregating the per-source rows recorded since the
/// previous call, then reset the accumulator. Called by the TS sync
/// orchestration in its finally block so even failed runs get a row.
/// `alignment_max_ms` / `sources_ok` / `sources_failed` are TS-side facts the
/// Rust side cannot see (per-source JS alignment, per-source success flags).
pub fn epg_timing_run_end<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    alignment_max_ms: Option<u64>,
    sources_ok: Option<usize>,
    sources_failed: Option<usize>,
) -> Result<()> {
    use tauri::Manager;
    use std::io::Write;

    if !epg_timing_enabled() {
        // Nothing accumulated (append is gated too), so there is no state to clear.
        return Ok(());
    }

    let agg = {
        let mut g = EPG_RUN_TIMING.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *g)
    };

    let Ok(dir) = app_handle.path().app_data_dir() else {
        return Ok(());
    };
    let path = dir.join("epg_timings.jsonl");

    let wall_ms = match (agg.first_ts, agg.last_ts) {
        (Some(first), Some(last)) => (last - first).num_milliseconds().max(0) as u64,
        _ => 0,
    };

    let line = serde_json::json!({
        "kind": "run",
        "ts": chrono::Utc::now().to_rfc3339(),
        "wall_ms": wall_ms,
        "sources": agg.sources,
        "sources_ok": sources_ok,
        "sources_failed": sources_failed,
        "total_inserted": agg.total_inserted,
        "sum_download_ms": agg.sum_download_ms,
        "sum_parse_ms": agg.sum_parse_ms,
        "sum_insert_ms": agg.sum_insert_ms,
        "sum_lock_wait_ms": agg.sum_lock_wait_ms,
        "sum_total_ms": agg.sum_total_ms,
        "alignment_max_ms": alignment_max_ms,
    });

    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => writeln!(f, "{}", line)
            .map_err(|e| anyhow::anyhow!("Failed to write run timing record: {}", e))?,
        Err(e) => return Err(anyhow::anyhow!("Failed to open timing log {}: {}", path.display(), e)),
    }
    info!("[EPG] Run summary written: {} sources, {} programs, {}ms wall", agg.sources, agg.total_inserted, wall_ms);
    Ok(())
}

/// Estimate remaining time for download
fn estimate_remaining(bytes_read: u64, total_bytes: Option<u64>, elapsed_secs: u64) -> Option<u64> {
    if elapsed_secs == 0 {
        return None;
    }

    let total = total_bytes?;
    if bytes_read >= total {
        return Some(0);
    }

    let rate = bytes_read as f64 / elapsed_secs as f64;
    let remaining = (total - bytes_read) as f64 / rate;

    Some(remaining as u64)
}

/// Estimate remaining time for program processing
fn estimate_remaining_programs(programs_processed: u64, total_programs: u64, elapsed_secs: u64) -> Option<u64> {
    if elapsed_secs == 0 || programs_processed == 0 {
        return None;
    }

    if programs_processed >= total_programs {
        return Some(0);
    }

    let rate = programs_processed as f64 / elapsed_secs as f64;
    let remaining_programs = total_programs - programs_processed;
    let remaining_secs = remaining_programs as f64 / rate;

    Some(remaining_secs as u64)
}

/// Parse EPG from file (for local XMLTV files) - optimized version
pub async fn parse_epg_file<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: &DvrDatabase,
    source_id: String,
    file_path: String,
    channel_mappings: Vec<ChannelMapping>,
    advanced_epg_matching: bool,
    timeshift_hours: f64,
    clear_existing: bool,
) -> Result<EpgParseResult> {
    info!("Parsing local EPG file with streaming: {}, clear_existing: {}", file_path, clear_existing);
    let start_time = std::time::Instant::now();

    // Build channel lookup map (supports multiple stream_ids per epg_channel_id)
    let channel_lookup = build_channel_lookup(channel_mappings);

    // Probe the file with a separate handle (so the main reader isn't
    // consumed): detect gzip by magic bytes and confirm the content is
    // actually XMLTV BEFORE deleting existing programs.
    let (is_gzip, head_is_xmltv) = {
        use std::io::{BufRead, Read};
        let mut probe = std::io::BufReader::with_capacity(
            256 * 1024,
            std::fs::File::open(&file_path).context("Failed to open EPG file")?,
        );
        let head = probe.fill_buf().context("Failed to read EPG file")?;
        let gz = head.len() >= 2 && head[0] == 0x1f && head[1] == 0x8b;
        let looks_like_xmltv = if gz {
            // MultiGzDecoder: handles concatenated gzip members (some providers
            // append members), which plain GzDecoder silently truncates at the
            // first member boundary. Single-member files are unchanged.
            let mut dec = flate2::bufread::MultiGzDecoder::new(probe);
            let mut h = Vec::new();
            let _ = (&mut dec).take(256 * 1024).read_to_end(&mut h);
            let s = String::from_utf8_lossy(&h);
            s.contains("<programme") || s.contains("<tv")
        } else {
            let s = String::from_utf8_lossy(head);
            s.contains("<programme") || s.contains("<tv")
        };
        (gz, looks_like_xmltv)
    };
    if !head_is_xmltv {
        return Err(anyhow::anyhow!(
            "EPG file {} contained no XMLTV data (channels/programmes); keeping existing EPG data",
            file_path
        ));
    }

    let total_bytes = std::fs::File::open(&file_path)
        .and_then(|f| f.metadata())
        .ok()
        .map(|m| m.len());

    // Safe to replace old programs now: content is confirmed XMLTV
    if clear_existing {
        let deleted_count = delete_programs_for_source(db, &source_id)?;
        info!("[EPG] Deleted {} old programs for source {}", deleted_count, source_id);
        log_pin_kept_programs(db, &source_id);
    } else {
        info!("[EPG] Skipping deletion of old programs because clear_existing is false");
    }

    // Streaming reader for the parse pass (re-opened so the probe above can
    // consume its own handle). Decompressed data is never fully materialized.
    let reader: Box<dyn std::io::BufRead + Send> = if is_gzip {
        // flate2's bufread::MultiGzDecoder implements Read (not BufRead), so
        // wrap it in a BufReader to hand quick_xml a streaming BufRead.
        let file = std::fs::File::open(&file_path).context("Failed to open EPG file")?;
        let dec = flate2::bufread::MultiGzDecoder::new(std::io::BufReader::with_capacity(
            256 * 1024,
            file,
        ));
        Box::new(std::io::BufReader::with_capacity(256 * 1024, dec))
    } else {
        let file = std::fs::File::open(&file_path).context("Failed to open EPG file")?;
        Box::new(std::io::BufReader::with_capacity(256 * 1024, file))
    };

    // Create channel for parse->insert pipeline
    let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);

    // Spawn parser task (file read + decompress + parse all happen inside the
    // streaming pass; the inserter runs concurrently on this task)
    let app_handle_clone = app_handle.clone();
    let source_id_clone = source_id.clone();
    let parse_start = std::time::Instant::now();
    let mut last_progress_update = std::time::Instant::now();
    // Parse on a blocking thread: file reads + decompression + the sync parse
    // core run here, while the inserter consumes batches concurrently below
    // (blocking_send hands each batch off with backpressure).
    let parser_task = tokio::task::spawn_blocking(move || {
        let mut on_progress = |parsed: usize, matched: usize| {
            if last_progress_update.elapsed().as_millis() > 100 {
                emit_progress(
                    &app_handle_clone,
                    &source_id_clone,
                    EpgParseProgress {
                        source_id: source_id_clone.to_string(),
                        phase: "parsing".to_string(),
                        bytes_downloaded: total_bytes.unwrap_or(0),
                        total_bytes,
                        programs_parsed: parsed,
                        programs_matched: matched,
                        programs_inserted: 0,
                        estimated_remaining_seconds: estimate_remaining(
                            total_bytes.unwrap_or(0),
                            total_bytes,
                            start_time.elapsed().as_secs(),
                        ),
                    },
                );
                last_progress_update = std::time::Instant::now();
            }
        };
        let mut sink = |batch: Vec<EpgProgram>| batch_tx.blocking_send(batch).is_ok();
        let (channels, result) = parse_and_stream_epg_once(
            reader,
            channel_lookup,
            advanced_epg_matching,
            timeshift_hours,
            &mut sink,
            &mut on_progress,
        )?;
        drop(batch_tx);
        Ok::<_, anyhow::Error>((channels, result))
    });

    // Run inserter concurrently
    let inserter_result = insert_batches_pipeline(
        db,
        batch_rx,
        &source_id,
        app_handle.clone(),
        total_bytes,
        start_time,
    ).await;

    // Wait for parser
    let (epg_channels, mut parser_result) = parser_task.await
        .context("Parser task panicked")??;
    // A batch that exhausted its retry budget means programs are missing —
    // surface it instead of reporting a silent partial insert.
    let inserter_result = inserter_result?;
    let parse_ms = parse_start.elapsed().as_millis() as u64;

    // Persist channel metadata for the channel editor (collected in the pass)
    if let Err(e) = insert_epg_channels(db, &source_id, &epg_channels) {
        warn!("[EPG] Failed to insert epg_channels for source {}: {}", source_id, e);
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    // File read is overlapped with the streaming parse, so download/decompress
    // are reported inside parse_ms (0 here).
    parser_result.download_ms = 0;
    parser_result.decompress_ms = 0;
    parser_result.parse_ms = parse_ms;
    parser_result.bytes_processed = total_bytes.unwrap_or(0);

    let result = EpgParseResult {
        source_id: source_id.clone(),
        total_programs: parser_result.total_programs,
        matched_programs: parser_result.matched_programs,
        inserted_programs: inserter_result.inserted,
        unmatched_channels: parser_result.unmatched_channels,
        matched_channels: parser_result.matched_channels,
        duration_ms,
        bytes_processed: parser_result.bytes_processed,
        download_ms: parser_result.download_ms,
        decompress_ms: parser_result.decompress_ms,
        parse_ms: parser_result.parse_ms,
        insert_ms: inserter_result.insert_ms,
        lock_wait_ms: inserter_result.lock_wait_ms,
    };

    info!(
        "[EPG TIMING] source=\"{}\" file=\"{}\" download_ms={} decompress_ms={} parse_ms={} insert_ms={} lock_wait_ms={} total_ms={} bytes={} programs={} matched={} inserted={} unmatched_channels={}",
        source_id, file_path,
        result.download_ms, result.decompress_ms, result.parse_ms, result.insert_ms,
        result.lock_wait_ms,
        result.duration_ms, result.bytes_processed,
        result.total_programs, result.matched_programs, result.inserted_programs,
        result.unmatched_channels
    );

    append_epg_timing_record(&app_handle, &source_id, &source_id, &file_path, &result);

    Ok(result)
}

/// Result of the spooled cache parse: the full feed was committed to the cache
/// DB after download verification; matched programmes are spooled per source
/// for the main-DB gap-fill, and first-match overrides are ready to persist.
struct CacheSpooledParse {
    spools: HashMap<String, Vec<EpgProgram>>,
    source_stats: HashMap<String, SourceParseStats>,
    /// stream_id -> first matched EPG channel id (for epg_channel_overrides).
    overrides: HashMap<String, String>,
    total_programs: usize,
    cache_channels: usize,
    cache_programs: usize,
}

/// Persist matched EPG channel ids as overrides, and — when the pass is a global
/// EPG link — lock the channels it just filled to that feed.
///
/// The id write never overwrites an existing override (INSERT OR IGNORE): the
/// renderer's previous behaviour of saving the first successful match per stream.
///
/// `pin` is `Some("global_epg_<linkId>")` for a link pass and `None` otherwise.
/// A channel a link has just filled is locked to it exactly as if the user had
/// picked that feed in the EPG editor: the channel's own playlist feed no longer
/// writes it, the source's wipe spares its guide, and the link replaces (rather
/// than merges into) that guide on its own syncs. Without this the fill is a
/// one-off — the next source sync deletes it and only a wipe-the-channel-again
/// cycle brings it back.
///
/// An existing lock is never replaced (a channel the user pinned to another feed
/// keeps it) and an existing id is never overwritten. Rows with a lock naming a
/// feed that no longer exists are left for the renderer's release pass.
fn save_epg_channel_overrides(
    db: &DvrDatabase,
    overrides: &HashMap<String, String>,
    pin: Option<&str>,
) -> Result<usize> {
    if overrides.is_empty() {
        return Ok(0);
    }
    let mut conn = db.get_conn()?;
    save_epg_channel_overrides_conn(&mut conn, overrides, pin)
}

fn save_epg_channel_overrides_conn(
    conn: &mut rusqlite::Connection,
    overrides: &HashMap<String, String>,
    pin: Option<&str>,
) -> Result<usize> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut saved = 0usize;

    if let Some(feed_ref) = pin {
        // The SELECT-free upsert: a new row gets id + lock, and an existing row
        // only gains the lock — and only when it has none.
        let mut stmt = tx.prepare(
            "INSERT INTO epg_channel_overrides (stream_id, epg_channel_id, epg_source_id)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(stream_id) DO UPDATE SET epg_source_id = excluded.epg_source_id
              WHERE epg_channel_overrides.epg_source_id IS NULL
                 OR TRIM(epg_channel_overrides.epg_source_id) = ''",
        )?;
        for (stream_id, epg_channel_id) in overrides {
            match stmt.execute(rusqlite::params![stream_id, epg_channel_id, feed_ref]) {
                // Every changed row is a row that now carries this lock.
                Ok(n) if n > 0 => saved += n,
                Ok(_) => {}
                Err(e) => return Err(e.into()),
            }
        }
        stmt.finalize()?;
    } else {
        let mut stmt = tx.prepare(
            "INSERT OR IGNORE INTO epg_channel_overrides (stream_id, epg_channel_id) VALUES (?1, ?2)",
        )?;
        for (stream_id, epg_channel_id) in overrides {
            match stmt.execute(rusqlite::params![stream_id, epg_channel_id]) {
                Ok(1) => saved += 1,
                Ok(_) => {}
                Err(e) => return Err(e.into()),
            }
        }
        stmt.finalize()?;
    }

    tx.commit()?;
    Ok(saved)
}

/// The feed a pass may lock the channels it fills to: only a global EPG link
/// pass locks anything. A playlist's own feed/extra-URL pass must not, or every
/// matched channel would end up pinned to its own source, which bars every other
/// feed — including the global EPG links that are meant to fill it.
fn lockable_feed_ref(feed_ref: Option<&str>) -> Option<&str> {
    feed_ref.filter(|feed| feed.starts_with("global_epg_"))
}

/// Sync and save all EPG channels and programs to a separate database cache file.
///
/// Downloads the feed once and, in a single streaming pass, writes the FULL
/// feed to the per-link cache DB (`epg_cache_<id>.db`, kept for offline use)
/// while routing matched programmes to per-source spools using the exact same
/// matching as `stream_parse_epg_multi`. After the download is verified, the
/// spools are inserted into the MAIN database (gap-fill only — nothing is
/// deleted) and matched channel overrides are persisted, so the renderer no
/// longer has to read the cache DB back and bulkPut the matches itself.
pub async fn cache_entire_epg_db<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: &DvrDatabase,
    epg_url: String,
    epg_link_id: String,
    user_agent: Option<String>,
    sources: Vec<EpgSourceRef>,
    // Feed refs a pin may name that no longer exist — see
    // `load_channel_mappings_from_db`.
    unservable_feeds: Vec<String>,
) -> Result<Vec<EpgParseResult>, String> {
    use tauri::Manager;
    let start_time = std::time::Instant::now();

    // The needing-EPG channel mappings are computed here, from the main DB
    // (channels minus already-filled stream ids, overrides applied). When
    // nothing needs filling we skip the download entirely — the existing cache
    // file stays untouched and the caller marks the link as synced (the JS
    // side used to gate on this before calling; now Rust does it).
    // This pass IS the pinned feed for channels the user matched to this link.
    let feed_ref = format!("global_epg_{}", epg_link_id);
    let sources = load_channel_mappings_from_db(db, &sources, Some(&feed_ref), &unservable_feeds)?;
    if sources.is_empty() {
        info!(
            "[EPG Cache] No sources need EPG from {}; skipping download and cache refresh",
            epg_url
        );
        return Ok(Vec::new());
    }

    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join(format!("epg_cache_{}.db", epg_link_id));

    info!("[EPG Cache] Downloading and caching entire EPG from {} to {:?}", epg_url, db_path);

    // Per-source channel lookups BEFORE the download (they depend only on the
    // mappings) — identical to the multi-source parser, so both global-EPG
    // paths match channels the same way. Display-name merging for advanced
    // matching happens inside the shared single pass.
    let mut per_source_lookups: Vec<(String, HashMap<String, Vec<String>>, bool)> =
        Vec::with_capacity(sources.len());
    for config in &sources {
        let lookup = build_channel_lookup(config.channel_mappings.clone());
        info!(
            "[EPG Cache] Source {} channel lookup has {} entries",
            config.source_id,
            lookup.len()
        );
        per_source_lookups.push((config.source_id.clone(), lookup, config.advanced_epg_matching));
    }

    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(10)
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .user_agent(ua)
        .build()
        .map_err(|e| e.to_string())?;

    let response = client.get(&epg_url).send().await.map_err(|e| e.to_string())?;
    // Reject HTTP error responses (404/503/...) before their body can be parsed
    // as empty XML and overwrite the existing cache below.
    let response = response
        .error_for_status()
        .map_err(|e| format!("HTTP error from EPG URL {}: {}", epg_url, e))?;
    let total_bytes = response.content_length();
    info!("EPG download started, total size: {:?} bytes", total_bytes);

    // Read Content-Encoding before the body is consumed by the bridge (used
    // only for logging — the gzip magic bytes are the authoritative signal).
    let content_encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "none".to_string());

    // Bridge the async download into a synchronous byte stream. The probe +
    // single-pass parse + cache-DB writes + matched-program routing run on a
    // blocking thread as chunks arrive, so download, decompress, cache write
    // and matching all OVERLAP instead of running serially.
    //
    // Safety is unchanged: the cache DROP/CREATE + inserts happen inside a
    // SQLite transaction that is only committed after the download is verified
    // (no network error, content-length satisfied) AND the payload head is
    // confirmed XMLTV. Any failure rolls the cache transaction back AND
    // discards the matched spools, so neither the cache nor the main DB is
    // touched with a bad or partial download.
    let (mut bridge, downloaded_total, download_finished, download_errored, download_finished_ms) =
        spawn_streaming_download(response);

    let parse_start = std::time::Instant::now();
    // Clones so the blocking task can reference the URL and byte counter in
    // errors/logs without moving them away from the async side (both are used
    // again for timing records below).
    let epg_url_for_task = epg_url.clone();
    let downloaded_total_for_task = downloaded_total.clone();
    let blocking = tokio::task::spawn_blocking(move || -> Result<CacheSpooledParse, String> {
        use std::io::Read;
        let epg_url = epg_url_for_task;

        // Peek the first two bytes for the gzip magic (authoritative signal;
        // see the streaming parsers), then hand the stream to the
        // (de)compression layer.
        let mut first_two = [0u8; 2];
        let mut filled = 0usize;
        while filled < 2 {
            let n = bridge.read(&mut first_two[filled..]).map_err(|e| e.to_string())?;
            if n == 0 {
                break; // empty body
            }
            filled += n;
        }
        let has_gzip_magic = filled == 2 && first_two[0] == 0x1f && first_two[1] == 0x8b;
        if has_gzip_magic {
            info!(
                "[EPG Cache] Decompressing response (URL gzipped: {}, Content-Encoding: {})",
                epg_url.ends_with(".gz"),
                content_encoding
            );
        }

        let prefix = std::io::Cursor::new(first_two.to_vec());
        let mut dec: Box<dyn Read + Send> = if has_gzip_magic {
            let inner = std::io::BufReader::with_capacity(256 * 1024, prefix.chain(bridge));
            // MultiGzDecoder: handles concatenated gzip members (plain
            // GzDecoder silently truncates at the first member boundary).
            Box::new(flate2::bufread::MultiGzDecoder::new(inner))
        } else {
            Box::new(prefix.chain(bridge))
        };

        // Guard: verify the payload actually looks like XMLTV BEFORE any DB
        // write (protects against HTTP error pages / garbage served with
        // status 200 replacing the cache). Consumes up to 256KB; the bytes are
        // replayed below so nothing is lost.
        let mut head = Vec::with_capacity(256 * 1024);
        let _ = (&mut dec)
            .take(256 * 1024)
            .read_to_end(&mut head)
            .map_err(|e| e.to_string())?;
        let head_is_xmltv = {
            let s = String::from_utf8_lossy(&head);
            s.contains("<programme") || s.contains("<tv")
        };
        if !head_is_xmltv {
            return Err(format!(
                "EPG response from {} contained no XMLTV data; preserving existing cache",
                epg_url
            ));
        }

        // 2. Open separate SQLite database connection + transaction. All
        // writes stay in the transaction until the download is verified below.
        let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // Drop and recreate tables
        tx.execute("DROP TABLE IF EXISTS epg_channels", []).map_err(|e| e.to_string())?;
        tx.execute("DROP TABLE IF EXISTS programs", []).map_err(|e| e.to_string())?;

        tx.execute(
            "CREATE TABLE epg_channels (
                id TEXT PRIMARY KEY,
                display_name TEXT,
                icon_url TEXT
            )",
            [],
        ).map_err(|e| e.to_string())?;

        tx.execute(
            "CREATE TABLE programs (
                id TEXT PRIMARY KEY,
                stream_id TEXT,
                title TEXT,
                subtitle TEXT,
                description TEXT,
                start TEXT,
                end TEXT
            )",
            [],
        ).map_err(|e| e.to_string())?;

        let mut chan_stmt = tx.prepare(
            "INSERT OR REPLACE INTO epg_channels (id, display_name, icon_url)
             VALUES (?1, ?2, ?3)",
        ).map_err(|e| e.to_string())?;

        let mut prog_stmt = tx.prepare(
            "INSERT OR REPLACE INTO programs (
                id, stream_id, title, subtitle, description, start, end
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        ).map_err(|e| e.to_string())?;

        // Single pass REUSING the multi-source parser's exact routing
        // (parse_and_stream_multi_once) — this is what guarantees both
        // global-EPG paths match channels identically. Three callbacks wire
        // the cache DB into the same pass:
        //   - on_program:  write EVERY programme (matched or not) to the cache DB
        //   - batch sink:  spool matched programmes per source for the main-DB
        //                  gap-fill after the download is verified
        //   - on_match:    collect (stream_id, feed channel id) for overrides
        let reader = std::io::BufReader::with_capacity(
            256 * 1024,
            std::io::Cursor::new(head).chain(dec),
        );

        let mut spools: HashMap<String, Vec<EpgProgram>> = HashMap::new();
        let mut overrides: HashMap<String, String> = HashMap::new();
        let mut program_count: usize = 0;

        let mut on_program = |p: &EpgProgram| {
            program_count += 1;
            let id = format!("{}_{}", p.channel_id, p.start);
            let title = &p.title;
            let sub = p.sub_title.as_deref().unwrap_or("");
            let desc = p.description.as_deref().unwrap_or("");
            if let Err(e) = prog_stmt.execute(rusqlite::params![
                id,
                p.channel_id,
                title,
                sub,
                desc,
                p.start,
                p.stop,
            ]) {
                if !e.to_string().contains("UNIQUE constraint failed") {
                    warn!("Failed to insert EPG program in cache: {}", e);
                }
            }
        };
        let mut sink = |source_id: &str, batch: Vec<EpgProgram>| {
            spools.entry(source_id.to_string()).or_default().extend(batch);
            true
        };
        let mut on_match = |stream_id: &str, feed_id: &str| {
            overrides
                .entry(stream_id.to_string())
                .or_insert_with(|| feed_id.to_string());
        };

        let (channels, parse_result) = parse_and_stream_multi_once(
            reader,
            per_source_lookups,
            &mut sink,
            &mut |_, _| {}, // progress is surfaced by the renderer's own status text
            Some(&mut on_program),
            Some(&mut on_match),
        )
        .map_err(|e| format!("Failed to parse EPG for cache: {}", e))?;
        // Release on_program's borrow of prog_stmt so it can be finalized below.
        drop(on_program);

        let channel_count = channels.len();
        for ch in &channels {
            let icon_ref = ch.icon_url.as_deref().unwrap_or("");
            if let Err(e) = chan_stmt.execute(rusqlite::params![ch.id, ch.display_name, icon_ref]) {
                warn!("Failed to insert EPG channel in cache: {}", e);
            }
        }

        chan_stmt.finalize().map_err(|e| e.to_string())?;
        prog_stmt.finalize().map_err(|e| e.to_string())?;

        // The parser reads to EOF, which only happens once the download task
        // has ended, so the download outcome is final here. Verify before
        // committing anything.
        let total_bytes_downloaded = downloaded_total_for_task.load(std::sync::atomic::Ordering::Relaxed);
        if download_errored.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(format!(
                "EPG download for {} was interrupted by a network error; preserving existing cache",
                epg_url
            ));
        }
        if !download_finished.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(format!(
                "EPG download for {} did not complete; preserving existing cache",
                epg_url
            ));
        }
        if let Some(expected_len) = total_bytes {
            if total_bytes_downloaded < expected_len {
                return Err(format!(
                    "Incomplete EPG download: expected {} bytes but got {}; preserving existing cache",
                    expected_len, total_bytes_downloaded
                ));
            }
        }

        // Guard against replacing a good cache with an empty/garbage parse
        // (e.g. an HTTP error page served with status 200). Returning Err drops
        // the transaction, rolling back the DROP/CREATE above so the existing
        // cache survives intact.
        if channel_count == 0 && program_count == 0 {
            return Err(format!(
                "EPG response from {} contained no channels or programmes; preserving existing cache",
                epg_url
            ));
        }

        // Swap point: download verified AND payload is XMLTV (probe above).
        // Commit the transaction and compact the database file.
        tx.commit().map_err(|e| e.to_string())?;
        conn.execute("VACUUM", []).map_err(|e| e.to_string())?;

        info!(
            "[EPG Cache] Cached {} channels and {} programs from {}",
            channel_count, program_count, epg_url
        );
        Ok(CacheSpooledParse {
            spools,
            source_stats: parse_result.source_stats,
            overrides,
            total_programs: parse_result.total_programs,
            cache_channels: channel_count,
            cache_programs: program_count,
        })
    });

    let spooled = blocking.await.map_err(|e| format!("EPG cache parse task panicked: {}", e))??;
    let parse_ms = parse_start.elapsed().as_millis() as u64;
    let download_ms = {
        let stamped = download_finished_ms.load(std::sync::atomic::Ordering::Relaxed);
        if stamped == 0 {
            start_time.elapsed().as_millis() as u64
        } else {
            stamped
        }
    };
    let bytes_processed = downloaded_total.load(std::sync::atomic::Ordering::Relaxed);

    info!("[EPG Cache] Entire EPG cached successfully for link {}", epg_link_id);

    let CacheSpooledParse {
        spools,
        source_stats,
        overrides,
        total_programs,
        cache_channels,
        cache_programs,
    } = spooled;

    // Drain matched programmes into the MAIN database (gap-fill only — never
    // deletes) through the same serialized, retried insert path the streaming
    // parsers use, so cache-path writes play by the same lock rules.
    let mut per_source_inserted: HashMap<String, usize> = HashMap::new();
    let mut per_source_insert_ms: HashMap<String, u64> = HashMap::new();
    let mut per_source_lock_wait_ms: HashMap<String, u64> = HashMap::new();
    for (source_id, spool) in &spools {
        // Channels locked to this link are this feed's projection, not a gap to
        // fill: replace their guide instead of merging into it.
        replace_locked_guides(db, source_id, &feed_ref, spool.iter());

        let ins_start = std::time::Instant::now();
        match insert_programs_batch_timed(db, source_id, spool).await {
            Ok((inserted, lock_wait_ms)) => {
                per_source_inserted.insert(source_id.clone(), inserted);
                per_source_lock_wait_ms.insert(source_id.clone(), lock_wait_ms);
            }
            Err(e) => warn!(
                "[EPG Cache] Failed to insert matched programs for source {}: {}",
                source_id, e
            ),
        }
        per_source_insert_ms.insert(source_id.clone(), ins_start.elapsed().as_millis() as u64);
    }

    // Persist the first successful match per stream as a channel override
    // (INSERT OR IGNORE — never overwrites an existing override), and lock the
    // channels this link filled to it, so its guide survives the source's wipe
    // and is replaced (not merged) on the link's next sync.
    // Best-effort like the multi-source path: in-memory preferences, and the
    // guides are already stored — a metadata write must not fail the whole pass
    // (the user would see an error over a fill that actually succeeded).
    let link_lock = lockable_feed_ref(Some(&feed_ref));
    match with_sync_db_retry(|| save_epg_channel_overrides(db, &overrides, link_lock)) {
        Ok(0) => {}
        Ok(saved) => match link_lock {
            Some(feed) => info!(
                "[EPG Cache] Locked {} channel(s) this link filled to {}",
                saved, feed
            ),
            None => info!("[EPG Cache] Saved {} channel override(s)", saved),
        },
        Err(e) => warn!("[EPG Cache] Failed to save EPG channel overrides: {}", e),
    }

    // Per-source results + timing records, shaped exactly like the multi
    // parser's so the renderer aggregates them identically (and the cache
    // fills now show up in epg_timings.jsonl / the run summary).
    let duration_ms = start_time.elapsed().as_millis() as u64;
    let mut results = Vec::with_capacity(sources.len());
    for config in &sources {
        let sid = &config.source_id;
        let stats = source_stats.get(sid);
        let matched = stats.map(|s| s.matched_programs).unwrap_or(0);
        let unmatched = stats.map(|s| s.unmatched_channels.len()).unwrap_or(0);
        let matched_ch = stats.map(|s| s.matched_channels.len()).unwrap_or(0);

        let result = EpgParseResult {
            source_id: sid.clone(),
            total_programs,
            matched_programs: matched,
            inserted_programs: per_source_inserted.get(sid).copied().unwrap_or(0),
            unmatched_channels: unmatched,
            matched_channels: matched_ch,
            duration_ms,
            bytes_processed,
            download_ms,
            decompress_ms: 0,
            parse_ms,
            insert_ms: per_source_insert_ms.get(sid).copied().unwrap_or(0),
            lock_wait_ms: per_source_lock_wait_ms.get(sid).copied().unwrap_or(0),
        };

        append_epg_timing_record(&app_handle, sid, &config.source_name, &epg_url, &result);
        results.push(result);
    }

    info!(
        "[EPG Cache] Applied {} programmes for {} source(s) from {} ({} channels / {} programmes cached)",
        results.iter().map(|r| r.inserted_programs).sum::<usize>(),
        results.len(),
        epg_url,
        cache_channels,
        cache_programs
    );

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_mappings() -> Vec<ChannelMapping> {
        // M3U names deliberately mixed-case / prefixed to exercise the
        // display-name merge edge cases.
        vec![
            ChannelMapping { epg_channel_id: "M3U0001".into(), stream_id: "s1".into(), channel_name: "FooBar".into() },
            ChannelMapping { epg_channel_id: "M3U0002".into(), stream_id: "s2".into(), channel_name: "US: News HD".into() },
            ChannelMapping { epg_channel_id: "M3U0003".into(), stream_id: "s3".into(), channel_name: "Sports One".into() },
            ChannelMapping { epg_channel_id: "M3U0004".into(), stream_id: "s4".into(), channel_name: "plain".into() },
        ]
    }

    fn sample_xml() -> String {
        // Display names engineered to match M3U names in different ways:
        // - "foobar" == normalize("FooBar")   (the case the incremental merge missed)
        // - "US: News HD" exact match
        // - "sport one" == normalize("Sports One")
        // - "plain" exact (already normalized)
        let mut xml = String::from("<?xml version=\"1.0\"?><tv>");
        for (id, disp) in [
            ("CH1", "foobar"),
            ("CH2", "US: News HD"),
            ("CH3", "sports one"),
            ("CH4", "plain"),
        ] {
            xml.push_str(&format!(
                "<channel id=\"{}\"><display-name>{}</display-name></channel>",
                id, disp
            ));
        }
        for (ch, start) in [
            ("CH1", "20260223010000 +0000"),
            ("CH2", "20260223020000 +0000"),
            ("CH3", "20260223030000 +0000"),
            ("CH4", "20260223040000 +0000"),
        ] {
            xml.push_str(&format!(
                "<programme start=\"{}\" stop=\"20260223100000 +0000\" channel=\"{}\"><title>T</title><desc>D</desc></programme>",
                start, ch
            ));
        }
        xml.push_str("</tv>");
        xml
    }

    /// Count how many programmes (and how many stream copies, matching the
    /// one-copy-per-stream-id behaviour) the OLD pipeline
    /// (build_display_name_mapping + merge_with_display_names + lookup) would
    /// produce. Returns (programs, copies).
    fn old_pipeline_counts(xml: &str, mappings: &[ChannelMapping]) -> (usize, usize) {
        let lookup = build_channel_lookup(mappings.to_vec());
        let display = build_display_name_mapping(xml.as_bytes());
        let merged = merge_with_display_names(lookup, &display);

        let mut programs = 0usize;
        let mut copies = 0usize;
        let mut reader = Reader::from_reader(xml.as_bytes());
        reader.config_mut().trim_text(true);
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(e)) => {
                    if e.local_name().as_ref() == b"programme" {
                        let mut ch = String::new();
                        for attr in e.attributes() {
                            if let Ok(a) = attr {
                                if a.key.as_ref() == b"channel" {
                                    ch = a
                                        .decode_and_unescape_value(reader.decoder())
                                        .unwrap_or_default()
                                        .to_string();
                                }
                            }
                        }
                        if let Some(ids) = merged
                            .get(&ch)
                            .or_else(|| merged.get(&normalize_channel_name(&ch)))
                        {
                            programs += 1;
                            // Copies: one per unique stream_id. The merge
                            // dedupes the raw+normalized alias collisions, so
                            // this is the same count the single-pass core emits.
                            copies += ids.len();
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            buf.clear();
        }
        (programs, copies)
    }

    #[tokio::test]
    async fn single_pass_merge_matches_old_pipeline() {
        let xml = sample_xml();
        let mappings = sample_mappings();
        let (expected_programs, expected_copies) = old_pipeline_counts(&xml, &mappings);
        assert_eq!(
            (expected_programs, expected_copies),
            (4, 4),
            "sanity: 4 programmes / 4 copies after dedupe (CH2/CH3 previously emitted 2 copies each via raw+normalized keys)"
        );

        let lookup = build_channel_lookup(mappings);

        let mut flowed: Vec<EpgProgram> = Vec::new();
        let mut sink = |batch: Vec<EpgProgram>| {
            flowed.extend(batch);
            true
        };

        let (channels, result) = parse_and_stream_epg_once(
            xml.as_bytes(),
            lookup,
            true, // advanced matching
            0.0,
            &mut sink,
            &mut |_, _| {},
        )
        .expect("single-pass parse");

        let flowed = flowed.len();

        assert_eq!(channels.len(), 4, "all channels extracted");
        assert_eq!(result.total_programs, 4, "all programmes counted");
        assert_eq!(
            result.matched_programs, expected_programs,
            "matched programmes must be identical to the old pipeline"
        );
        assert_eq!(flowed, expected_copies, "stream copies must match the old pipeline");
    }

    #[tokio::test]
    async fn multi_source_single_pass_routes_and_matches_old_pipeline() {
        let xml = sample_xml();
        let mappings = sample_mappings();
        let (expected_programs, expected_copies) = old_pipeline_counts(&xml, &mappings);
        assert_eq!(
            (expected_programs, expected_copies),
            (4, 4),
            "sanity: source A matches the old pipeline counts"
        );

        // Source B: no advanced matching, a direct epg_channel_id match for
        // CH1 only — the shared CH1 programme must route to BOTH sources.
        let b_mappings = vec![ChannelMapping {
            epg_channel_id: "CH1".into(),
            stream_id: "b1".into(),
            channel_name: "B Channel".into(),
        }];

        let per_source = vec![
            ("src-a".to_string(), build_channel_lookup(mappings), true),
            ("src-b".to_string(), build_channel_lookup(b_mappings), false),
        ];

        let mut spools: HashMap<String, Vec<EpgProgram>> = HashMap::new();
        let mut sink = |source_id: &str, batch: Vec<EpgProgram>| {
            spools.entry(source_id.to_string()).or_default().extend(batch);
            true
        };

        let (channels, result) = parse_and_stream_multi_once(
            xml.as_bytes(),
            per_source,
            &mut sink,
            &mut |_, _| {},
            None,
            None,
        )
        .expect("multi-source single-pass parse");

        assert_eq!(channels.len(), 4, "all channels extracted");
        assert_eq!(result.total_programs, 4, "each programme counted exactly once");

        // Source A (advanced) must be identical to the old pipeline: 4
        // programmes matched, one copy per stream_id, 4 matched channels.
        let a = result.source_stats.get("src-a").unwrap();
        assert_eq!(a.matched_programs, expected_programs);
        assert_eq!(
            spools.get("src-a").map(Vec::len).unwrap_or(0),
            expected_copies,
            "source A stream copies must match the old pipeline"
        );
        assert_eq!(a.matched_channels.len(), 4, "source A matched channels");

        // Source B (plain) gets only CH1's programme, routed to its own stream.
        let b = result.source_stats.get("src-b").unwrap();
        assert_eq!(b.matched_programs, 1, "source B matched programmes");
        let b_copies = spools.get("src-b").map(Vec::len).unwrap_or(0);
        assert_eq!(b_copies, 1, "source B copies");
        assert_eq!(
            spools.get("src-b").unwrap()[0].channel_id, "b1",
            "CH1 routed to source B's stream id"
        );
        assert_eq!(b.matched_channels.len(), 1, "source B matched channels");

        // No per-source stats missing.
        assert!(result.source_stats.contains_key("src-a"));
        assert!(result.source_stats.contains_key("src-b"));
    }

    #[test]
    fn merge_dedupes_duplicate_stream_ids() {
        let lookup = build_channel_lookup(sample_mappings());
        let display = build_display_name_mapping(sample_xml().as_bytes());
        let merged = merge_with_display_names(lookup, &display);

        // CH2 ("US: News HD") and CH3 ("Sports One") match their display
        // names via BOTH the raw key and the normalized alias key, which
        // previously appended the same stream_id twice to the epg id's
        // vector (2 copies each). After dedupe each stream appears once.
        assert_eq!(merged.get("CH2").map(Vec::len), Some(1), "CH2 stream_id deduped");
        assert_eq!(merged.get("CH3").map(Vec::len), Some(1), "CH3 stream_id deduped");
        assert_eq!(merged.get("CH1").map(Vec::len), Some(1));
        assert_eq!(merged.get("CH4").map(Vec::len), Some(1));

        // Invariant: no lookup vector contains a duplicate stream_id.
        for (key, ids) in &merged {
            let mut sorted = ids.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), ids.len(), "no duplicate stream_ids under key {}", key);
        }
    }

    /// A feed whose channel id is cased differently from the playlist's tvg-id.
    /// The channel name is deliberately decorated so that name matching cannot
    /// rescue it — the id is the only way this channel can match.
    fn case_fold_fixture(epg_id: &str) -> (String, Vec<ChannelMapping>) {
        let xml = String::from(
            "<?xml version=\"1.0\"?><tv>\
             <channel id=\"espn2.us\"><display-name>ESPN2</display-name></channel>\
             <programme start=\"20260223010000 +0000\" stop=\"20260223100000 +0000\" channel=\"espn2.us\">\
             <title>T</title><desc>D</desc></programme></tv>",
        );
        let mappings = vec![ChannelMapping {
            epg_channel_id: epg_id.into(),
            stream_id: "s1".into(),
            channel_name: "US: ESPN2 HD".into(),
        }];
        (xml, mappings)
    }

    /// Parse the fixture with advanced matching OFF, so the epg-id path alone
    /// decides whether the programme matches.
    async fn id_path_result(epg_id: &str) -> (usize, Vec<String>) {
        let (xml, mappings) = case_fold_fixture(epg_id);
        let lookup = build_channel_lookup(mappings);

        let mut flowed: Vec<EpgProgram> = Vec::new();
        let mut sink = |batch: Vec<EpgProgram>| {
            flowed.extend(batch);
            true
        };

        let (_channels, _result) = parse_and_stream_epg_once(
            xml.as_bytes(),
            lookup,
            false, // advanced matching off
            0.0,
            &mut sink,
            &mut |_, _| {},
        )
        .expect("single-pass parse");

        let ids = flowed.iter().map(|p| p.channel_id.clone()).collect();
        (flowed.len(), ids)
    }

    #[tokio::test]
    async fn exact_case_id_match_is_unchanged() {
        // Parity guard: this resolved before the alias existed and must keep
        // resolving identically.
        let (count, ids) = id_path_result("espn2.us").await;
        assert_eq!(count, 1, "an exact id match still resolves");
        assert_eq!(ids, vec!["s1".to_string()]);
    }

    #[tokio::test]
    async fn id_differing_only_by_case_resolves() {
        let (count, ids) = id_path_result("ESPN2.us").await;
        assert_eq!(count, 1, "an id differing only by case now resolves");
        assert_eq!(ids, vec!["s1".to_string()]);
    }

    #[test]
    fn id_alias_is_lowercase_only() {
        let lookup = build_channel_lookup(vec![ChannelMapping {
            epg_channel_id: "ESPN2.us".into(),
            stream_id: "s1".into(),
            channel_name: String::new(),
        }]);

        assert_eq!(lookup.get("ESPN2.us").map(Vec::len), Some(1), "raw key kept");
        assert_eq!(
            lookup.get("espn2.us"),
            Some(&vec!["s1".to_string()]),
            "case-folded alias points at the same stream"
        );

        // Punctuation must survive untouched: `a-b.c` must not alias to `abc`,
        // and a lowercase id must not gain an uppercase alias.
        let lower = build_channel_lookup(vec![ChannelMapping {
            epg_channel_id: "a-b.c".into(),
            stream_id: "s2".into(),
            channel_name: String::new(),
        }]);
        assert!(lower.contains_key("a-b.c"), "raw punctuation-only id kept");
        assert!(!lower.contains_key("A-B.C"), "no uppercase alias");
        assert!(!lower.contains_key("abc"), "punctuation is not stripped");
    }

    #[test]
    fn id_alias_shares_streams_rather_than_replacing_them() {
        // A channel already keyed on the lowercase id and another keyed on the
        // canonical id must both end up on the folded key, so a feed declaring
        // the lowercase form still reaches both.
        let lookup = build_channel_lookup(vec![
            ChannelMapping {
                epg_channel_id: "ESPN2.us".into(),
                stream_id: "s1".into(),
                channel_name: String::new(),
            },
            ChannelMapping {
                epg_channel_id: "espn2.us".into(),
                stream_id: "s2".into(),
                channel_name: String::new(),
            },
        ]);

        let mut folded = lookup.get("espn2.us").cloned().unwrap_or_default();
        folded.sort();
        assert_eq!(folded, vec!["s1".to_string(), "s2".to_string()]);
        assert_eq!(lookup.get("ESPN2.us"), Some(&vec!["s1".to_string()]));
    }

    #[test]
    fn busy_contention_aborts_batch_instead_of_dropping_rows() {
        use tempfile::tempdir;

        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let mut conn1 = rusqlite::Connection::open(&db_path).expect("conn1");
        conn1
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE programs (
                     id TEXT PRIMARY KEY, stream_id TEXT, title TEXT, subtitle TEXT,
                     description TEXT, start TEXT, end TEXT, source_id TEXT
                 );",
            )
            .expect("schema");
        // conn1 holds the SQLite write lock for the rest of the test.
        let tx1 = conn1.transaction().expect("tx1");
        tx1.execute(
            "INSERT INTO programs VALUES ('lock','l','t','','','0','0','s')",
            [],
        )
        .expect("write lock");

        let mut conn2 = rusqlite::Connection::open(&db_path).expect("conn2");
        conn2
            .busy_timeout(std::time::Duration::ZERO)
            .expect("busy_timeout=0");
        let tx2 = conn2.transaction().expect("tx2");
        let mut stmt = tx2
            .prepare(
                "INSERT INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title",
            )
            .expect("stmt");

        let programs = vec![EpgProgram {
            channel_id: "c1".into(),
            title: "Title".into(),
            sub_title: None,
            description: None,
            start: "20260223010000 +0000".into(),
            stop: "20260223100000 +0000".into(),
        }];

        // The whole batch must fail (so the timed retry loop can re-run it
        // with lock_wait accounting), NOT silently report fewer inserted rows.
        let err = insert_programs_rows(&mut stmt, &programs, "src")
            .expect_err("contended write must abort the batch");
        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("database is locked") || msg.contains("busy"),
            "expected a lock error, got: {}",
            msg
        );
    }

    #[tokio::test]
    async fn cdata_wrapped_title_is_parsed() {
        let xml = "<?xml version=\"1.0\"?><tv>\
            <channel id=\"c1\"><display-name>One</display-name></channel>\
            <programme start=\"20260223010000 +0000\" stop=\"20260223100000 +0000\" channel=\"c1\">\
            <title><![CDATA[Show <Name> & More]]></title></programme></tv>";
        let mappings = vec![ChannelMapping {
            epg_channel_id: "c1".into(),
            stream_id: "s1".into(),
            channel_name: "One".into(),
        }];
        let lookup = build_channel_lookup(mappings);
        let mut programs: Vec<EpgProgram> = Vec::new();
        let mut sink = |batch: Vec<EpgProgram>| {
            programs.extend(batch);
            true
        };
        let (_channels, _result) = parse_and_stream_epg_once(
            xml.as_bytes(),
            lookup,
            false,
            0.0,
            &mut sink,
            &mut |_, _| {},
        )
        .expect("parse");
        assert_eq!(programs.len(), 1);
        assert_eq!(programs[0].title, "Show <Name> & More");
    }

    #[test]
    fn multigz_decodes_all_members_plain_gz_truncates_at_first() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::{Read, Write};

        let doc1 = "<tv><programme channel=\"c1\" start=\"20260223010000 +0000\" stop=\"20260223020000 +0000\"><title>A</title></programme></tv>";
        let doc2 = "<programme channel=\"c2\" start=\"20260223020000 +0000\" stop=\"20260223030000 +0000\"><title>B</title></programme></tv>";

        let mut member1 = Vec::new();
        {
            let mut enc = GzEncoder::new(&mut member1, Compression::default());
            enc.write_all(doc1.as_bytes()).unwrap();
            enc.finish().unwrap();
        }
        let mut member2 = Vec::new();
        {
            let mut enc = GzEncoder::new(&mut member2, Compression::default());
            enc.write_all(doc2.as_bytes()).unwrap();
            enc.finish().unwrap();
        }
        let mut combined = member1.clone();
        combined.extend_from_slice(&member2);

        // Plain GzDecoder silently stops at the first member boundary — this is
        // the pre-existing behavior the new MultiGzDecoder replaces.
        let mut single = String::new();
        flate2::read::GzDecoder::new(&combined[..])
            .read_to_string(&mut single)
            .unwrap();
        assert!(
            single.contains("c1") && !single.contains("c2"),
            "GzDecoder must stop at the first member boundary"
        );

        // MultiGzDecoder (now used by the parse paths) reads every member.
        let mut multi = String::new();
        flate2::read::MultiGzDecoder::new(&combined[..])
            .read_to_string(&mut multi)
            .unwrap();
        assert!(
            multi.contains("c1") && multi.contains("c2"),
            "MultiGzDecoder must read all members"
        );

        // Truncated gzip: member1 complete + a cut member2 must ERROR, not
        // silently return partial data (so a truncated download that slips
        // past content-length can't swap partial programs).
        let cut = member1.len() + 5;
        let mut out = String::new();
        let res = flate2::read::MultiGzDecoder::new(&combined[..cut]).read_to_string(&mut out);
        assert!(
            res.is_err(),
            "truncated gzip must error, not silently succeed (got {})",
            out
        );
    }

    #[test]
    fn gap_fill_gate_reopens_channels_whose_guide_ran_out() {
        use tempfile::tempdir;

        let dir = tempdir().expect("tempdir");
        let conn = rusqlite::Connection::open(dir.path().join("gate.db")).expect("open");
        conn.execute_batch(
            "CREATE TABLE programs (
                 id TEXT PRIMARY KEY, stream_id TEXT, title TEXT, subtitle TEXT,
                 description TEXT, start TEXT, end TEXT, source_id TEXT
             );",
        )
        .expect("schema");

        let insert = |id: &str, stream_id: &str, end: Option<&str>, source: &str| {
            conn.execute(
                "INSERT INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
                 VALUES (?1, ?2, 't', '', '', '2026-01-01T00:00:00.000Z', ?3, ?4)",
                rusqlite::params![id, stream_id, end, source],
            )
            .expect("insert");
        };
        // Still has upcoming guide data -> stays out of the needing pool.
        insert("p1", "s1", Some("2030-01-01T00:00:00.000Z"), "src");
        // Every programme has ended -> must rejoin the needing pool.
        insert("p2", "s2", Some("2020-01-01T00:00:00.000Z"), "src");
        // Rows without a usable end time -> also needs EPG.
        insert("p3", "s3", None, "src");
        // Another source's programmes must not leak into this source's gate.
        insert("p4", "s4", Some("2030-01-01T00:00:00.000Z"), "other");

        let cutoff = "2026-06-01T00:00:00.000Z";
        let end_times = load_stream_end_times(&conn, "src").expect("end times");
        assert_eq!(end_times.len(), 3, "only this source's stream ids are read");
        let covered = covered_stream_ids(&end_times, cutoff);
        assert_eq!(covered.len(), 1, "only s1 still has guide data");
        assert!(covered.contains("s1"));

        // The run-out channels come back, channels that never had programmes
        // still need EPG, and the cutoff compares as a plain RFC 3339 string.
        let channels = vec![
            ("s1".to_string(), Some("ID1".to_string()), "One".to_string()),
            ("s2".to_string(), Some("ID2".to_string()), "Two".to_string()),
            ("s3".to_string(), Some("ID3".to_string()), "Three".to_string()),
            ("s9".to_string(), Some("ID9".to_string()), "Nine".to_string()),
        ];
        let mappings =
            build_needing_mappings(channels, &covered, &HashMap::new(), &HashMap::new(), None);
        let ids: Vec<&str> = mappings.iter().map(|m| m.stream_id.as_str()).collect();
        assert_eq!(ids, vec!["s2", "s3", "s9"]);

        // The generated cutoff uses the stored timestamp format, so a future
        // guide is always classed as covered and a past one never is.
        let now = epg_coverage_cutoff();
        assert_eq!(now.len(), 24, "RFC 3339 with millis: {}", now);
        assert!(now.ends_with('Z'));
        let future = HashMap::from([(
            "f".to_string(),
            Some("2999-01-01T00:00:00.000Z".to_string()),
        )]);
        let past = HashMap::from([(
            "p".to_string(),
            Some("2000-01-01T00:00:00.000Z".to_string()),
        )]);
        assert!(covered_stream_ids(&future, &now).contains("f"));
        assert!(covered_stream_ids(&past, &now).is_empty());
    }

    #[test]
    fn needing_mappings_apply_override_then_id_then_name() {
        use std::collections::HashSet;

        let channels = vec![
            ("s1".to_string(), Some("ID1".to_string()), "Name One".to_string()),
            ("s2".to_string(), Some("ID2".to_string()), "Name Two".to_string()),
            ("s3".to_string(), Some("".to_string()), "Name Three".to_string()),
            ("s4".to_string(), None, "Name Four".to_string()),
            ("s5".to_string(), Some("ID5".to_string()), "".to_string()),
            ("s6".to_string(), None, "".to_string()),
            ("s7".to_string(), Some("ID7".to_string()), "Name Seven".to_string()),
        ];
        // s2's guide is still current -> excluded. s7 has an override -> override wins.
        let with_upcoming: HashSet<String> = ["s2".to_string()].into_iter().collect();
        let overrides: HashMap<String, String> =
            [("s7".to_string(), "OVERRIDE".to_string())].into_iter().collect();

        let mappings =
            build_needing_mappings(channels, &with_upcoming, &overrides, &HashMap::new(), None);

        // s2 skipped (already filled); s6 skipped (no usable id); others kept.
        let ids: Vec<&str> = mappings.iter().map(|m| m.stream_id.as_str()).collect();
        assert_eq!(ids, vec!["s1", "s3", "s4", "s5", "s7"]);

        let by_id: HashMap<&str, &str> = mappings
            .iter()
            .map(|m| (m.stream_id.as_str(), m.epg_channel_id.as_str()))
            .collect();
        assert_eq!(by_id["s1"], "ID1", "epg_channel_id used directly");
        assert_eq!(by_id["s3"], "Name Three", "empty epg_channel_id falls back to name");
        assert_eq!(by_id["s4"], "Name Four", "name used when no epg_channel_id");
        assert_eq!(by_id["s5"], "ID5", "name empty but id present");
        assert_eq!(by_id["s7"], "OVERRIDE", "override beats epg_channel_id");
    }

    #[test]
    fn match_by_alias_replaces_the_provider_name() {
        // Off by default: the provider name is what matching sees.
        assert_eq!(effective_match_name("|DE| ZDF HD", Some("ZDF"), false), "|DE| ZDF HD");
        // Opted in: the rename replaces it (so the raw name stops being a key).
        assert_eq!(effective_match_name("|DE| ZDF HD", Some("ZDF"), true), "ZDF");
        // A flag with no usable alias must never produce an empty match key.
        assert_eq!(effective_match_name("ARD-ALPHA HD", None, true), "ARD-ALPHA HD");
        assert_eq!(effective_match_name("ARD-ALPHA HD", Some("  "), true), "ARD-ALPHA HD");
        // Aliases are trimmed, and a missing provider name stays empty.
        assert_eq!(effective_match_name("x", Some("  ZDF HD "), true), "ZDF HD");
        assert_eq!(effective_match_name("", None, true), "");
    }

    #[test]
    fn feed_pins_restrict_a_channel_to_its_chosen_feed() {
        use std::collections::HashSet;

        let channels = vec![
            ("pinned_to_link".to_string(), Some("ID1".to_string()), "One".to_string()),
            ("pinned_to_source".to_string(), Some("ID2".to_string()), "Two".to_string()),
            ("unpinned".to_string(), Some("ID3".to_string()), "Three".to_string()),
        ];
        let covered = HashSet::new();
        let overrides = HashMap::new();
        let pins: HashMap<String, String> = [
            ("pinned_to_link".to_string(), "global_epg_link3".to_string()),
            ("pinned_to_source".to_string(), "source_a".to_string()),
        ]
        .into_iter()
        .collect();

        let ids = |feed_ref: Option<&str>| -> Vec<String> {
            build_needing_mappings(
                channels.clone(),
                &covered,
                &overrides,
                &pins,
                feed_ref,
            )
            .into_iter()
            .map(|m| m.stream_id)
            .collect()
        };

        // A different global EPG link is a different feed: both pins are excluded,
        // so a higher-priority link can never overwrite the user's chosen feed.
        assert_eq!(ids(Some("global_epg_link1")), vec!["unpinned"]);

        // Its own feed sees only its own pin (the other pin still belongs
        // elsewhere), and the unpinned channel stays available to every feed.
        assert_eq!(
            ids(Some("global_epg_link3")),
            vec!["pinned_to_link", "unpinned"]
        );
        assert_eq!(ids(Some("source_a")), vec!["pinned_to_source", "unpinned"]);

        // No feed identity (e.g. a direct "update this EPG" run with no link) —
        // pinned channels are skipped rather than guessed at.
        assert_eq!(ids(None), vec!["unpinned"]);
    }

    #[test]
    fn a_channel_pinned_to_this_feed_is_refetched_even_when_covered() {
        use std::collections::HashSet;

        let channels = vec![
            ("pinned_here".to_string(), Some("ID1".to_string()), "One".to_string()),
            ("pinned_elsewhere".to_string(), Some("ID2".to_string()), "Two".to_string()),
            ("unpinned".to_string(), Some("ID3".to_string()), "Three".to_string()),
        ];
        // Every channel already has guide data running into the future, which is
        // the state that used to freeze a pinned channel's horizon.
        let covered: HashSet<String> = ["pinned_here", "pinned_elsewhere", "unpinned"]
            .iter()
            .map(|id| id.to_string())
            .collect();
        let pins: HashMap<String, String> = [
            ("pinned_here".to_string(), "global_epg_link1".to_string()),
            ("pinned_elsewhere".to_string(), "source_b".to_string()),
        ]
        .into_iter()
        .collect();

        let ids = |feed_ref: Option<&str>| -> Vec<String> {
            build_needing_mappings(channels.clone(), &covered, &HashMap::new(), &pins, feed_ref)
                .into_iter()
                .map(|m| m.stream_id)
                .collect()
        };

        // The pinned channel is this link's to fill, so it stays in the pool and
        // gets refreshed; the covered unpinned one and the one pinned elsewhere
        // are both left alone.
        assert_eq!(ids(Some("global_epg_link1")), vec!["pinned_here"]);
        assert_eq!(ids(Some("source_b")), vec!["pinned_elsewhere"]);
        // No feed can claim it, so nothing is refetched.
        assert!(ids(None).is_empty());
    }

    #[test]
    fn pins_naming_a_missing_feed_are_dropped() {
        let mut pins: HashMap<String, String> = [
            ("ch_dead_source".to_string(), "playlist-gone".to_string()),
            ("ch_dead_link".to_string(), "global_epg_gone".to_string()),
            ("ch_live_source".to_string(), "playlist-a".to_string()),
            ("ch_live_link".to_string(), "global_epg_l1".to_string()),
        ]
        .into_iter()
        .collect();

        let dropped = drop_unservable_pins(
            &mut pins,
            &[
                "playlist-gone".to_string(),
                "global_epg_gone".to_string(),
                // Blank entries are ignored rather than treated as a feed named "".
                "   ".to_string(),
            ],
        );

        assert_eq!(dropped, 2, "one pin per missing feed is released");
        assert_eq!(pins.get("ch_live_source").map(String::as_str), Some("playlist-a"));
        assert_eq!(pins.get("ch_live_link").map(String::as_str), Some("global_epg_l1"));

        // An empty list is the normal case and must leave every pin in place.
        let mut untouched: HashMap<String, String> =
            [("ch".to_string(), "playlist-x".to_string())].into_iter().collect();
        assert_eq!(drop_unservable_pins(&mut untouched, &[]), 0);
        assert_eq!(untouched.len(), 1);
    }

    fn program_row(channel_id: &str) -> EpgProgram {
        EpgProgram {
            channel_id: channel_id.to_string(),
            title: "t".to_string(),
            sub_title: None,
            description: None,
            start: "2026-09-15T20:00:00.000Z".to_string(),
            stop: "2026-09-15T21:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn spooled_stream_ids_reads_the_mapped_channels() {
        // The router rewrites channel_id to the target stream id, so a spool's
        // channel ids are the channels this pass filled.
        let spool = vec![
            vec![program_row("ch_a"), program_row("ch_b")],
            vec![program_row("ch_a")],
        ];
        let ids = spooled_stream_ids(spool.iter().flatten());
        assert_eq!(ids.len(), 2, "duplicates across batches collapse");
        assert!(ids.contains("ch_a") && ids.contains("ch_b"));
        assert!(spooled_stream_ids(std::iter::empty()).is_empty());
    }

    fn overrides_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE epg_channel_overrides (
                 stream_id TEXT PRIMARY KEY, epg_channel_id TEXT, epg_source_id TEXT
             );",
        )
        .expect("schema");
        conn
    }

    fn override_row(conn: &rusqlite::Connection, stream_id: &str) -> (Option<String>, Option<String>) {
        conn.query_row(
            "SELECT epg_channel_id, epg_source_id FROM epg_channel_overrides WHERE stream_id = ?1",
            rusqlite::params![stream_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("override row")
    }

    #[test]
    fn only_a_link_pass_may_lock_the_channels_it_filled() {
        assert_eq!(lockable_feed_ref(Some("global_epg_link1")), Some("global_epg_link1"));
        assert_eq!(
            lockable_feed_ref(Some("source_a")),
            None,
            "a playlist's own feed must not lock: every match would end up pinned to its own source"
        );
        assert_eq!(lockable_feed_ref(None), None);
    }

    #[test]
    fn link_pass_locks_the_channels_it_filled_without_clobbering_choices() {
        let mut conn = overrides_conn();
        // A channel carrying a user's own id but no lock, one locked elsewhere,
        // one locked to its own source, and one with a blank lock string.
        conn.execute(
            "INSERT INTO epg_channel_overrides (stream_id, epg_channel_id) VALUES ('ch_user_id', 'user.pick')",
            [],
        )
        .expect("insert");
        conn.execute(
            "INSERT INTO epg_channel_overrides (stream_id, epg_channel_id, epg_source_id) VALUES ('ch_other_feed', 'other.pick', 'source_b')",
            [],
        )
        .expect("insert");
        conn.execute(
            "INSERT INTO epg_channel_overrides (stream_id, epg_channel_id, epg_source_id) VALUES ('ch_self_pinned', 'self.pick', 'source_a')",
            [],
        )
        .expect("insert");
        conn.execute(
            "INSERT INTO epg_channel_overrides (stream_id, epg_source_id) VALUES ('ch_blank_pin', '  ')",
            [],
        )
        .expect("insert");

        let overrides: HashMap<String, String> = [
            ("ch_new", "feed.new"),
            ("ch_user_id", "feed.user"),
            ("ch_other_feed", "feed.other"),
            ("ch_self_pinned", "feed.self"),
            ("ch_blank_pin", "feed.blank"),
        ]
        .iter()
        .map(|(stream_id, id)| (stream_id.to_string(), id.to_string()))
        .collect();

        let saved = save_epg_channel_overrides_conn(&mut conn, &overrides, Some("global_epg_link9"))
            .expect("save");
        // The new channel, the user-id row and the blank-lock row gained a lock;
        // the two rows that already named a feed did not.
        assert_eq!(saved, 3);

        assert_eq!(
            override_row(&conn, "ch_new"),
            (Some("feed.new".to_string()), Some("global_epg_link9".to_string())),
            "a filled channel is recorded and locked to the link"
        );
        assert_eq!(
            override_row(&conn, "ch_user_id"),
            (Some("user.pick".to_string()), Some("global_epg_link9".to_string())),
            "the user's id survives; only the missing lock is added"
        );
        assert_eq!(
            override_row(&conn, "ch_other_feed"),
            (Some("other.pick".to_string()), Some("source_b".to_string())),
            "a channel locked to another feed is never taken over"
        );
        assert_eq!(
            override_row(&conn, "ch_self_pinned"),
            (Some("self.pick".to_string()), Some("source_a".to_string())),
            "a channel locked to its own playlist keeps that lock"
        );
        assert_eq!(
            override_row(&conn, "ch_blank_pin").1,
            Some("global_epg_link9".to_string()),
            "a blank lock counts as no lock"
        );

        // Every row it could lock is locked, so a second pass writes nothing.
        let again = save_epg_channel_overrides_conn(&mut conn, &overrides, Some("global_epg_link9"))
            .expect("save again");
        assert_eq!(again, 0, "the lock write is idempotent");
    }

    #[test]
    fn non_link_pass_saves_ids_without_locking_anything() {
        let mut conn = overrides_conn();
        let overrides: HashMap<String, String> = [("ch_a", "feed.a"), ("ch_b", "feed.b")]
            .iter()
            .map(|(stream_id, id)| (stream_id.to_string(), id.to_string()))
            .collect();

        let saved = save_epg_channel_overrides_conn(&mut conn, &overrides, None).expect("save");
        assert_eq!(saved, 2);
        assert_eq!(override_row(&conn, "ch_a").1, None, "no feed is locked by this pass");

        // The user later matched ch_a by hand (id) and locked it to another feed.
        conn.execute(
            "UPDATE epg_channel_overrides SET epg_channel_id = 'hand.pick', epg_source_id = 'source_b' WHERE stream_id = 'ch_a'",
            [],
        )
        .expect("update");

        let saved = save_epg_channel_overrides_conn(&mut conn, &overrides, None).expect("save");
        assert_eq!(saved, 0, "an existing override keeps its id");
        assert_eq!(override_row(&conn, "ch_a").0, Some("hand.pick".to_string()));
    }

    #[test]
    fn feed_locked_guides_are_replaced_not_merged() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE programs (
                 id TEXT PRIMARY KEY, stream_id TEXT, title TEXT, subtitle TEXT,
                 description TEXT, start TEXT, end TEXT, source_id TEXT
             );
             CREATE TABLE epg_channel_overrides (
                 stream_id TEXT PRIMARY KEY, epg_channel_id TEXT, epg_source_id TEXT
             );",
        )
        .expect("schema");

        for (id, stream_id) in [
            // The locked channel this pass matched: its stale row (a start the
            // new feed doesn't repeat) must go.
            ("l1a", "ch_locked_matched"),
            ("l1b", "ch_locked_matched"),
            // Locked to the same feed but the feed carries nothing for it — its
            // guide must survive.
            ("l2a", "ch_locked_unmatched"),
            // Ordinary gap-fill channel: this pass is additive for it.
            ("ua", "ch_unlocked"),
            // Locked to a *different* feed: not this feed's to replace.
            ("l3a", "ch_locked_elsewhere"),
        ] {
            conn.execute(
                "INSERT INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
                 VALUES (?1, ?2, 't', '', '', '2998-01-01T00:00:00.000Z', '2999-01-01T01:00:00.000Z', 'source_a')",
                rusqlite::params![id, stream_id],
            )
            .expect("insert program");
        }
        for (stream_id, pin) in [
            ("ch_locked_matched", "global_epg_link9"),
            ("ch_locked_unmatched", "global_epg_link9"),
            ("ch_locked_elsewhere", "system_epg"),
        ] {
            conn.execute(
                "INSERT INTO epg_channel_overrides (stream_id, epg_source_id) VALUES (?1, ?2)",
                rusqlite::params![stream_id, pin],
            )
            .expect("insert override");
        }

        let matched: std::collections::HashSet<String> =
            ["ch_locked_matched".to_string(), "ch_unlocked".to_string()]
                .into_iter()
                .collect();

        let (channels, cleared) =
            replace_locked_guides_conn(&conn, "global_epg_link9", &matched).expect("replace");
        assert_eq!(channels, 1, "only the matched, locked channel is replaced");
        assert_eq!(cleared, 2, "all of that channel's rows, not just overlapping ones");

        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM programs ORDER BY id")
            .expect("select")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .map(|row| row.expect("row"))
            .collect();
        assert_eq!(
            remaining,
            vec!["l2a", "l3a", "ua"],
            "unmatched locked, other-feed locked and unpinned rows all survive"
        );

        // Nothing matched: nothing may be deleted (a feed with no data for the
        // channel must leave its guide alone).
        let (channels, cleared) = replace_locked_guides_conn(
            &conn,
            "global_epg_link9",
            &std::collections::HashSet::new(),
        )
        .expect("replace");
        assert_eq!((channels, cleared), (0, 0));
    }

    #[test]
    fn pin_kept_report_names_only_the_channels_pinned_elsewhere() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE programs (
                 id TEXT PRIMARY KEY, stream_id TEXT, title TEXT, subtitle TEXT,
                 description TEXT, start TEXT, end TEXT, source_id TEXT
             );
             CREATE TABLE channels (stream_id TEXT PRIMARY KEY, name TEXT, source_id TEXT);
             CREATE TABLE epg_channel_overrides (
                 stream_id TEXT PRIMARY KEY, epg_channel_id TEXT, epg_source_id TEXT
             );",
        )
        .expect("schema");

        for (stream_id, name, source_id) in [
            ("ch_link_pinned", "A & E", "source_a"),
            ("ch_self_pinned", "Self", "source_a"),
            ("ch_unpinned", "Plain", "source_a"),
            ("ch_foreign_pinned", "Foreign", "source_b"),
        ] {
            conn.execute(
                "INSERT INTO channels (stream_id, name, source_id) VALUES (?1, ?2, ?3)",
                rusqlite::params![stream_id, name, source_id],
            )
            .expect("insert channel");
        }
        for (id, stream_id, end) in [
            ("k1", "ch_link_pinned", "2026-09-18T00:00:00.000Z"),
            ("k2", "ch_link_pinned", "2026-09-18T03:00:00.000Z"),
            ("k3", "ch_self_pinned", "2026-09-18T01:00:00.000Z"),
            ("k4", "ch_unpinned", "2026-09-18T02:00:00.000Z"),
            ("k5", "ch_foreign_pinned", "2026-09-18T04:00:00.000Z"),
        ] {
            conn.execute(
                "INSERT INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
                 VALUES (?1, ?2, 't', '', '', '2026-09-17T00:00:00.000Z', ?3, (SELECT source_id FROM channels WHERE stream_id = ?2))",
                rusqlite::params![id, stream_id, end],
            )
            .expect("insert program");
        }
        for (stream_id, pin) in [
            ("ch_link_pinned", "source_b"),
            ("ch_self_pinned", "source_a"),
            ("ch_foreign_pinned", "   "),
        ] {
            conn.execute(
                "INSERT INTO epg_channel_overrides (stream_id, epg_channel_id, epg_source_id) VALUES (?1, NULL, ?2)",
                rusqlite::params![stream_id, pin],
            )
            .expect("insert override");
        }

        let kept = pin_kept_programs_conn(&conn, "source_a").expect("report");
        assert_eq!(
            kept.len(),
            1,
            "only channels of this source pinned to a *different* feed are reported"
        );
        let (name, feed, rows, end) = &kept[0];
        assert_eq!(name, "A & E");
        assert_eq!(feed, "source_b");
        assert_eq!(*rows, 2, "the rows left for the pinned channel, not other feeds'");
        assert_eq!(end.as_deref(), Some("2026-09-18T03:00:00.000Z"));

        // A source with no pin of its own reports nothing, even with pins around.
        assert!(pin_kept_programs_conn(&conn, "source_b").expect("report").is_empty());
    }

    #[test]
    fn source_wipe_keeps_channels_pinned_to_another_feed() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE programs (
                 id TEXT PRIMARY KEY, stream_id TEXT, title TEXT, subtitle TEXT,
                 description TEXT, start TEXT, end TEXT, source_id TEXT
             );
             CREATE TABLE epg_channel_overrides (
                 stream_id TEXT PRIMARY KEY, epg_channel_id TEXT, epg_source_id TEXT
             );",
        )
        .expect("schema");

        for (id, stream_id, source_id) in [
            ("p_link", "ch_link_pinned", "source_a"),
            ("p_self", "ch_self_pinned", "source_a"),
            ("p_plain", "ch_unpinned", "source_a"),
            ("p_other", "ch_other_pinned", "source_a"),
            ("p_blank", "ch_blank_pinned", "source_a"),
            ("p_foreign", "ch_link_pinned", "source_b"),
        ] {
            conn.execute(
                // Future ends: this test is about whose rows survive the wipe,
                // not about the expired-row pruning the next test covers.
                "INSERT INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
                 VALUES (?1, ?2, 't', '', '', '2998-01-01T00:00:00.000Z', '2999-01-01T01:00:00.000Z', ?3)",
                rusqlite::params![id, stream_id, source_id],
            )
            .expect("insert program");
        }
        for (stream_id, pin) in [
            ("ch_link_pinned", "global_epg_link9"),
            ("ch_self_pinned", "source_a"),
            ("ch_other_pinned", "source_b"),
            ("ch_blank_pinned", "   "),
        ] {
            conn.execute(
                "INSERT INTO epg_channel_overrides (stream_id, epg_source_id) VALUES (?1, ?2)",
                rusqlite::params![stream_id, pin],
            )
            .expect("insert override");
        }

        let deleted = delete_programs_for_source_conn(&conn, "source_a").expect("wipe");
        // The unpinned row, the one pinned to this very source, and the one whose
        // pin is blank are all this pass's to replace. `p_foreign` belongs to
        // source B and is never in scope.
        assert_eq!(deleted, 3, "only the rows this source owns are wiped");

        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM programs ORDER BY id")
            .expect("select")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .map(|row| row.expect("row"))
            .collect();
        assert_eq!(
            remaining,
            vec!["p_foreign", "p_link", "p_other"],
            "rows for channels pinned to another feed survive, in this source's name too"
        );
    }

    #[test]
    fn the_wipe_still_prunes_expired_rows_of_a_pinned_channel() {
        // Keeping a pinned channel's rows must not turn this wipe into a no-op
        // for that channel: it is the only pruning `programs` gets, so a feed
        // appending a fresh window every sync would otherwise grow it forever.
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE programs (
                 id TEXT PRIMARY KEY, stream_id TEXT, title TEXT, subtitle TEXT,
                 description TEXT, start TEXT, end TEXT, source_id TEXT
             );
             CREATE TABLE epg_channel_overrides (
                 stream_id TEXT PRIMARY KEY, epg_channel_id TEXT, epg_source_id TEXT
             );",
        )
        .expect("schema");
        conn.execute(
            "INSERT INTO epg_channel_overrides (stream_id, epg_source_id) VALUES ('ch', 'global_epg_l1')",
            [],
        )
        .expect("override");

        for (id, start, end) in [
            ("current", "2999-01-01T00:00:00.000Z", "2999-01-01T01:00:00.000Z"),
            ("ended_long_ago", "2000-01-01T00:00:00.000Z", "2000-01-01T01:00:00.000Z"),
            ("no_end", "2000-01-01T00:00:00.000Z", ""),
        ] {
            conn.execute(
                "INSERT INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
                 VALUES (?1, 'ch', 't', '', '', ?2, ?3, 'source_a')",
                rusqlite::params![id, start, end],
            )
            .expect("insert program");
        }
        conn.execute(
            "UPDATE programs SET end = NULL WHERE id = 'no_end'",
            [],
        )
        .expect("null end");

        let deleted = delete_programs_for_source_conn(&conn, "source_a").expect("wipe");
        assert_eq!(deleted, 2, "only the expired rows of the pinned channel go");

        let remaining: Vec<String> = conn
            .prepare("SELECT id FROM programs ORDER BY id")
            .expect("select")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .map(|row| row.expect("row"))
            .collect();
        assert_eq!(remaining, vec!["current"]);
    }

    // ─── Matchable name keys and all display names ──────────────────────────

    /// Run the real single-source streaming parse over an XML string and report
    /// how many programs matched.
    fn run_streaming(xml: &str, mappings: Vec<ChannelMapping>, advanced: bool) -> usize {
        let lookup = build_channel_lookup(mappings);
        let mut matched_programs = 0usize;
        let mut sink = |batch: Vec<EpgProgram>| {
            matched_programs += batch.len();
            true
        };
        let mut progress = |_parsed: usize, _matched: usize| {};
        let (_channels, result) = parse_and_stream_epg_once(
            std::io::Cursor::new(xml.as_bytes().to_vec()),
            lookup,
            advanced,
            0.0,
            &mut sink,
            &mut progress,
        )
        .expect("streaming parse");
        assert_eq!(result.matched_programs, matched_programs);
        result.matched_programs
    }

    /// One channel, one programme, plus a second display name for it.
    fn xml_with_alias(first: &str, alias: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><tv>\
             <channel id=\"CH1\"><display-name>{}</display-name><display-name>{}</display-name></channel>\
             <programme start=\"20260223010000 +0000\" stop=\"20260223020000 +0000\" channel=\"CH1\"><title>T</title></programme>\
             </tv>",
            first, alias
        )
    }

    fn one_mapping(name: &str) -> Vec<ChannelMapping> {
        vec![ChannelMapping {
            epg_channel_id: String::new(),
            stream_id: "s1".into(),
            channel_name: name.into(),
        }]
    }

    #[test]
    fn clean_names_get_a_normalized_key() {
        // "TLC" normalizes to "tlc", which is *not* the raw key stored
        // (casing is preserved for display/verbatim matching), so the key must
        // be inserted. The old guard compared against the lowercased name and
        // silently skipped it, leaving only a case-sensitive key.
        let lookup = build_channel_lookup(one_mapping("TLC"));
        assert!(lookup.contains_key("TLC"), "raw key preserved");
        assert!(lookup.contains_key("tlc"), "normalized key inserted");

        let lookup = build_channel_lookup(one_mapping("Nickelodeon"));
        assert!(lookup.contains_key("Nickelodeon"));
        assert!(lookup.contains_key("nickelodeon"));

        // Already-normalized names must not gain a redundant key either way.
        let lookup = build_channel_lookup(one_mapping("tlc"));
        assert_eq!(lookup.get("tlc").map(|v| v.len()), Some(1));
    }

    #[test]
    fn clean_display_name_matches_different_casing() {
        // Playlist "TLC" vs feed "Tlc": neither the raw key nor the normalized
        // query used to find the other, so these channels got no guide at all.
        assert_eq!(
            run_streaming(&xml_with_alias("Tlc", "Tlc"), one_mapping("TLC"), true),
            1,
            "a case-only difference must still match"
        );
    }

    #[test]
    fn every_display_name_is_matchable_not_just_the_first() {
        // The playlist channel carries the *second* display name; the first
        // ("1 KZN") is not equal to it after normalization, so matching can only
        // come from the alias being indexed.
        let xml = xml_with_alias("1 KZN", "SA One KZN");
        assert_eq!(
            run_streaming(&xml, one_mapping("SA One KZN"), true),
            1,
            "aliases must be matchable"
        );
        assert_ne!(
            normalize_channel_name("SA One KZN"),
            normalize_channel_name("1 KZN"),
            "the alias is genuinely a different name"
        );
    }

    #[test]
    fn display_name_merge_is_skipped_without_advanced_matching() {
        let xml = xml_with_alias("1 KZN", "SA One KZN");
        assert_eq!(
            run_streaming(&xml, one_mapping("SA One KZN"), false),
            0,
            "advanced matching off: no display-name merge, so no alias match"
        );
    }
}
