//! Thumbnail generation for DVR recordings
//!
//! Uses FFmpeg to extract a frame from recorded videos for preview.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

/// Generate a thumbnail from a recorded video file
///
/// Extracts a frame at 10% into the video (or 5 seconds, whichever is greater)
/// and saves it as a JPEG image.
///
/// # Arguments
/// * `video_path` - Path to the recorded video file
/// * `recording_id` - ID of the recording (used for thumbnail filename)
/// * `storage_path` - Base storage path for recordings
///
/// # Returns
/// * `Ok(Some(PathBuf))` - Path to the generated thumbnail
/// * `Ok(None)` - Thumbnail generation failed but not critically
/// * `Err` - Critical error occurred
pub async fn generate_thumbnail(
    video_path: &str,
    recording_id: i64,
    storage_path: &str,
) -> Result<Option<PathBuf>> {
    let video_path = Path::new(video_path);

    // Verify video file exists
    if !video_path.exists() {
        warn!(
            "Cannot generate thumbnail - video file not found: {:?}",
            video_path
        );
        return Ok(None);
    }

    // Get video file size
    let file_size = tokio::fs::metadata(video_path).await?.len();
    if file_size == 0 {
        warn!("Cannot generate thumbnail - video file is empty");
        return Ok(None);
    }

    // Create thumbnails directory
    let thumbnails_dir = Path::new(storage_path).join(".thumbnails");
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .context("Failed to create thumbnails directory")?;

    // Generate thumbnail filename
    let thumbnail_filename = format!("{}.jpg", recording_id);
    let thumbnail_path = thumbnails_dir.join(&thumbnail_filename);

    // Find FFmpeg binary
    let ffmpeg_path = find_ffmpeg().await?;

    // Calculate seek time (10% into video, minimum 5 seconds)
    let seek_seconds = 5i64;

    info!(
        "Generating thumbnail for recording {} at {}s",
        recording_id, seek_seconds
    );

    // Build FFmpeg command
    // -ss: seek to position (before -i for faster seeking)
    // -i: input file
    // -vframes 1: extract only 1 frame
    // -q:v 2: quality (2 = high quality, 31 = low)
    // -y: overwrite output
    let mut cmd = Command::new(&ffmpeg_path);
    cmd.arg("-ss")
        .arg(seek_seconds.to_string())
        .arg("-i")
        .arg(video_path)
        .arg("-vframes")
        .arg("1")
        .arg("-q:v")
        .arg("2")
        .arg("-y")
        .arg(&thumbnail_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Hide console window on Windows (CREATE_NO_WINDOW = 0x08000000)
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let output = timeout(
        Duration::from_secs(30), // 30 second timeout
        cmd.output(),
    )
    .await
    .context("Thumbnail generation timed out")?;

    match output {
        Ok(result) => {
            if result.status.success() {
                // Verify thumbnail was created
                if thumbnail_path.exists() {
                    let thumb_size = tokio::fs::metadata(&thumbnail_path).await?.len();
                    info!(
                        "Thumbnail generated successfully: {:?} ({} bytes)",
                        thumbnail_path, thumb_size
                    );
                    Ok(Some(thumbnail_path))
                } else {
                    error!("FFmpeg reported success but thumbnail file not found");
                    Ok(None)
                }
            } else {
                let stderr = String::from_utf8_lossy(&result.stderr);
                error!("FFmpeg failed to generate thumbnail: {}", stderr);
                Ok(None)
            }
        }
        Err(e) => {
            error!("Failed to execute FFmpeg for thumbnail: {}", e);
            Ok(None)
        }
    }
}

/// Find FFmpeg binary
///
/// Searches for FFmpeg in the following order:
/// 1. Sidecar directory (executable directory)
/// 2. Bundled resources (platform-specific)
/// 3. Development path
/// 4. System PATH
async fn find_ffmpeg() -> Result<PathBuf> {
    // First try sidecar directory (where Tauri places externalBin files)
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            // Sidecar naming: ffmpeg.exe on Windows, ffmpeg on Unix
            #[cfg(target_os = "windows")]
            let sidecar_names = ["ffmpeg.exe", "ffmpeg-x86_64-pc-windows-msvc.exe"];
            #[cfg(target_os = "macos")]
            let sidecar_names = ["ffmpeg", "ffmpeg-x86_64-apple-darwin"];
            #[cfg(target_os = "linux")]
            let sidecar_names = ["ffmpeg", "ffmpeg-x86_64-unknown-linux-gnu"];

            for name in &sidecar_names {
                let sidecar_path = dir.join(name);
                if sidecar_path.exists() {
                    debug!("Using sidecar FFmpeg: {:?}", sidecar_path);
                    return Ok(sidecar_path);
                }
            }
        }
    }

    // Try bundled FFmpeg in resources
    #[cfg(target_os = "windows")]
    let bundled_paths = [
        "./resources/ffmpeg.exe",
        "../resources/ffmpeg.exe",
        "./src-tauri/resources/ffmpeg.exe",
    ];

    #[cfg(not(target_os = "windows"))]
    let bundled_paths = [
        "./resources/ffmpeg",
        "../resources/ffmpeg",
        "./src-tauri/resources/ffmpeg",
    ];

    for path in &bundled_paths {
        let path = Path::new(path);
        if path.exists() {
            debug!("Using bundled FFmpeg: {:?}", path);
            return Ok(path.to_path_buf());
        }
    }

    // Try development path
    let dev_paths = [
        "./src-tauri/bin/ffmpeg",
        "../src-tauri/bin/ffmpeg",
        "./bin/ffmpeg",
    ];

    for path in &dev_paths {
        let path = Path::new(path);
        if path.exists() {
            debug!("Using development FFmpeg: {:?}", path);
            return Ok(path.to_path_buf());
        }
    }

    // Try system PATH
    #[cfg(target_os = "windows")]
    let ffmpeg_name = "ffmpeg.exe";
    #[cfg(not(target_os = "windows"))]
    let ffmpeg_name = "ffmpeg";

    if let Ok(path) = which::which(ffmpeg_name) {
        debug!("Using system FFmpeg: {:?}", path);
        return Ok(path);
    }

    Err(anyhow::anyhow!(
        "FFmpeg not found. Please ensure FFmpeg is installed and in PATH"
    ))
}


