//! Stream URL resolver
//!
//! Resolves stream URLs for recording. Regenerates fresh URLs for Xtream/Stalker sources
//! to handle token expiration. Uses stored direct_url as fallback for M3U sources.

use anyhow::Result;
use tracing::{debug, info, warn};
use rusqlite::{Row, OptionalExtension};

use crate::dvr::database::DvrDatabase;
use crate::dvr::models::Schedule;

/// Source configuration for URL regeneration
#[derive(Debug)]
struct SourceConfig {
    source_type: String,
    url: String,
    username: Option<String>,
    password: Option<String>,
    mac: Option<String>,
}

/// Resolve a stream URL for a schedule
/// 
/// If the schedule has a pre-resolved stream_url (e.g., from frontend for Stalker sources),
/// uses that directly. Otherwise, for Xtream Codes and Stalker sources, this regenerates 
/// a fresh URL to handle token expiration. For M3U sources, uses the stored direct_url.
pub async fn resolve_stream_url(
    schedule: &Schedule,
    db: &DvrDatabase,
) -> Result<String> {
    debug!("Resolving stream URL for channel {} from source {}", 
           schedule.channel_id, schedule.source_id);

    // If we have a pre-resolved URL from the schedule, use it directly
    if let Some(ref url) = schedule.stream_url {
        info!("Using pre-resolved stream URL from schedule: {}", url);
        return Ok(url.clone());
    }
    
    warn!("No pre-resolved stream_url found in schedule {}, falling back to URL regeneration", schedule.id);

    // First, try to get source configuration for URL regeneration
    let source_config = get_source_config(db, &schedule.source_id).await?;
    
    match source_config {
        Some(config) => {
            // Regenerate URL based on source type
            match config.source_type.as_str() {
                "xtream" => {
                    if let (Some(username), Some(password)) = (&config.username, &config.password) {
                        let url = generate_xtream_url(&config.url, username, password, &schedule.channel_id)?;
                        info!("Generated fresh Xtream URL for channel {}", schedule.channel_id);
                        Ok(url)
                    } else {
                        warn!("Xtream source missing credentials, falling back to stored URL");
                        get_stored_url(db, &schedule.channel_id).await
                    }
                }
                "stalker" => {
                    // For Stalker, we need to authenticate and get a fresh token
                    // For now, fall back to stored URL but log the limitation
                    warn!("Stalker URL regeneration not yet implemented, using stored URL");
                    get_stored_url(db, &schedule.channel_id).await
                }
                "m3u" | _ => {
                    // M3U sources have static URLs, use stored direct_url
                    debug!("M3U source detected, using stored direct_url");
                    get_stored_url(db, &schedule.channel_id).await
                }
            }
        }
        None => {
            // No source config found, fall back to stored URL
            debug!("No source config found, using stored direct_url");
            get_stored_url(db, &schedule.channel_id).await
        }
    }
}

/// Get source configuration from the database
async fn get_source_config(db: &DvrDatabase, source_id: &str) -> Result<Option<SourceConfig>> {
    // Note: Source credentials are stored in Tauri Store, not SQLite
    // We need to query the app state or have the frontend pass this info
    // For now, we check if we have any cached source info in the database
    
    let conn = db.get_conn()?;
    
    // Check sourcesMeta for any stored source info
    // This is a placeholder - in the real implementation, we'd need to either:
    // 1. Store source credentials in SQLite during sync (encrypted)
    // 2. Create a Tauri command to fetch from frontend
    // 3. Pass credentials when scheduling
    
    // For now, we'll try to extract info from the channel's source_id
    // by checking if we can find a pattern
    
    // Check if source_id starts with known prefixes
    if source_id.starts_with("xtream_") {
        // Try to get stored URL to extract base URL
        let url: Option<String> = conn
            .query_row(
                "SELECT direct_url FROM channels WHERE source_id = ?1 LIMIT 1",
                [source_id],
                |row: &Row| row.get::<_, String>(0),
            )
            .optional()?;
        
        if let Some(url_str) = url {
            // Parse the URL to extract base URL and credentials
            if let Some(config) = parse_xtream_url(&url_str) {
                return Ok(Some(config));
            }
        }
    }
    
    Ok(None)
}

/// Parse Xtream URL to extract configuration
/// URL format: http://host:port/live/username/password/stream_id.ts
fn parse_xtream_url(url: &str) -> Option<SourceConfig> {
    // Try to parse the URL
    let url_parts: Vec<&str> = url.split('/').collect();
    
    // Look for /live/ pattern which indicates Xtream
    if let Some(live_idx) = url_parts.iter().position(|&p| p == "live") {
        if url_parts.len() > live_idx + 3 {
            let base_url = url_parts[..live_idx].join("/");
            let username = url_parts[live_idx + 1].to_string();
            let password = url_parts[live_idx + 2].to_string();
            
            return Some(SourceConfig {
                source_type: "xtream".to_string(),
                url: base_url,
                username: Some(username),
                password: Some(password),
                mac: None,
            });
        }
    }
    
    None
}

/// Generate fresh Xtream URL
fn generate_xtream_url(base_url: &str, username: &str, password: &str, stream_id: &str) -> Result<String> {
    // Ensure base URL doesn't have trailing slash
    let base = base_url.trim_end_matches('/');
    
    // Determine file extension (default to .ts for live streams)
    let extension = if stream_id.contains('.') {
        ""
    } else {
        ".ts"
    };
    
    let url = format!("{}/live/{}/{}/{}{}", base, username, password, stream_id, extension);
    
    Ok(url)
}

/// Get stored direct_url from channels table
async fn get_stored_url(db: &DvrDatabase, channel_id: &str) -> Result<String> {
    let conn = db.get_conn()?;
    
    let url: Option<String> = conn
        .query_row(
            "SELECT direct_url FROM channels WHERE stream_id = ?1",
            [channel_id],
            |row: &Row| row.get::<_, String>(0),
        )
        .optional()?;
    
    match url {
        Some(url) => {
            debug!("Found stored URL for channel {}: {}", channel_id, url);
            Ok(url)
        }
        None => {
            Err(anyhow::anyhow!(
                "No stream URL found for channel {}",
                channel_id
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_xtream_url() {
        let url = "http://example.com:8080/live/user/pass/12345.ts";
        let config = parse_xtream_url(url).unwrap();
        
        assert_eq!(config.source_type, "xtream");
        assert_eq!(config.url, "http://example.com:8080");
        assert_eq!(config.username, Some("user".to_string()));
        assert_eq!(config.password, Some("pass".to_string()));
    }
    
    #[test]
    fn test_generate_xtream_url() {
        let url = generate_xtream_url(
            "http://example.com:8080",
            "user",
            "pass",
            "12345"
        ).unwrap();
        
        assert_eq!(url, "http://example.com:8080/live/user/pass/12345.ts");
    }
}
