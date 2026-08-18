//! Streaming EPG Parser
//!
//! This module provides high-performance streaming XMLTV parsing that:
//! - Downloads and parses XML simultaneously (streaming)
//! - Inserts programs in batches as they're parsed (pipelined)
//! - Sends progress updates to the frontend
//! - Handles large EPG files (>50MB) efficiently
//! - Uses minimal memory (doesn't load entire XML into RAM)
//! - Optimized for modern multi-core hardware
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

/// Retry an async database operation with exponential backoff when "database is locked" occurs.
async fn with_async_db_retry<F, Fut, T>(mut operation: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let max_retries = 5;
    let mut last_error = None;

    for attempt in 1..=max_retries {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                let err_str = e.to_string().to_lowercase();
                if err_str.contains("database is locked") || err_str.contains("busy") {
                    if attempt < max_retries {
                        let delay_ms = 100 * attempt as u64;
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
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

/// Retry a sync database operation with exponential backoff when "database is locked" occurs.
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

/// Build a channel lookup map that supports multiple stream_ids per epg_channel_id
/// This allows primary + backup streams to all get the same EPG data
fn build_channel_lookup(mappings: Vec<ChannelMapping>) -> HashMap<String, Vec<String>> {
    let mut lookup: HashMap<String, Vec<String>> = HashMap::new();

    for mapping in mappings {
        let stream_id = mapping.stream_id;

        if !mapping.epg_channel_id.is_empty() {
            lookup
                .entry(mapping.epg_channel_id.trim().to_string())
                .or_default()
                .push(stream_id.clone());
        }

        // Also add name-based lookup for fallback
        if !mapping.channel_name.is_empty() {
            let name = mapping.channel_name.trim().to_string();
            lookup
                .entry(name.clone())
                .or_default()
                .push(stream_id.clone());

            // Also add normalized version for fuzzy matching
            let normalized = normalize_channel_name(&name);
            if normalized != name.to_lowercase() && !normalized.is_empty() {
                lookup
                    .entry(normalized)
                    .or_default()
                    .push(stream_id.clone());
            }
        }
    }

    lookup
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

    channel_lookup
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
        .connect_timeout(std::time::Duration::from_secs(30))
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
    )
    .await;

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
    let parse_start = std::time::Instant::now();
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

    // Wait for parser to complete
    let parser_result = parser_task.await
        .context("Parser task panicked")?
        .context("Parser task failed")?;

    let parse_duration_ms = parse_start.elapsed().as_millis() as u64;
    let duration_ms = start_time.elapsed().as_millis() as u64;

    info!(
        "[EPG Timing] Parse+Download: {}ms, Total: {}ms, DB Insert: {} programs",
        parse_duration_ms, duration_ms, inserter_result.inserted
    );

    info!(
        "Streaming EPG parse complete for {}: {} programs, {} matched, {} inserted in {}ms",
        src_ctx,
        parser_result.total_programs,
        parser_result.matched_programs,
        inserter_result.inserted,
        duration_ms
    );

    Ok(EpgParseResult {
        source_id,
        total_programs: parser_result.total_programs,
        matched_programs: parser_result.matched_programs,
        inserted_programs: inserter_result.inserted,
        unmatched_channels: parser_result.unmatched_channels,
        matched_channels: parser_result.matched_channels,
        duration_ms,
        bytes_processed: parser_result.bytes_processed,
    })
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
    source_configs: Vec<SourceEpgConfig>,
    user_agent: Option<String>,
) -> Result<Vec<EpgParseResult>> {
    let start_time = std::time::Instant::now();
    let source_count = source_configs.len();

    if source_configs.is_empty() {
        return Ok(Vec::new());
    }

    info!(
        "Starting multi-source EPG parse for {} source(s) from {}",
        source_count, epg_url
    );

    // Determine if any source needs advanced matching (build display mapping once if so)
    let _any_advanced = source_configs.iter().any(|c| c.advanced_epg_matching);

    // Check if URL is gzipped
    let is_gzipped = epg_url.ends_with(".gz");

    // Create HTTP client
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

    let is_response_gzipped = response.headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_lowercase().contains("gzip"))
        .unwrap_or(false);
    let should_decompress = is_gzipped || is_response_gzipped;

    // Download chunks into memory
    let mut chunks: Vec<bytes::Bytes> = Vec::new();
    let mut total_bytes_downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                total_bytes_downloaded += chunk.len() as u64;
                chunks.push(chunk);
            }
            Err(e) => {
                warn!("Download error: {}", e);
                return Err(anyhow::anyhow!("Download interrupted: {}", e));
            }
        }
    }

    if let Some(expected) = total_bytes {
        if total_bytes_downloaded < expected {
            return Err(anyhow::anyhow!(
                "Incomplete EPG download: expected {} bytes but got {}",
                expected, total_bytes_downloaded
            ));
        }
    }

    info!("[EPG] EPG Download verified successful.");

    // Combine chunks
    let total_size = chunks.iter().map(|c| c.len()).sum::<usize>();
    let mut compressed_data = Vec::with_capacity(total_size);
    for chunk in chunks {
        compressed_data.extend_from_slice(&chunk);
    }

    let has_gzip_magic = compressed_data.len() >= 2
        && compressed_data[0] == 0x1f && compressed_data[1] == 0x8b;
    let should_decompress = should_decompress || has_gzip_magic;

    // Decompress
    let xml_data: Vec<u8> = if should_decompress {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut decoder = GzDecoder::new(&compressed_data[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)
            .context("Failed to decompress gzipped EPG")?;
        info!("[EPG] Decompressed {} bytes to {} bytes", compressed_data.len(), decompressed.len());
        decompressed
    } else {
        compressed_data
    };

    // Extract EPG channel metadata once, insert for all sources
    let epg_channels = extract_epg_channels(&xml_data);

    // Guard against applying an empty/garbage response (e.g. an HTTP error page
    // served with status 200) which would otherwise wipe per-source epg_channels
    // and report a bogus success. Keep existing EPG data intact instead.
    let has_programmes = xml_data
        .windows(b"<programme".len())
        .any(|w| w == b"<programme");
    if epg_channels.is_empty() && !has_programmes {
        return Err(anyhow::anyhow!(
            "EPG response from {} contained no channels or programmes; keeping existing EPG data",
            epg_url
        ));
    }

    for config in &source_configs {
        if let Err(e) = insert_epg_channels(db, &config.source_id, &epg_channels) {
            warn!("[EPG] Failed to insert epg_channels for source {}: {}", config.source_id, e);
        }
    }

    // Delete old programs for sources that request it (after verified download)
    for config in &source_configs {
        if config.clear_existing {
            let deleted = delete_programs_for_source(db, &config.source_id)?;
            info!("[EPG] Deleted {} old programs for source {}", deleted, config.source_id);
        }
    }

    // Build master channel lookup: epg_channel_id -> Vec<(source_id, stream_id)>
    let mut master_lookup: HashMap<String, Vec<(String, String)>> = HashMap::new();

    for config in &source_configs {
        let mut source_lookup = build_channel_lookup(config.channel_mappings.clone());

        // If advanced matching enabled for this source, merge display names
        if config.advanced_epg_matching {
            let display_mapping = build_display_name_mapping(&xml_data);
            source_lookup = merge_with_display_names(source_lookup, &display_mapping);
        }

        for (epg_id, stream_ids) in source_lookup {
            let entry = master_lookup.entry(epg_id).or_default();
            for stream_id in stream_ids {
                entry.push((config.source_id.clone(), stream_id));
            }
        }
    }

    info!("[EPG] Master lookup has {} entries for {} sources", master_lookup.len(), source_count);

    // Create per-source batch channels and inserter tasks
    let mut batch_senders: HashMap<String, mpsc::Sender<Vec<EpgProgram>>> = HashMap::new();
    let mut inserter_handles: Vec<tokio::task::JoinHandle<InserterResult>> = Vec::new();

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

    // Parse once, route programmes to per-source batches
    let parse_result = parse_and_stream_batches_multi(
        &xml_data,
        master_lookup,
        batch_senders,
        app_handle.clone(),
        total_bytes,
        total_bytes_downloaded,
        start_time,
    ).await?;

    // Wait for all inserters to finish
    let mut per_source_inserted: HashMap<String, usize> = HashMap::new();
    for (i, handle) in inserter_handles.into_iter().enumerate() {
        let sid = source_configs[i].source_id.clone();
        match handle.await {
            Ok(result) => {
                per_source_inserted.insert(sid, result.inserted);
            }
            Err(e) => {
                warn!("[EPG] Inserter task panicked for source {}: {}", sid, e);
                per_source_inserted.insert(sid, 0);
            }
        }
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    // Build per-source results
    let mut results = Vec::with_capacity(source_configs.len());
    for config in &source_configs {
        let sid = &config.source_id;
        let stats = parse_result.source_stats.get(sid);
        let inserted = per_source_inserted.get(sid).copied().unwrap_or(0);

        let matched = stats.map(|s| s.matched_programs).unwrap_or(0);
        let unmatched = stats.map(|s| s.unmatched_channels.len()).unwrap_or(0);
        let matched_ch = stats.map(|s| s.matched_channels.len()).unwrap_or(0);

        info!(
            "[EPG] Multi-source result for {}: {} matched, {} inserted, {} unmatched channels, {} matched channels",
            sid, matched, inserted, unmatched, matched_ch
        );

        results.push(EpgParseResult {
            source_id: sid.clone(),
            total_programs: parse_result.total_programs,
            matched_programs: matched,
            inserted_programs: inserted,
            unmatched_channels: unmatched,
            matched_channels: matched_ch,
            duration_ms,
            bytes_processed: parse_result.bytes_processed,
        });
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
    let is_response_gzipped = response.headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_lowercase().contains("gzip"))
        .unwrap_or(false);
    let should_decompress = is_gzipped || is_response_gzipped;

    // Download chunks into a buffer
    let mut chunks: Vec<bytes::Bytes> = Vec::new();
    let mut total_bytes_downloaded: u64 = 0;

    // Convert response to byte stream and collect chunks
    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                total_bytes_downloaded += chunk.len() as u64;
                chunks.push(chunk);
            }
            Err(e) => {
                warn!("Download error: {}", e);
                return Err(anyhow::anyhow!("Download interrupted by network error: {}", e));
            }
        }
    }

    // Verify download completeness
    if let Some(expected_len) = total_bytes {
        if total_bytes_downloaded < expected_len {
            return Err(anyhow::anyhow!(
                "Incomplete EPG download: expected {} bytes but got {}",
                expected_len, total_bytes_downloaded
            ));
        }
    }

    // Defer SQLite deletion until we know the EPG was completely downloaded into memory!
    info!("[EPG] EPG Download verified successful.");
    if clear_existing {
        info!("[EPG] Safe to delete old programs!");
        info!("[EPG] Deleting old programs for source {}", src_ctx);
        let deleted_count = delete_programs_for_source(&db, &source_id)?;
        info!("[EPG] Deleted {} old programs for source {}", deleted_count, src_ctx);
    } else {
        info!("[EPG] Skipping deletion of old programs because clear_existing is false");
    }

    let download_ms = start_time.elapsed().as_millis() as u64;

    info!(
        "[EPG] Downloaded {} bytes in {} chunks in {}ms (gzipped: {})",
        total_bytes_downloaded,
        chunks.len(),
        download_ms,
        should_decompress
    );

    // Combine chunks for parsing (pre-allocate for speed)
    let combine_start = std::time::Instant::now();
    let total_size = chunks.iter().map(|c| c.len()).sum::<usize>();
    let mut compressed_data = Vec::with_capacity(total_size);
    for chunk in chunks {
        compressed_data.extend_from_slice(&chunk);
    }

    // Log first few bytes for debugging
    if compressed_data.len() >= 4 {
        info!("[EPG] First 4 bytes: {:02x} {:02x} {:02x} {:02x}",
            compressed_data[0], compressed_data[1], compressed_data[2], compressed_data[3]);
    }

    // Check for gzip magic bytes (1f 8b) as fallback detection
    let has_gzip_magic = compressed_data.len() >= 2 && compressed_data[0] == 0x1f && compressed_data[1] == 0x8b;
    if !should_decompress && has_gzip_magic {
        info!("[EPG] Detected gzip magic bytes, will decompress");
    }
    let should_decompress = should_decompress || has_gzip_magic;

    // Decompress if gzipped (either by URL extension, Content-Encoding header, or magic bytes)
    let xml_data: Vec<u8> = if should_decompress {
        use flate2::read::GzDecoder;
        use std::io::Read;

        let mut decoder = GzDecoder::new(&compressed_data[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)
            .context("Failed to decompress gzipped EPG")?;
        info!("[EPG] Decompressed {} bytes to {} bytes", compressed_data.len(), decompressed.len());
        decompressed
    } else {
        compressed_data
    };

    let combine_ms = combine_start.elapsed().as_millis() as u64;

    // Extract and persist EPG channel metadata (id, display_name, icon) for the editor
    let epg_channels = extract_epg_channels(&xml_data);
    if let Err(e) = insert_epg_channels(&db, &source_id, &epg_channels) {
        warn!("[EPG] Failed to insert epg_channels for source {}: {}", source_id, e);
    }

    // Parse and stream batches
    let parse_result = parse_and_stream_batches(
        &xml_data,
        channel_lookup,
        batch_tx,
        app_handle,
        source_id,
        total_bytes,
        total_bytes_downloaded,
        start_time,
        advanced_epg_matching,
        timeshift_hours,
    ).await?;

    let total_ms = start_time.elapsed().as_millis() as u64;
    info!(
        "[EPG Timing] Download: {}ms, Combine: {}ms, Parse+Insert: {}ms, Total: {}ms",
        download_ms, combine_ms, total_ms - download_ms - combine_ms, total_ms
    );

    Ok(parse_result)
}

