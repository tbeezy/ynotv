use crate::db_bulk_ops::{self, BulkCategory, BulkChannel, BulkResult};
use crate::dvr::DvrState;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use log::{error, info};

/// Extract Xtream stream_id from a channel URL.
/// Matches patterns like /live/{user}/{pass}/{stream_id}.ts
fn extract_xtream_stream_id(url: &str) -> Option<String> {
    let path: Vec<&str> = url.split('/').collect();
    for (i, segment) in path.iter().enumerate() {
        if *segment == "live" {
            // stream_id is at index i+3 (live / user / pass / stream_id.ext)
            if let Some(id_seg) = path.get(i + 3) {
                let id: String = id_seg.chars().take_while(|c| c.is_ascii_digit()).collect();
                if !id.is_empty() {
                    return Some(id);
                }
            }
        }
    }
    None
}

// ============================================================================
// Xtream Types
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct XtreamCategory {
    pub category_id: String,
    pub category_name: String,
    pub parent_id: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct XtreamStream {
    pub num: Option<serde_json::Value>,
    pub stream_id: serde_json::Value,
    pub name: String,
    pub stream_type: Option<String>,
    pub stream_icon: Option<String>,
    pub epg_channel_id: Option<String>,
    pub category_id: Option<String>, // sometimes comes as a number in some providers
    pub tv_archive: Option<i32>,
    pub direct_source: Option<String>,
    pub added: Option<String>,
    pub custom_sid: Option<String>,
}

// ============================================================================
// Sync Xtream (Live)
// ============================================================================

#[tauri::command]
pub async fn sync_xtream_source(
    state: tauri::State<'_, DvrState>,
    source_id: String,
    base_url: String,
    username: String,
    password: String,
    user_agent: Option<String>,
) -> Result<XtreamSyncResult, String> {
    info!("[Xtream Sync] Starting native sync for {}", source_id);

    let client_builder = Client::builder();
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };
    let client = client_builder.user_agent(ua).build().map_err(|e| e.to_string())?;

    let base_url = base_url.trim_end_matches('/');

    // 1. Fetch Categories
    let cat_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_live_categories",
        base_url, username, password
    );
    
    let cat_res = client.get(&cat_url).send().await.map_err(|e| {
        let msg = format!("Failed to connect to Xtream categories: {}", e);
        error!("[Xtream Sync] {}", msg);
        msg
    })?;
    
    let cat_res = cat_res.error_for_status().map_err(|e| {
        let msg = format!("HTTP error from Xtream categories: {}", e);
        error!("[Xtream Sync] {}", msg);
        msg
    })?;

    let xtream_categories: Vec<XtreamCategory> = cat_res.json().await.map_err(|e| {
        error!("[Xtream Sync] Failed to parse categories: {}", e);
        e.to_string()
    })?;

    // Map to BulkCategory
    let mut bulk_categories = Vec::with_capacity(xtream_categories.len());
    for (index, cat) in xtream_categories.into_iter().enumerate() {
        bulk_categories.push(BulkCategory {
            category_id: format!("{}_{}", source_id, cat.category_id),
            source_id: source_id.clone(),
            category_name: cat.category_name,
            parent_id: cat.parent_id,
            enabled: None,
            display_order: Some(index as i32),
            channel_count: None,
            filter_words: None,
            folder_id: None,
        });
    }

    // 2. Fetch Streams
    let stream_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_live_streams",
        base_url, username, password
    );

    let stream_res = client.get(&stream_url).send().await.map_err(|e| {
        let msg = format!("Failed to connect to Xtream streams: {}", e);
        error!("[Xtream Sync] {}", msg);
        msg
    })?;
    
    let stream_res = stream_res.error_for_status().map_err(|e| {
        let msg = format!("HTTP error from Xtream streams: {}", e);
        error!("[Xtream Sync] {}", msg);
        msg
    })?;

    let xtream_streams: Vec<XtreamStream> = stream_res.json().await.map_err(|e| {
        error!("[Xtream Sync] Failed to parse streams: {}", e);
        e.to_string()
    })?;

    // Map to BulkChannel
    let mut bulk_channels = Vec::with_capacity(xtream_streams.len());
    for (index, stream) in xtream_streams.into_iter().enumerate() {
        let stream_id_str = match &stream.stream_id {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => continue, // skip invalid IDs
        };

        let cat_id_str = match &stream.category_id {
            Some(c) => c.clone(),
            None => "".to_string(), // fallback for missing category
        };

        let channel_num = stream.num.and_then(|v| {
            if let serde_json::Value::Number(n) = v {
                n.as_i64().map(|i| i as i32)
            } else if let serde_json::Value::String(s) = v {
                s.parse::<i32>().ok()
            } else {
                None
            }
        });

        // Map Category IDs array
        let category_ids_json = if !cat_id_str.is_empty() {
            Some(format!("[\"{}_{}\"]", source_id, cat_id_str))
        } else {
            Some("[]".to_string())
        };

        let direct_url = format!(
            "{}/live/{}/{}/{}.ts",
            base_url, username, password, stream_id_str
        );

        bulk_channels.push(BulkChannel {
            stream_id: format!("{}_{}", source_id, stream_id_str),
            source_id: source_id.clone(),
            category_ids: category_ids_json,
            name: stream.name,
            channel_num,
            provider_order: Some(index as i32),
            is_favorite: None, // Uses COALESCE in SQL natively!
            enabled: None,     // Uses COALESCE!
            stream_type: stream.stream_type,
            stream_icon: stream.stream_icon,
            epg_channel_id: stream.epg_channel_id,
            added: stream.added,
            custom_sid: stream.custom_sid,
            tv_archive: stream.tv_archive,
            direct_source: stream.direct_source,
            direct_url: Some(direct_url),
            xmltv_id: None,
            series_no: None,
            live: Some(1),
            is_adult: None,
            xtream_stream_id: Some(stream_id_str.clone()),
            tv_archive_duration: None,
            catchup_type: None,
            catchup_source: None,
            catchup_days: None,
        });
    }

    let mut parsed_category_ids = Vec::with_capacity(bulk_categories.len());
    for b in &bulk_categories {
        parsed_category_ids.push(b.category_id.clone());
    }
    let result_cats = db_bulk_ops::bulk_upsert_categories(&state.db, bulk_categories).map_err(|e| e.to_string())?;

    let mut parsed_channel_ids = Vec::with_capacity(bulk_channels.len());
    for b in &bulk_channels {
        parsed_channel_ids.push(b.stream_id.clone());
    }
    let result_chans = db_bulk_ops::bulk_upsert_channels(&state.db, bulk_channels).map_err(|e| e.to_string())?;

    info!("[Xtream Sync] Competed successfully: {} categories, {} channels", result_cats.inserted + result_cats.updated, result_chans.inserted + result_chans.updated);

    Ok(XtreamSyncResult {
        categories: result_cats,
        channels: result_chans,
        parsed_channel_ids,
        parsed_category_ids,
    })
}

