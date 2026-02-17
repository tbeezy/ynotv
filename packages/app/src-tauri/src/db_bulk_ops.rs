//! Optimized bulk database operations for sync operations
//!
//! This module provides high-performance bulk insert/update operations that
//! significantly reduce IPC overhead compared to individual row operations.

use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::dvr::database::DvrDatabase;

/// A single channel to be inserted/updated
#[derive(Debug, Clone, Deserialize)]
pub struct BulkChannel {
    pub stream_id: String,
    pub source_id: String,
    pub category_ids: Option<String>, // JSON array as string
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub channel_num: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub is_favorite: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub enabled: Option<i32>,
    #[serde(default)]
    pub stream_type: Option<String>,
    #[serde(default)]
    pub stream_icon: Option<String>,
    #[serde(default)]
    pub epg_channel_id: Option<String>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(default)]
    pub custom_sid: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub tv_archive: Option<i32>,
    #[serde(default)]
    pub direct_source: Option<String>,
    #[serde(default)]
    pub direct_url: Option<String>,
    #[serde(default)]
    pub xmltv_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub series_no: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub live: Option<i32>,
}

/// A single category to be inserted/updated
#[derive(Debug, Clone, Deserialize)]
pub struct BulkCategory {
    pub category_id: String,
    pub source_id: String,
    pub category_name: String,
    #[serde(default)]
    pub parent_id: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub enabled: Option<i32>,
    #[serde(default)]
    pub display_order: Option<i32>,
    #[serde(default)]
    pub channel_count: Option<i32>,
    #[serde(default)]
    pub filter_words: Option<String>, // JSON array as string
}

/// Custom deserializer that accepts both booleans and integers
/// Converts boolean true/false to 1/0 for SQLite storage
fn deserialize_bool_to_i32<'de, D>(deserializer: D) -> Result<Option<i32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;

    let value = serde_json::Value::deserialize(deserializer)?;

    match value {
        serde_json::Value::Bool(b) => Ok(Some(if b { 1 } else { 0 })),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Some(i as i32))
            } else {
                Err(D::Error::custom("expected integer"))
            }
        }
        serde_json::Value::Null => Ok(None),
        _ => Err(D::Error::custom("expected boolean or integer")),
    }
}

/// Custom deserializer that accepts numbers (integers or floats) and converts them to strings
fn deserialize_number_to_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;

    let value = serde_json::Value::deserialize(deserializer)?;

    match value {
        serde_json::Value::Number(n) => Ok(Some(n.to_string())),
        serde_json::Value::String(s) => Ok(Some(s)),
        serde_json::Value::Null => Ok(None),
        _ => Err(D::Error::custom("expected number or string")),
    }
}

/// A single EPG program to be inserted
#[derive(Debug, Clone, Deserialize)]
pub struct BulkProgram {
    pub id: String,
    pub stream_id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub start: String, // ISO 8601 datetime string
    pub end: String,   // ISO 8601 datetime string
    pub source_id: String,
}

/// A single VOD movie to be inserted/updated
#[derive(Debug, Clone, Deserialize)]
pub struct BulkMovie {
    pub stream_id: String,
    pub source_id: String,
    #[serde(default)]
    pub category_ids: Option<String>, // JSON array as string
    pub name: String,
    #[serde(default)]
    pub tmdb_id: Option<i64>,
    #[serde(default)]
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(default)]
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub popularity: Option<f64>,
    #[serde(default)]
    pub match_attempted: Option<String>,
    #[serde(default)]
    pub container_extension: Option<String>,
    #[serde(default, deserialize_with = "deserialize_number_to_string")]
    pub rating: Option<String>,
    #[serde(default)]
    pub director: Option<String>,
    #[serde(default, deserialize_with = "deserialize_number_to_string")]
    pub year: Option<String>,
    #[serde(default)]
    pub cast: Option<String>,
    #[serde(default)]
    pub plot: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub duration_secs: Option<i64>,
    #[serde(default)]
    pub duration: Option<String>,
    #[serde(default)]
    pub stream_icon: Option<String>,
    #[serde(default)]
    pub direct_url: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub title: Option<String>, // Clean title without year
}

