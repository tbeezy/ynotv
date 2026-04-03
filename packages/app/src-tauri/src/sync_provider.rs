use crate::db_bulk_ops::{self, BulkCategory, BulkChannel, BulkResult};
use crate::dvr::DvrState;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tracing::{error, info};

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

#[derive(Serialize)]
pub struct XtreamVodSyncResult {
    pub categories: BulkResult,
    pub content: BulkResult,
    pub parsed_content_ids: Vec<String>,
    pub parsed_category_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct XtreamVodStream {
    pub stream_id: serde_json::Value,
    pub name: String,
    pub title: Option<String>,
    pub year: Option<serde_json::Value>,
    pub stream_icon: Option<String>,
    pub category_id: Option<serde_json::Value>, // Sometimes comes as number
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
                let _duration = duration_str.parse::<i32>().unwrap_or(-1);

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
        
    let client = if let Some(ua) = user_agent {
        client_builder.user_agent(ua).build().map_err(|e| e.to_string())?
    } else {
        client_builder.build().map_err(|e| e.to_string())?
    };

    let base_url = base_url.trim_end_matches('/');

    // 1. Fetch Categories
    let cat_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_vod_categories",
        base_url, username, password
    );
    
    let cat_res = client.get(&cat_url).send().await.map_err(|e| e.to_string())?;
    let xtream_categories: Vec<XtreamCategory> = cat_res.json().await.unwrap_or_else(|e| {
        error!("[Xtream VOD] Failed to parse categories: {}", e);
        Vec::new() // Fallback to empty if fails
    });

    let mut bulk_categories = Vec::with_capacity(xtream_categories.len());
    for cat in xtream_categories {
        use crate::db_bulk_ops::BulkVodCategory;
        bulk_categories.push(BulkVodCategory {
            category_id: format!("{}_vod_{}", source_id, cat.category_id),
            source_id: source_id.clone(),
            name: cat.category_name,
            type_str: "movie".to_string(),
            enabled: None,
            display_order: None,
        });
    }

    // 2. Fetch Streams
    let stream_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_vod_streams",
        base_url, username, password
    );

    let start_dl = std::time::Instant::now();
    let stream_res = client.get(&stream_url).send().await.map_err(|e| e.to_string())?;
    
    let bytes = stream_res.bytes().await.map_err(|e| e.to_string())?;
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

        let cat_id_str = match &stream.category_id {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => "".to_string(),
        };

        let category_ids_json = if !cat_id_str.is_empty() {
            Some(format!("[\"{}_vod_{}\"]", source_id, cat_id_str))
        } else {
            Some("[]".to_string())
        };

        let ext = stream.container_extension.clone().unwrap_or_else(|| "mp4".to_string());
        let direct_url = format!(
            "{}/movie/{}/{}/{}.{}",
            base_url, username, password, stream_id_str, ext
        );

        let rating_str = stream.rating.map(|v| v.to_string());
        let year_str = stream.year.map(|v| v.to_string());
        
        let added_str = match stream.added {
            Some(serde_json::Value::Number(n)) => Some(n.to_string()),
            Some(serde_json::Value::String(s)) => Some(s),
            _ => Some(chrono::Utc::now().to_rfc3339()),
        };

        bulk_movies.push(BulkMovie {
            stream_id: format!("{}_{}", source_id, stream_id_str),
            source_id: source_id.clone(),
            category_ids: category_ids_json,
            name: stream.name,
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
        
    let client = if let Some(ua) = user_agent {
        client_builder.user_agent(ua).build().map_err(|e| e.to_string())?
    } else {
        client_builder.build().map_err(|e| e.to_string())?
    };

    let base_url = base_url.trim_end_matches('/');

    let cat_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_series_categories",
        base_url, username, password
    );
    
    let cat_res = client.get(&cat_url).send().await.map_err(|e| e.to_string())?;
    let xtream_categories: Vec<XtreamCategory> = cat_res.json().await.unwrap_or_else(|e| {
        error!("[Xtream Series] Failed to parse categories: {}", e);
        Vec::new()
    });

    let mut bulk_categories = Vec::with_capacity(xtream_categories.len());
    for cat in xtream_categories {
        use crate::db_bulk_ops::BulkVodCategory;
        bulk_categories.push(BulkVodCategory {
            category_id: format!("{}_series_{}", source_id, cat.category_id),
            source_id: source_id.clone(),
            name: cat.category_name,
            type_str: "series".to_string(),
            enabled: None,
            display_order: None,
        });
    }

    let stream_url = format!(
        "{}/player_api.php?username={}&password={}&action=get_series",
        base_url, username, password
    );

    let start_dl = std::time::Instant::now();
    let stream_res = client.get(&stream_url).send().await.map_err(|e| e.to_string())?;

    let bytes = stream_res.bytes().await.map_err(|e| e.to_string())?;
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

        let cat_id_str = match &stream.category_id {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => "".to_string(),
        };

        let category_ids_json = if !cat_id_str.is_empty() {
            Some(format!("[\"{}_series_{}\"]", source_id, cat_id_str))
        } else {
            Some("[]".to_string())
        };

        let rating_str = stream.rating.map(|v| v.to_string());
        let year_str = stream.year.map(|v| v.to_string());
        
        let added_str = match stream.added {
            Some(serde_json::Value::Number(n)) => Some(n.to_string()),
            Some(serde_json::Value::String(s)) => Some(s),
            _ => Some(chrono::Utc::now().to_rfc3339()),
        };

        // Note: db_bulk_ops.rs handles preserving COALESCE fields
        bulk_series.push(BulkSeries {
            series_id: format!("{}_{}", source_id, series_id_str),
            source_id: source_id.clone(),
            category_ids: category_ids_json,
            name: stream.name,
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
            episode_run_time: stream.episode_run_time.map(|v| v.to_string()),
            title: stream.title,
            last_modified: stream.last_modified.map(|v| v.to_string()),
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
