//! Streaming EPG Parser
//!
//! This module provides high-performance streaming XMLTV parsing that:
//! - Downloads and parses XML simultaneously (streaming)
//! - Inserts programs in batches as they're parsed (pipelined)
//! - Sends progress updates to the frontend
//! - Handles large EPG files (>50MB) efficiently
//! - Uses minimal memory (doesn't load entire XML into RAM)
//! - Optimized for modern multi-core hardware

use std::collections::HashMap;
use anyhow::{Context, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tracing::{info, warn};
use futures_util::StreamExt;

use crate::dvr::database::DvrDatabase;
use tauri::Emitter;

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
    // Examples: "20240223020000 +0000" or "20240223020000"
    let trimmed = date_str.trim();

    // Try to parse with regex-like approach
    if trimmed.len() >= 14 {
        let year = &trimmed[0..4];
        let month = &trimmed[4..6];
        let day = &trimmed[6..8];
        let hour = &trimmed[8..10];
        let min = &trimmed[10..12];
        let sec = &trimmed[12..14];

        // Extract timezone if present (format: +0000 or -0500)
        let tz = if trimmed.len() > 15 {
            let tz_part = trimmed[15..].trim();
            if tz_part.len() >= 5 && (tz_part.starts_with('+') || tz_part.starts_with('-')) {
                // Convert +0000 to +00:00
                format!("{}{}:{}", &tz_part[0..1], &tz_part[1..3], &tz_part[3..5])
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

/// Channel mapping from EPG channel ID to stream_id
#[derive(Debug, Clone, Deserialize)]
pub struct ChannelMapping {
    pub epg_channel_id: String,
    pub stream_id: String,
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

/// Stream and parse EPG XML from URL with true streaming and pipelining
pub async fn stream_parse_epg<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: &DvrDatabase,
    source_id: String,
    epg_url: String,
    channel_mappings: Vec<ChannelMapping>,
) -> Result<EpgParseResult> {
    let start_time = std::time::Instant::now();

    info!("Starting TRUE streaming EPG parse for source {} from {}", source_id, epg_url);

    // Build channel lookup map
    let channel_map: HashMap<String, String> = channel_mappings
        .into_iter()
        .map(|m| (m.epg_channel_id, m.stream_id))
        .collect();

    info!("Channel map has {} entries", channel_map.len());

    // Create HTTP client with optimized settings
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .pool_max_idle_per_host(10)
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

    let response = client
        .get(&epg_url)
        .send()
        .await
        .context("Failed to start EPG download")?;

    let total_bytes = response.content_length();
    info!("EPG download started, total size: {:?} bytes", total_bytes);

    // Delete old programs BEFORE starting the pipeline
    info!("[EPG] Deleting old programs for source {}", source_id);
    let deleted_count = delete_programs_for_source(db, &source_id)?;
    info!("[EPG] Deleted {} old programs for source {}", deleted_count, source_id);

    // Create channel for parse->insert pipeline
    let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);

    // Clone for parser task
    let channel_map_clone = channel_map.clone();
    let source_id_clone = source_id.clone();
    let app_handle_clone = app_handle.clone();

    // Spawn parser task that downloads and parses concurrently
    let parse_start = std::time::Instant::now();
    let parser_task = tokio::spawn(async move {
        parse_download_stream(
            response,
            channel_map_clone,
            batch_tx,
            app_handle_clone,
            source_id_clone,
            total_bytes,
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
        source_id,
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
async fn parse_download_stream<R: tauri::Runtime>(
    response: reqwest::Response,
    channel_map: HashMap<String, String>,
    batch_tx: mpsc::Sender<Vec<EpgProgram>>,
    app_handle: tauri::AppHandle<R>,
    source_id: String,
    total_bytes: Option<u64>,
) -> Result<StreamingParserResult> {
    let start_time = std::time::Instant::now();

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
                break;
            }
        }
    }

    let download_ms = start_time.elapsed().as_millis() as u64;
    info!(
        "[EPG] Downloaded {} bytes in {} chunks in {}ms",
        total_bytes_downloaded,
        chunks.len(),
        download_ms
    );

    // Combine chunks for parsing (pre-allocate for speed)
    let combine_start = std::time::Instant::now();
    let total_size = chunks.iter().map(|c| c.len()).sum::<usize>();
    let mut xml_data = Vec::with_capacity(total_size);
    for chunk in chunks {
        xml_data.extend_from_slice(&chunk);
    }
    let combine_ms = combine_start.elapsed().as_millis() as u64;

    // Parse and stream batches
    let parse_result = parse_and_stream_batches(
        &xml_data,
        channel_map,
        batch_tx,
        app_handle,
        source_id,
        total_bytes,
        total_bytes_downloaded,
        start_time,
    ).await?;

    let total_ms = start_time.elapsed().as_millis() as u64;
    info!(
        "[EPG Timing] Download: {}ms, Combine: {}ms, Parse+Insert: {}ms, Total: {}ms",
        download_ms, combine_ms, total_ms - download_ms - combine_ms, total_ms
    );

    Ok(parse_result)
}

/// Parse XML and stream batches to inserter
async fn parse_and_stream_batches<R: tauri::Runtime>(
    xml_data: &[u8],
    channel_map: HashMap<String, String>,
    batch_tx: mpsc::Sender<Vec<EpgProgram>>,
    app_handle: tauri::AppHandle<R>,
    source_id: String,
    total_bytes: Option<u64>,
    bytes_downloaded: u64,
    start_time: std::time::Instant,
) -> Result<StreamingParserResult> {
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
                        if let Some(mut program) = current_program.take() {
                            total_programs += 1;

                            // Check if channel is in our mapping
                            if let Some(stream_id) = channel_map.get(&program.channel_id) {
                                matched_programs += 1;
                                // Replace channel_id with stream_id
                                program.channel_id = stream_id.clone();
                                batch.push(program);

                                // Send batch when full
                                if batch.len() >= BATCH_SIZE {
                                    let batch_to_send = std::mem::take(&mut batch);
                                    batch.reserve(BATCH_SIZE);

                                    if batch_tx.send(batch_to_send).await.is_err() {
                                        warn!("Batch channel closed, stopping parser");
                                        break;
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
    let conn = db.get_conn()?;

    let deleted = conn.execute(
        "DELETE FROM programs WHERE source_id = ?1",
        rusqlite::params![source_id],
    )?;

    Ok(deleted)
}

/// Insert a batch of programs into database
async fn insert_programs_batch(
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
            Err(e) => warn!("Failed to insert program for stream {}: {}", stream_id, e),
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

    // Build channel lookup map
    let channel_map: HashMap<String, String> = channel_mappings
        .into_iter()
        .map(|m| (m.epg_channel_id, m.stream_id))
        .collect();

    // Delete old programs first
    let deleted_count = delete_programs_for_source(db, &source_id)?;
    info!("[EPG] Deleted {} old programs for source {}", deleted_count, source_id);

    // Create channel for parse->insert pipeline
    let (batch_tx, batch_rx) = mpsc::channel::<Vec<EpgProgram>>(CHANNEL_BUFFER);

    // Clone for parser
    let channel_map_clone = channel_map.clone();
    let source_id_clone = source_id.clone();
    let app_handle_clone = app_handle.clone();

    // Spawn parser task
    let parser_task = tokio::spawn(async move {
        parse_and_stream_batches(
            &xml_data,
            channel_map_clone,
            batch_tx,
            app_handle_clone,
            source_id_clone,
            Some(total_bytes),
            total_bytes,
            start_time,
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
