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

        println!("[DVR DB] Schema initialized successfully");
        debug!("Database schema initialized");
        Ok(())
    }

    /// Configure WAL mode for concurrent access
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

        // Note: Other PRAGMAs omitted due to inconsistent behavior between
        // SQLite versions. The defaults are acceptable for DVR functionality.
        // journal_mode=WAL is the critical one for concurrent access.

        info!("Database journal mode: {}", journal_mode);

        if journal_mode != "wal" {
            warn!("WAL mode not enabled, got: {}", journal_mode);
        }

        println!(
            "[DVR DB] WAL mode configured successfully: {}",
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
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: Tests would need a mock AppHandle or use temp files
    // For now, we're skipping tests in this module
}