// ============================================================================
// Sync M3U
// ============================================================================

/// Basic stable hash implementation mirroring JS local-adapter stableHash logic (DJB2 base36)
fn stable_hash(s: &str) -> String {
    let mut hash: i32 = 5381;
    for b in s.bytes() {
        hash = (hash << 5).wrapping_add(hash).wrapping_add(b as i32);
    }
    let mut n = hash.abs() as u32;
    if n == 0 {
        return "0".to_string();
    }
    let mut res = String::new();
    let chars = b"0123456789abcdefghijklmnopqrstuvwxyz";
    while n > 0 {
        res.push(chars[(n % 36) as usize] as char);
        n /= 36;
    }
    // Return first 8 chars, exactly like JS `substring(0, 8)` after reversal
    let reversed: String = res.chars().rev().take(8).collect();
    reversed
}

fn generate_stable_stream_id(source_id: &str, tvg_id: &str, url: &str, seen_ids: &mut HashSet<String>) -> String {
    let sanitized_tvg_id = tvg_id.replace(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '_' && c != '-', "_");

    if !sanitized_tvg_id.is_empty() {
        let base_id = format!("{}_{}", source_id, sanitized_tvg_id);
        if !seen_ids.contains(&base_id) {
            seen_ids.insert(base_id.clone());
            return base_id;
        }

        let url_hash = stable_hash(url);
        let unique_id = format!("{}_{}", base_id, url_hash);
        if !seen_ids.contains(&unique_id) {
            seen_ids.insert(unique_id.clone());
            return unique_id;
        }

        // If both tvg-id and URL collide, keep incrementing until unique.
        let mut counter = 1;
        loop {
            let final_id = format!("{}_{}", unique_id, counter);
            if !seen_ids.contains(&final_id) {
                seen_ids.insert(final_id.clone());
                return final_id;
            }
            counter += 1;
        }
    }

    let url_hash = stable_hash(url);
    let fallback_id = format!("{}_url_{}", source_id, url_hash);
    
    if !seen_ids.contains(&fallback_id) {
        seen_ids.insert(fallback_id.clone());
        return fallback_id;
    }

    let mut counter = 1;
    loop {
        let final_id = format!("{}_{}", fallback_id, counter);
        if !seen_ids.contains(&final_id) {
            seen_ids.insert(final_id.clone());
            return final_id;
        }
        counter += 1;
    }
}

fn create_m3u_category_id(source_id: &str, category_name: &str) -> String {
    let slug = category_name
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric(), "-")
        .trim_matches('-')
        .to_string();
    let slug = if slug.is_empty() {
        format!("category-{}", stable_hash(category_name))
    } else {
        slug
    };

    format!("{}_{}", source_id, slug)
}

