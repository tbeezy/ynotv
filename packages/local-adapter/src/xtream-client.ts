/**
 * Xtream Codes API Client
 *
 * Implements the Xtream Codes player_api.php interface.
 * Client for Xtream Codes API.
 *
 * API Reference:
 * - Base: http://server/player_api.php?username=X&password=Y
 * - Actions: get_live_categories, get_live_streams, get_vod_categories, etc.
 * - Stream URLs: http://server/live/username/password/stream_id.ts
 */

import type { Channel, Category, Movie, Series, Season } from '@ynotv/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { parseXmltv, type XmltvProgram } from './xmltv-parser';

export interface XtreamConfig {
  baseUrl: string;
  username: string;
  password: string;
  userAgent?: string;
}

export interface XtreamServerInfo {
  url: string;
  port: string;
  server_protocol: string;
  rtmp_port: string;
  timezone: string;
  timestamp_now: number;
  time_now: string;
}

export interface XtreamUserInfo {
  username: string;
  password: string;
  message: string;
  auth: number;
  status: string;
  exp_date: string;
  is_trial: string;
  active_cons: string;
  created_at: string;
  max_connections: string;
  allowed_output_formats: string[];
}

export interface XtreamAuthResponse {
  user_info: XtreamUserInfo;
  server_info: XtreamServerInfo;
}

export class XtreamClient {
  private config: XtreamConfig;
  private sourceId: string;

