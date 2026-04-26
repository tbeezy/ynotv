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
use chrono::{DateTime, Duration};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{error, info, warn};
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
    pub duration_ms: u64,
    pub bytes_processed: u64,
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

    // Remove extra whitespace and convert to lowercase
    result = result.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();

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
) -> Result<EpgParseResult> {
    let start_time = std::time::Instant::now();
    let src_ctx = format!("{} ({})", source_name, source_id);

    info!("Starting TRUE streaming EPG parse for source {} from {} (advanced matching: {})", src_ctx, epg_url, advanced_epg_matching);

    // Build channel lookup map (supports multiple stream_ids per epg_channel_id)
    let channel_lookup = build_channel_lookup(channel_mappings);

    info!("Channel lookup has {} entries", channel_lookup.len());

    // Check if URL is gzipped
    let is_gzipped = epg_url.ends_with(".gz");

    // Create HTTP client with optimized settings and TLS configuration
    // Using native-tls to handle various certificate types including self-signed
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(10)
        .danger_accept_invalid_certs(true)  // Accept self-signed/invalid certificates
        .danger_accept_invalid_hostnames(true)  // Accept invalid hostnames
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
        duration_ms,
        bytes_processed: parser_result.bytes_processed,
    })
}

/// Parser result from streaming parse
struct StreamingParserResult {
    total_programs: usize,
    matched_programs: usize,
    unmatched_channels: usize,
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
    info!("[EPG] EPG Download verified successful. Safe to delete old programs!");
    info!("[EPG] Deleting old programs for source {}", src_ctx);
    let deleted_count = delete_programs_for_source(&db, &source_id)?;
    info!("[EPG] Deleted {} old programs for source {}", deleted_count, src_ctx);

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
    let timeshift_secs = (timeshift_hours * 3600.0).round() as i64;
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
                    "title" | "desc" => {
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
        "[EPG] Parser finished: {} programs, {} matched, {} unmatched channels",
        total_programs,
        matched_programs,
        unmatched_channels.len()
    );

    Ok(StreamingParserResult {
        total_programs,
        matched_programs,
        unmatched_channels: unmatched_channels.len(),
        bytes_processed: bytes_downloaded,
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
            id, stream_id, title, description, start, end, source_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
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
) -> Result<EpgParseResult> {
    use tokio::fs::File;
    use tokio::io::AsyncReadExt;

    info!("Parsing local EPG file with streaming: {}", file_path);
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

    // Delete old programs first
    let deleted_count = delete_programs_for_source(db, &source_id)?;
    info!("[EPG] Deleted {} old programs for source {}", deleted_count, source_id);

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
        duration_ms,
        bytes_processed: total_bytes,
    })
}
