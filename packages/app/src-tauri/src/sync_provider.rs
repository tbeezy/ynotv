use crate::db_bulk_ops::{self, BulkCategory, BulkChannel, BulkResult};
use crate::dvr::DvrState;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tracing::{debug, error, info};

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
    let client = if let Some(ua) = user_agent {
        client_builder.user_agent(ua).build().map_err(|e| e.to_string())?
    } else {
        client_builder.build().map_err(|e| e.to_string())?
    };

    let base_url = base_url.trim_end_matches('/');

    // 1. Fetch Categories
    let cat_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_live_categories",
        base_url, username, password
    );
    
    let cat_res = client.get(&cat_url).send().await.map_err(|e| e.to_string())?;
    let xtream_categories: Vec<XtreamCategory> = cat_res.json().await.map_err(|e| {
        error!("[Xtream Sync] Failed to parse categories: {}", e);
        e.to_string()
    })?;

    // Map to BulkCategory
    let mut bulk_categories = Vec::with_capacity(xtream_categories.len());
    for cat in xtream_categories {
        bulk_categories.push(BulkCategory {
            category_id: format!("{}_{}", source_id, cat.category_id),
            source_id: source_id.clone(),
            category_name: cat.category_name,
            parent_id: cat.parent_id,
            enabled: None,
            display_order: None,
            channel_count: None,
            filter_words: None,
        });
    }

    // 2. Fetch Streams
    let stream_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_live_streams",
        base_url, username, password
    );

    let stream_res = client.get(&stream_url).send().await.map_err(|e| e.to_string())?;
    let xtream_streams: Vec<XtreamStream> = stream_res.json().await.map_err(|e| {
        error!("[Xtream Sync] Failed to parse streams: {}", e);
        e.to_string()
    })?;

    // Map to BulkChannel
    let mut bulk_channels = Vec::with_capacity(xtream_streams.len());
    for stream in xtream_streams {
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
        seen_ids.insert(unique_id.clone());
        return unique_id;
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

// Regex imports inside method to avoid polluting global scope
#[tauri::command]
pub async fn sync_m3u_source(
    state: tauri::State<'_, DvrState>,
    source_id: String,
    url: String,
    user_agent: Option<String>,
) -> Result<M3uSyncResult, String> {
    info!("[M3U Sync] Starting native sync for {}", source_id);

    let client_builder = Client::builder();
    let client = if let Some(ua) = user_agent {
        client_builder.user_agent(ua).build().map_err(|e| e.to_string())?
    } else {
        client_builder.build().map_err(|e| e.to_string())?
    };

    let content = client.get(&url).send().await.map_err(|e| e.to_string())?
        .text().await.map_err(|e| e.to_string())?;

    let mut bulk_channels = Vec::new();
    let mut bulk_categories = Vec::new();
    let mut categories_map = HashMap::new();
    let mut seen_ids = HashSet::new();

    let mut current_extinf: Option<String> = None;
    let mut channel_counter = 0;
    let mut epg_url: Option<String> = None;

    for line in content.lines().map(|l| l.trim()) {
        if line.is_empty() { continue; }

        if line.starts_with("#EXTM3U") {
            // Extract epg_url from url-tvg=".." or x-tvg-url=".."
            if let Some(start) = line.find("url-tvg=\"").or_else(|| line.find("x-tvg-url=\"")) {
                let quote_start = line[start..].find('"').unwrap() + 1;
                let substr = &line[start + quote_start..];
                if let Some(end) = substr.find('"') {
                    epg_url = Some(substr[..end].to_string());
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

                // Simple attribute extraction
                let extract_attr = |key: &str| -> String {
                    if let Some(start) = extinf.find(&format!("{}=\"", key)) {
                        let substr = &extinf[start + key.len() + 2..];
                        if let Some(end) = substr.find('"') {
                            return substr[..end].to_string();
                        }
                    }
                    "".to_string()
                };

                let duration_str = extinf[8..].split_whitespace().next().unwrap_or("-1").replace(",", "");
                let duration = duration_str.parse::<i32>().unwrap_or(-1);

                let tvg_id = extract_attr("tvg-id");
                let tvg_name = extract_attr("tvg-name");
                let tvg_logo = extract_attr("tvg-logo");
                let group_title = extract_attr("group-title");
                let tvg_chno_str = extract_attr("tvg-chno");
                let tvg_chno = tvg_chno_str.parse::<i32>().ok();
                
                let tv_archive = if extract_attr("catchup") != "" || extract_attr("catchup-source") != "" { 1 } else { 0 };

                let display_name = if let Some(comma_pos) = extinf.rfind(',') {
                    extinf[comma_pos + 1..].trim().to_string()
                } else {
                    format!("Channel {}", channel_counter)
                };

                let stream_id = generate_stable_stream_id(&source_id, &tvg_id, line, &mut seen_ids);

                let mut category_ids = Vec::new();
                if !group_title.is_empty() {
                    let cat_slug = group_title.to_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-").trim_matches('-').to_string();
                    let category_id = format!("{}_{}", source_id, cat_slug);
                    category_ids.push(category_id.clone());

                    if !categories_map.contains_key(&category_id) {
                        categories_map.insert(category_id.clone(), true);
                        bulk_categories.push(BulkCategory {
                            category_id,
                            category_name: group_title.clone(),
                            source_id: source_id.clone(),
                            parent_id: None,
                            enabled: None,
                            display_order: None,
                            channel_count: None,
                            filter_words: None,
                        });
                    }
                }

                bulk_channels.push(BulkChannel {
                    stream_id,
                    source_id: source_id.clone(),
                    category_ids: if category_ids.is_empty() { Some("[]".to_string()) } else { Some(format!("[\"{}\"]", category_ids[0])) },
                    name: if !display_name.is_empty() { display_name } else { tvg_name.clone() },
                    channel_num: tvg_chno,
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
