//! Database operations for DVR
//!
//! Uses rusqlite with connection pooling (r2d2) for efficient concurrent access.
//! WAL mode is enabled for concurrent reads/writes with the frontend.

use anyhow::{Context, Result};
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, OptionalExtension};
use tauri::Manager;
use tracing::{debug, info, warn};

use crate::dvr::models::*;

/// Basic channel info for lookups
pub struct Channel {
    pub stream_id: String,
    pub name: String,
}

/// Database connection pool for DVR operations
pub struct DvrDatabase {
    pool: Pool<SqliteConnectionManager>,
}

impl DvrDatabase {
    /// Initialize the database with connection pool
    pub fn new(app_handle: &tauri::AppHandle) -> Result<Self> {
        // Get database path from Tauri
        let app_data_dir = app_handle
            .path()
            .app_data_dir()
            .context("Failed to get app data directory")?;

        let db_path = app_data_dir.join("ynotv.db");

        info!("Initializing DVR database at: {:?}", db_path);

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).context("Failed to create database directory")?;
        }

        // Create connection manager
        let manager = SqliteConnectionManager::file(&db_path);

        // Build connection pool with custom configuration
        let pool = Pool::builder()
            .max_size(5) // Max 5 concurrent connections
            .connection_timeout(std::time::Duration::from_secs(10))
            .build(manager)
            .context("Failed to create database pool")?;

        // Initialize database schema and settings
        let db = Self { pool };
        db.initialize_schema()?;
        db.configure_wal_mode()?;

        info!("DVR database initialized successfully");
        Ok(db)
    }

    /// Get a connection from the pool
    pub fn get_conn(&self) -> Result<PooledConnection<SqliteConnectionManager>> {
        self.pool.get().context("Failed to get database connection")
    }

    /// Initialize database schema
    fn initialize_schema(&self) -> Result<()> {
        println!("[DVR DB] initialize_schema starting...");
        let conn = self.get_conn()?;
        println!("[DVR DB] Got connection, creating tables...");

        // DVR Schedules table
        println!("[DVR DB] Creating dvr_schedules table...");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS dvr_schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                channel_name TEXT NOT NULL,
                program_title TEXT NOT NULL,
                scheduled_start INTEGER NOT NULL,
                scheduled_end INTEGER NOT NULL,
                start_padding_sec INTEGER DEFAULT 60,
                end_padding_sec INTEGER DEFAULT 300,
                status TEXT NOT NULL DEFAULT 'scheduled',
                series_match_title TEXT,
                recurrence TEXT,
                created_at INTEGER NOT NULL,
                started_at INTEGER,
                stream_url TEXT,
                FOREIGN KEY (source_id) REFERENCES sourcesMeta(source_id),
                FOREIGN KEY (channel_id) REFERENCES channels(stream_id)
            )",
            [],
        )?;

        // DVR Recordings table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS dvr_recordings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                schedule_id INTEGER,
                file_path TEXT NOT NULL UNIQUE,
                filename TEXT NOT NULL,
                channel_name TEXT NOT NULL,
                program_title TEXT NOT NULL,
                size_bytes INTEGER DEFAULT 0,
                scheduled_start INTEGER NOT NULL,
                scheduled_end INTEGER NOT NULL,
                actual_start INTEGER,
                actual_end INTEGER,
                status TEXT NOT NULL,
                error_message TEXT,
                auto_delete_policy TEXT DEFAULT 'space_needed',
                created_at INTEGER NOT NULL,
                FOREIGN KEY (schedule_id) REFERENCES dvr_schedules(id)
            )",
            [],
        )?;

        // DVR Settings table
        conn.execute(
            "CREATE TABLE IF NOT EXISTS dvr_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )?;

        // Indexes for performance
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dvr_schedules_status ON dvr_schedules(status)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dvr_schedules_time ON dvr_schedules(scheduled_start, scheduled_end)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dvr_schedules_source ON dvr_schedules(source_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dvr_recordings_schedule ON dvr_recordings(schedule_id)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dvr_recordings_status ON dvr_recordings(status)",
            [],
        )?;

        // Migration: Add stream_url column to existing databases
        // This handles databases created before the stream_url column was added
        println!("[DVR DB] Checking for stream_url column migration...");
        let _ = conn.execute("ALTER TABLE dvr_schedules ADD COLUMN stream_url TEXT", []); // Ignore error if column already exists
        println!("[DVR DB] Migration check complete");

        // Migration: Add thumbnail_path column to existing databases
        println!("[DVR DB] Checking for thumbnail_path column migration...");
        let _ = conn.execute(
            "ALTER TABLE dvr_recordings ADD COLUMN thumbnail_path TEXT",
            [],
        ); // Ignore error if column already exists
        println!("[DVR DB] thumbnail_path migration check complete");

        // Migration: Add airstamp column to tv_episodes for timezone-aware display
        println!("[DVR DB] Checking for airstamp column migration...");
        let _ = conn.execute(
            "ALTER TABLE tv_episodes ADD COLUMN airstamp TEXT",
            [],
        ); // Ignore error if column already exists
        println!("[DVR DB] airstamp migration check complete");

        // Migration: Add tvmaze_episode_id column to tv_episodes for episode detail lookups
        println!("[DVR DB] Checking for tvmaze_episode_id column migration...");
        let _ = conn.execute(
            "ALTER TABLE tv_episodes ADD COLUMN tvmaze_episode_id INTEGER",
            [],
        ); // Ignore error if column already exists
        let _ = conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tv_episodes_tvmaze_ep_id ON tv_episodes(tvmaze_episode_id)",
            [],
        );
        println!("[DVR DB] tvmaze_episode_id migration check complete");

        // Migration: Add auto-add to watchlist columns to tv_favorites
        println!("[DVR DB] Checking for auto-add watchlist columns migration...");
        let _ = conn.execute(
            "ALTER TABLE tv_favorites ADD COLUMN auto_add_to_watchlist INTEGER DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE tv_favorites ADD COLUMN watchlist_reminder_enabled INTEGER DEFAULT 1",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE tv_favorites ADD COLUMN watchlist_reminder_minutes INTEGER DEFAULT 5",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE tv_favorites ADD COLUMN watchlist_autoswitch_enabled INTEGER DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE tv_favorites ADD COLUMN watchlist_autoswitch_seconds INTEGER DEFAULT 30",
            [],
        );
        println!("[DVR DB] auto-add watchlist columns migration check complete");

        // Migration: Create table to track episodes auto-added to watchlist (prevents duplicates on sync)
        println!("[DVR DB] Creating tv_watchlist_added_episodes table...");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tv_watchlist_added_episodes (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                tvmaze_id           INTEGER NOT NULL,
                tvmaze_episode_id   INTEGER NOT NULL,
                added_at            TEXT DEFAULT (datetime('now')),
                UNIQUE(tvmaze_id, tvmaze_episode_id)
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_tv_watchlist_added ON tv_watchlist_added_episodes(tvmaze_id, tvmaze_episode_id)",
            [],
        )?;
        println!("[DVR DB] tv_watchlist_added_episodes table ready");

        // TVMaze tables for TV Show Calendar feature
        println!("[DVR DB] Creating TVMaze tables...");
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tv_favorites (
                id                              INTEGER PRIMARY KEY AUTOINCREMENT,
                tvmaze_id                       INTEGER UNIQUE NOT NULL,
                show_name                       TEXT NOT NULL,
                show_image                      TEXT,
                channel_name                    TEXT,
                channel_id                      TEXT,
                status                          TEXT,
                last_synced                     TEXT,
                added_at                        TEXT DEFAULT (datetime('now')),
                auto_add_to_watchlist           INTEGER DEFAULT 0,
                watchlist_reminder_enabled      INTEGER DEFAULT 1,
                watchlist_reminder_minutes      INTEGER DEFAULT 5,
                watchlist_autoswitch_enabled    INTEGER DEFAULT 0,
                watchlist_autoswitch_seconds    INTEGER DEFAULT 30
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS tv_episodes (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                tvmaze_id           INTEGER NOT NULL,
                tvmaze_episode_id   INTEGER UNIQUE,
                season              INTEGER,
                episode             INTEGER,
                episode_name        TEXT,
                airdate             TEXT,
                airtime             TEXT,
                airstamp            TEXT,
                runtime             INTEGER,
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

        println!("[DVR DB] Schema initialized successfully");
        debug!("Database schema initialized");
        Ok(())
    }

    /// Configure WAL mode for concurrent access and optimize for bulk operations
    fn configure_wal_mode(&self) -> Result<()> {
        println!("[DVR DB] configure_wal_mode starting...");
        let conn = self.get_conn()?;
        println!("[DVR DB] Got connection for WAL mode...");

        // Enable WAL mode for concurrent reads/writes
        // PRAGMA journal_mode returns the new mode, so we use query_row
        println!("[DVR DB] Setting journal_mode to WAL...");
        let journal_mode: String =
            conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        println!("[DVR DB] journal_mode = {}", journal_mode);

        // Optimize for bulk insert performance on modern hardware
        // These are best-effort - if they fail, we still proceed
        println!("[DVR DB] Setting performance pragmas (best effort)...");

        // Reduce fsync frequency for better write performance (safe with WAL)
        if let Err(e) = conn.execute("PRAGMA synchronous = NORMAL", []) {
            println!("[DVR DB] Warning: Could not set synchronous = NORMAL: {}", e);
        }

        // Use memory for temp storage (faster than disk)
        if let Err(e) = conn.execute("PRAGMA temp_store = MEMORY", []) {
            println!("[DVR DB] Warning: Could not set temp_store = MEMORY: {}", e);
        }

        // Larger cache size for better performance (64MB)
        if let Err(e) = conn.execute("PRAGMA cache_size = -64000", []) {
            println!("[DVR DB] Warning: Could not set cache_size: {}", e);
        }

        // Allow WAL file to grow large before checkpointing
        if let Err(e) = conn.execute("PRAGMA wal_autocheckpoint = 10000", []) {
            println!("[DVR DB] Warning: Could not set wal_autocheckpoint: {}", e);
        }

        info!("Database journal mode: {}, optimized for bulk operations", journal_mode);

        if journal_mode != "wal" {
            warn!("WAL mode not enabled, got: {}", journal_mode);
        }

        println!(
            "[DVR DB] WAL mode configured successfully: {} (optimized for bulk inserts)",
            journal_mode
        );
        Ok(())
    }

    /// Get all scheduled recordings that need to start
    pub fn get_scheduled_recordings(
        &self,
        now: i64,
        window_seconds: i64,
        grace_period_seconds: i64,
    ) -> Result<Vec<Schedule>> {
        println!(
            "[DVR DB] get_scheduled_recordings called: now={}, window={}, grace={}",
            now, window_seconds, grace_period_seconds
        );

        let conn = self.get_conn()?;

        // Debug: Show all scheduled records
        let all_scheduled: Vec<(i64, String, i64, i64, String)> = conn.prepare(
            "SELECT id, program_title, scheduled_start, scheduled_end, status FROM dvr_schedules WHERE status = 'scheduled'"
        )?.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?.collect::<Result<Vec<_>, _>>()?;

        println!(
            "[DVR DB] All scheduled records ({} total):",
            all_scheduled.len()
        );
        for (id, title, start, end, status) in all_scheduled {
            let start_padding: i32 = conn
                .query_row(
                    "SELECT start_padding_sec FROM dvr_schedules WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap_or(60);
            let actual_start = start - start_padding as i64;
            println!(
                "[DVR DB]   ID {}: '{}' start={} (actual={}) end={} status={}",
                id, title, start, actual_start, end, status
            );
        }

        let mut stmt = conn.prepare(
            "SELECT * FROM dvr_schedules
             WHERE status = 'scheduled'
             AND (
                 -- Upcoming recordings within window
                 ((scheduled_start - start_padding_sec) <= ?1 AND (scheduled_start - start_padding_sec) >= ?2)
                 OR
                 -- Missed recordings within grace period
                 (scheduled_start <= ?1 AND scheduled_start >= ?3 AND started_at IS NULL)
             )
             ORDER BY scheduled_start ASC"
        )?;

        let upcoming = now + window_seconds;
        let window_start = now - window_seconds;
        let grace_start = now - grace_period_seconds;

        let schedules = stmt.query_map(params![upcoming, window_start, grace_start], |row| {
            let status_str: String = row.get("status")?;
            Ok(Schedule {
                id: row.get("id")?,
                source_id: row.get("source_id")?,
                channel_id: row.get("channel_id")?,
                channel_name: row.get("channel_name")?,
                program_title: row.get("program_title")?,
                scheduled_start: row.get("scheduled_start")?,
                scheduled_end: row.get("scheduled_end")?,
                start_padding_sec: row.get("start_padding_sec")?,
                end_padding_sec: row.get("end_padding_sec")?,
                status: status_str.parse().unwrap_or(ScheduleStatus::Scheduled),
                series_match_title: row.get("series_match_title")?,
                recurrence: row.get("recurrence")?,
                created_at: row.get("created_at")?,
                started_at: row.get("started_at")?,
                stream_url: row.get("stream_url")?,
            })
        })?;

        let mut result = Vec::new();
        for schedule in schedules {
            result.push(schedule?);
        }

        println!(
            "[DVR DB] Query found {} recordings ready to start",
            result.len()
        );
        for schedule in &result {
            println!(
                "[DVR DB]   -> ID {}: '{}' (actual_start={})",
                schedule.id,
                schedule.program_title,
                schedule.actual_start()
            );
        }

        Ok(result)
    }

    /// Count scheduled recordings (lightweight check)
    pub fn count_scheduled(&self) -> Result<i64> {
        let conn = self.get_conn()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM dvr_schedules WHERE status = 'scheduled'",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Add a new recording schedule
    pub fn add_schedule(&self, request: &ScheduleRequest) -> Result<i64> {
        println!(
            "[DVR DB] add_schedule called for: {}",
            request.program_title
        );

        let conn = self.get_conn()?;
        println!("[DVR DB] Got database connection");

        // First check if table exists and its schema
        let table_info: Vec<(i32, String, String, i32, Option<String>, i32)> = conn
            .prepare("PRAGMA table_info(dvr_schedules)")?
            .query_map([], |row| {
                Ok((
                    row.get(0)?,                      // cid
                    row.get(1)?,                      // name
                    row.get(2)?,                      // type
                    row.get(3)?,                      // notnull
                    row.get::<_, Option<String>>(4)?, // dflt_value
                    row.get(5)?,                      // pk
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        println!("[DVR DB] dvr_schedules schema:");
        for (cid, name, typ, notnull, dflt, pk) in table_info {
            println!(
                "[DVR DB]   {}: {} (type={}, notnull={}, pk={}, default={:?})",
                cid, name, typ, notnull, pk, dflt
            );
        }

        // Count existing records before insert
        let count_before: i64 =
            conn.query_row("SELECT COUNT(*) FROM dvr_schedules", [], |row| row.get(0))?;
        println!("[DVR DB] Record count before insert: {}", count_before);

        // Get max ID before insert
        let max_id: Option<i64> = conn
            .query_row("SELECT MAX(id) FROM dvr_schedules", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .optional()?
            .flatten();
        println!("[DVR DB] Max ID before insert: {:?}", max_id);

        println!("[DVR DB] Executing INSERT...");
        let result = conn.execute(
            "INSERT INTO dvr_schedules (
                source_id, channel_id, channel_name, program_title,
                scheduled_start, scheduled_end, start_padding_sec, end_padding_sec,
                series_match_title, recurrence, status, created_at, stream_url
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'scheduled', ?11, ?12)",
            params![
                request.source_id,
                request.channel_id,
                request.channel_name,
                request.program_title,
                request.scheduled_start,
                request.scheduled_end,
                request.start_padding_sec,
                request.end_padding_sec,
                request.series_match_title,
                request.recurrence,
                chrono::Utc::now().timestamp(),
                request.stream_url
            ],
        )?;
        println!("[DVR DB] INSERT affected {} rows", result);

        let id = conn.last_insert_rowid();
        println!("[DVR DB] last_insert_rowid() returned: {}", id);

        // Verify the insert
        let count_after: i64 =
            conn.query_row("SELECT COUNT(*) FROM dvr_schedules", [], |row| row.get(0))?;
        println!("[DVR DB] Record count after insert: {}", count_after);

        // Verify the record exists
        let verify: Option<i64> = conn
            .query_row(
                "SELECT id FROM dvr_schedules WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        println!(
            "[DVR DB] Verification - record with ID {} exists: {}",
            id,
            verify.is_some()
        );

        info!("Added schedule {}: {}", id, request.program_title);
        Ok(id)
    }

    /// Update schedule status
    pub fn update_schedule_status(&self, id: i64, status: ScheduleStatus) -> Result<()> {
        let conn = self.get_conn()?;

        let mut stmt = if status == ScheduleStatus::Recording {
            conn.prepare("UPDATE dvr_schedules SET status = ?1, started_at = ?2 WHERE id = ?3")?
        } else {
            conn.prepare("UPDATE dvr_schedules SET status = ?1 WHERE id = ?2")?
        };

        if status == ScheduleStatus::Recording {
            stmt.execute(params![status.as_str(), chrono::Utc::now().timestamp(), id])?;
        } else {
            stmt.execute(params![status.as_str(), id])?;
        }

        debug!("Updated schedule {} to {:?}", id, status);
        Ok(())
    }

    /// Cancel a scheduled recording
    pub fn cancel_schedule(&self, id: i64) -> Result<()> {
        let conn = self.get_conn()?;

        conn.execute(
            "UPDATE dvr_schedules SET status = 'canceled' WHERE id = ?1 AND status = 'scheduled'",
            params![id],
        )?;

        info!("Canceled schedule {}", id);
        Ok(())
    }

    /// Update the stream_url for a schedule
    pub fn update_schedule_stream_url(&self, id: i64, stream_url: &str) -> Result<()> {
        let conn = self.get_conn()?;

        conn.execute(
            "UPDATE dvr_schedules SET stream_url = ?1 WHERE id = ?2",
            params![stream_url, id],
        )?;

        info!("Updated stream_url for schedule {}", id);
        Ok(())
    }

    /// Update schedule padding times
    pub fn update_schedule_paddings(
        &self,
        id: i64,
        start_padding_sec: i64,
        end_padding_sec: i64,
    ) -> Result<()> {
        let conn = self.get_conn()?;

        conn.execute(
            "UPDATE dvr_schedules SET start_padding_sec = ?1, end_padding_sec = ?2 WHERE id = ?3",
            params![start_padding_sec, end_padding_sec, id],
        )?;

        info!(
            "Updated padding for schedule {}: start={}, end={}",
            id, start_padding_sec, end_padding_sec
        );
        Ok(())
    }

    /// Get schedule by ID
    pub fn get_schedule(&self, id: i64) -> Result<Option<Schedule>> {
        let conn = self.get_conn()?;

        let schedule = conn
            .query_row(
                "SELECT * FROM dvr_schedules WHERE id = ?1",
                params![id],
                |row| {
                    let status_str: String = row.get("status")?;
                    Ok(Schedule {
                        id: row.get("id")?,
                        source_id: row.get("source_id")?,
                        channel_id: row.get("channel_id")?,
                        channel_name: row.get("channel_name")?,
                        program_title: row.get("program_title")?,
                        scheduled_start: row.get("scheduled_start")?,
                        scheduled_end: row.get("scheduled_end")?,
                        start_padding_sec: row.get("start_padding_sec")?,
                        end_padding_sec: row.get("end_padding_sec")?,
                        status: status_str.parse().unwrap_or(ScheduleStatus::Scheduled),
                        series_match_title: row.get("series_match_title")?,
                        recurrence: row.get("recurrence")?,
                        created_at: row.get("created_at")?,
                        started_at: row.get("started_at")?,
                        stream_url: row.get("stream_url")?,
                    })
                },
            )
            .optional()?;

        Ok(schedule)
    }

    /// Add a new recording entry
    pub fn add_recording(
        &self,
        schedule_id: i64,
        file_path: &str,
        filename: &str,
        channel_name: &str,
        program_title: &str,
        scheduled_start: i64,
        scheduled_end: i64,
    ) -> Result<i64> {
        let conn = self.get_conn()?;

        conn.execute(
            "INSERT INTO dvr_recordings (
                schedule_id, file_path, filename, channel_name, program_title,
                scheduled_start, scheduled_end, actual_start, status, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'recording', ?9)",
            params![
                schedule_id,
                file_path,
                filename,
                channel_name,
                program_title,
                scheduled_start,
                scheduled_end,
                chrono::Utc::now().timestamp(),
                chrono::Utc::now().timestamp()
            ],
        )?;

        let id = conn.last_insert_rowid();
        info!("Added recording {} for schedule {}", id, schedule_id);

        Ok(id)
    }

    /// Update recording status
    pub fn update_recording_status(
        &self,
        id: i64,
        status: RecordingStatus,
        size_bytes: Option<i64>,
        error_message: Option<&str>,
    ) -> Result<()> {
        let conn = self.get_conn()?;

        conn.execute(
            "UPDATE dvr_recordings SET
                status = ?1,
                size_bytes = COALESCE(?2, size_bytes),
                error_message = ?3,
                actual_end = CASE WHEN ?1 IN ('completed', 'failed', 'partial') THEN ?4 ELSE actual_end END
             WHERE id = ?5",
            params![
                status.as_str(),
                size_bytes,
                error_message,
                chrono::Utc::now().timestamp(),
                id
            ]
        )?;

        debug!("Updated recording {} to {:?}", id, status);
        Ok(())
    }

    /// Update recording file size
    pub fn update_recording_size(&self, id: i64, size_bytes: i64) -> Result<()> {
        let conn = self.get_conn()?;

        conn.execute(
            "UPDATE dvr_recordings SET size_bytes = ?1 WHERE id = ?2",
            params![size_bytes, id],
        )?;

        Ok(())
    }

    /// Update recording thumbnail path
    pub fn update_recording_thumbnail(&self, id: i64, thumbnail_path: &str) -> Result<()> {
        let conn = self.get_conn()?;

        conn.execute(
            "UPDATE dvr_recordings SET thumbnail_path = ?1 WHERE id = ?2",
            params![thumbnail_path, id],
        )?;

        info!("Updated thumbnail for recording {}: {}", id, thumbnail_path);
        Ok(())
    }

    /// Get recording by ID
    pub fn get_recording(&self, id: i64) -> Result<Option<Recording>> {
        let conn = self.get_conn()?;

        let recording = conn
            .query_row(
                "SELECT * FROM dvr_recordings WHERE id = ?1",
                params![id],
                |row| {
                    let status_str: String = row.get("status")?;
                    Ok(Recording {
                        id: row.get("id")?,
                        schedule_id: row.get("schedule_id")?,
                        file_path: row.get("file_path")?,
                        filename: row.get("filename")?,
                        channel_name: row.get("channel_name")?,
                        program_title: row.get("program_title")?,
                        size_bytes: row.get("size_bytes")?,
                        scheduled_start: row.get("scheduled_start")?,
                        scheduled_end: row.get("scheduled_end")?,
                        actual_start: row.get("actual_start")?,
                        actual_end: row.get("actual_end")?,
                        status: status_str.parse().unwrap_or(RecordingStatus::Failed),
                        error_message: row.get("error_message")?,
                        auto_delete_policy: row.get("auto_delete_policy")?,
                        created_at: row.get("created_at")?,
                        thumbnail_path: row.get("thumbnail_path")?,
                    })
                },
            )
            .optional()?;

        Ok(recording)
    }

    /// Get completed recordings for cleanup
    pub fn get_completed_recordings(&self) -> Result<Vec<Recording>> {
        let conn = self.get_conn()?;

        let mut stmt = conn.prepare(
            "SELECT * FROM dvr_recordings
             WHERE status IN ('completed', 'partial')
             ORDER BY actual_end DESC",
        )?;

        let recordings = stmt.query_map([], |row| {
            let status_str: String = row.get("status")?;
            Ok(Recording {
                id: row.get("id")?,
                schedule_id: row.get("schedule_id")?,
                file_path: row.get("file_path")?,
                filename: row.get("filename")?,
                channel_name: row.get("channel_name")?,
                program_title: row.get("program_title")?,
                size_bytes: row.get("size_bytes")?,
                scheduled_start: row.get("scheduled_start")?,
                scheduled_end: row.get("scheduled_end")?,
                actual_start: row.get("actual_start")?,
                actual_end: row.get("actual_end")?,
                status: status_str.parse().unwrap_or(RecordingStatus::Failed),
                error_message: row.get("error_message")?,
                auto_delete_policy: row.get("auto_delete_policy")?,
                created_at: row.get("created_at")?,
                thumbnail_path: row.get("thumbnail_path")?,
            })
        })?;

        let mut result = Vec::new();
        for recording in recordings {
            result.push(recording?);
        }

        Ok(result)
    }

    /// Delete a recording entry and return file path and thumbnail path for deletion
    pub fn delete_recording(&self, id: i64) -> Result<Option<(String, Option<String>)>> {
        let conn = self.get_conn()?;

        // Get file path and thumbnail path first
        let (file_path, thumbnail_path): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT file_path, thumbnail_path FROM dvr_recordings WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, None));

        // Delete from database
        conn.execute("DELETE FROM dvr_recordings WHERE id = ?1", params![id])?;

        info!("Deleted recording {} from database", id);
        Ok(file_path.map(|fp| (fp, thumbnail_path)))
    }

    /// Get DVR settings
    pub fn get_settings(&self) -> Result<DvrSettings> {
        let conn = self.get_conn()?;

        let mut settings = DvrSettings::default();

        let mut stmt = conn.prepare("SELECT key, value FROM dvr_settings")?;
        let rows = stmt.query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })?;

        for row in rows {
            let (key, value) = row?;
            match key.as_str() {
                "storage_path" => settings.storage_path = value,
                "max_disk_usage_percent" => {
                    if let Ok(v) = value.parse() {
                        settings.max_disk_usage_percent = v;
                    }
                }
                "auto_cleanup_enabled" => {
                    settings.auto_cleanup_enabled = value == "true" || value == "1";
                }
                "default_start_padding_sec" => {
                    if let Ok(v) = value.parse() {
                        settings.default_start_padding_sec = v;
                    }
                }
                "default_end_padding_sec" => {
                    if let Ok(v) = value.parse() {
                        settings.default_end_padding_sec = v;
                    }
                }
                "keep_recordings_days" => {
                    if let Ok(v) = value.parse() {
                        settings.keep_recordings_days = Some(v);
                    }
                }
                _ => {}
            }
        }

        Ok(settings)
    }

    /// Save DVR setting
    pub fn save_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.get_conn()?;

        conn.execute(
            "INSERT INTO dvr_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;

        Ok(())
    }

    /// Check for scheduling conflicts with connection limit awareness
    ///
    /// Returns conflicting schedules and indicates if max_connections would be exceeded.
    /// For single-connection sources, any overlap is a conflict.
    pub fn check_conflicts(
        &self,
        source_id: &str,
        start: i64,
        end: i64,
    ) -> Result<(Vec<Schedule>, Option<i32>)> {
        let conn = self.get_conn()?;

        // Get max_connections for this source
        let max_connections: Option<i32> = conn
            .query_row(
                "SELECT max_connections FROM sourcesMeta WHERE source_id = ?1",
                [source_id],
                |row| row.get(0),
            )
            .optional()?;

        // Find overlapping schedules
        let mut stmt = conn.prepare(
            "SELECT * FROM dvr_schedules
             WHERE source_id = ?1
             AND status IN ('scheduled', 'recording')
             AND NOT (scheduled_end <= ?2 OR scheduled_start >= ?3)",
        )?;

        let conflicts = stmt.query_map(params![source_id, start, end], |row| {
            let status_str: String = row.get("status")?;
            Ok(Schedule {
                id: row.get("id")?,
                source_id: row.get("source_id")?,
                channel_id: row.get("channel_id")?,
                channel_name: row.get("channel_name")?,
                program_title: row.get("program_title")?,
                scheduled_start: row.get("scheduled_start")?,
                scheduled_end: row.get("scheduled_end")?,
                start_padding_sec: row.get("start_padding_sec")?,
                end_padding_sec: row.get("end_padding_sec")?,
                status: status_str.parse().unwrap_or(ScheduleStatus::Scheduled),
                series_match_title: row.get("series_match_title")?,
                recurrence: row.get("recurrence")?,
                created_at: row.get("created_at")?,
                started_at: row.get("started_at")?,
                stream_url: row.get("stream_url")?,
            })
        })?;

        let mut result = Vec::new();
        for conflict in conflicts {
            result.push(conflict?);
        }

        Ok((result, max_connections))
    }

    /// Get max connections for a source
    pub fn get_max_connections(&self, source_id: &str) -> Result<Option<i32>> {
        let conn = self.get_conn()?;

        let max_connections: Option<i32> = conn
            .query_row(
                "SELECT max_connections FROM sourcesMeta WHERE source_id = ?1",
                [source_id],
                |row| row.get(0),
            )
            .optional()?;

        Ok(max_connections)
    }

    // TVMaze / TV Calendar methods

    pub fn tvmaze_add_favorite(
        &self,
        tvmaze_id: i64,
        show_name: &str,
        show_image: Option<&str>,
        channel_name: Option<&str>,
        channel_id: Option<&str>,
        status: Option<&str>,
    ) -> Result<()> {
        println!("[TVMaze DB] Adding favorite: id={}, name={}", tvmaze_id, show_name);
        let conn = self.get_conn()?;
        let rows = conn.execute(
            "INSERT OR IGNORE INTO tv_favorites
             (tvmaze_id, show_name, show_image, channel_name, channel_id, status, last_synced)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))",
            params![tvmaze_id, show_name, show_image, channel_name, channel_id, status],
        )?;
        println!("[TVMaze DB] Insert affected {} rows", rows);
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
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM tv_favorites", [], |r| r.get(0))?;
        println!("[TVMaze DB] get_favorites: found {} favorites in DB", count);

        let mut stmt = conn.prepare(
            "SELECT tvmaze_id, show_name, show_image, channel_name, channel_id, status, last_synced,
                    auto_add_to_watchlist, watchlist_reminder_enabled, watchlist_reminder_minutes,
                    watchlist_autoswitch_enabled, watchlist_autoswitch_seconds
             FROM tv_favorites ORDER BY show_name ASC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(crate::tvmaze::TrackedShow {
                tvmaze_id:                      row.get(0)?,
                show_name:                      row.get(1)?,
                show_image:                     row.get(2)?,
                channel_name:                   row.get(3)?,
                channel_id:                     row.get(4)?,
                status:                         row.get(5)?,
                last_synced:                    row.get(6)?,
                auto_add_to_watchlist:          row.get::<_, Option<i64>>(7)?.unwrap_or(0) != 0,
                watchlist_reminder_enabled:     row.get::<_, Option<i64>>(8)?.unwrap_or(1) != 0,
                watchlist_reminder_minutes:     row.get::<_, Option<i64>>(9)?.unwrap_or(5) as i32,
                watchlist_autoswitch_enabled:   row.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0,
                watchlist_autoswitch_seconds:   row.get::<_, Option<i64>>(11)?.unwrap_or(30) as i32,
            })
        })?;
        let result = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(anyhow::Error::from)?;
        println!("[TVMaze DB] get_favorites: returning {} shows", result.len());
        Ok(result)
    }

    pub fn tvmaze_upsert_episodes(
        &self,
        tvmaze_id: i64,
        episodes: &[crate::tvmaze::EpisodeRow],
    ) -> Result<()> {
        println!("[TVMaze DB] upsert_episodes: tvmaze_id={}, {} episodes", tvmaze_id, episodes.len());
        let conn = self.get_conn()?;
        let deleted = conn.execute("DELETE FROM tv_episodes WHERE tvmaze_id = ?1", params![tvmaze_id])?;
        println!("[TVMaze DB] upsert_episodes: deleted {} old episodes", deleted);
        for (i, ep) in episodes.iter().enumerate() {
            conn.execute(
                "INSERT INTO tv_episodes
                 (tvmaze_id, tvmaze_episode_id, season, episode, episode_name, airdate, airtime, airstamp, runtime)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![tvmaze_id, ep.tvmaze_episode_id, ep.season, ep.episode, ep.episode_name, ep.airdate, ep.airtime, ep.airstamp, ep.runtime],
            )?;
            if i < 3 {
                // Log first 3 episodes for debugging
                println!("[TVMaze DB] upsert_episodes: inserted ep {}: tvmaze_episode_id={} S{}E{} airdate={}",
                    i, ep.tvmaze_episode_id, ep.season.unwrap_or(-1), ep.episode.unwrap_or(-1), ep.airdate.as_deref().unwrap_or("NULL"));
            }
        }
        println!("[TVMaze DB] upsert_episodes: done");
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
        &self,
        month_prefix: &str,
    ) -> Result<Vec<crate::tvmaze::CalendarEpisode>> {
        let conn = self.get_conn()?;
        let like_pattern = format!("{}%", month_prefix);
        println!("[TVMaze DB] get_calendar_episodes: month_prefix={}, pattern={}", month_prefix, like_pattern);

        // Check all unique airdates in the database for debugging
        let mut date_stmt = conn.prepare("SELECT DISTINCT airdate FROM tv_episodes WHERE airdate IS NOT NULL ORDER BY airdate DESC LIMIT 20")?;
        let dates: Vec<String> = date_stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        println!("[TVMaze DB] Recent airdates in DB: {:?}", dates);

        // Check specifically for 2026 dates
        let mut future_stmt = conn.prepare("SELECT DISTINCT airdate FROM tv_episodes WHERE airdate LIKE '2026-%' ORDER BY airdate")?;
        let future_dates: Vec<String> = future_stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        println!("[TVMaze DB] 2026 airdates in DB: {:?}", future_dates);

        // Check specifically for Storage Wars (tvmaze_id=860) 2026 dates
        let mut sw_stmt = conn.prepare("SELECT season, episode, airdate FROM tv_episodes WHERE tvmaze_id=860 AND airdate LIKE '2026-%' ORDER BY airdate")?;
        let sw_rows = sw_stmt.query_map([], |r| {
            let season: i64 = r.get(0)?;
            let episode: i64 = r.get(1)?;
            let date: String = r.get(2)?;
            Ok((season, episode, date))
        })?.collect::<Result<Vec<_>, _>>()?;
        println!("[TVMaze DB] Storage Wars 2026 episodes: {:?}", sw_rows);

        // Check for data without the JOIN (raw episodes)
        let raw_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tv_episodes WHERE airdate LIKE ?1",
            params![like_pattern],
            |r| r.get(0)
        )?;
        println!("[TVMaze DB] Raw episode count (no join): {}", raw_count);

        // Check episode count
        let ep_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tv_episodes WHERE airdate LIKE ?1",
            params![like_pattern],
            |r| r.get(0)
        )?;
        println!("[TVMaze DB] get_calendar_episodes: found {} episodes matching pattern", ep_count);

        let mut stmt = conn.prepare(
            "SELECT e.tvmaze_episode_id, e.airdate, e.airtime, e.airstamp, e.episode_name, e.season, e.episode,
                    f.show_name, f.channel_name, f.show_image
             FROM tv_episodes e
             JOIN tv_favorites f ON f.tvmaze_id = e.tvmaze_id
             WHERE e.airdate LIKE ?1
             ORDER BY e.airdate ASC, e.airtime ASC"
        )?;
        let rows = stmt.query_map(params![like_pattern], |row| {
            Ok(crate::tvmaze::CalendarEpisode {
                tvmaze_episode_id: row.get(0)?,
                airdate:           row.get(1)?,
                airtime:           row.get(2)?,
                airstamp:          row.get(3)?,
                episode_name:      row.get(4)?,
                season:            row.get(5)?,
                episode:           row.get(6)?,
                show_name:         row.get(7)?,
                channel_name:      row.get(8)?,
                show_image:        row.get(9)?,
            })
        })?;
        let result = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(anyhow::Error::from)?;
        println!("[TVMaze DB] get_calendar_episodes: returning {} episodes", result.len());
        Ok(result)
    }

    pub fn tvmaze_get_running_shows(&self) -> Result<Vec<(i64, String)>> {
        let conn = self.get_conn()?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM tv_favorites WHERE status = 'Running'", [], |r| r.get(0))?;
        println!("[TVMaze DB] get_running_shows: found {} running shows", count);

        let mut stmt = conn.prepare(
            "SELECT tvmaze_id, show_name FROM tv_favorites WHERE status = 'Running'"
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        let result = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(anyhow::Error::from)?;
        println!("[TVMaze DB] get_running_shows: returning {} shows", result.len());
        Ok(result)
    }

    pub fn tvmaze_update_channel(
        &self,
        tvmaze_id: i64,
        channel_id: Option<&str>,
        channel_name: Option<&str>,
    ) -> Result<()> {
        println!("[TVMaze DB] update_channel: tvmaze_id={}, channel_id={:?}, channel_name={:?}",
            tvmaze_id, channel_id, channel_name);
        let conn = self.get_conn()?;

        // First check if the show exists
        let exists: bool = conn.query_row(
            "SELECT 1 FROM tv_favorites WHERE tvmaze_id = ?1",
            params![tvmaze_id],
            |_row| Ok(true)
        ).optional()?.unwrap_or(false);
        println!("[TVMaze DB] update_channel: show exists={}", exists);

        if !exists {
            println!("[TVMaze DB] update_channel: ERROR - Show with tvmaze_id={} not found!", tvmaze_id);
            return Err(anyhow::anyhow!("Show not found in favorites"));
        }

        let rows_affected = conn.execute(
            "UPDATE tv_favorites SET channel_id = ?1, channel_name = ?2 WHERE tvmaze_id = ?3",
            params![channel_id, channel_name, tvmaze_id],
        )?;
        println!("[TVMaze DB] update_channel: done, rows_affected={}", rows_affected);

        if rows_affected == 0 {
            println!("[TVMaze DB] update_channel: WARNING - No rows were updated!");
        }

        Ok(())
    }

    pub fn tvmaze_update_watchlist_settings(
        &self,
        tvmaze_id: i64,
        auto_add: bool,
        reminder_enabled: bool,
        reminder_minutes: i32,
        autoswitch_enabled: bool,
        autoswitch_seconds: i32,
    ) -> Result<()> {
        println!("[TVMaze DB] update_watchlist_settings: tvmaze_id={}, auto_add={}",
            tvmaze_id, auto_add);
        let conn = self.get_conn()?;
        conn.execute(
            "UPDATE tv_favorites SET
                auto_add_to_watchlist = ?1,
                watchlist_reminder_enabled = ?2,
                watchlist_reminder_minutes = ?3,
                watchlist_autoswitch_enabled = ?4,
                watchlist_autoswitch_seconds = ?5
             WHERE tvmaze_id = ?6",
            params![
                auto_add as i64,
                reminder_enabled as i64,
                reminder_minutes,
                autoswitch_enabled as i64,
                autoswitch_seconds,
                tvmaze_id
            ],
        )?;
        println!("[TVMaze DB] update_watchlist_settings: done");
        Ok(())
    }

    /// Check if an episode has already been auto-added to watchlist
    pub fn tvmaze_is_episode_added_to_watchlist(&self, tvmaze_id: i64, tvmaze_episode_id: i64) -> Result<bool> {
        let conn = self.get_conn()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tv_watchlist_added_episodes WHERE tvmaze_id = ?1 AND tvmaze_episode_id = ?2",
            params![tvmaze_id, tvmaze_episode_id],
            |r| r.get(0),
        )?;
        Ok(count > 0)
    }

    /// Mark an episode as auto-added to watchlist
    pub fn tvmaze_mark_episode_added_to_watchlist(&self, tvmaze_id: i64, tvmaze_episode_id: i64) -> Result<()> {
        let conn = self.get_conn()?;
        conn.execute(
            "INSERT OR IGNORE INTO tv_watchlist_added_episodes (tvmaze_id, tvmaze_episode_id) VALUES (?1, ?2)",
            params![tvmaze_id, tvmaze_episode_id],
        )?;
        Ok(())
    }

    /// Clear all tracked episodes for a show (when user clears watchlist)
    pub fn tvmaze_clear_show_added_episodes(&self, tvmaze_id: i64) -> Result<usize> {
        let conn = self.get_conn()?;
        let count = conn.execute(
            "DELETE FROM tv_watchlist_added_episodes WHERE tvmaze_id = ?1",
            params![tvmaze_id],
        )?;
        println!("[TVMaze DB] Cleared {} tracked episodes for show {}", count, tvmaze_id);
        Ok(count)
    }

    /// Get show's watchlist auto-add settings
    pub fn tvmaze_get_watchlist_settings(&self, tvmaze_id: i64) -> Result<Option<(bool, bool, i32, bool, i32)>> {
        let conn = self.get_conn()?;
        let result = conn.query_row(
            "SELECT auto_add_to_watchlist, watchlist_reminder_enabled, watchlist_reminder_minutes,
                    watchlist_autoswitch_enabled, watchlist_autoswitch_seconds
             FROM tv_favorites WHERE tvmaze_id = ?1",
            params![tvmaze_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?.unwrap_or(0) != 0,
                    row.get::<_, Option<i64>>(1)?.unwrap_or(1) != 0,
                    row.get::<_, Option<i64>>(2)?.unwrap_or(5) as i32,
                    row.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0,
                    row.get::<_, Option<i64>>(4)?.unwrap_or(30) as i32,
                ))
            },
        ).optional()?;
        Ok(result)
    }

    /// Get channel by stream_id
    pub fn get_channel_by_id(&self, stream_id: &str) -> Result<Option<Channel>> {
        let conn = self.get_conn()?;
        let channel = conn
            .query_row(
                "SELECT stream_id, name FROM channels WHERE stream_id = ?1",
                params![stream_id],
                |row| {
                    Ok(Channel {
                        stream_id: row.get(0)?,
                        name: row.get(1)?,
                    })
                },
            )
            .optional()?;
        Ok(channel)
    }

    /// Get show's assigned channel_id
    pub fn tvmaze_get_show_channel(&self, tvmaze_id: i64) -> Result<Option<String>> {
        let conn = self.get_conn()?;
        let channel_id: Option<String> = conn
            .query_row(
                "SELECT channel_id FROM tv_favorites WHERE tvmaze_id = ?1",
                params![tvmaze_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(channel_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: Tests would need a mock AppHandle or use temp files
    // For now, we're skipping tests in this module
}