/// A single VOD series to be inserted/updated
#[derive(Debug, Clone, Deserialize)]
pub struct BulkSeries {
    pub series_id: String,
    pub source_id: String,
    #[serde(default)]
    pub category_ids: Option<String>, // JSON array as string
    pub name: String,
    #[serde(default)]
    pub tmdb_id: Option<i64>,
    #[serde(default)]
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(default)]
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub popularity: Option<f64>,
    #[serde(default)]
    pub match_attempted: Option<String>,
    #[serde(default)]
    pub _stalker_category: Option<String>,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub plot: Option<String>,
    #[serde(default)]
    pub cast: Option<String>,
    #[serde(default)]
    pub director: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>, // Maps to releaseDate
    #[serde(default)]
    pub rating: Option<String>,
    #[serde(default)]
    pub youtube_trailer: Option<String>,
    #[serde(default)]
    pub episode_run_time: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub last_modified: Option<String>,
    #[serde(default, deserialize_with = "deserialize_number_to_string")]
    pub year: Option<String>,
    #[serde(default)]
    pub stream_type: Option<String>,
    #[serde(default)]
    pub stream_icon: Option<String>,
    #[serde(default)]
    pub direct_url: Option<String>,
    #[serde(default)]
    pub rating_5based: Option<f64>,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub _stalker_raw_id: Option<String>,
}

/// Result of a bulk operation
#[derive(Debug, Serialize)]
pub struct BulkResult {
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
    pub duration_ms: u64,
}

