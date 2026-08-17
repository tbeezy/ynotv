use serde::Serialize;
use std::path::PathBuf;
use walkdir::WalkDir;

#[derive(Serialize)]
pub struct ScannedFile {
    pub path: String,
    pub filename: String,
    pub size: u64,
}

const VIDEO_EXTS: &[&str] = &[
    "mkv", "mp4", "m4v", "mov", "avi", "wmv", "webm", "ts", "m2ts", "mpg", "mpeg", "flv", "ogv",
];

#[tauri::command]
pub async fn scan_local_folder(
    folder: String,
    min_size_mb: Option<u64>,
) -> Result<Vec<ScannedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&folder);
        if !root.exists() {
            return Err(format!("folder does not exist: {}", folder));
        }
        let min_bytes = min_size_mb.unwrap_or(50).saturating_mul(1024 * 1024);
        let mut out = Vec::new();
        for entry in WalkDir::new(&root)
            .max_depth(8)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase());
            if !ext.as_deref().map(|e| VIDEO_EXTS.contains(&e)).unwrap_or(false) {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() < min_bytes {
                continue;
            }
            let filename = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            let path = p.to_string_lossy().to_string();
            out.push(ScannedFile {
                path,
                filename,
                size: meta.len(),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
