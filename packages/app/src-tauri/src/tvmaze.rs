use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::dvr::database::DvrDatabase;

// TVMaze API response types

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeShowResult {
    pub score: f64,
    pub show:  TvMazeShow,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeShow {
    pub id:      i64,
    pub name:    String,
    pub status:  Option<String>,
    pub network: Option<TvMazeNetwork>,
    pub image:   Option<TvMazeImage>,
    pub summary: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeNetwork {
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeImage {
    pub medium:   Option<String>,
    pub original: Option<String>,
}

// Full show details from /shows/:id endpoint
#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeShowDetails {
    pub id:           i64,
    pub name:         String,
    pub url:          Option<String>,
    pub r#type:       Option<String>,
    pub language:     Option<String>,
    pub genres:       Option<Vec<String>>,
    pub status:       Option<String>,
    pub runtime:      Option<i64>,
    pub average_runtime: Option<i64>,
    pub premiered:    Option<String>,
    pub ended:        Option<String>,
    pub official_site: Option<String>,
    pub schedule:     Option<TvMazeSchedule>,
    pub rating:       Option<TvMazeRating>,
    pub weight:       Option<i64>,
    pub network:      Option<TvMazeNetworkDetails>,
    pub web_channel:  Option<TvMazeWebChannel>,
    pub dvd_country:  Option<String>,
    pub externals:    Option<TvMazeExternals>,
    pub image:        Option<TvMazeImage>,
    pub summary:      Option<String>,
    pub updated:      Option<i64>,
    pub _links:       Option<TvMazeLinks>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeSchedule {
    pub time: Option<String>,
    pub days: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeRating {
    pub average: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeNetworkDetails {
    pub id:      Option<i64>,
    pub name:    Option<String>,
    pub country: Option<TvMazeCountry>,
    pub official_site: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeCountry {
    pub name:     Option<String>,
    pub code:     Option<String>,
    pub timezone: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeWebChannel {
    pub id:      Option<i64>,
    pub name:    Option<String>,
    pub country: Option<TvMazeCountry>,
    pub official_site: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeExternals {
    pub tvrage:  Option<i64>,
    pub thetvdb: Option<i64>,
    pub imdb:    Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeLinks {
    #[serde(rename = "self")]
    pub self_link: Option<TvMazeLink>,
    pub previousepisode: Option<TvMazeLink>,
    pub nextepisode:     Option<TvMazeLink>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct TvMazeLink {
    pub href: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct TvMazeEpisode {
    pub id:       i64,
    pub name:     Option<String>,
    pub season:   Option<i64>,
    pub number:   Option<i64>,
    pub airdate:  Option<String>,
    pub airtime:  Option<String>,
    pub runtime:  Option<i64>,
    pub summary:  Option<String>,
    pub airstamp: Option<String>,
}

// DB-facing types (returned to frontend)

#[derive(Debug, Serialize)]
pub struct TrackedShow {
    pub tvmaze_id:                      i64,
    pub show_name:                      String,
    pub show_image:                     Option<String>,
    pub channel_name:                   Option<String>,
    pub channel_id:                     Option<String>,
    pub status:                         Option<String>,
    pub last_synced:                    Option<String>,
    pub auto_add_to_watchlist:          bool,
    pub watchlist_reminder_enabled:     bool,
    pub watchlist_reminder_minutes:     i32,
    pub watchlist_autoswitch_enabled:   bool,
    pub watchlist_autoswitch_seconds:   i32,
}

#[derive(Debug, Serialize)]
pub struct CalendarEpisode {
    pub tvmaze_episode_id: Option<i64>,
    pub airdate:           Option<String>,
    pub airtime:           Option<String>,
    pub airstamp:          Option<String>,
    pub episode_name:      Option<String>,
    pub season:            Option<i64>,
    pub episode:           Option<i64>,
    pub show_name:         String,
    pub channel_name:      Option<String>,
    pub show_image:        Option<String>,
}

// Intermediate struct for DB inserts
pub struct EpisodeRow {
    pub tvmaze_episode_id: i64,
    pub season:            Option<i64>,
    pub episode:           Option<i64>,
    pub episode_name:      Option<String>,
    pub airdate:           Option<String>,
    pub airtime:           Option<String>,
    pub airstamp:          Option<String>,
    pub runtime:           Option<i64>,
}

// HTTP helpers

pub async fn fetch_show_search(query: &str) -> Result<Vec<TvMazeShowResult>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.tvmaze.com/search/shows")
        .query(&[("q", query)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    resp.json::<Vec<TvMazeShowResult>>()
        .await
        .map_err(|e| e.to_string())
}

pub async fn fetch_episodes(tvmaze_id: i64) -> Result<Vec<EpisodeRow>, String> {
    let client = reqwest::Client::new();
    let url = format!("https://api.tvmaze.com/shows/{}/episodes", tvmaze_id);
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let raw: Vec<TvMazeEpisode> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(raw.into_iter().map(|ep| EpisodeRow {
        tvmaze_episode_id: ep.id,
        season:            ep.season,
        episode:           ep.number,
        episode_name:      ep.name,
        airdate:           ep.airdate,
        airtime:           ep.airtime,
        airstamp:          ep.airstamp,
        runtime:           ep.runtime,
    }).collect())
}

pub async fn fetch_show_details(tvmaze_id: i64) -> Result<TvMazeShowDetails, String> {
    let client = reqwest::Client::new();
    let url = format!("https://api.tvmaze.com/shows/{}", tvmaze_id);
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    resp.json::<TvMazeShowDetails>().await.map_err(|e| e.to_string())
}

pub async fn fetch_show_details_with_episodes(tvmaze_id: i64) -> Result<(TvMazeShowDetails, Vec<TvMazeEpisode>), String> {
    let client = reqwest::Client::new();

    // Fetch show details
    let details_url = format!("https://api.tvmaze.com/shows/{}", tvmaze_id);
    let details_resp = client.get(&details_url).send().await.map_err(|e| e.to_string())?;
    let details: TvMazeShowDetails = details_resp.json().await.map_err(|e| e.to_string())?;

    // Fetch episodes
    let episodes_url = format!("https://api.tvmaze.com/shows/{}/episodes", tvmaze_id);
    let episodes_resp = client.get(&episodes_url).send().await.map_err(|e| e.to_string())?;
    let episodes: Vec<TvMazeEpisode> = episodes_resp.json().await.map_err(|e| e.to_string())?;

    Ok((details, episodes))
}

// Background sync

pub async fn run_background_sync(db: Arc<DvrDatabase>) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
        println!("[TVMaze Sync] Starting 24h episode refresh...");

        let shows = match db.tvmaze_get_running_shows() {
            Ok(s) => s,
            Err(e) => { eprintln!("[TVMaze Sync] Failed to get shows: {}", e); continue; }
        };

        let mut refreshed = 0u32;
        for (tvmaze_id, show_name) in shows {
            match fetch_episodes(tvmaze_id).await {
                Ok(episodes) => {
                    let _ = db.tvmaze_upsert_episodes(tvmaze_id, &episodes);
                    let _ = db.tvmaze_update_last_synced(tvmaze_id);
                    refreshed += 1;
                    println!("[TVMaze Sync] Refreshed: {}", show_name);
                }
                Err(e) => eprintln!("[TVMaze Sync] Error for {}: {}", show_name, e),
            }
            // Be polite to the public API
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        println!("[TVMaze Sync] Done. Refreshed {} shows.", refreshed);
    }
}