  constructor(config: XtreamConfig, sourceId: string) {
    // Normalize base URL (remove trailing slash)
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
    };
    this.sourceId = sourceId;
  }

  // ===========================================================================
  // API Helpers
  // ===========================================================================

  private buildApiUrl(action?: string): string {
    const { baseUrl, username, password } = this.config;
    let url = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
    if (action) {
      url += `&action=${action}`;
    }
    return url;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.config.userAgent) {
      headers['User-Agent'] = this.config.userAgent;
    }

    // Tauri Environment
    if ((window as any).__TAURI__) {
      try {
        console.log('[Xtream] Fetching (Tauri):', url);
        const response = await tauriFetch(url, {
          method: 'GET',
          headers
        });
        console.log('[Xtream] Response status:', response.status);
        if (!response.ok) {
          const text = await response.text();
          console.error('[Xtream] Error response body:', text);
          throw new Error(`Xtream API error: ${response.status} ${response.statusText}`);
        }
        const json = await response.json();
        console.log('[Xtream] Success, data length:', JSON.stringify(json).length);
        return json;
      } catch (e: any) {
        console.error('[Xtream] Tauri fetch failed:', e);
        throw new Error(`Tauri fetch failed: ${e.message || e}`);
      }
    }

    // Use Electron's fetch proxy if available (bypasses CORS)
    if (typeof window !== 'undefined' && window.fetchProxy) {
      const result = await window.fetchProxy.fetch(url, { headers });
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Fetch failed');
      }
      if (!result.data.ok) {
        throw new Error(`Xtream API error: ${result.data.status} ${result.data.statusText}`);
      }
      return JSON.parse(result.data.text);
    }

    // Fallback to regular fetch (works in Node.js or when CORS is not an issue)
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Xtream API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  private async fetchText(url: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.config.userAgent) {
      headers['User-Agent'] = this.config.userAgent;
    }

    // Use Electron's fetch proxy if available (bypasses CORS)
    if (typeof window !== 'undefined' && window.fetchProxy) {
      const result = await window.fetchProxy.fetch(url, { headers });
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Fetch failed');
      }
      if (!result.data.ok) {
        throw new Error(`Xtream API error: ${result.data.status} ${result.data.statusText}`);
      }
      return result.data.text;
    }

    // Fallback to regular fetch (works in Node.js or when CORS is not an issue)
    // Tauri Environment
    if ((window as any).__TAURI__) {
      try {
        const response = await tauriFetch(url, { headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } catch (e) {
        console.error('[Xtream] EPG Tauri fetch failed:', e);
        throw e;
      }
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch EPG: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  // ===========================================================================
  // Authentication
  // ===========================================================================

  async authenticate(): Promise<XtreamAuthResponse> {
    const url = this.buildApiUrl();
    return this.fetchJson<XtreamAuthResponse>(url);
  }

  async testConnection(): Promise<{ success: boolean; error?: string; info?: XtreamAuthResponse }> {
    try {
      const info = await this.authenticate();
      if (info.user_info.auth !== 1) {
        return { success: false, error: 'Authentication failed' };
      }
      return { success: true, info };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async getUserInfo(): Promise<{ expiry_date?: string; active_cons?: string; max_connections?: string }> {
    try {
      const authResponse = await this.authenticate();

      // Format expiry date from Unix timestamp to readable format
      let formattedExpiry: string | undefined;
      if (authResponse.user_info.exp_date) {
        const timestamp = parseInt(authResponse.user_info.exp_date, 10);
        if (!isNaN(timestamp)) {
          const date = new Date(timestamp * 1000); // Convert seconds to milliseconds

          // Format to match Stalker style: "August 18, 2026, 12:00 am"
          const options: Intl.DateTimeFormatOptions = {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          };
          formattedExpiry = date.toLocaleString('en-US', options);
        }
      }

      return {
        expiry_date: formattedExpiry,
        active_cons: authResponse.user_info.active_cons,
        max_connections: authResponse.user_info.max_connections,
      };
    } catch (error) {
      console.error('[Xtream] Failed to fetch user info:', error);
      return {};
    }
  }

  // ===========================================================================
  // Live TV
  // ===========================================================================

  async getLiveCategories(): Promise<Category[]> {
    const url = this.buildApiUrl('get_live_categories');
    const data = await this.fetchJson<XtreamCategory[]>(url);

    return data.map(cat => ({
      category_id: `${this.sourceId}_${cat.category_id}`,
      category_name: cat.category_name,
      source_id: this.sourceId,
    }));
  }

  async getLiveStreams(categoryId?: string): Promise<Channel[]> {
    let url = this.buildApiUrl('get_live_streams');
    if (categoryId) {
      // Strip source prefix if present
      const rawCatId = categoryId.replace(`${this.sourceId}_`, '');
      url += `&category_id=${rawCatId}`;
    }

    const data = await this.fetchJson<XtreamStream[]>(url);

    return data.map(stream => ({
      stream_id: `${this.sourceId}_${stream.stream_id}`,
      name: stream.name,
      stream_icon: stream.stream_icon || '',
      epg_channel_id: stream.epg_channel_id || '',
      category_ids: stream.category_id ? [`${this.sourceId}_${stream.category_id}`] : [],
      direct_url: this.buildStreamUrl('live', stream.stream_id),
      source_id: this.sourceId,
      tv_archive: stream.tv_archive === 1,
      channel_num: stream.num,
    }));
  }

  // ===========================================================================
  // VOD (Movies)
  // ===========================================================================

  async getVodCategories(): Promise<Category[]> {
    const url = this.buildApiUrl('get_vod_categories');
    const data = await this.fetchJson<XtreamCategory[]>(url);

    return data.map(cat => ({
      category_id: `${this.sourceId}_vod_${cat.category_id}`,
      category_name: cat.category_name,
      source_id: this.sourceId,
    }));
  }

  async getVodStreams(categoryId?: string): Promise<Movie[]> {
    let url = this.buildApiUrl('get_vod_streams');
    if (categoryId) {
      const rawCatId = categoryId.replace(`${this.sourceId}_vod_`, '');
      url += `&category_id=${rawCatId}`;
    }

    const data = await this.fetchJson<XtreamVodStream[]>(url);

    return data.map(vod => ({
      stream_id: `${this.sourceId}_${vod.stream_id}`,
      name: vod.name,
      title: vod.title,
      year: vod.year,
      stream_icon: vod.stream_icon || '',
      category_ids: vod.category_id ? [`${this.sourceId}_vod_${vod.category_id}`] : [],
      direct_url: this.buildStreamUrl('movie', vod.stream_id, vod.container_extension),
      source_id: this.sourceId,
      plot: vod.plot,
      cast: vod.cast,
      director: vod.director,
      genre: vod.genre,
      release_date: vod.releasedate,
      rating: vod.rating,
    }));
  }

  // ===========================================================================
  // Series
  // ===========================================================================

  async getSeriesCategories(): Promise<Category[]> {
    const url = this.buildApiUrl('get_series_categories');
    const data = await this.fetchJson<XtreamCategory[]>(url);

    return data.map(cat => ({
      category_id: `${this.sourceId}_series_${cat.category_id}`,
      category_name: cat.category_name,
      source_id: this.sourceId,
    }));
  }

  async getSeries(categoryId?: string): Promise<Series[]> {
    let url = this.buildApiUrl('get_series');
    if (categoryId) {
      const rawCatId = categoryId.replace(`${this.sourceId}_series_`, '');
      url += `&category_id=${rawCatId}`;
    }

    const data = await this.fetchJson<XtreamSeries[]>(url);

    return data.map(series => ({
      series_id: `${this.sourceId}_${series.series_id}`,
      name: series.name,
      title: series.title,
      year: series.year,
      cover: series.cover || '',
      category_ids: series.category_id ? [`${this.sourceId}_series_${series.category_id}`] : [],
      source_id: this.sourceId,
      plot: series.plot,
      cast: series.cast,
      genre: series.genre,
      release_date: series.releaseDate,
      rating: series.rating,
    }));
  }

  async getSeriesInfo(seriesId: string): Promise<Season[]> {
    const rawSeriesId = seriesId.replace(`${this.sourceId}_`, '');
    const url = this.buildApiUrl('get_series_info') + `&series_id=${rawSeriesId}`;
    const data = await this.fetchJson<XtreamSeriesInfo>(url);

    if (!data.episodes) return [];

    // Episodes are grouped by season number
    const seasons: Season[] = [];

    for (const [seasonNum, episodes] of Object.entries(data.episodes)) {
      const seasonEpisodes = (episodes as XtreamEpisode[]).map(ep => ({
        id: `${this.sourceId}_${ep.id}`,
        title: ep.title,
        episode_num: ep.episode_num,
        season_num: parseInt(seasonNum, 10),
        direct_url: this.buildStreamUrl('series', ep.id, ep.container_extension),
        plot: ep.info?.plot,
        duration: ep.info?.duration ? parseInt(ep.info.duration, 10) : undefined,
        info: ep.info,
      }));

      seasons.push({
        season_number: parseInt(seasonNum, 10),
        episodes: seasonEpisodes,
      });
    }

    return seasons.sort((a, b) => a.season_number - b.season_number);
  }

  // ===========================================================================
  // EPG
  // ===========================================================================

  getEpgUrl(): string {
    const { baseUrl, username, password } = this.config;
    return `${baseUrl}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  }

  async getShortEpg(streamId: string, limit = 4): Promise<XtreamEpgEntry[]> {
    const rawStreamId = streamId.replace(`${this.sourceId}_`, '');
    const url = this.buildApiUrl('get_short_epg') + `&stream_id=${rawStreamId}&limit=${limit}`;
    const data = await this.fetchJson<{ epg_listings: XtreamEpgEntry[] }>(url);
    return data.epg_listings || [];
  }

  // Fetch full XMLTV EPG data
  async getXmltvEpg(): Promise<XmltvProgram[]> {
    const url = this.getEpgUrl();
    const xmlText = await this.fetchText(url);
    return parseXmltv(xmlText);
  }

  // ===========================================================================
  // URL Building
  // ===========================================================================

  buildStreamUrl(type: 'live' | 'movie' | 'series', streamId: string | number, extension?: string): string {
    const { baseUrl, username, password } = this.config;
    const ext = extension || 'ts';
    return `${baseUrl}/${type}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`;
  }

  buildTimeshiftUrl(streamId: string | number, duration: number, startTime: string, extension = 'ts'): string {
    const { baseUrl, username, password } = this.config;
    return `${baseUrl}/timeshift/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${duration}/${startTime}/${streamId}.${extension}`;
  }
}

// ===========================================================================
// Xtream API Response Types
// ===========================================================================

interface XtreamCategory {
  category_id: string;
  category_name: string;
  parent_id: number;
}

interface XtreamStream {
  num: number;            // Channel order from provider
  stream_id: number;
  name: string;
  stream_icon: string;
  epg_channel_id: string;
  category_id: string;
  tv_archive: number;
  direct_source: string;
}

interface XtreamVodStream {
  stream_id: number;
  name: string;
  title?: string;       // Clean title without year (e.g., "40 Pounds of Trouble")
  year?: string;        // Release year (e.g., "1962")
  stream_icon: string;
  category_id: string;
  container_extension: string;
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  releasedate?: string;
  rating?: string;
}

interface XtreamSeries {
  series_id: number;
  name: string;
  title?: string;       // Clean title without year
  year?: string;        // First air year
  cover: string;
  category_id: string;
  plot?: string;
  cast?: string;
  genre?: string;
  releaseDate?: string;
  rating?: string;
}

interface XtreamSeriesInfo {
  seasons: unknown[];
  episodes: Record<string, XtreamEpisode[]>;
}

interface XtreamEpisode {
  id: string;
  title: string;
  episode_num: number;
  container_extension: string;
  info?: {
    plot?: string;
    duration?: string;
    [key: string]: unknown;
  };
}

interface XtreamEpgEntry {
  id: string;
  epg_id: string;
  title: string;
  lang: string;
  start: string;
  end: string;
  description: string;
  channel_id: string;
}

// XmltvProgram is now exported from xmltv-parser.ts
