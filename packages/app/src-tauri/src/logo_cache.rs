//! Channel Logo Caching Service
//!
//! Provides disk-based caching of channel logos backed by SQLite metadata tracking,
//! negative caching (dead URL backoff), and base64 data URI output.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use log::info;
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::fs;

const BACKOFF_WINDOW_SECS: i64 = 7 * 86400; // 7 days negative cache backoff
const MAX_FAIL_COUNT: i64 = 3;
const STALE_DEAD_WINDOW_SECS: i64 = 30 * 86400; // 30 days cleanup window for dead URLs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogoCacheStats {
    pub total_files: usize,
    pub total_bytes: u64,
    pub enabled: bool,
    pub max_bytes: u64,
    pub ttl_days: u32,
}

pub struct LogoCacheManager {
    cache_dir: PathBuf,
    db_path: PathBuf,
    client: Client,
}

fn get_now_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl LogoCacheManager {
    pub fn new(cache_dir: PathBuf) -> Self {
        let db_path = cache_dir.join("logo_cache.db");
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_default();

        Self {
            cache_dir,
            db_path,
            client,
        }
    }

    /// Open a connection to the SQLite database
    fn get_db(&self) -> Result<Connection> {
        let conn = Connection::open(&self.db_path)
            .context("Failed to open logo cache SQLite database")?;
        let _ = conn.execute("PRAGMA journal_mode = WAL;", []);
        let _ = conn.execute("PRAGMA busy_timeout = 5000;", []);
        Ok(conn)
    }

    /// Ensure the logo cache directory exists and initialize SQLite schema
    pub async fn init(&self) -> Result<()> {
        if !self.cache_dir.exists() {
            fs::create_dir_all(&self.cache_dir)
                .await
                .context("Failed to create logo cache directory")?;
        }

        let conn = self.get_db()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS logo_cache_meta (
                url_hash TEXT PRIMARY KEY,
                original_url TEXT NOT NULL,
                etag TEXT,
                last_modified TEXT,
                last_fetched INTEGER,
                fail_count INTEGER NOT NULL DEFAULT 0,
                last_failed_at INTEGER,
                file_ext TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_logo_cache_last_fetched ON logo_cache_meta(last_fetched);
            CREATE INDEX IF NOT EXISTS idx_logo_cache_last_failed ON logo_cache_meta(last_failed_at);"
        ).context("Failed to initialize logo cache SQLite schema")?;

        Ok(())
    }

    /// Generate a 16-character hex hash of the URL
    fn hash_url(&self, url: &str) -> String {
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    }

    /// Extract file extension from URL
    fn get_url_ext(&self, url: &str) -> String {
        let lower = url.to_lowercase();
        if lower.contains(".png") {
            "png".to_string()
        } else if lower.contains(".jpg") || lower.contains(".jpeg") {
            "jpg".to_string()
        } else if lower.contains(".svg") {
            "svg".to_string()
        } else if lower.contains(".webp") {
            "webp".to_string()
        } else {
            "png".to_string()
        }
    }

    /// Get local base64 data URL for a cached logo with negative caching (dead URL backoff)
    pub async fn get_or_cache_logo_data(&self, url: &str) -> Result<String> {
        if url.trim().is_empty() {
            anyhow::bail!("Empty URL provided");
        }

        self.init().await?;
        let hash = self.hash_url(url);
        let now = get_now_timestamp();
        let fallback_ext = self.get_url_ext(url);

        // Query metadata from SQLite synchronously before any async call
        let meta_opt: Option<(String, u64, i64, Option<i64>)> = {
            let conn = self.get_db()?;
            conn.query_row(
                "SELECT file_ext, file_size, fail_count, last_failed_at FROM logo_cache_meta WHERE url_hash = ?1",
                params![hash],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?
        };

        if let Some((ext, file_size, fail_count, last_failed_at)) = &meta_opt {
            // Serve the already-downloaded copy from disk whenever it exists — even
            // if the URL has since failed (fail_count > 0) or the entry is inside
            // the negative-cache backoff window. The negative cache only gates
            // *network retries*; a good file on disk is never worse than showing a
            // letter placeholder, and TTL pruning handles eventual revalidation.
            let file_path = self.cache_dir.join(format!("{}.{}", hash, ext));
            if file_path.exists() && *file_size > 0 {
                if let Ok(bytes) = fs::read(&file_path).await {
                    let mime = match ext.as_str() {
                        "jpg" | "jpeg" => "image/jpeg",
                        "svg" => "image/svg+xml",
                        "webp" => "image/webp",
                        _ => "image/png",
                    };
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    return Ok(format!("data:{};base64,{}", mime, b64));
                }
            }

            // Negative cache check: if fail_count >= 3 and within backoff window, skip network call
            if *fail_count >= MAX_FAIL_COUNT {
                if let Some(failed_time) = last_failed_at {
                    if (now - failed_time) < BACKOFF_WINDOW_SECS {
                        anyhow::bail!("Logo URL is marked dead in negative cache backoff window");
                    }
                }
            }
        }

        // Cache miss or retry — fetch from network
        match self.client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(bytes) = resp.bytes().await {
                    let fetched_bytes = bytes.to_vec();
                    let file_size = fetched_bytes.len() as u64;
                    let file_path = self.cache_dir.join(format!("{}.{}", hash, fallback_ext));

                    let _ = fs::write(&file_path, &fetched_bytes).await;

                    // Upsert success row into SQLite
                    if let Ok(conn) = self.get_db() {
                        let _ = conn.execute(
                            "INSERT INTO logo_cache_meta (url_hash, original_url, last_fetched, fail_count, last_failed_at, file_ext, file_size)
                             VALUES (?1, ?2, ?3, 0, NULL, ?4, ?5)
                             ON CONFLICT(url_hash) DO UPDATE SET
                                 last_fetched = excluded.last_fetched,
                                 fail_count = 0,
                                 last_failed_at = NULL,
                                 file_ext = excluded.file_ext,
                                 file_size = excluded.file_size;",
                            params![hash, url, now, fallback_ext, file_size],
                        );
                    }

                    let mime = match fallback_ext.as_str() {
                        "jpg" | "jpeg" => "image/jpeg",
                        "svg" => "image/svg+xml",
                        "webp" => "image/webp",
                        _ => "image/png",
                    };
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&fetched_bytes);
                    return Ok(format!("data:{};base64,{}", mime, b64));
                }
            }
            _ => {}
        }

        // Failure — record in negative cache SQLite table
        if let Ok(conn) = self.get_db() {
            let _ = conn.execute(
                "INSERT INTO logo_cache_meta (url_hash, original_url, fail_count, last_failed_at, file_ext, file_size)
                 VALUES (?1, ?2, 1, ?3, ?4, 0)
                 ON CONFLICT(url_hash) DO UPDATE SET
                     fail_count = logo_cache_meta.fail_count + 1,
                     last_failed_at = excluded.last_failed_at;",
                params![hash, url, now, fallback_ext],
            );
        }

        anyhow::bail!("Failed to download logo from network")
    }


    /// Fast indexed stats reporting directly from SQLite
    pub async fn get_stats(&self, enabled: bool, max_bytes: u64, ttl_days: u32) -> Result<LogoCacheStats> {
        self.init().await?;
        let conn = self.get_db()?;

        let (total_files, total_bytes): (usize, u64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(file_size), 0) FROM logo_cache_meta WHERE file_size > 0",
                [],
                |row| {
                    let count: i64 = row.get(0)?;
                    let size: i64 = row.get(1)?;
                    Ok((count as usize, size as u64))
                },
            )
            .unwrap_or((0, 0));

        Ok(LogoCacheStats {
            total_files,
            total_bytes,
            enabled,
            max_bytes,
            ttl_days,
        })
    }

    /// Clear all cached logo files from disk and reset SQLite table
    pub async fn clear_cache(&self) -> Result<()> {
        if self.cache_dir.exists() {
            let mut entries = fs::read_dir(&self.cache_dir).await?;
            while let Ok(Some(entry)) = entries.next_entry().await {
                if entry.metadata().await.map(|m| m.is_file()).unwrap_or(false) {
                    let _ = fs::remove_file(entry.path()).await;
                }
            }
        }

        if self.db_path.exists() {
            if let Ok(conn) = self.get_db() {
                let _ = conn.execute("DELETE FROM logo_cache_meta;", []);
                let _ = conn.execute("VACUUM;", []);
            }
        }

        info!("[LogoCache] Cleared logo cache files and SQLite metadata");
        Ok(())
    }

    /// Prune expired entries and stale negative cache rows from SQLite and disk
    pub async fn prune(&self, max_bytes: u64, ttl_days: u32) -> Result<()> {
        if !self.db_path.exists() {
            return Ok(());
        }

        self.init().await?;
        let now = get_now_timestamp();

        // 1. Collect expired entries older than TTL before doing async disk ops
        let to_remove: Vec<(String, String)> = if ttl_days > 0 {
            let ttl_secs = i64::from(ttl_days) * 86400;
            let cutoff = now - ttl_secs;
            let conn = self.get_db()?;
            let mut stmt = conn.prepare(
                "SELECT url_hash, file_ext FROM logo_cache_meta WHERE last_fetched IS NOT NULL AND last_fetched < ?1",
            )?;
            let rows = stmt.query_map(params![cutoff], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.filter_map(|r| r.ok()).collect()
        } else {
            Vec::new()
        };

        for (hash, ext) in to_remove {
            let file_path = self.cache_dir.join(format!("{}.{}", hash, ext));
            let _ = fs::remove_file(&file_path).await;
            if let Ok(conn) = self.get_db() {
                let _ = conn.execute("DELETE FROM logo_cache_meta WHERE url_hash = ?1", params![hash]);
            }
        }

        // 2. Prune stale dead URL rows older than 30 days
        let dead_cutoff = now - STALE_DEAD_WINDOW_SECS;
        if let Ok(conn) = self.get_db() {
            let _ = conn.execute(
                "DELETE FROM logo_cache_meta WHERE fail_count >= ?1 AND last_failed_at IS NOT NULL AND last_failed_at < ?2",
                params![MAX_FAIL_COUNT, dead_cutoff],
            );
        }

        // 3. Enforce max_bytes limit if set
        if max_bytes > 0 {
            let conn = self.get_db()?;
            let total_size: u64 = conn
                .query_row("SELECT COALESCE(SUM(file_size), 0) FROM logo_cache_meta WHERE file_size > 0", [], |row| {
                    let s: i64 = row.get(0)?;
                    Ok(s as u64)
                })
                .unwrap_or(0);

            if total_size > max_bytes {
                let to_evict: Vec<(String, String, u64)> = {
                    let mut stmt = conn.prepare(
                        "SELECT url_hash, file_ext, file_size FROM logo_cache_meta WHERE file_size > 0 ORDER BY last_fetched ASC",
                    )?;
                    let rows = stmt.query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? as u64))
                    })?;
                    rows.filter_map(|r| r.ok()).collect()
                };

                let mut current_size = total_size;
                for (hash, ext, size) in to_evict {
                    if current_size <= max_bytes {
                        break;
                    }
                    let file_path = self.cache_dir.join(format!("{}.{}", hash, ext));
                    let _ = fs::remove_file(&file_path).await;
                    if let Ok(c) = self.get_db() {
                        let _ = c.execute("DELETE FROM logo_cache_meta WHERE url_hash = ?1", params![hash]);
                    }
                    current_size = current_size.saturating_sub(size);
                }
            }
        }

        Ok(())
    }
}