/// Build a mapping from display names to channel IDs by parsing <channel> elements
/// This allows matching M3U channel names like "US: BET" to EPG channel id "bet.us"
fn build_display_name_mapping(xml_data: &[u8]) -> HashMap<String, String> {
    let mut mapping: HashMap<String, String> = HashMap::new();
    let mut reader = Reader::from_reader(xml_data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_channel_id: Option<String> = None;
    let mut current_element: Option<String> = None;
    let mut current_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = std::str::from_utf8(e.name().as_ref()).unwrap_or("").to_string();
                match name.as_str() {
                    "channel" => {
                        // Parse channel id attribute
                        for attr in e.attributes() {
                            if let Ok(attr) = attr {
                                let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                                if key == "id" {
                                    let value = attr
                                        .decode_and_unescape_value(reader.decoder())
                                        .unwrap_or_default();
                                    current_channel_id = Some(value.to_string());
                                    break;
                                }
                            }
                        }
                    }
                    "display-name" => {
                        current_element = Some(name);
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
                let name = std::str::from_utf8(e.name().as_ref()).unwrap_or("").to_string();
                match name.as_str() {
                    "channel" => {
                        current_channel_id = None;
                    }
                    "display-name" => {
                        if let Some(ref channel_id) = current_channel_id {
                            let display_name = current_text.trim().to_string();
                            if !display_name.is_empty() {
                                // Add mapping from display name to channel ID
                                mapping.insert(display_name.clone(), channel_id.clone());
                                // Also add normalized version
                                let normalized = normalize_channel_name(&display_name);
                                if !normalized.is_empty() && normalized != display_name.to_lowercase() {
                                    mapping.insert(normalized, channel_id.clone());
                                }
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

/// Extract all <channel> elements from XMLTV data.
/// Collects id, first <display-name>, and first <icon src="..."> for each channel.
fn extract_epg_channels(xml_data: &[u8]) -> Vec<EpgChannelInfo> {
    let mut channels: Vec<EpgChannelInfo> = Vec::new();
    let mut reader = Reader::from_reader(xml_data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_channel_id: Option<String> = None;
    let mut current_display_name: Option<String> = None;
    let mut current_icon_url: Option<String> = None;
    let mut current_element: Option<String> = None;
    let mut current_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = std::str::from_utf8(e.name().as_ref()).unwrap_or("").to_string();
                match name.as_str() {
                    "channel" => {
                        current_channel_id = None;
                        current_display_name = None;
                        current_icon_url = None;
                        for attr in e.attributes() {
                            if let Ok(attr) = attr {
                                let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                                if key == "id" {
                                    let value = attr
                                        .decode_and_unescape_value(reader.decoder())
                                        .unwrap_or_default();
                                    current_channel_id = Some(value.to_string());
                                    break;
                                }
                            }
                        }
                    }
                    "display-name" | "icon" => {
                        current_element = Some(name.clone());
                        current_text.clear();

                        // For <icon>, also try to read src attribute immediately
                        if name == "icon" {
                            for attr in e.attributes() {
                                if let Ok(attr) = attr {
                                    let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                                    if key == "src" {
                                        let value = attr
                                            .decode_and_unescape_value(reader.decoder())
                                            .unwrap_or_default();
                                        current_icon_url = Some(value.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if current_element.as_deref() == Some("display-name") {
                    if let Ok(text) = e.unescape() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = std::str::from_utf8(e.name().as_ref()).unwrap_or("").to_string();
                match name.as_str() {
                    "channel" => {
                        if let (Some(id), Some(display_name)) = (current_channel_id.take(), current_display_name.take()) {
                            channels.push(EpgChannelInfo {
                                id,
                                display_name,
                                icon_url: current_icon_url.take(),
                            });
                        }
                    }
                    "display-name" => {
                        let text = current_text.trim().to_string();
                        if !text.is_empty() && current_display_name.is_none() {
                            // Keep only the first display-name per channel
                            current_display_name = Some(text);
                        }
                        current_element = None;
                    }
                    "icon" => {
                        current_element = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                // Handle self-closing <icon src="..."/>
                let name = std::str::from_utf8(e.name().as_ref()).unwrap_or("").to_string();
                if name == "icon" && current_channel_id.is_some() && current_icon_url.is_none() {
                    for attr in e.attributes() {
                        if let Ok(attr) = attr {
                            let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                            if key == "src" {
                                let value = attr
                                    .decode_and_unescape_value(reader.decoder())
                                    .unwrap_or_default();
                                current_icon_url = Some(value.to_string());
                                break;
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parse error during EPG channel extraction: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    info!("[EPG] Extracted {} channels from XMLTV", channels.len());
    channels
}

/// Bulk insert/replace EPG channels into the epg_channels table
fn insert_epg_channels(db: &DvrDatabase, source_id: &str, channels: &[EpgChannelInfo]) -> Result<usize> {
    with_sync_db_retry(|| {
        let mut conn = db.get_conn()?;
        let tx = conn.transaction()?;

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

/// Parse XML and stream batches to inserter
async fn parse_and_stream_batches<R: tauri::Runtime>(
    xml_data: &[u8],
    channel_lookup: HashMap<String, Vec<String>>,
    batch_tx: mpsc::Sender<Vec<EpgProgram>>,
    app_handle: tauri::AppHandle<R>,
    source_id: String,
    total_bytes: Option<u64>,
    bytes_downloaded: u64,
    start_time: std::time::Instant,
    advanced_epg_matching: bool,
    timeshift_hours: f64,
) -> Result<StreamingParserResult> {
    // Pre-compute offset in whole seconds so we avoid repeated float math in the hot loop
    let _timeshift_secs = (timeshift_hours * 3600.0).round() as i64;
    // Conditionally build display name mapping for advanced EPG matching
    let channel_lookup = if advanced_epg_matching {
        info!("[EPG] Advanced EPG matching enabled - building display name mappings");
        let display_name_mapping = build_display_name_mapping(xml_data);
        merge_with_display_names(channel_lookup, &display_name_mapping)
    } else {
        info!("[EPG] Using standard EPG matching (advanced matching disabled)");
        channel_lookup
    };

    let mut reader = Reader::from_reader(xml_data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_program: Option<EpgProgram> = None;
    let mut current_element: Option<String> = None;
    let mut current_text = String::new();

    let mut total_programs = 0usize;
    let mut matched_programs = 0usize;
    let mut unmatched_channels: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut matched_channels_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    let mut last_progress_update = std::time::Instant::now();

    // Emit parsing progress
    emit_progress(
        &app_handle,
        &source_id,
        EpgParseProgress {
            source_id: source_id.to_string(),
            phase: "parsing".to_string(),
            bytes_downloaded,
            total_bytes,
            programs_parsed: 0,
            programs_matched: 0,
            programs_inserted: 0,
            estimated_remaining_seconds: None,
        },
    )
    .await;

    // Parse XML events
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = std::str::from_utf8(e.name().as_ref())
                    .unwrap_or("")
                    .to_string();

                match name.as_str() {
                    "programme" => {
                        let mut program = EpgProgram::default();

                        // Parse attributes
                        for attr in e.attributes() {
                            if let Ok(attr) = attr {
                                let key = std::str::from_utf8(attr.key.as_ref())
                                    .unwrap_or("");
                                let value = attr
                                    .decode_and_unescape_value(reader.decoder())
                                    .unwrap_or_default();

                                match key {
                                    "channel" => program.channel_id = value.to_string(),
                                    "start" => program.start = parse_xmltv_date(&value),
                                    "stop" => program.stop = parse_xmltv_date(&value),
                                    _ => {}
                                }
                            }
                        }

                        current_program = Some(program);
                    }
                    "title" | "desc" | "sub-title" => {
                        current_element = Some(name);
                        current_text.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(ref _element) = current_element {
                    if let Ok(text) = e.unescape() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = std::str::from_utf8(e.name().as_ref())
                    .unwrap_or("")
                    .to_string();

                match name.as_str() {
                    "programme" => {
                        if let Some(program) = current_program.take() {
                            total_programs += 1;

                            // Check if channel is in our merged lookup (fast O(1) lookup)
                            // The lookup now contains mappings from:
                            // - EPG channel IDs (e.g., "bet.us")
                            // - M3U channel names (e.g., "US: BET ᴿᴬᵂ")
                            // - Normalized versions of both
                            let stream_ids = channel_lookup.get(&program.channel_id)
                                .or_else(|| channel_lookup.get(&normalize_channel_name(&program.channel_id)));

                            if let Some(stream_ids) = stream_ids {
                                matched_programs += 1;  // Count the program once, not per stream_id

                                // Add a copy of the program for each matching stream_id
                                // This allows primary + backup streams to all get EPG data
                                for stream_id in stream_ids {
                                    matched_channels_set.insert(stream_id.clone());
                                    let mut program_copy = program.clone();
                                    program_copy.channel_id = stream_id.clone();
                                    // Normalize timestamps to UTC for storage
                                    // Timeshift is applied in SQL (programs_effective view) for immediate per-channel updates
                                    program_copy.start = normalize_to_utc(&program_copy.start);
                                    program_copy.stop = normalize_to_utc(&program_copy.stop);
                                    batch.push(program_copy);

                                    // Send batch when full
                                    if batch.len() >= BATCH_SIZE {
                                        let batch_to_send = std::mem::take(&mut batch);
                                        batch.reserve(BATCH_SIZE);

                                        if batch_tx.send(batch_to_send).await.is_err() {
                                            warn!("Batch channel closed, stopping parser");
                                            break;
                                        }
                                    }
                                }
                            } else {
                                unmatched_channels.insert(program.channel_id);
                            }

                            // Progress updates
                            if total_programs % (BATCH_SIZE * PROGRESS_INTERVAL) == 0 {
                                if last_progress_update.elapsed().as_millis() > 100 {
                                    emit_progress(
                                        &app_handle,
                                        &source_id,
                                        EpgParseProgress {
                                            source_id: source_id.to_string(),
                                            phase: "parsing".to_string(),
                                            bytes_downloaded,
                                            total_bytes,
                                            programs_parsed: total_programs,
                                            programs_matched: matched_programs,
                                            programs_inserted: 0,
                                            estimated_remaining_seconds: estimate_remaining(
                                                bytes_downloaded,
                                                total_bytes,
                                                start_time.elapsed().as_secs(),
                                            ),
                                        },
                                    )
                                    .await;
                                    last_progress_update = std::time::Instant::now();
                                }
                            }
                        }
                    }
                    "title" => {
                        if let Some(ref mut program) = current_program {
                            program.title = current_text.clone();
                        }
                        current_element = None;
                    }
                    "desc" => {
                        if let Some(ref mut program) = current_program {
                            program.description = Some(current_text.clone());
                        }
                        current_element = None;
                    }
                    "sub-title" => {
                        if let Some(ref mut program) = current_program {
                            program.sub_title = Some(current_text.clone());
                        }
                        current_element = None;
                    }
                    _ => {}
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
        let _ = batch_tx.send(batch).await;
    }

    // Drop sender to signal completion
    drop(batch_tx);

    info!(
        "[EPG] Parser finished: {} programs, {} matched, {} unmatched channels, {} matched channels",
        total_programs,
        matched_programs,
        unmatched_channels.len(),
        matched_channels_set.len()
    );

    Ok(StreamingParserResult {
        total_programs,
        matched_programs,
        unmatched_channels: unmatched_channels.len(),
        matched_channels: matched_channels_set.len(),
        bytes_processed: bytes_downloaded,
    })
}

/// Parse XMLTV and route matched programmes to per-source batch channels.
/// A single download is shared across all sources — each source only gets
/// programmes for channels in its own channel mapping (waterfill behaviour).
async fn parse_and_stream_batches_multi<R: tauri::Runtime>(
    xml_data: &[u8],
    master_lookup: HashMap<String, Vec<(String, String)>>,
    mut batch_senders: HashMap<String, mpsc::Sender<Vec<EpgProgram>>>,
    app_handle: tauri::AppHandle<R>,
    total_bytes: Option<u64>,
    bytes_downloaded: u64,
    start_time: std::time::Instant,
) -> Result<MultiSourceParserResult> {
    let mut reader = Reader::from_reader(xml_data);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_program: Option<EpgProgram> = None;
    let mut current_element: Option<String> = None;
    let mut current_text = String::new();

    let mut total_programs = 0usize;
    let mut global_matched = 0usize;
    let mut last_progress_update = std::time::Instant::now();

    // Per-source batch buffers and stats
    let mut batch_buffers: HashMap<String, Vec<EpgProgram>> = HashMap::new();
    let mut source_stats: HashMap<String, SourceParseStats> = HashMap::new();

    for sid in batch_senders.keys() {
        batch_buffers.insert(sid.clone(), Vec::with_capacity(BATCH_SIZE));
        source_stats.insert(sid.clone(), SourceParseStats {
            matched_programs: 0,
            unmatched_channels: std::collections::HashSet::new(),
            matched_channels: std::collections::HashSet::new(),
        });
    }

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = std::str::from_utf8(e.name().as_ref()).unwrap_or("").to_string();
                match name.as_str() {
                    "programme" => {
                        let mut program = EpgProgram::default();
                        for attr in e.attributes() {
                            if let Ok(attr) = attr {
                                let key = std::str::from_utf8(attr.key.as_ref()).unwrap_or("");
                                let value = attr.decode_and_unescape_value(reader.decoder()).unwrap_or_default();
                                match key {
                                    "channel" => program.channel_id = value.to_string(),
                                    "start" => program.start = parse_xmltv_date(&value),
                                    "stop" => program.stop = parse_xmltv_date(&value),
                                    _ => {}
                                }
                            }
                        }
                        current_program = Some(program);
                    }
                    "title" | "desc" | "sub-title" => {
                        current_element = Some(name);
                        current_text.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(ref _element) = current_element {
                    if let Ok(text) = e.unescape() {
                        current_text.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = std::str::from_utf8(e.name().as_ref()).unwrap_or("").to_string();
                match name.as_str() {
                    "programme" => {
                        if let Some(program) = current_program.take() {
                            total_programs += 1;

                            let pairs = master_lookup.get(&program.channel_id)
                                .or_else(|| master_lookup.get(&normalize_channel_name(&program.channel_id)));

                            if let Some(pairs) = pairs {
                                global_matched += 1;

                                for (source_id, stream_id) in pairs {
                                    let mut copy = program.clone();
                                    copy.channel_id = stream_id.clone();
                                    copy.start = normalize_to_utc(&copy.start);
                                    copy.stop = normalize_to_utc(&copy.stop);

                                    let buffer = batch_buffers.get_mut(source_id).unwrap();
                                    buffer.push(copy);

                                    if buffer.len() >= BATCH_SIZE {
                                        let batch_to_send = std::mem::take(buffer);
                                        buffer.reserve(BATCH_SIZE);
                                        if let Some(sender) = batch_senders.get(source_id) {
                                            if sender.send(batch_to_send).await.is_err() {
                                                warn!("Batch channel closed for source {}, stopping parser", source_id);
                                            }
                                        }
                                    }

                                    // Update per-source stats
                                    if let Some(stats) = source_stats.get_mut(source_id) {
                                        stats.matched_programs += 1;
                                        stats.matched_channels.insert(stream_id.clone());
                                    }
                                }
                            } else {
                                // Track unmatched per source... but we don't know which source
                                // expected this channel. Skip for now.
                            }

                            // Progress update
                            if total_programs % (BATCH_SIZE * PROGRESS_INTERVAL) == 0 {
                                if last_progress_update.elapsed().as_millis() > 100 {
                                    emit_progress(
                                        &app_handle,
                                        "multi",
                                        EpgParseProgress {
                                            source_id: "multi".to_string(),
                                            phase: "parsing".to_string(),
                                            bytes_downloaded,
                                            total_bytes,
                                            programs_parsed: total_programs,
                                            programs_matched: global_matched,
                                            programs_inserted: 0,
                                            estimated_remaining_seconds: estimate_remaining(
                                                bytes_downloaded, total_bytes,
                                                start_time.elapsed().as_secs(),
                                            ),
                                        },
                                    ).await;
                                    last_progress_update = std::time::Instant::now();
                                }
                            }
                        }
                    }
                    "title" => {
                        if let Some(ref mut program) = current_program {
                            program.title = current_text.clone();
                        }
                        current_element = None;
                    }
                    "desc" => {
                        if let Some(ref mut program) = current_program {
                            program.description = Some(current_text.clone());
                        }
                        current_element = None;
                    }
                    "sub-title" => {
                        if let Some(ref mut program) = current_program {
                            program.sub_title = Some(current_text.clone());
                        }
                        current_element = None;
                    }
                    _ => {}
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

    // Send remaining batches for all sources and drop senders to signal completion
    for (source_id, buffer) in batch_buffers {
        if !buffer.is_empty() {
            if let Some(sender) = batch_senders.remove(&source_id) {
                let _ = sender.send(buffer).await;
            }
        } else if let Some(sender) = batch_senders.remove(&source_id) {
            drop(sender);
        }
    }

    info!(
        "[EPG] Multi-source parser finished: {} programs, {} total matched",
        total_programs, global_matched
    );

    Ok(MultiSourceParserResult {
        total_programs,
        bytes_processed: bytes_downloaded,
        source_stats,
    })
}

/// Inserter pipeline - receives batches and inserts them concurrently
struct InserterResult {
    inserted: usize,
}

async fn insert_batches_pipeline<R: tauri::Runtime>(
    db: &DvrDatabase,
    mut batch_rx: mpsc::Receiver<Vec<EpgProgram>>,
    source_id: &str,
    app_handle: tauri::AppHandle<R>,
    total_bytes: Option<u64>,
    start_time: std::time::Instant,
) -> InserterResult {
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
    )
    .await;

    // Process batches as they arrive
    while let Some(batch) = batch_rx.recv().await {
        batch_count += 1;

        match insert_programs_batch(db, source_id, &batch).await {
            Ok(inserted) => {
                total_inserted += inserted;

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
                    )
                    .await;
                }
            }
            Err(e) => {
                warn!("Failed to insert batch: {}", e);
            }
        }
    }

    info!("[EPG] Inserter finished: {} batches, {} programs inserted", batch_count, total_inserted);

    InserterResult {
        inserted: total_inserted,
    }
}

/// Delete all programs for a source (called before inserting new programs)
fn delete_programs_for_source(db: &DvrDatabase, source_id: &str) -> Result<usize> {
    with_sync_db_retry(|| {
        let conn = db.get_conn()?;
        let deleted = conn.execute(
            "DELETE FROM programs WHERE source_id = ?1",
            rusqlite::params![source_id],
        )?;
        Ok(deleted)
    })
}

/// Insert a batch of programs into database
async fn insert_programs_batch(
    db: &DvrDatabase,
    source_id: &str,
    programs: &[EpgProgram],
) -> Result<usize> {
    with_async_db_retry(|| async move {
        insert_programs_batch_inner(db, source_id, programs).await
    }).await
}

async fn insert_programs_batch_inner(
    db: &DvrDatabase,
    source_id: &str,
    programs: &[EpgProgram],
) -> Result<usize> {
    use rusqlite::params;

    let mut conn = db.get_conn()?;
    let tx = conn.transaction()?;

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
                // Silently ignore duplicates - they happen when multiple channels share tvg-id
                // and have the same program at the same time
                if !e.to_string().contains("UNIQUE constraint failed") {
                    warn!("Failed to insert program for stream {}: {}", stream_id, e);
                }
            }
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    Ok(inserted)
}

/// Emit progress event to frontend
async fn emit_progress<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    _source_id: &str,
    progress: EpgParseProgress,
) {
    let _ = app_handle.emit("epg:parse_progress", progress);
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
    use tokio::fs::File;
    use tokio::io::AsyncReadExt;

    info!("Parsing local EPG file with streaming: {}, clear_existing: {}", file_path, clear_existing);
    let start_time = std::time::Instant::now();

    // Read file
    let mut file = File::open(&file_path).await
        .context("Failed to open EPG file")?;

    // Get file size for progress
    let metadata = file.metadata().await?;
    let total_bytes = metadata.len();

    // Read entire file into memory (for local files this is acceptable)
    let mut xml_data = Vec::with_capacity(total_bytes as usize);
    file.read_to_end(&mut xml_data).await
        .context("Failed to read EPG file")?;

    // Build channel lookup map (supports multiple stream_ids per epg_channel_id)
    let channel_lookup = build_channel_lookup(channel_mappings);

    // Delete old programs first if requested
    if clear_existing {
        let deleted_count = delete_programs_for_source(db, &source_id)?;
        info!("[EPG] Deleted {} old programs for source {}", deleted_count, source_id);
    } else {
        info!("[EPG] Skipping deletion of old programs because clear_existing is false");
    }

    // Extract and persist EPG channel metadata (id, display_name, icon) for the editor
    let epg_channels = extract_epg_channels(&xml_data);
    if let Err(e) = insert_epg_channels(db, &source_id, &epg_channels) {
        warn!("[EPG] Failed to insert epg_channels for source {}: {}", source_id, e);
    }

    // Create channel for parse->insert pipeline
    let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);

    // Clone for parser
    let channel_lookup_clone = channel_lookup.clone();
    let source_id_clone = source_id.clone();
    let app_handle_clone = app_handle.clone();

    // Spawn parser task
    let parser_task = tokio::spawn(async move {
        parse_and_stream_batches(
            &xml_data,
            channel_lookup_clone,
            batch_tx,
            app_handle_clone,
            source_id_clone,
            Some(total_bytes),
            total_bytes,
            start_time,
            advanced_epg_matching,
            timeshift_hours,
        ).await
    });

    // Run inserter concurrently
    let inserter_result = insert_batches_pipeline(
        db,
        batch_rx,
        &source_id,
        app_handle.clone(),
        Some(total_bytes),
        start_time,
    ).await;

    // Wait for parser
    let parser_result = parser_task.await
        .context("Parser task panicked")??;

    let duration_ms = start_time.elapsed().as_millis() as u64;

    Ok(EpgParseResult {
        source_id,
        total_programs: parser_result.total_programs,
        matched_programs: parser_result.matched_programs,
        inserted_programs: inserter_result.inserted,
        unmatched_channels: parser_result.unmatched_channels,
        matched_channels: parser_result.matched_channels,
        duration_ms,
        bytes_processed: total_bytes,
    })
}

/// Sync and save all EPG channels and programs to a separate database cache file
pub async fn cache_entire_epg_db<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    epg_url: String,
    epg_link_id: String,
    user_agent: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = app_dir.join(format!("epg_cache_{}.db", epg_link_id));
    
    info!("[EPG Cache] Downloading and caching entire EPG from {} to {:?}", epg_url, db_path);

    // 1. Download EPG XML data
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
    let is_response_gzipped = response.headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_lowercase().contains("gzip"))
        .unwrap_or(false);
    let should_decompress = epg_url.ends_with(".gz") || is_response_gzipped;

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let data = bytes.to_vec();

    let has_gzip_magic = data.len() >= 2 && data[0] == 0x1f && data[1] == 0x8b;
    let should_decompress = should_decompress || has_gzip_magic;

    let xml_data = if should_decompress {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut decoder = GzDecoder::new(&data[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed)
            .map_err(|e| format!("Failed to decompress gzipped EPG: {}", e))?;
        decompressed
    } else {
        data
    };

    // 2. Open separate SQLite database connection
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

    // Extract and insert EPG channels
    let epg_channels = extract_epg_channels(&xml_data);
    let mut chan_stmt = tx.prepare(
        "INSERT OR REPLACE INTO epg_channels (id, display_name, icon_url)
         VALUES (?1, ?2, ?3)",
    ).map_err(|e| e.to_string())?;

    for ch in &epg_channels {
        let icon = ch.icon_url.as_deref().unwrap_or("");
        if let Err(e) = chan_stmt.execute(rusqlite::params![ch.id, ch.display_name, icon]) {
            warn!("Failed to insert EPG channel in cache {}: {}", ch.id, e);
        }
    }
    chan_stmt.finalize().map_err(|e| e.to_string())?;

    // Extract and insert programs
    let mut prog_stmt = tx.prepare(
        "INSERT OR REPLACE INTO programs (
            id, stream_id, title, subtitle, description, start, end
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).map_err(|e| e.to_string())?;

    let mut reader = Reader::from_reader(&xml_data[..]);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::with_capacity(4096);
    let mut current_program: Option<EpgProgram> = None;
    let mut current_element: Option<String> = None;
    let mut current_text = String::new();
    let mut program_count: usize = 0;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "programme" {
                    let mut program = EpgProgram {
                        channel_id: String::new(),
                        title: String::new(),
                        sub_title: None,
                        description: None,
                        start: String::new(),
                        stop: String::new(),
                    };
                    for attr in e.attributes() {
                        if let Ok(a) = attr {
                            let key = String::from_utf8_lossy(a.key.as_ref()).to_string();
                            let value = a.decode_and_unescape_value(reader.decoder()).unwrap_or_default().to_string();
                            match key.as_str() {
                                "channel" => program.channel_id = value,
                                "start" => program.start = parse_xmltv_date(&value),
                                "stop" => program.stop = parse_xmltv_date(&value),
                                _ => {}
                            }
                        }
                    }
                    current_program = Some(program);
                } else if current_program.is_some() {
                    current_element = Some(name);
                    current_text.clear();
                }
            }
            Ok(Event::Text(e)) => {
                if current_element.is_some() {
                    if let Ok(t) = e.unescape() {
                        current_text.push_str(&t);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == "programme" {
                    if let Some(program) = current_program.take() {
                        program_count += 1;
                        let id = format!("{}_{}", program.channel_id, program.start);
                        let title = &program.title;
                        let sub = program.sub_title.as_deref().unwrap_or("");
                        let desc = program.description.as_deref().unwrap_or("");
                        
                        if let Err(e) = prog_stmt.execute(rusqlite::params![
                            id,
                            program.channel_id,
                            title,
                            sub,
                            desc,
                            program.start,
                            program.stop,
                        ]) {
                            if !e.to_string().contains("UNIQUE constraint failed") {
                                warn!("Failed to insert EPG program in cache: {}", e);
                            }
                        }
                    }
                } else if current_program.is_some() {
                    if let Some(ref elem) = current_element {
                        if let Some(ref mut program) = current_program {
                            match elem.as_str() {
                                "title" => program.title = current_text.trim().to_string(),
                                "sub-title" => program.sub_title = Some(current_text.trim().to_string()),
                                "desc" => program.description = Some(current_text.trim().to_string()),
                                _ => {}
                            }
                        }
                    }
                    current_element = None;
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

    prog_stmt.finalize().map_err(|e| e.to_string())?;

    // Guard against replacing a good cache with an empty/garbage parse (e.g. an
    // HTTP error page served with status 200). Returning Err drops the
    // transaction, rolling back the DROP/CREATE above so the existing cache
    // survives intact.
    if epg_channels.is_empty() && program_count == 0 {
        return Err(format!(
            "EPG response from {} contained no channels or programmes; preserving existing cache",
            epg_url
        ));
    }

    tx.commit().map_err(|e| e.to_string())?;

    // Compact database file size
    conn.execute("VACUUM", []).map_err(|e| e.to_string())?;

    info!("[EPG Cache] Entire EPG cached successfully for link {}", epg_link_id);
    Ok(())
}