/// True when an unquoted remainder reads as the *next* attribute assignment
/// (`name="value"` or `name=value`) rather than as this attribute's value.
///
/// This is what tells an attribute written without a value apart from a
/// legitimate unquoted value that merely contains '='. In
/// `tvg-id= tvg-name="A"` the space terminates an empty value and `tvg-name`
/// starts the next attribute, so the remainder must be rejected; but
/// `url-tvg=http://epg.example/x.xml?token=abc` is a real value, and its scheme /
/// query punctuation means no bare attribute name precedes the '='.
fn looks_like_attribute_assignment(val: &str) -> bool {
    let Some(eq_pos) = val.find('=') else {
        return false;
    };

    let name = &val[..eq_pos];
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

pub(crate) fn extract_m3u_attr(text: &str, keys: &[&str]) -> String {
    let lower = text.to_ascii_lowercase();

    for key in keys {
        let key_lower = key.to_ascii_lowercase();
        let key_len = key_lower.len();
        let mut search_from = 0;

        while let Some(rel_pos) = lower[search_from..].find(&key_lower) {
            let key_pos = search_from + rel_pos;
            search_from = key_pos + key_len;

            // Word boundary check before key:
            // Must be start of string or preceded by whitespace/delimiter (not inside another identifier or URL)
            if key_pos > 0 {
                let prev_char = text[..key_pos].chars().next_back().unwrap();
                if !prev_char.is_whitespace()
                    && prev_char != ','
                    && prev_char != ':'
                    && prev_char != ';'
                    && prev_char != '"'
                    && prev_char != '\''
                    && prev_char != '['
                    && prev_char != '('
                {
                    continue;
                }
            }

            // Key must be followed by optional whitespace, then '='
            let remainder = &text[key_pos + key_len..];
            let trimmed_leading = remainder.trim_start();
            if !trimmed_leading.starts_with('=') {
                continue;
            }

            // Skip '=' and any optional whitespace after '='
            let after_eq = trimmed_leading[1..].trim_start();
            if after_eq.is_empty() {
                continue;
            }

            // Extract value: double quoted, single quoted, or unquoted
            if let Some(after_quote) = after_eq.strip_prefix('"') {
                if let Some(end) = after_quote.find('"') {
                    let val = after_quote[..end].trim();
                    if !val.is_empty() {
                        return val.to_string();
                    }
                } else {
                    // Unclosed double quote - stop at comma or end of string
                    let end = after_quote.find(',').unwrap_or(after_quote.len());
                    let val = after_quote[..end].trim().trim_matches('"');
                    if !val.is_empty() {
                        return val.to_string();
                    }
                }
            } else if let Some(after_quote) = after_eq.strip_prefix('\'') {
                if let Some(end) = after_quote.find('\'') {
                    let val = after_quote[..end].trim();
                    if !val.is_empty() {
                        return val.to_string();
                    }
                } else {
                    // Unclosed single quote - stop at comma or end of string
                    let end = after_quote.find(',').unwrap_or(after_quote.len());
                    let val = after_quote[..end].trim().trim_matches('\'');
                    if !val.is_empty() {
                        return val.to_string();
                    }
                }
            } else {
                // Unquoted: terminated by whitespace or comma
                let end = after_eq.find(|c: char| c.is_whitespace() || c == ',').unwrap_or(after_eq.len());
                let val = after_eq[..end].trim().trim_matches('"').trim_matches('\'');
                // An empty unquoted value must not swallow the next attribute:
                // `tvg-id= tvg-name="A"` has no value, so returning the whole
                // `tvg-name="A"` remainder would poison epg_channel_id.
                if !val.is_empty() && !looks_like_attribute_assignment(val) {
                    return val.to_string();
                }
            }
        }
    }

    "".to_string()
}

#[cfg(test)]
mod tests {
    use super::{create_m3u_category_id, extract_m3u_attr, read_local_playlist_file};

    #[test]
    fn reads_an_imported_playlist_and_strips_a_bom() {
        let dir = std::env::temp_dir().join(format!("ynotv-m3u-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("list.m3u");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"#EXTM3U url-tvg=\"http://epg.test/g.xml\"\n#EXTINF:-1,Channel\nhttp://x/1.ts\n");
        std::fs::write(&path, bytes).unwrap();

        let text = read_local_playlist_file(path.to_string_lossy().to_string()).unwrap();

        // The header check in the sync looks for `#EXTM3U` at the start of the line.
        assert!(text.starts_with("#EXTM3U"), "unexpected start: {:?}", text);
        assert!(text.contains("url-tvg=\"http://epg.test/g.xml\""));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_a_missing_or_empty_playlist_path() {
        let missing = std::env::temp_dir().join("ynotv-does-not-exist.m3u");
        let _ = std::fs::remove_file(&missing);
        assert!(read_local_playlist_file(missing.to_string_lossy().to_string()).is_err());
        assert!(read_local_playlist_file("   ".to_string()).is_err());
    }

    #[test]
    fn decodes_non_utf8_playlist_bytes_instead_of_failing() {
        let dir = std::env::temp_dir().join(format!("ynotv-m3u-cp1252-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("latin.m3u");
        // "Café" in Windows-1252: 0xE9 is not valid UTF-8.
        std::fs::write(&path, b"#EXTM3U\n#EXTINF:-1,Caf\xE9 TV\nhttp://x/2.ts\n").unwrap();

        let text = read_local_playlist_file(path.to_string_lossy().to_string()).unwrap();

        assert!(text.contains("Caf"), "unexpected text: {:?}", text);
        assert!(text.contains("http://x/2.ts"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_distinct_ids_for_cyrillic_m3u_groups() {
        let first = create_m3u_category_id("source", "Федеральные");
        let second = create_m3u_category_id("source", "Кинозалы");

        assert_eq!(first, "source_федеральные");
        assert_eq!(second, "source_кинозалы");
        assert_ne!(first, second);
    }

    #[test]
    fn keeps_ascii_m3u_category_ids_stable() {
        assert_eq!(
            create_m3u_category_id("source", "News HD"),
            "source_news-hd"
        );
    }

    #[test]
    fn falls_back_when_group_name_has_no_alphanumeric_chars() {
        let category_id = create_m3u_category_id("source", "★★★");

        assert!(category_id.starts_with("source_category-"));
        assert_ne!(category_id, "source_");
    }

    #[test]
    fn extracts_tvg_id_case_insensitively() {
        let line1 = r#"#EXTINF:-1 tvg-id="channel26.ar" tvg-name="Channel 26",Channel 26"#;
        assert_eq!(extract_m3u_attr(line1, &["tvg-id"]), "channel26.ar");

        let line2 = r#"#EXTINF:-1 tvg-ID="channel26.ar" tvg-name="Channel 26",Channel 26"#;
        assert_eq!(extract_m3u_attr(line2, &["tvg-id"]), "channel26.ar");

        let line3 = r#"#EXTINF:-1 TVG-ID="channel26.ar" tvg-name="Channel 26",Channel 26"#;
        assert_eq!(extract_m3u_attr(line3, &["tvg-id"]), "channel26.ar");

        let line4 = r#"#EXTINF:-1 tvg-Id="channel26.ar" tvg-name="Channel 26",Channel 26"#;
        assert_eq!(extract_m3u_attr(line4, &["tvg-id"]), "channel26.ar");
    }

    #[test]
    fn extracts_attributes_with_whitespace_around_equals() {
        let line1 = r#"#EXTINF:-1 tvg-ID = "channel26.ar",Channel 26"#;
        assert_eq!(extract_m3u_attr(line1, &["tvg-id"]), "channel26.ar");

        let line2 = r#"#EXTINF:-1 tvg-ID= "channel26.ar",Channel 26"#;
        assert_eq!(extract_m3u_attr(line2, &["tvg-id"]), "channel26.ar");

        let line3 = r#"#EXTINF:-1 tvg-ID ="channel26.ar",Channel 26"#;
        assert_eq!(extract_m3u_attr(line3, &["tvg-id"]), "channel26.ar");

        let line4 = r#"#EXTINF:-1 tvg-ID   =   "channel26.ar",Channel 26"#;
        assert_eq!(extract_m3u_attr(line4, &["tvg-id"]), "channel26.ar");
    }

    #[test]
    fn extracts_single_quoted_and_unquoted_values() {
        let line1 = r#"#EXTINF:-1 tvg-ID='channel26.ar',Channel 26"#;
        assert_eq!(extract_m3u_attr(line1, &["tvg-id"]), "channel26.ar");

        let line2 = r#"#EXTINF:-1 tvg-ID=channel26.ar,Channel 26"#;
        assert_eq!(extract_m3u_attr(line2, &["tvg-id"]), "channel26.ar");

        let line3 = r#"#EXTINF:-1 tvg-ID=channel26.ar tvg-name="Channel 26",Channel 26"#;
        assert_eq!(extract_m3u_attr(line3, &["tvg-id"]), "channel26.ar");
    }

    #[test]
    fn preserves_value_casing_and_unicode() {
        let line = r#"#EXTINF:-1 tvg-id="Channel26.AR" group-title="PELÍCULAS",Películas"#;
        assert_eq!(extract_m3u_attr(line, &["tvg-id"]), "Channel26.AR");
        assert_eq!(extract_m3u_attr(line, &["group-title"]), "PELÍCULAS");
    }

    #[test]
    fn respects_word_boundaries_and_fallback_keys() {
        let line1 = r#"#EXTINF:-1 custom-tvg-id="wrong" tvg-id="correct",Channel"#;
        assert_eq!(extract_m3u_attr(line1, &["tvg-id"]), "correct");

        let line2 = r#"#EXTINF:-1 catchup-type="flussonic",Channel"#;
        assert_eq!(extract_m3u_attr(line2, &["catchup"]), "");
        assert_eq!(extract_m3u_attr(line2, &["catchup-type"]), "flussonic");
        assert_eq!(extract_m3u_attr(line2, &["catchup", "catchup-type"]), "flussonic");

        let line3 = r#"#EXTINF:-1 tvg-logo="" tvg-icon="http://example.com/icon.png",Channel"#;
        assert_eq!(extract_m3u_attr(line3, &["tvg-logo", "tvg-icon"]), "http://example.com/icon.png");

        let line4 = r#"#EXTINF:-1 tvg-logo="http://server.com/img?logo=bar&tvg-id=wrong" tvg-id="right",Channel"#;
        assert_eq!(extract_m3u_attr(line4, &["tvg-id"]), "right");
    }

    #[test]
    fn empty_unquoted_value_does_not_swallow_the_next_attribute() {
        // No value between '=' and the next attribute: must yield "", not the
        // next attribute's name=value text (which would poison epg_channel_id).
        let line1 = r#"#EXTINF:-1 tvg-id= tvg-name="Channel 26",Channel 26"#;
        assert_eq!(extract_m3u_attr(line1, &["tvg-id"]), "");
        assert_eq!(extract_m3u_attr(line1, &["tvg-name"]), "Channel 26");

        // Same when the following attribute is unquoted, and for a fallback key.
        let line2 = r#"#EXTINF:-1 group-title= group="News",Channel"#;
        assert_eq!(extract_m3u_attr(line2, &["group-title"]), "");
        assert_eq!(extract_m3u_attr(line2, &["group"]), "News");

        let line3 = r#"#EXTINF:-1 tvg-id= tvg-name=A,Channel"#;
        assert_eq!(extract_m3u_attr(line3, &["tvg-id"]), "");

        // Whitespace around '=' is still fine when a real value follows.
        let line4 = r#"#EXTINF:-1 tvg-id= "channel26.ar",Channel"#;
        assert_eq!(extract_m3u_attr(line4, &["tvg-id"]), "channel26.ar");
        let line5 = r#"#EXTINF:-1 tvg-chno= 5,Channel"#;
        assert_eq!(extract_m3u_attr(line5, &["tvg-chno"]), "5");

        // Unquoted values that legitimately contain '=' (URL query params) are
        // preserved - only a bare `name=` prefix marks the next attribute.
        let line6 = r#"#EXTM3U url-tvg=http://epg.example/x.xml?token=abc"#;
        assert_eq!(
            extract_m3u_attr(line6, &["url-tvg"]),
            "http://epg.example/x.xml?token=abc"
        );
        let line7 = r#"#EXTINF:-1 catchup-source=http://x/ts?utc={utc}&lutc={lutc},Channel"#;
        assert_eq!(
            extract_m3u_attr(line7, &["catchup-source"]),
            "http://x/ts?utc={utc}&lutc={lutc}"
        );
    }
}

#[derive(Serialize)]
pub struct M3uSyncResult {
    pub categories: BulkResult,
    pub channels: BulkResult,
    pub epg_url: Option<String>,
    pub parsed_channel_ids: Vec<String>,
    pub parsed_category_ids: Vec<String>,
}

#[derive(Serialize)]
pub struct XtreamSyncResult {
    pub categories: BulkResult,
    pub channels: BulkResult,
    pub parsed_channel_ids: Vec<String>,
    pub parsed_category_ids: Vec<String>,
}

#[derive(Serialize)]
pub struct XtreamVodSyncResult {
    pub categories: BulkResult,
    pub content: BulkResult,
    pub parsed_content_ids: Vec<String>,
    pub parsed_category_ids: Vec<String>,
}

// Some Xtream endpoints send JSON arrays (or null/other types) where a string
// is expected. A single bad stream must not abort decoding of the whole list,
// so coerce non-string values to an empty string instead of failing the parse.
fn de_string_or_default<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match v {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        Some(serde_json::Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    })
}

fn extract_xtream_category_ids(
    primary: &Option<serde_json::Value>,
    secondary: &Option<serde_json::Value>,
    source_id: &str,
    prefix: &str,
) -> Option<String> {
    let mut ids = Vec::new();

    let mut add_id = |s: &str| {
        let s = s.trim();
        if !s.is_empty() {
            let formatted = format!("{}_{}_{}", source_id, prefix, s);
            if !ids.contains(&formatted) {
                ids.push(formatted);
            }
        }
    };

    let process_val = |val: &serde_json::Value, add_fn: &mut dyn FnMut(&str)| {
        match val {
            serde_json::Value::String(s) => add_fn(s),
            serde_json::Value::Number(n) => add_fn(&n.to_string()),
            serde_json::Value::Array(arr) => {
                for item in arr {
                    match item {
                        serde_json::Value::String(s) => add_fn(s),
                        serde_json::Value::Number(n) => add_fn(&n.to_string()),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    };

    if let Some(p) = primary {
        process_val(p, &mut add_id);
    }
    if let Some(s) = secondary {
        process_val(s, &mut add_id);
    }

    if ids.is_empty() {
        Some("[]".to_string())
    } else {
        serde_json::to_string(&ids).ok()
    }
}

fn is_valid_stream_icon(icon: &str) -> bool {
    let trimmed = icon.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.contains("image.tmdb.org/t/p/") {
        let path = trimmed.trim_end_matches('/');
        if path.ends_with("w600_and_h900_bestv2")
            || path.ends_with("w500")
            || path.ends_with("w185")
            || path.ends_with("w342")
            || path.ends_with("original")
        {
            return false;
        }
    }
    true
}

/// Convert a serde_json::Value to a plain string without JSON encoding.
/// `serde_json::Value::to_string()` keeps the surrounding quotes for string
/// values (e.g. "2021" -> `"\"2021\""`), which would be stored verbatim in
/// the DB. This unwraps strings and numbers to their plain representation.
fn json_value_to_plain_string(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
pub struct XtreamVodStream {
    pub stream_id: serde_json::Value,
    #[serde(deserialize_with = "de_string_or_default")]
    pub name: String,
    pub title: Option<String>,
    pub year: Option<serde_json::Value>,
    pub stream_icon: Option<String>,
    pub category_id: Option<serde_json::Value>, // Sometimes comes as number
    pub category_ids: Option<serde_json::Value>, // Array of numbers/strings
    pub container_extension: Option<String>,
    pub plot: Option<String>,
    pub cast: Option<String>,
    pub director: Option<String>,
    pub genre: Option<String>,
    pub releasedate: Option<String>,
    pub rating: Option<serde_json::Value>,
    pub rating_5based: Option<serde_json::Value>,
    pub added: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct XtreamSeriesStream {
    pub series_id: serde_json::Value,
    pub name: String,
    pub title: Option<String>,
    pub year: Option<serde_json::Value>,
    pub cover: Option<serde_json::Value>,
    pub category_id: Option<serde_json::Value>,
    pub category_ids: Option<serde_json::Value>,
    pub plot: Option<serde_json::Value>, // Some APIs send empty plot as array or bool
    pub cast: Option<serde_json::Value>,
    pub director: Option<serde_json::Value>,
    pub genre: Option<serde_json::Value>,
    pub releaseDate: Option<serde_json::Value>,
    pub rating: Option<serde_json::Value>,
    pub rating_5based: Option<serde_json::Value>,
    pub added: Option<serde_json::Value>,
    pub last_modified: Option<serde_json::Value>,
    pub episode_run_time: Option<serde_json::Value>,
    pub youtube_trailer: Option<String>,
}

/// Largest playlist file we will read into memory (64 MB of text).
const MAX_LOCAL_PLAYLIST_BYTES: u64 = 64 * 1024 * 1024;

/// Read a playlist file the user imported from disk.
///
/// This lives in Rust rather than the JS fs plugin because the plugin only
/// grants access to a picked path for the session it was picked in, so a path
/// remembered in a source (and restored from a backup) could not be read back
/// later. Invalid UTF-8 is decoded with replacement characters: a Windows-1252
/// playlist should still sync, with the mangled names it already had.
#[tauri::command]
pub fn read_local_playlist_file(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No playlist file path given".to_string());
    }

    let metadata = std::fs::metadata(trimmed)
        .map_err(|e| format!("Cannot open the playlist file: {}", e))?;
    if !metadata.is_file() {
        return Err("The playlist path is not a file".to_string());
    }
    if metadata.len() > MAX_LOCAL_PLAYLIST_BYTES {
        return Err(format!(
            "The playlist file is larger than {} MB",
            MAX_LOCAL_PLAYLIST_BYTES / (1024 * 1024)
        ));
    }

    let bytes = std::fs::read(trimmed)
        .map_err(|e| format!("Cannot read the playlist file: {}", e))?;
    // A UTF-8 BOM would otherwise become part of the first line, so the `#EXTM3U`
    // header check (and the `url-tvg` attribute on it) would miss.
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

// Regex imports inside method to avoid polluting global scope
#[tauri::command]
pub async fn sync_m3u_source(
    state: tauri::State<'_, DvrState>,
    source_id: String,
    url: String,
    user_agent: Option<String>,
) -> Result<M3uSyncResult, String> {
    info!("[M3U Sync] Starting native sync for {}", source_id);

    let client_builder = Client::builder()
        .brotli(true)
        .deflate(true)
        .gzip(true);
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };
    let client = client_builder.user_agent(ua).build().map_err(|e| e.to_string())?;

    let response = client.get(&url).send().await.map_err(|e| {
        let msg = format!("Failed to connect to M3U URL: {}", e);
        error!("[M3U Sync] {}", msg);
        msg
    })?;

    let response = response.error_for_status().map_err(|e| {
        let msg = format!("HTTP error from M3U URL: {}", e);
        error!("[M3U Sync] {}", msg);
        msg
    })?;

    let content = response.text().await.map_err(|e| {
        let msg = format!("Failed to read M3U content: {}", e);
        error!("[M3U Sync] {}", msg);
        msg
    })?;

    let mut bulk_channels = Vec::new();
    let mut bulk_categories = Vec::new();
    let mut categories_map = HashMap::new();
    let mut seen_ids = HashSet::new();

    let mut current_extinf: Option<String> = None;
    let mut channel_counter = 0;
    let mut epg_url: Option<String> = None;
    let mut header_catchup_type: Option<String> = None;
    let mut header_catchup_source: Option<String> = None;
    let mut header_catchup_days: Option<i32> = None;

    let extract_attr = extract_m3u_attr;

    for line in content.lines().map(|l| l.trim()) {
        if line.is_empty() { continue; }

        if line.starts_with("#EXTM3U") {
            let extracted_epg = extract_attr(line, &["url-tvg", "x-tvg-url"]);
            if !extracted_epg.is_empty() {
                epg_url = Some(extracted_epg);
            }
            let catchup_attr = extract_attr(line, &["catchup", "catchup-type", "catchup-mode"]);
            if !catchup_attr.is_empty() {
                header_catchup_type = Some(catchup_attr);
            }
            let catchup_days_str = extract_attr(line, &["catchup-days", "catchup-days-max", "catchup-range"]);
            if let Ok(days) = catchup_days_str.parse::<i32>() {
                if days > 0 {
                    header_catchup_days = Some(days);
                }
            }
            let catchup_source_attr = extract_attr(line, &["catchup-source", "catchup-url"]);
            if !catchup_source_attr.is_empty() {
                header_catchup_source = Some(catchup_source_attr);
            }
            let timeshift_str = extract_attr(line, &["timeshift", "tvg-shift"]);
            if header_catchup_type.is_none() {
                if let Ok(shift) = timeshift_str.parse::<i32>() {
                    if shift > 0 {
                        header_catchup_type = Some("shift".to_string());
                    }
                }
            }
            continue;
        }

        if line.starts_with("#EXTINF:") {
            current_extinf = Some(line.to_string());
            continue;
        }

        if line.starts_with('#') {
            continue;
        }

        if let Some(extinf) = current_extinf.take() {
            if line.starts_with("http://") || line.starts_with("https://") || line.starts_with("rtmp://") {
                channel_counter += 1;

                let duration_str = extinf[8..].split_whitespace().next().unwrap_or("-1").replace(",", "");
                let _duration = duration_str.parse::<i32>().unwrap_or(-1);

                let tvg_id = extract_attr(&extinf, &["tvg-id"]);
                let tvg_name = extract_attr(&extinf, &["tvg-name"]);
                let tvg_logo = extract_attr(&extinf, &["tvg-logo", "tvg-icon", "logo"]);
                let group_title = extract_attr(&extinf, &["group-title", "group"]);
                let tvg_chno_str = extract_attr(&extinf, &["tvg-chno", "tvg-ch", "channel-id"]);
                let tvg_chno = tvg_chno_str.parse::<i32>().ok();
                
                let catchup_attr = extract_attr(&extinf, &["catchup", "catchup-type", "catchup-mode"]);
                let catchup_source_attr = extract_attr(&extinf, &["catchup-source", "catchup-url"]);
                let catchup_days_attr = extract_attr(&extinf, &["catchup-days", "catchup-days-max", "catchup-range"]);
                let timeshift_attr = extract_attr(&extinf, &["timeshift", "tvg-shift"]);

                let catchup_type = if !catchup_attr.is_empty() {
                    Some(catchup_attr)
                } else if !timeshift_attr.is_empty() {
                    Some("shift".to_string())
                } else {
                    header_catchup_type.clone()
                };

                let catchup_source = if !catchup_source_attr.is_empty() {
                    Some(catchup_source_attr)
                } else {
                    header_catchup_source.clone()
                };

                let catchup_days = catchup_days_attr.parse::<i32>().ok().or(header_catchup_days);

                let tv_archive = if catchup_type.is_some() || catchup_source.is_some() || catchup_days.is_some() { 1 } else { 0 };

                let display_name = if let Some(comma_pos) = extinf.rfind(',') {
                    extinf[comma_pos + 1..].trim().to_string()
                } else {
                    format!("Channel {}", channel_counter)
                };

                let stream_id = generate_stable_stream_id(&source_id, &tvg_id, line, &mut seen_ids);

                let mut category_ids = Vec::new();
                let category_name = if group_title.is_empty() { "Uncategorized".to_string() } else { group_title.clone() };
                let category_id = create_m3u_category_id(&source_id, &category_name);
                category_ids.push(category_id.clone());

                if !categories_map.contains_key(&category_id) {
                    let display_order = bulk_categories.len() as i32;
                    categories_map.insert(category_id.clone(), true);
                    bulk_categories.push(BulkCategory {
                        category_id,
                        category_name,
                        source_id: source_id.clone(),
                        parent_id: None,
                        enabled: None,
                        display_order: Some(display_order),
                        channel_count: None,
                        filter_words: None,
                        folder_id: None,
                    });
                }

                let xtream_stream_id = extract_xtream_stream_id(line);
                bulk_channels.push(BulkChannel {
                    stream_id,
                    source_id: source_id.clone(),
                    category_ids: if category_ids.is_empty() { Some("[]".to_string()) } else { Some(format!("[\"{}\"]", category_ids[0])) },
                    name: if !display_name.is_empty() { display_name } else { tvg_name.clone() },
                    channel_num: tvg_chno,
                    provider_order: Some(channel_counter - 1),
                    is_favorite: None,
                    enabled: None,
                    stream_type: Some("live".to_string()),
                    stream_icon: Some(tvg_logo),
                    epg_channel_id: Some(tvg_id),
                    added: None,
                    custom_sid: None,
                    tv_archive: Some(tv_archive),
                    direct_source: None,
                    direct_url: Some(line.to_string()),
                    xmltv_id: None,
                    series_no: None,
                    live: Some(1),
                    is_adult: None,
                    xtream_stream_id,
                    tv_archive_duration: None,
                    catchup_type,
                    catchup_source,
                    catchup_days,
                });
            }
        }
    }

    let mut parsed_category_ids = Vec::with_capacity(bulk_categories.len());
    for b in &bulk_categories {
        parsed_category_ids.push(b.category_id.clone());
    }
    let result_cats = db_bulk_ops::bulk_upsert_categories(&state.db, bulk_categories).map_err(|e| e.to_string())?;
    
    let mut parsed_channel_ids = Vec::with_capacity(bulk_channels.len());
    for b in &bulk_channels {
        parsed_channel_ids.push(b.stream_id.clone());
    }
    let result_chans = db_bulk_ops::bulk_upsert_channels(&state.db, bulk_channels).map_err(|e| e.to_string())?;

    info!("[M3U Sync] Competed successfully: {} categories, {} channels", result_cats.inserted + result_cats.updated, result_chans.inserted + result_chans.updated);

    Ok(M3uSyncResult {
        categories: result_cats,
        channels: result_chans,
        epg_url,
        parsed_channel_ids,
        parsed_category_ids,
    })
}

// ============================================================================
// Sync VOD Movies
// ============================================================================

#[tauri::command]
pub async fn sync_xtream_vod_movies(
    state: tauri::State<'_, DvrState>,
    source_id: String,
    base_url: String,
    username: String,
    password: String,
    user_agent: Option<String>,
) -> Result<XtreamVodSyncResult, String> {
    info!("[Xtream VOD Movies] Starting native sync for {}", source_id);

    let client_builder = Client::builder()
        .brotli(true)
        .deflate(true)
        .gzip(true);
        
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };
    let client = client_builder.user_agent(ua).build().map_err(|e| e.to_string())?;

    let base_url = base_url.trim_end_matches('/');

    // 1. Fetch Categories
    let cat_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_vod_categories",
        base_url, username, password
    );
    
    let cat_res = client.get(&cat_url).send().await.map_err(|e| {
        let msg = format!("Failed to connect to Xtream VOD categories: {}", e);
        error!("[Xtream VOD] {}", msg);
        msg
    })?;
    
    let cat_res = cat_res.error_for_status().map_err(|e| {
        let msg = format!("HTTP error from Xtream VOD categories: {}", e);
        error!("[Xtream VOD] {}", msg);
        msg
    })?;

    let xtream_categories: Vec<XtreamCategory> = cat_res.json().await.unwrap_or_else(|e| {
        error!("[Xtream VOD] Failed to parse categories: {}", e);
        Vec::new() // Fallback to empty if fails
    });

    let mut bulk_categories = Vec::with_capacity(xtream_categories.len());
    for (index, cat) in xtream_categories.into_iter().enumerate() {
        use crate::db_bulk_ops::BulkVodCategory;
        bulk_categories.push(BulkVodCategory {
            category_id: format!("{}_vod_{}", source_id, cat.category_id),
            source_id: source_id.clone(),
            name: cat.category_name,
            type_str: "movie".to_string(),
            enabled: None,
            display_order: Some(index as i32),
        });
    }

    // 2. Fetch Streams
    let stream_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_vod_streams",
        base_url, username, password
    );

    let start_dl = std::time::Instant::now();
    let stream_res = client.get(&stream_url).send().await.map_err(|e| {
        let msg = format!("Failed to connect to Xtream VOD streams: {}", e);
        error!("[Xtream VOD] {}", msg);
        msg
    })?;
    
    let stream_res = stream_res.error_for_status().map_err(|e| {
        let msg = format!("HTTP error from Xtream VOD streams: {}", e);
        error!("[Xtream VOD] {}", msg);
        msg
    })?;
    
    let bytes = stream_res.bytes().await.map_err(|e| {
        let msg = format!("Failed to read Xtream VOD streams: {}", e);
        error!("[Xtream VOD] {}", msg);
        msg
    })?;
    info!("[Xtream VOD] Downloaded {} bytes in {}ms", bytes.len(), start_dl.elapsed().as_millis());
    
    let start_parse = std::time::Instant::now();
    let xtream_streams: Vec<XtreamVodStream> = serde_json::from_slice(&bytes).map_err(|e| {
        error!("[Xtream VOD] Failed to parse vod streams from slice: {}", e);
        e.to_string()
    })?;
    info!("[Xtream VOD] JSON decoding parsed {} streams in {}ms", xtream_streams.len(), start_parse.elapsed().as_millis());

    use crate::db_bulk_ops::BulkMovie;

    let mut bulk_movies = Vec::with_capacity(xtream_streams.len());
    for stream in xtream_streams {
        let stream_id_str = match &stream.stream_id {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => continue,
        };

        let category_ids_json = extract_xtream_category_ids(
            &stream.category_id,
            &stream.category_ids,
            &source_id,
            "vod",
        );

        let mut final_name = stream.name.trim().to_string();
        if final_name.is_empty() {
            if let Some(ref t) = stream.title {
                let t_str = t.trim();
                if !t_str.is_empty() {
                    final_name = t_str.to_string();
                }
            }
        }

        if final_name.is_empty() {
            let has_icon = stream.stream_icon.as_ref().map(|i| is_valid_stream_icon(i)).unwrap_or(false);
            if !has_icon {
                continue;
            } else {
                final_name = format!("Untitled Movie ({})", stream_id_str);
            }
        }

        let ext = stream.container_extension.clone().unwrap_or_else(|| "mp4".to_string());
        let direct_url = format!(
            "{}/movie/{}/{}/{}.{}",
            base_url, username, password, stream_id_str, ext
        );

        let rating_str = stream.rating.as_ref().and_then(json_value_to_plain_string);
        let year_str = stream.year.as_ref().and_then(json_value_to_plain_string);
        
        let added_str = match stream.added {
            Some(serde_json::Value::Number(n)) => Some(n.to_string()),
            Some(serde_json::Value::String(s)) => Some(s),
            _ => Some(chrono::Utc::now().to_rfc3339()),
        };

        bulk_movies.push(BulkMovie {
            stream_id: format!("{}_{}", source_id, stream_id_str),
            source_id: source_id.clone(),
            category_ids: category_ids_json,
            name: final_name,
            tmdb_id: None,
            imdb_id: None,
            added: added_str,
            backdrop_path: None,
            popularity: None,
            match_attempted: None,
            container_extension: Some(ext), // Use the fallback extension here too
            rating: rating_str,
            director: stream.director,
            year: year_str,
            cast: stream.cast,
            plot: stream.plot,
            genre: stream.genre,
            duration_secs: None,
            duration: None, // We don't have duration from list endpoint usually
            stream_icon: stream.stream_icon,
            direct_url: Some(direct_url),
            release_date: stream.releasedate,
            title: stream.title,
        });
    }

    let mut parsed_category_ids = Vec::with_capacity(bulk_categories.len());
    for b in &bulk_categories {
        parsed_category_ids.push(b.category_id.clone());
    }
    
    let result_cats = db_bulk_ops::bulk_upsert_vod_categories(&state.db, bulk_categories).map_err(|e| e.to_string())?;

    let mut parsed_content_ids = Vec::with_capacity(bulk_movies.len());
    for b in &bulk_movies {
        parsed_content_ids.push(b.stream_id.clone());
    }
    
    let result_content = db_bulk_ops::bulk_upsert_movies(&state.db, bulk_movies).map_err(|e| e.to_string())?;

    info!("[Xtream VOD Movies] Sync successful: {} categories, {} movies", result_cats.inserted + result_cats.updated, result_content.inserted + result_content.updated);

    Ok(XtreamVodSyncResult {
        categories: result_cats,
        content: result_content,
        parsed_content_ids,
        parsed_category_ids,
    })
}

// ============================================================================
// Sync VOD Series
// ============================================================================

#[tauri::command]
pub async fn sync_xtream_vod_series(
    state: tauri::State<'_, DvrState>,
    source_id: String,
    base_url: String,
    username: String,
    password: String,
    user_agent: Option<String>,
) -> Result<XtreamVodSyncResult, String> {
    info!("[Xtream VOD Series] Starting native sync for {}", source_id);

    let client_builder = Client::builder()
        .brotli(true)
        .deflate(true)
        .gzip(true);
        
    let ua = match user_agent {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => "VLC/3.0.18 LibVLC/3.0.18".to_string(),
    };
    let client = client_builder.user_agent(ua).build().map_err(|e| e.to_string())?;

    let base_url = base_url.trim_end_matches('/');

    let cat_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_series_categories",
        base_url, username, password
    );
    
    let cat_res = client.get(&cat_url).send().await.map_err(|e| {
        let msg = format!("Failed to connect to Xtream Series categories: {}", e);
        error!("[Xtream Series] {}", msg);
        msg
    })?;
    
    let cat_res = cat_res.error_for_status().map_err(|e| {
        let msg = format!("HTTP error from Xtream Series categories: {}", e);
        error!("[Xtream Series] {}", msg);
        msg
    })?;

    let xtream_categories: Vec<XtreamCategory> = cat_res.json().await.unwrap_or_else(|e| {
        error!("[Xtream Series] Failed to parse categories: {}", e);
        Vec::new()
    });

    let mut bulk_categories = Vec::with_capacity(xtream_categories.len());
    for (index, cat) in xtream_categories.into_iter().enumerate() {
        use crate::db_bulk_ops::BulkVodCategory;
        bulk_categories.push(BulkVodCategory {
            category_id: format!("{}_series_{}", source_id, cat.category_id),
            source_id: source_id.clone(),
            name: cat.category_name,
            type_str: "series".to_string(),
            enabled: None,
            display_order: Some(index as i32),
        });
    }

    let stream_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_series",
        base_url, username, password
    );

    let start_dl = std::time::Instant::now();
    let stream_res = client.get(&stream_url).send().await.map_err(|e| {
        let msg = format!("Failed to connect to Xtream Series streams: {}", e);
        error!("[Xtream Series] {}", msg);
        msg
    })?;
    
    let stream_res = stream_res.error_for_status().map_err(|e| {
        let msg = format!("HTTP error from Xtream Series streams: {}", e);
        error!("[Xtream Series] {}", msg);
        msg
    })?;

    let bytes = stream_res.bytes().await.map_err(|e| {
        let msg = format!("Failed to read Xtream Series streams: {}", e);
        error!("[Xtream Series] {}", msg);
        msg
    })?;
    info!("[Xtream Series] Downloaded {} bytes in {}ms", bytes.len(), start_dl.elapsed().as_millis());
    
    let start_parse = std::time::Instant::now();
    let xtream_streams: Vec<XtreamSeriesStream> = serde_json::from_slice(&bytes).map_err(|e| {
        error!("[Xtream Series] Failed to parse series streams from slice: {}", e);
        e.to_string()
    })?;
    info!("[Xtream Series] JSON decoding parsed {} streams in {}ms", xtream_streams.len(), start_parse.elapsed().as_millis());

    use crate::db_bulk_ops::BulkSeries;

    let mut bulk_series = Vec::with_capacity(xtream_streams.len());
    for stream in xtream_streams {
        let series_id_str = match &stream.series_id {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => continue,
        };

        let category_ids_json = extract_xtream_category_ids(
            &stream.category_id,
            &stream.category_ids,
            &source_id,
            "series",
        );

        let mut final_name = stream.name.trim().to_string();
        if final_name.is_empty() {
            if let Some(ref t) = stream.title {
                let t_str = t.trim();
                if !t_str.is_empty() {
                    final_name = t_str.to_string();
                }
            }
        }

        if final_name.is_empty() {
            let has_cover = stream.cover.as_ref().map(|c| match c {
                serde_json::Value::String(s) => is_valid_stream_icon(s),
                _ => false,
            }).unwrap_or(false);

            if !has_cover {
                continue;
            } else {
                final_name = format!("Untitled Series ({})", series_id_str);
            }
        }

        let rating_str = stream.rating.as_ref().and_then(json_value_to_plain_string);
        let year_str = stream.year.as_ref().and_then(json_value_to_plain_string);
        
        let added_val = stream.added.clone().or_else(|| stream.last_modified.clone());
        let added_str = match added_val {
            Some(serde_json::Value::Number(n)) => Some(n.to_string()),
            Some(serde_json::Value::String(s)) => Some(s),
            _ => Some(chrono::Utc::now().to_rfc3339()),
        };

        // Note: db_bulk_ops.rs handles preserving COALESCE fields
        bulk_series.push(BulkSeries {
            series_id: format!("{}_{}", source_id, series_id_str),
            source_id: source_id.clone(),
            category_ids: category_ids_json,
            name: final_name,
            tmdb_id: None,
            imdb_id: None,
            added: added_str,
            backdrop_path: None,
            popularity: None,
            match_attempted: None,
            _stalker_category: None,
            cover: stream.cover.and_then(|v| if let serde_json::Value::String(s) = v { Some(s) } else { None }),
            plot: stream.plot.and_then(|v| if let serde_json::Value::String(s) = v { Some(s) } else { None }),
            cast: stream.cast.and_then(|v| if let serde_json::Value::String(s) = v { Some(s) } else { None }),
            director: stream.director.and_then(|v| if let serde_json::Value::String(s) = v { Some(s) } else { None }),
            genre: stream.genre.and_then(|v| if let serde_json::Value::String(s) = v { Some(s) } else { None }),
            release_date: stream.releaseDate.and_then(|v| if let serde_json::Value::String(s) = v { Some(s) } else { None }),
            rating: rating_str,
            youtube_trailer: stream.youtube_trailer,
            episode_run_time: stream.episode_run_time.as_ref().and_then(json_value_to_plain_string),
            title: stream.title,
            last_modified: stream.last_modified.as_ref().and_then(json_value_to_plain_string),
            year: year_str,
            stream_type: Some("series".to_string()),
            stream_icon: None,
            direct_url: None,
            rating_5based: stream.rating_5based.and_then(|v| {
                if let serde_json::Value::Number(n) = v { n.as_f64() } 
                else if let serde_json::Value::String(s) = v { s.parse::<f64>().ok() } 
                else { None }
            }),
            category_id: None,
            _stalker_raw_id: None,
        });
    }

    let mut parsed_category_ids = Vec::with_capacity(bulk_categories.len());
    for b in &bulk_categories {
        parsed_category_ids.push(b.category_id.clone());
    }
    
    let result_cats = db_bulk_ops::bulk_upsert_vod_categories(&state.db, bulk_categories).map_err(|e| e.to_string())?;

    let mut parsed_content_ids = Vec::with_capacity(bulk_series.len());
    for b in &bulk_series {
        parsed_content_ids.push(b.series_id.clone());
    }
    
    let result_content = db_bulk_ops::bulk_upsert_series(&state.db, bulk_series).map_err(|e| e.to_string())?;

    info!("[Xtream VOD Series] Sync successful: {} categories, {} series", result_cats.inserted + result_cats.updated, result_content.inserted + result_content.updated);

    Ok(XtreamVodSyncResult {
        categories: result_cats,
        content: result_content,
        parsed_content_ids,
        parsed_category_ids,
    })
}