/// Bulk insert or replace channels (upsert operation)
/// Uses a single prepared statement in a transaction for maximum performance
pub fn bulk_upsert_channels(db: &DvrDatabase, channels: Vec<BulkChannel>) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction()?;

    // Prepare the upsert statement once
    let mut stmt = tx.prepare(
        "INSERT INTO channels (
            stream_id, source_id, category_ids, name, channel_num, is_favorite,
            enabled, stream_type, stream_icon, epg_channel_id, added, custom_sid,
            tv_archive, direct_source, direct_url, xmltv_id, series_no, live
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
        ON CONFLICT(stream_id) DO UPDATE SET
            source_id = excluded.source_id,
            category_ids = excluded.category_ids,
            name = excluded.name,
            channel_num = excluded.channel_num,
            is_favorite = COALESCE(excluded.is_favorite, channels.is_favorite),
            enabled = COALESCE(excluded.enabled, channels.enabled),
            stream_type = excluded.stream_type,
            stream_icon = excluded.stream_icon,
            epg_channel_id = excluded.epg_channel_id,
            added = excluded.added,
            custom_sid = excluded.custom_sid,
            tv_archive = excluded.tv_archive,
            direct_source = excluded.direct_source,
            direct_url = excluded.direct_url,
            xmltv_id = excluded.xmltv_id,
            series_no = excluded.series_no,
            live = excluded.live",
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for channel in channels {
        match stmt.execute(params![
            channel.stream_id,
            channel.source_id,
            channel.category_ids,
            channel.name,
            channel.channel_num,
            channel.is_favorite,
            channel.enabled,
            channel.stream_type,
            channel.stream_icon,
            channel.epg_channel_id,
            channel.added,
            channel.custom_sid,
            channel.tv_archive,
            channel.direct_source,
            channel.direct_url,
            channel.xmltv_id,
            channel.series_no,
            channel.live,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert channels: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Bulk insert or replace categories (upsert operation)
pub fn bulk_upsert_categories(
    db: &DvrDatabase,
    categories: Vec<BulkCategory>,
) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction()?;

    let mut stmt = tx.prepare(
        "INSERT INTO categories (
            category_id, source_id, category_name, parent_id, enabled,
            display_order, channel_count, filter_words
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(category_id) DO UPDATE SET
            source_id = excluded.source_id,
            category_name = excluded.category_name,
            parent_id = excluded.parent_id,
            enabled = COALESCE(excluded.enabled, categories.enabled),
            display_order = COALESCE(excluded.display_order, categories.display_order),
            channel_count = excluded.channel_count,
            filter_words = excluded.filter_words",
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for category in categories {
        match stmt.execute(params![
            category.category_id,
            category.source_id,
            category.category_name,
            category.parent_id,
            category.enabled,
            category.display_order,
            category.channel_count,
            category.filter_words,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert categories: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Bulk insert EPG programs with transaction
/// First clears existing programs for the source, then inserts new ones
pub fn bulk_replace_programs(
    db: &DvrDatabase,
    source_id: &str,
    programs: Vec<BulkProgram>,
) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction()?;

    // Delete existing programs for this source
    let deleted = tx.execute(
        "DELETE FROM programs WHERE source_id = ?1",
        params![source_id],
    )?;

    // Insert new programs (use OR IGNORE to skip duplicates)
    let mut stmt = tx.prepare(
        "INSERT OR IGNORE INTO programs (
            id, stream_id, title, description, start, end, source_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;

    let mut inserted = 0;
    let mut duplicates = 0;

    for program in programs {
        match stmt.execute(params![
            program.id,
            program.stream_id,
            program.title,
            program.description,
            program.start,
            program.end,
            program.source_id,
        ]) {
            Ok(1) => inserted += 1,
            Ok(_) => duplicates += 1, // Row was ignored (duplicate)
            Err(e) => return Err(e.into()),
        }
    }

    if duplicates > 0 {
        info!("Skipped {} duplicate EPG programs", duplicates);
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk replace programs for {}: {} deleted, {} inserted in {}ms",
        source_id, deleted, inserted, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated: 0,
        deleted: deleted as usize,
        duration_ms,
    })
}

/// Bulk upsert VOD movies
pub fn bulk_upsert_movies(db: &DvrDatabase, movies: Vec<BulkMovie>) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction()?;

    let mut stmt = tx.prepare(
        "INSERT INTO vodMovies (
            stream_id, source_id, category_ids, name, tmdb_id, imdb_id, added,
            backdrop_path, popularity, match_attempted, container_extension,
            rating, director, year, cast, plot, genre, duration_secs, duration,
            stream_icon, direct_url, release_date, title
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
        ON CONFLICT(stream_id) DO UPDATE SET
            source_id = excluded.source_id,
            category_ids = excluded.category_ids,
            name = excluded.name,
            tmdb_id = COALESCE(excluded.tmdb_id, vodMovies.tmdb_id),
            imdb_id = COALESCE(excluded.imdb_id, vodMovies.imdb_id),
            added = excluded.added,
            backdrop_path = COALESCE(excluded.backdrop_path, vodMovies.backdrop_path),
            popularity = COALESCE(excluded.popularity, vodMovies.popularity),
            match_attempted = COALESCE(excluded.match_attempted, vodMovies.match_attempted),
            container_extension = excluded.container_extension,
            rating = excluded.rating,
            director = excluded.director,
            year = excluded.year,
            cast = excluded.cast,
            plot = excluded.plot,
            genre = excluded.genre,
            duration_secs = excluded.duration_secs,
            duration = excluded.duration,
            stream_icon = excluded.stream_icon,
            direct_url = excluded.direct_url,
            release_date = excluded.release_date,
            title = excluded.title"
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for movie in movies {
        match stmt.execute(params![
            movie.stream_id,
            movie.source_id,
            movie.category_ids,
            movie.name,
            movie.tmdb_id,
            movie.imdb_id,
            movie.added,
            movie.backdrop_path,
            movie.popularity,
            movie.match_attempted,
            movie.container_extension,
            movie.rating,
            movie.director,
            movie.year,
            movie.cast,
            movie.plot,
            movie.genre,
            movie.duration_secs,
            movie.duration,
            movie.stream_icon,
            movie.direct_url,
            movie.release_date,
            movie.title,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert movies: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Bulk upsert VOD series
pub fn bulk_upsert_series(db: &DvrDatabase, series: Vec<BulkSeries>) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction()?;

    let mut stmt = tx.prepare(
        "INSERT INTO vodSeries (
            series_id, source_id, category_ids, name, tmdb_id, imdb_id, added,
            backdrop_path, popularity, match_attempted, _stalker_category, cover,
            plot, cast, director, genre, releaseDate, rating, youtube_trailer,
            episode_run_time, title, last_modified, year, stream_type,
            stream_icon, direct_url, rating_5based, category_id, _stalker_raw_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)
        ON CONFLICT(series_id) DO UPDATE SET
            source_id = excluded.source_id,
            category_ids = excluded.category_ids,
            name = excluded.name,
            tmdb_id = COALESCE(excluded.tmdb_id, vodSeries.tmdb_id),
            imdb_id = COALESCE(excluded.imdb_id, vodSeries.imdb_id),
            added = excluded.added,
            backdrop_path = COALESCE(excluded.backdrop_path, vodSeries.backdrop_path),
            popularity = COALESCE(excluded.popularity, vodSeries.popularity),
            match_attempted = COALESCE(excluded.match_attempted, vodSeries.match_attempted),
            _stalker_category = excluded._stalker_category,
            cover = excluded.cover,
            plot = excluded.plot,
            cast = excluded.cast,
            director = excluded.director,
            genre = excluded.genre,
            releaseDate = excluded.releaseDate,
            rating = excluded.rating,
            youtube_trailer = excluded.youtube_trailer,
            episode_run_time = excluded.episode_run_time,
            title = excluded.title,
            last_modified = excluded.last_modified,
            year = excluded.year,
            stream_type = excluded.stream_type,
            stream_icon = excluded.stream_icon,
            direct_url = excluded.direct_url,
            rating_5based = excluded.rating_5based,
            category_id = excluded.category_id,
            _stalker_raw_id = excluded._stalker_raw_id"
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for s in series {
        match stmt.execute(params![
            s.series_id,
            s.source_id,
            s.category_ids,
            s.name,
            s.tmdb_id,
            s.imdb_id,
            s.added,
            s.backdrop_path,
            s.popularity,
            s.match_attempted,
            s._stalker_category,
            s.cover,
            s.plot,
            s.cast,
            s.director,
            s.genre,
            s.release_date,
            s.rating,
            s.youtube_trailer,
            s.episode_run_time,
            s.title,
            s.last_modified,
            s.year,
            s.stream_type,
            s.stream_icon,
            s.direct_url,
            s.rating_5based,
            s.category_id,
            s._stalker_raw_id,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert series: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Delete channels by stream_id
pub fn bulk_delete_channels(db: &DvrDatabase, stream_ids: Vec<String>) -> Result<usize> {
    let mut conn = db.get_conn()?;
    let tx = conn.transaction()?;

    let placeholders: Vec<String> = stream_ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "DELETE FROM channels WHERE stream_id IN ({})",
        placeholders.join(", ")
    );

    let mut stmt = tx.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = stream_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();

    let deleted = stmt.execute(rusqlite::params_from_iter(params.iter()))?;
    stmt.finalize()?;
    tx.commit()?;

    info!("Bulk deleted {} channels", deleted);

    Ok(deleted as usize)
}

/// Delete categories by category_id
pub fn bulk_delete_categories(db: &DvrDatabase, category_ids: Vec<String>) -> Result<usize> {
    let mut conn = db.get_conn()?;
    let tx = conn.transaction()?;

    let placeholders: Vec<String> = category_ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "DELETE FROM categories WHERE category_id IN ({})",
        placeholders.join(", ")
    );

    let mut stmt = tx.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = category_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();

    let deleted = stmt.execute(rusqlite::params_from_iter(params.iter()))?;
    stmt.finalize()?;
    tx.commit()?;

    info!("Bulk deleted {} categories", deleted);

    Ok(deleted as usize)
}

/// Update sourcesMeta
#[derive(Debug, Clone, Deserialize)]
pub struct SourceMetaUpdate {
    pub source_id: String,
    #[serde(default)]
    pub epg_url: Option<String>,
    #[serde(default)]
    pub last_synced: Option<String>,
    #[serde(default)]
    pub vod_last_synced: Option<String>,
    #[serde(default)]
    pub channel_count: Option<i32>,
    #[serde(default)]
    pub category_count: Option<i32>,
    #[serde(default)]
    pub vod_movie_count: Option<i32>,
    #[serde(default)]
    pub vod_series_count: Option<i32>,
    #[serde(default)]
    pub expiry_date: Option<String>,
    #[serde(default)]
    pub active_cons: Option<String>,
    #[serde(default)]
    pub max_connections: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn update_source_meta(db: &DvrDatabase, meta: SourceMetaUpdate) -> Result<()> {
    let mut conn = db.get_conn()?;
    let tx = conn.transaction()?;

    // Try to update first - using COALESCE to preserve existing values when new values are NULL
    // This approach works for both partial updates and new records
    let rows_affected = tx.execute(
        "UPDATE sourcesMeta SET
            epg_url = COALESCE(?1, epg_url),
            last_synced = COALESCE(?2, last_synced),
            vod_last_synced = COALESCE(?3, vod_last_synced),
            channel_count = COALESCE(?4, channel_count),
            category_count = COALESCE(?5, category_count),
            vod_movie_count = COALESCE(?6, vod_movie_count),
            vod_series_count = COALESCE(?7, vod_series_count),
            expiry_date = COALESCE(?8, expiry_date),
            active_cons = COALESCE(?9, active_cons),
            max_connections = COALESCE(?10, max_connections),
            error = COALESCE(?11, error)
        WHERE source_id = ?12",
        params![
            meta.epg_url,
            meta.last_synced,
            meta.vod_last_synced,
            meta.channel_count,
            meta.category_count,
            meta.vod_movie_count,
            meta.vod_series_count,
            meta.expiry_date,
            meta.active_cons,
            meta.max_connections,
            meta.error,
            meta.source_id,
        ],
    )?;

    // If no rows were updated, insert a new record
    if rows_affected == 0 {
        tx.execute(
            "INSERT INTO sourcesMeta (
                source_id, epg_url, last_synced, vod_last_synced, channel_count,
                category_count, vod_movie_count, vod_series_count, expiry_date,
                active_cons, max_connections, error
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                meta.source_id,
                meta.epg_url,
                meta.last_synced,
                meta.vod_last_synced,
                meta.channel_count,
                meta.category_count,
                meta.vod_movie_count,
                meta.vod_series_count,
                meta.expiry_date,
                meta.active_cons,
                meta.max_connections,
                meta.error,
            ],
        )?;
    }

    tx.commit()?;
    Ok(())
}
