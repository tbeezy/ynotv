//! Data models for DVR operations

// chrono types imported when needed
use serde::{Deserialize, Serialize};

/// Status of a scheduled recording
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleStatus {
    Scheduled,
    Recording,
    Completed,
    Failed,
    Canceled,
}

impl ScheduleStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScheduleStatus::Scheduled => "scheduled",
            ScheduleStatus::Recording => "recording",
            ScheduleStatus::Completed => "completed",
            ScheduleStatus::Failed => "failed",
            ScheduleStatus::Canceled => "canceled",
        }
    }
}

impl std::str::FromStr for ScheduleStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "scheduled" => Ok(ScheduleStatus::Scheduled),
            "recording" => Ok(ScheduleStatus::Recording),
            "completed" => Ok(ScheduleStatus::Completed),
            "failed" => Ok(ScheduleStatus::Failed),
            "canceled" => Ok(ScheduleStatus::Canceled),
            _ => Err(format!("Unknown schedule status: {}", s)),
        }
    }
}

/// Status of a recording file
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingStatus {
    Recording,
    Completed,
    Failed,
    Partial,
}

impl RecordingStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RecordingStatus::Recording => "recording",
            RecordingStatus::Completed => "completed",
            RecordingStatus::Failed => "failed",
            RecordingStatus::Partial => "partial",
        }
    }
}

impl std::str::FromStr for RecordingStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "recording" => Ok(RecordingStatus::Recording),
            "completed" => Ok(RecordingStatus::Completed),
            "failed" => Ok(RecordingStatus::Failed),
            "partial" => Ok(RecordingStatus::Partial),
            _ => Err(format!("Unknown recording status: {}", s)),
        }
    }
}

/// A scheduled recording from the database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schedule {
    pub id: i64,
    pub source_id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub program_title: String,
    pub scheduled_start: i64, // Unix timestamp
    pub scheduled_end: i64,   // Unix timestamp
    pub start_padding_sec: i32,
    pub end_padding_sec: i32,
    pub status: ScheduleStatus,
    pub series_match_title: Option<String>,
    pub recurrence: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    /// Pre-resolved stream URL (optional, for sources that need URL regeneration)
    pub stream_url: Option<String>,
}

impl Schedule {
    /// Calculate the actual start time accounting for padding
    pub fn actual_start(&self) -> i64 {
        self.scheduled_start - self.start_padding_sec as i64
    }

    /// Calculate the actual end time accounting for padding
    pub fn actual_end(&self) -> i64 {
        self.scheduled_end + self.end_padding_sec as i64
    }
}

/// A completed or in-progress recording file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recording {
    pub id: i64,
    pub schedule_id: Option<i64>,
    pub file_path: String,
    pub filename: String,
    pub channel_name: String,
    pub program_title: String,
    pub size_bytes: Option<i64>,
    pub scheduled_start: i64,
    pub scheduled_end: i64,
    pub actual_start: Option<i64>,
    pub actual_end: Option<i64>,
    pub status: RecordingStatus,
    pub error_message: Option<String>,
    pub auto_delete_policy: String,
    pub created_at: i64,
    /// Path to thumbnail image file
    pub thumbnail_path: Option<String>,
}

/// Settings for DVR operations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DvrSettings {
    pub storage_path: String,
    pub max_disk_usage_percent: u8,
    pub auto_cleanup_enabled: bool,
    pub default_start_padding_sec: i32,
    pub default_end_padding_sec: i32,
    pub keep_recordings_days: Option<i32>,
}

impl Default for DvrSettings {
    fn default() -> Self {
        Self {
            storage_path: String::new(),
            max_disk_usage_percent: 80,
            auto_cleanup_enabled: true,
            default_start_padding_sec: 60,
            default_end_padding_sec: 300,
            keep_recordings_days: Some(30),
        }
    }
}

/// Request to schedule a new recording
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleRequest {
    pub source_id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub program_title: String,
    pub scheduled_start: i64,
    pub scheduled_end: i64,
    #[serde(default = "default_start_padding")]
    pub start_padding_sec: i32,
    #[serde(default = "default_end_padding")]
    pub end_padding_sec: i32,
    #[serde(default)]
    pub series_match_title: Option<String>,
    #[serde(default)]
    pub recurrence: Option<String>,
    /// Optional pre-resolved stream URL for sources requiring URL regeneration
    #[serde(default)]
    pub stream_url: Option<String>,
}

fn default_start_padding() -> i32 {
    60
}
fn default_end_padding() -> i32 {
    300
}

/// Conflict information when scheduling overlaps
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleConflict {
    pub has_conflict: bool,
    pub conflicts: Vec<Schedule>,
    pub message: Option<String>,
}

/// Disk usage information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub usage_percent: f64,
}

/// Event sent to frontend when recording starts/completes/fails
#[derive(Debug, Clone, Serialize)]
pub struct RecordingEvent {
    pub event_type: String, // "started", "completed", "failed", "progress"
    pub schedule_id: i64,
    pub recording_id: Option<i64>,
    pub channel_name: String,
    pub program_title: String,
    pub message: Option<String>,
}

impl RecordingEvent {
    pub fn started(schedule: &Schedule, recording_id: i64) -> Self {
        Self {
            event_type: "started".to_string(),
            schedule_id: schedule.id,
            recording_id: Some(recording_id),
            channel_name: schedule.channel_name.clone(),
            program_title: schedule.program_title.clone(),
            message: None,
        }
    }

    pub fn completed(schedule: &Schedule, recording_id: i64) -> Self {
        Self {
            event_type: "completed".to_string(),
            schedule_id: schedule.id,
            recording_id: Some(recording_id),
            channel_name: schedule.channel_name.clone(),
            program_title: schedule.program_title.clone(),
            message: None,
        }
    }

    pub fn failed(schedule: &Schedule, error: String) -> Self {
        Self {
            event_type: "failed".to_string(),
            schedule_id: schedule.id,
            recording_id: None,
            channel_name: schedule.channel_name.clone(),
            program_title: schedule.program_title.clone(),
            message: Some(error),
        }
    }
}
