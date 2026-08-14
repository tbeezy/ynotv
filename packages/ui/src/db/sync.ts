import { db, clearSourceData, clearVodData, restoreUserCustomizations, type SourceMeta, type StoredProgram, type StoredMovie, type StoredSeries, type StoredEpisode, type VodCategory } from './index';
import i18n, { translateNativeError } from '../i18n';
import { fetchAndParseM3U, XtreamClient, StalkerClient } from '@ynotv/local-adapter';
import type { Source, Channel, Category, Movie, Series } from '@ynotv/core';
import { useUIStore } from '../stores/uiStore';
import { bulkOps, type BulkChannel, type BulkCategory } from '../services/bulk-ops';
import { epgStreaming, type EpgProgressCallback, type EpgParseResult } from '../services/epg-streaming';
import { dbEvents } from './sqlite-adapter';
import { matchAllMoviesLazy, matchAllSeriesLazy } from '../services/title-match';
import type { GlobalEpgLink } from '../types/app';

import { invoke } from '@tauri-apps/api/core';

// Debug logging helper - logs to console and optionally to debug file
function debugLog(message: string, category = 'sync'): void {
  // Check if debug logging is enabled via global flag
  if (!(window as any).__debugLoggingEnabled) {
    return;
  }
  const logMsg = `[${category}] ${message}`;
  console.log(logMsg);
  // Also send to main process debug log if available
  if (window.debug?.logFromRenderer) {
    window.debug.logFromRenderer(logMsg).catch(() => { });
  }
}

/**
 * Load epg_channel_overrides as a streamId → epg_channel_id map.
 * Used by all EPG sync paths to honour user-applied TVG-ID overrides.
 */
async function loadEpgChannelOverrideMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const overrides = await db.epgChannelOverrides.toArray();
    for (const o of overrides) {
      if (o.epg_channel_id) map.set(o.stream_id, o.epg_channel_id);
    }
  } catch {
    // Table may not exist on very old DBs — silently ignore
  }
  return map;
}

// Helper to detect and fix duplicated URLs (e.g., "urlurl" -> "url")
function fixDuplicatedUrl(url: string | undefined): string | undefined {
  if (!url || url.length < 2) return url;
  const half = url.length / 2;
  if (url.substring(0, half) === url.substring(half)) {
    console.log(`[Sync] Detected duplicated URL, fixing: ${url.substring(0, half)}`);
    return url.substring(0, half);
  }
  return url;
}

async function resolveSourceUserAgent(source: any): Promise<any> {
  if (!source) return source;
  if (source.user_agent && source.user_agent.trim()) {
    return source; // source user agent overrides global
  }
  if (!window.storage) {
    return source;
  }
  try {
    const settingsResult = await window.storage.getSettings();
    const globalUa = settingsResult.data?.globalLiveTvUserAgent;
    if (globalUa && globalUa.trim()) {
      return {
        ...source,
        user_agent: globalUa.trim(),
      };
    }
  } catch (e) {
    console.error('[sync] Failed to load global user agent for source:', source.id, e);
  }
  return source;
}

export interface SyncResult {
  success: boolean;
  channelCount: number;
  categoryCount: number;
  programCount: number;
  epgUrl?: string;
  error?: string;
}

export interface VodSyncResult {
  success: boolean;
  movieCount: number;
  seriesCount: number;
  movieCategoryCount: number;
  seriesCategoryCount: number;
  error?: string;
}

// Default freshness thresholds (can be overridden by user settings)
const DEFAULT_EPG_STALE_HOURS = 6;
const DEFAULT_VOD_STALE_HOURS = 24;

// Track deleted sources to prevent sync from writing results after deletion
// This prevents the race condition where sync writes error AFTER clearSourceData runs
const deletedSourceIds = new Set<string>();

export function markSourceDeleted(sourceId: string) {
  deletedSourceIds.add(sourceId);
  // Clean up after 30 seconds (sync should be done by then)
  setTimeout(() => deletedSourceIds.delete(sourceId), 30000);
}

function isSourceDeleted(sourceId: string): boolean {
  return deletedSourceIds.has(sourceId);
}

// Reference counter for concurrent TMDB matching operations
// Prevents race condition where Source A finishing sets tmdbMatching=false
// while Source B is still running
let tmdbMatchingCount = 0;

function startTmdbMatching() {
  tmdbMatchingCount++;
  if (tmdbMatchingCount === 1) {
    useUIStore.getState().setTmdbMatching(true);
  }
}

function endTmdbMatching() {
  tmdbMatchingCount = Math.max(0, tmdbMatchingCount - 1);
  if (tmdbMatchingCount === 0) {
    useUIStore.getState().setTmdbMatching(false);
  }
}

// Safety limits for EPG fetching
// Large files (>50MB) cause UI freezing due to IPC overhead - TODO: implement streaming
// Valid columns based on db/index.ts schema
const VOD_MOVIE_FIELDS = [
  'stream_id', 'source_id', 'category_ids', 'name', 'tmdb_id', 'added',
  'popularity', 'backdrop_path', 'imdb_id', 'match_attempted',
  'container_extension', 'rating', 'director', 'year', 'cast', 'plot', 'genre',
  'duration_secs', 'duration', 'stream_icon', 'direct_url', 'release_date', // Fixed: direct_source -> direct_url
  'title'  // Clean title without year
];

const VOD_SERIES_FIELDS = [
  'series_id', 'source_id', 'category_ids', 'name', 'tmdb_id', 'added',
  'popularity', 'backdrop_path', 'imdb_id', 'match_attempted',
  '_stalker_category', '_stalker_raw_id', 'cover', 'plot', 'cast', 'director', 'genre',
  'releaseDate', 'rating', 'youtube_trailer', 'episode_run_time',
  'title', 'last_modified', 'year', 'stream_type', 'stream_icon', 'direct_url',
  'rating_5based', 'category_id'
];

function sanitizeMovie(movie: any, existingMovie?: any): any {
  const clean: any = {};

  // 1. Map known aliases/mismatches and apply defaults
  let addedVal = movie.added || movie.last_modified || existingMovie?.added;
  if (addedVal) {
    if (typeof addedVal === 'number') {
      clean.added = new Date(addedVal * 1000).toISOString();
    } else if (typeof addedVal === 'string' && /^\d+$/.test(addedVal.trim())) {
      clean.added = new Date(parseInt(addedVal.trim(), 10) * 1000).toISOString();
    } else {
      const parsedDate = new Date(addedVal);
      if (!isNaN(parsedDate.getTime())) {
        clean.added = parsedDate.toISOString();
      } else {
        clean.added = existingMovie?.added ? (existingMovie.added instanceof Date ? existingMovie.added.toISOString() : existingMovie.added) : new Date().toISOString();
      }
    }
  } else {
    clean.added = new Date().toISOString();
  }
  if (movie.title && !movie.name) clean.name = movie.title;

  // 2. Copy whitelist fields, prioritizing mapped values if already set
  for (const field of VOD_MOVIE_FIELDS) {
    if (clean[field] === undefined && movie[field] !== undefined) {
      clean[field] = movie[field];
    }
  }

  // 3. Ensure Types and specific transformations
  if (Array.isArray(clean.category_ids)) {
    clean.category_ids = JSON.stringify(clean.category_ids);
  }
  if (Array.isArray(clean.genre)) {
    clean.genre = clean.genre.join(', ');
  }
  if (Array.isArray(clean.backdrop_path)) {
    clean.backdrop_path = clean.backdrop_path[0];
  }
  if (clean.release_date) {
    clean.year = new Date(clean.release_date).getFullYear();
  }

  // Preserve existing enrichments if present and not overwritten by source data
  clean.tmdb_id = existingMovie?.tmdb_id ?? clean.tmdb_id;
  clean.imdb_id = existingMovie?.imdb_id ?? clean.imdb_id;
  clean.popularity = existingMovie?.popularity ?? clean.popularity;
  clean.match_attempted = existingMovie?.match_attempted ?? clean.match_attempted;
  clean.backdrop_path = existingMovie?.backdrop_path ?? clean.backdrop_path;
  clean.stream_icon = clean.stream_icon || existingMovie?.stream_icon; // Preserve source poster if exists

  return clean;
}

function sanitizeSeries(series: any, existingSeries?: any): any {
  const clean: any = {};

  // 1. Map known aliases/mismatches and apply defaults
  let addedVal = series.added || series.last_modified || existingSeries?.added;
  if (addedVal) {
    if (typeof addedVal === 'number') {
      clean.added = new Date(addedVal * 1000).toISOString();
    } else if (typeof addedVal === 'string' && /^\d+$/.test(addedVal.trim())) {
      clean.added = new Date(parseInt(addedVal.trim(), 10) * 1000).toISOString();
    } else {
      const parsedDate = new Date(addedVal);
      if (!isNaN(parsedDate.getTime())) {
        clean.added = parsedDate.toISOString();
      } else {
        clean.added = existingSeries?.added ? (existingSeries.added instanceof Date ? existingSeries.added.toISOString() : existingSeries.added) : new Date().toISOString();
      }
    }
  } else {
    clean.added = new Date().toISOString();
  }
  if (series.release_date && !series.releaseDate) clean.releaseDate = series.release_date;
  if (series.first_air_date && !series.releaseDate) clean.releaseDate = series.first_air_date; // Common alias for series
  if (series.name && !series.title) clean.title = series.name; // Ensure title is present for matching

  // 2. Copy whitelist fields, prioritizing mapped values if already set
  for (const field of VOD_SERIES_FIELDS) {
    if (clean[field] === undefined && series[field] !== undefined) {
      clean[field] = series[field];
    }
  }

  // 3. Ensure Types and specific transformations
  if (Array.isArray(clean.category_ids)) clean.category_ids = JSON.stringify(clean.category_ids);
  if (Array.isArray(clean.genre)) clean.genre = clean.genre.join(', ');
  if (Array.isArray(clean.backdrop_path)) clean.backdrop_path = clean.backdrop_path[0];
  if (clean.releaseDate) {
    clean.year = new Date(clean.releaseDate).getFullYear();
  }

  // Preserve existing enrichments if present and not overwritten by source data
  clean.tmdb_id = existingSeries?.tmdb_id ?? clean.tmdb_id;
  clean.imdb_id = existingSeries?.imdb_id ?? clean.imdb_id;
  clean.popularity = existingSeries?.popularity ?? clean.popularity;
  clean.backdrop_path = existingSeries?.backdrop_path ?? clean.backdrop_path; // Preserve if source doesn't provide
  clean.match_attempted = existingSeries?.match_attempted ?? clean.match_attempted;
  clean.stream_icon = clean.stream_icon || existingSeries?.stream_icon; // Preserve source poster if exists
  clean.cover = clean.cover || existingSeries?.cover; // Preserve source cover if exists

  return clean;
}

// Sync EPG from XMLTV URL(s) for M3U sources using streaming parser
async function syncEpgFromUrl(
  source: Source,
  epgUrl: string,
  channels: Channel[],
  onProgress?: EpgProgressCallback
): Promise<number> {
  console.log(`[EPG] Starting M3U EPG sync for source: ${source.name}`);
  console.log(`[EPG] EPG URL received: ${epgUrl}`);
  console.log(`[EPG] EPG URL length: ${epgUrl.length}`);
  console.log(`[EPG] Total channels: ${channels.length}`);

  // DEBUG: Check sample channel stream_ids
  console.log(`[EPG] DEBUG - Sample channel stream_ids:`, channels.slice(0, 3).map(ch => ({
    name: ch.name,
    stream_id: ch.stream_id,
    epg_channel_id: ch.epg_channel_id
  })));

  debugLog(`Starting M3U EPG sync with streaming parser`, 'epg');

  try {
    // Load user-applied EPG channel ID overrides so they win over the raw channel value
    const epgOverrideMap = await loadEpgChannelOverrideMap();

    // Create channel mappings for Rust parser
    // Include all channels (even without epg_channel_id) for name-based fallback matching
    const channelMappings = channels
      .filter((ch) => epgOverrideMap.has(ch.stream_id) || ch.epg_channel_id || ch.name)
      .map((ch) => ({
        epg_channel_id: epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || ch.name || '',
        stream_id: ch.stream_id,
        channel_name: ch.name || '',
      }));

    console.log(`[EPG] Channels with EPG mapping (tvg-id or name): ${channelMappings.length}/${channels.length}`);

    // Log sample mappings for debugging
    if (channelMappings.length > 0) {
      console.log(`[EPG] Sample mappings:`, channelMappings.slice(0, 3).map(m =>
        `${m.epg_channel_id} -> ${m.stream_id}`
      ).join(', '));
    }

    debugLog(
      `${channelMappings.length}/${channels.length} channels have EPG mapping (tvg-id or name)`,
      'epg'
    );

    if (channelMappings.length === 0) {
      console.warn(`[EPG] WARNING: No channels available for EPG matching - EPG sync skipped!`);
      console.warn(`[EPG] This means your M3U playlist doesn't have tvg-id attributes or channel names.`);
      debugLog('No channels for EPG matching, skipping EPG sync', 'epg');
      return 0;
    }

    // Use streaming EPG parser
    const result = await epgStreaming.streamParseEpg(
      source.id,
      source.name || source.id,
      epgUrl,
      channelMappings,
      onProgress
        ? (progress) => {
          debugLog(epgStreaming.formatProgress(progress), 'epg');
          onProgress(progress);
        }
        : undefined,
      source.advanced_epg_matching,
      source.epg_timeshift_hours ?? 0,
      true, // clearExisting = true for main EPG
      source.user_agent
    );

    debugLog(
      `Matched ${result.matched_programs}/${result.total_programs} programs (${result.unmatched_channels} unmatched EPG channels)`,
      'epg'
    );

    console.log(`[EPG] Streaming parser result: ${result.matched_programs}/${result.total_programs} programs matched`);
    console.log(`[EPG] ${result.inserted_programs} programs inserted, ${result.unmatched_channels} unmatched EPG channels`);
    console.log(`[EPG] Duration: ${result.duration_ms}ms`);

    if (result.inserted_programs === 0) {
      console.warn(`[EPG] WARNING: No programs inserted! Check if EPG channel IDs match M3U tvg-id values.`);
      debugLog(
        'WARNING: No programs inserted! Keeping existing EPG data',
        'epg'
      );
      return 0;
    }

    // Notify UI of EPG update
    dbEvents.notify('programs', 'clear');
    if (result.inserted_programs > 0) {
      dbEvents.notify('programs', 'add');
    }

    console.log(`[EPG] M3U EPG sync COMPLETE: ${result.inserted_programs} programs stored`);
    debugLog(
      `M3U EPG sync complete: ${result.inserted_programs} programs stored in ${result.duration_ms}ms`,
      'epg'
    );
    return result.inserted_programs;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[EPG] M3U EPG sync FAILED: ${errMsg}`);
    debugLog(`M3U EPG sync FAILED: ${errMsg}`, 'epg');
    return 0;
  }
}

// Sync EPG for Xtream source using RUST STREAMING PARSER (high performance)
async function syncEpgForSource(source: Source, channels: Channel[], epgUrl?: string): Promise<number> {
  if (!source.username || !source.password) return 0;

  console.log(`[EPG] Starting Xtream EPG sync with RUST STREAMING PARSER for source: ${source.name || source.id}`);
  console.log(`[EPG] Total channels: ${channels.length}`);

  debugLog(`Starting EPG sync with Rust streaming parser for source: ${source.name || source.id}`, 'epg');

  // Use the provided EPG URL or construct from source.url
  let xmltvUrl = epgUrl || `${source.url}/xmltv.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
  
  // Convert HTTPS to HTTP for EPG URLs to avoid TLS certificate issues
  // Many IPTV providers have misconfigured HTTPS on their EPG endpoints
  if (xmltvUrl.startsWith('https://')) {
    xmltvUrl = xmltvUrl.replace('https://', 'http://');
    console.log(`[EPG] Converted HTTPS to HTTP for EPG URL: ${xmltvUrl.substring(0, 80)}...`);
  }
  
  console.log(`[EPG] Streaming XMLTV from: ${xmltvUrl.substring(0, 80)}...`);
  debugLog(`Streaming XMLTV from: ${xmltvUrl}`, 'epg');

  try {
    // Load user-applied EPG channel ID overrides so they win over the raw channel value
    const epgOverrideMap = await loadEpgChannelOverrideMap();

    // Build channel mappings for Rust parser (overrides take precedence)
    const channelMappings = channels
      .filter(ch => epgOverrideMap.has(ch.stream_id) || ch.epg_channel_id || ch.name)
      .map(ch => ({
        epg_channel_id: epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || ch.name || '',
        stream_id: ch.stream_id,
        channel_name: ch.name || '',
      }));

    console.log(`[EPG] Channels with EPG mapping (tvg-id or name): ${channelMappings.length}/${channels.length}`);
    debugLog(`${channelMappings.length}/${channels.length} channels have epg_channel_id`, 'epg');

    // Use native Rust streaming parser for maximum performance
    // This downloads, parses, matches, and inserts all in Rust
    const result = await invoke<EpgParseResult>('stream_parse_epg', {
      sourceId: source.id,
      sourceName: source.name || source.id,
      epgUrl: xmltvUrl,
      channelMappings,
      advancedEpgMatching: source.advanced_epg_matching ?? false,
      timeshiftHours: source.epg_timeshift_hours ?? 0,
      clearExisting: true,
      userAgent: source.user_agent || null,
    });

    console.log(`[EPG] Rust streaming parser COMPLETE:`);
    console.log(`  - Total programs in XML: ${result.total_programs}`);
    console.log(`  - Matched to channels: ${result.matched_programs}`);
    console.log(`  - Inserted to DB: ${result.inserted_programs}`);
    console.log(`  - Duration: ${result.duration_ms}ms`);

    debugLog(`EPG sync complete: ${result.inserted_programs} programs stored (${result.duration_ms}ms)`, 'epg');

    // Trigger reactive query updates in UI since native insertions bypass the JS adapter
    if (result.inserted_programs > 0) {
      dbEvents.notify('programs', 'add');
    }

    return result.inserted_programs;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[EPG] Rust streaming parser FAILED: ${errMsg}`);
    debugLog(`EPG streaming parser FAILED: ${errMsg}`, 'epg');
    debugLog('Keeping existing EPG data', 'epg');
    return 0;
  }
}

// Sync EPG for Stalker source using get_epg_info endpoint
async function syncEpgForStalker(source: Source, channels: Channel[]): Promise<number> {
  if (!source.mac) {
    debugLog('Stalker source missing MAC address, skipping EPG sync', 'epg');
    return 0;
  }

  console.log(`[EPG] Starting Stalker EPG sync for source: ${source.name || source.id}`);
  console.log(`[EPG] Total channels: ${channels.length}`);
  console.log(`[EPG] EPG timeshift: ${source.epg_timeshift_hours || 0} hours (applied at display time via SQL view)`);

  debugLog(`Starting EPG sync for Stalker source: ${source.name || source.id}`, 'epg');

  const client = new StalkerClient(
    { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
    source.id
  );

  try {
    // Determine how many hours back to fetch EPG.
    // Each Stalker channel reports tv_archive_duration (hours of archive available).
    // We take the maximum across all channels for this source so we cover the full
    // catchup window, clamped to a sensible range of [1, 168] (1h – 7 days).
    const dbInstance = await (db as any).dbPromise;
    const durationRows = await dbInstance.select(
      `SELECT MAX(tv_archive_duration) AS max_duration FROM channels WHERE source_id = ? AND tv_archive = 1`,
      [source.id]
    ) as Array<{ max_duration: number | null }>;
    const archiveDurationHours = Math.min(
      168,
      Math.max(1, durationRows[0]?.max_duration ?? 24)
    );

    console.log(`[EPG] Using ${archiveDurationHours}h lookback based on portal's tv_archive_duration`);

    // Fetch EPG data (future window ≥ 48h; past window = archive duration)
    console.log(`[EPG] Fetching EPG data from Stalker portal (window: -${archiveDurationHours}h to +48h)...`);
    debugLog('Fetching EPG data from Stalker portal...', 'epg');
    const epgMap = await client.getEpg(72, archiveDurationHours);

    console.log(`[EPG] Received EPG for ${epgMap.size} channels from Stalker`);
    debugLog(`Received EPG for ${epgMap.size} channels`, 'epg');

    if (epgMap.size === 0) {
      console.warn(`[EPG] No EPG data returned from Stalker portal - keeping existing data`);
      debugLog('No EPG data returned from Stalker portal, keeping existing data', 'epg');
      return 0;
    }

    // Convert Stalker EPG format to StoredProgram format
    const storedPrograms: StoredProgram[] = [];

    // NOTE: Do NOT apply epg_timeshift_hours here.
    // Timestamps are stored as pure UTC. The programs_effective SQL view applies
    // (sm.epg_timeshift_hours + co.timeshift_hours) at read time, consistent with
    // M3U and Xtream sources. Baking the shift here would cause a double-application.

    for (const [channelId, programList] of epgMap.entries()) {
      // Helper to parse Stalker date string formatted in user's local timezone (via timezone cookie)
      const parseStalkerDate = (dateStr: string | undefined): Date | null => {
        if (!dateStr || typeof dateStr !== 'string') return null;
        // Format is typically "YYYY-MM-DD HH:mm:ss". Replace space with 'T' to parse as local ISO string.
        const formatted = dateStr.trim().replace(' ', 'T');
        const d = new Date(formatted);
        return isNaN(d.getTime()) ? null : d;
      };

      for (const prog of programList) {
        let startDate: Date;
        let stopDate: Date;
        let startTs = prog.start_timestamp;

        // Try timezone-adjusted string times first (similar to Enigma2 EStalker)
        const parsedStart = parseStalkerDate(prog.time);
        const parsedStop = parseStalkerDate(prog.time_to);

        if (parsedStart && parsedStop) {
          startDate = parsedStart;
          stopDate = parsedStop;
          startTs = Math.floor(parsedStart.getTime() / 1000);
        } else {
          // Fallback to Unix timestamps if string times are not available/parsable
          startDate = new Date(prog.start_timestamp * 1000);
          stopDate = new Date(prog.stop_timestamp * 1000);
        }

        storedPrograms.push({
          id: `${channelId}_${startTs}`,
          stream_id: channelId,
          title: prog.name || '',
          description: prog.descr || '',
          start: startDate,
          end: stopDate,
          source_id: source.id,
        });
      }
    }

    console.log(`[EPG] Converted ${storedPrograms.length} programs from ${epgMap.size} channels`);
    debugLog(`Converted ${storedPrograms.length} programs from ${epgMap.size} channels`, 'epg');

    // SAFETY: Only clear old data if we have new data to replace it
    if (storedPrograms.length === 0) {
      console.warn(`[EPG] WARNING: No programs found! Keeping existing EPG data to avoid data loss`);
      debugLog('WARNING: No programs found! Keeping existing EPG data to avoid data loss', 'epg');
      return 0;
    }

    // Clear old and store new
    // Store programs using optimized bulk operation
    debugLog('Storing EPG data with optimized bulk operation...', 'epg');

    const bulkPrograms = storedPrograms.map(p => ({
      id: p.id,
      stream_id: p.stream_id,
      title: p.title,
      description: p.description || '',
      start: p.start instanceof Date ? p.start.toISOString() : p.start,
      end: p.end instanceof Date ? p.end.toISOString() : p.end,
      source_id: p.source_id
    }));

    const result = await bulkOps.replacePrograms(source.id, bulkPrograms);

    console.log(`[EPG] Stalker EPG sync COMPLETE: ${result.inserted} programs inserted, ${result.deleted} old programs deleted`);
    debugLog(`Stalker EPG sync complete: ${storedPrograms.length} programs stored`, 'epg');

    // Clear on-demand channel sync cache so the next visit triggers a fresh get_short_epg fetch
    await clearChannelSyncCache(source.id);

    if (result.inserted > 0) {
      dbEvents.notify('programs', 'add');
    }

    return storedPrograms.length;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[EPG] Stalker EPG fetch FAILED: ${errMsg}`);
    debugLog(`Stalker EPG fetch FAILED: ${errMsg}`, 'epg');
    debugLog('Keeping existing EPG data', 'epg');
    return 0;
  }
}

/**
 * Concurrency-limiting pool helper for running promises in parallel.
 */
async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;
  
  const worker = async () => {
    while (index < items.length) {
      const currentIndex = index++;
      const item = items[currentIndex];
      try {
        results[currentIndex] = await fn(item);
      } catch (e) {
        console.error(`[Pool] Task failed at index ${currentIndex}:`, e);
      }
    }
  };

  const poolWorkers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(poolWorkers);
  return results;
}

// Global in-memory cache to prevent frequent Stalker short EPG calls
const channelSyncCache = new Map<string, number>();
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
let cacheInitialized = false;

/**
 * Ensures that the channelSyncCache is loaded from db.prefs table.
 */
async function ensureCacheInitialized() {
  if (cacheInitialized) return;
  try {
    const cachedData = await db.prefs.get('stalker_channel_sync_cache');
    if (cachedData && cachedData.value) {
      const parsed = JSON.parse(cachedData.value);
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val === 'number') {
          channelSyncCache.set(key, val);
        }
      }
      console.log(`[EPG] Loaded ${channelSyncCache.size} channels from persistent Stalker short EPG cache`);
    }
  } catch (err) {
    console.error('[EPG] Failed to load stalker channel sync cache:', err);
  }
  cacheInitialized = true;
}

/**
 * Saves the channelSyncCache to the db.prefs table.
 */
async function saveCacheToDb() {
  try {
    const obj: Record<string, number> = {};
    const now = Date.now();
    for (const [key, val] of channelSyncCache.entries()) {
      // Cleanup expired entries while saving to keep DB entry clean and small
      if (now - val < THREE_HOURS_MS) {
        obj[key] = val;
      }
    }
    await db.prefs.put({ key: 'stalker_channel_sync_cache', value: JSON.stringify(obj) });
  } catch (err) {
    console.error('[EPG] Failed to save stalker channel sync cache:', err);
  }
}

/**
 * Clears the channel sync cache entries for a specific Stalker source.
 * Called when a full EPG sync/autosync replaces the EPG database.
 */
export async function clearChannelSyncCache(sourceId: string) {
  console.log(`[EPG] Clearing channel sync cache for Stalker source ${sourceId}`);
  await ensureCacheInitialized();
  let changed = false;
  for (const key of channelSyncCache.keys()) {
    if (key.startsWith(`${sourceId}_`)) {
      channelSyncCache.delete(key);
      changed = true;
    }
  }
  if (changed) {
    await saveCacheToDb();
  }
}

/**
 * On-demand sync for Stalker short EPG (fetches currently playing programs).
 */
export async function syncStalkerShortEpg(
  source: any, 
  channels: any[], 
  categoryId: string | null = null,
  onProgress?: (completed: number, total: number) => void,
  force: boolean = false
): Promise<number> {
  source = await resolveSourceUserAgent(source);
  if (!source || !source.mac || channels.length === 0) return 0;

  await ensureCacheInitialized();

  const now = Date.now();

  // Filter channels to only those not synced in the last 3 hours, unless forced
  const channelsToFetch = channels.filter(ch => {
    if (force) return true;
    const lastSynced = channelSyncCache.get(ch.stream_id);
    return !lastSynced || (now - lastSynced) >= THREE_HOURS_MS;
  });

  if (channelsToFetch.length === 0) {
    // Report immediate completion if no channels need syncing
    onProgress?.(0, 0);
    return 0;
  }

  // Set the timestamp immediately to prevent concurrent duplicate syncs
  for (const ch of channelsToFetch) {
    channelSyncCache.set(ch.stream_id, now);
  }
  await saveCacheToDb();

  console.log(`[EPG] Starting on-demand Stalker short EPG sync for ${channelsToFetch.length} channels (out of ${channels.length} requested) on source: ${source.name || source.id}`);

  const client = new StalkerClient(
    { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
    source.id
  );

  try {
    // Helper to parse Stalker date string formatted in user's local timezone (via timezone cookie)
    const parseStalkerDate = (dateStr: string | undefined): Date | null => {
      if (!dateStr || typeof dateStr !== 'string') return null;
      // Format is typically "YYYY-MM-DD HH:mm:ss". Replace space with 'T' to parse as local ISO string.
      const formatted = dateStr.trim().replace(' ', 'T');
      const d = new Date(formatted);
      return isNaN(d.getTime()) ? null : d;
    };

    const storedPrograms: StoredProgram[] = [];
    let completed = 0;

    interface EpgFetchTask {
      channel: any;
      attempts: number;
    }

    const queue: EpgFetchTask[] = channelsToFetch.map(ch => ({
      channel: ch,
      attempts: 0
    }));

    const worker = async () => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) break;

        // Playback Priority Pause check before starting each task:
        // Wait/sleep if playback resolution is in progress or was initiated in the last 5 seconds.
        while (
          (window as any).isPlaybackResolving || 
          (Date.now() - ((window as any).lastPlaybackTime || 0)) < 5000
        ) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }

        const { channel } = task;
        const rawChId = channel.stream_id.replace(`${source.id}_`, '');
        task.attempts++;

        try {
          // Use the channel's own archive duration for the lookback window, defaulting to 24h
          const archiveDurationHours = Math.min(168, Math.max(1, channel.tv_archive_duration ?? 24));
          // getShortEpg will now throw exceptions on network/token failures
          const programList = await client.getShortEpg(rawChId, 10, archiveDurationHours);
          
          if (Array.isArray(programList)) {
            for (const prog of programList) {
              let startDate: Date;
              let stopDate: Date;
              let startTs = prog.start_timestamp;

              // Try timezone-adjusted string times first
              const parsedStart = parseStalkerDate(prog.time);
              const parsedStop = parseStalkerDate(prog.time_to);

              if (parsedStart && parsedStop) {
                startDate = parsedStart;
                stopDate = parsedStop;
                startTs = Math.floor(parsedStart.getTime() / 1000);
              } else {
                // Fallback to Unix timestamps if string times are not available/parsable
                startDate = new Date(prog.start_timestamp * 1000);
                stopDate = new Date(prog.stop_timestamp * 1000);
              }

              storedPrograms.push({
                id: `${channel.stream_id}_${startTs}`,
                stream_id: channel.stream_id,
                title: prog.name || '',
                description: prog.descr || '',
                start: startDate,
                end: stopDate,
                source_id: source.id,
              });
            }
          }

          // Successfully completed (even if programList was empty)
          completed++;
          onProgress?.(completed, channelsToFetch.length);
        } catch (e) {
          console.warn(`[EPG] Failed to fetch short EPG for channel ${rawChId} (attempt ${task.attempts}/3):`, e);
          
          if (task.attempts < 3) {
            // Requeue at the end of the batch
            queue.push(task);
          } else {
            // Fails completely after 3 attempts. Remove from cache so it can be retried in subsequent visits.
            channelSyncCache.delete(channel.stream_id);
            await saveCacheToDb();
            completed++;
            onProgress?.(completed, channelsToFetch.length);
          }
        }
      }
    };

    // Run fetches in parallel with concurrency limit of 15
    const poolWorkers = Array.from({ length: Math.min(15, queue.length) }, () => worker());
    await Promise.all(poolWorkers);

    if (storedPrograms.length > 0) {
      const bulkPrograms = storedPrograms.map(p => ({
        id: p.id,
        stream_id: p.stream_id,
        title: p.title,
        description: p.description || '',
        start: p.start instanceof Date ? p.start.toISOString() : p.start,
        end: p.end instanceof Date ? p.end.toISOString() : p.end,
        source_id: p.source_id
      }));

      await db.programs.bulkPut(bulkPrograms);
      console.log(`[EPG] Stored ${bulkPrograms.length} short EPG programs for source: ${source.id}`);
      dbEvents.notify('programs', 'add');
    }

    return storedPrograms.length;
  } catch (err) {
    // On failure of the entire sync operation, clean up cache entries for channels we tried to fetch
    for (const ch of channelsToFetch) {
      channelSyncCache.delete(ch.stream_id);
    }
    await saveCacheToDb();
    console.error('[EPG] Stalker short EPG sync failed, clearing channel cache entries:', err);
    throw err;
  }
}



/**
 * Normalize a channel name for fuzzy EPG matching.
 * Mirrors the Rust normalize_channel_name logic.
 */
function normalizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^prime:\s*|^il:\s*|^f:\s*|^ss:\s*|^##+\s*/g, '')
    .replace(/[\[\](){}]/g, '')
    .replace(/[\u{1d3f}\u{1d2c}\u{1d42}\u{1d34}\u{1d35}\u{2076}\u{2070}\u{1da0}\u{1d56}\u{02e2}]/gu, '')
    .replace(/[^a-z0-9+]/g, '');
}

// ─── Additional EPG waterfall helper ─────────────────────────────────────────
/**
 * Get the set of stream_ids that currently have at least one program for a source.
 */
async function getStreamIdsWithPrograms(sourceId: string): Promise<Set<string>> {
  try {
    const dbInstance = await (db as any).dbPromise;
    // Use a single aggregated query to find all stream_ids with programs
    const rows = await dbInstance.select(
      `SELECT DISTINCT stream_id FROM programs WHERE source_id = ?`,
      [sourceId]
    );
    return new Set((rows || []).map((r: any) => r.stream_id as string));
  } catch (err) {
    console.error(`[EPG] Failed to query existing programs for source ${sourceId}:`, err);
    return new Set();
  }
}

/**
 * Sync additional EPG URLs in waterfall order.
 * Each additional EPG only fills in channels that have no programs yet.
 */
async function syncAdditionalEpgUrls(
  source: Source,
  channels: Channel[],
  onProgress?: (msg: string) => void
): Promise<number> {
  if (!source.additional_epg_urls || source.additional_epg_urls.length === 0) {
    return 0;
  }
  if (channels.length === 0) {
    return 0;
  }

  debugLog(`Starting waterfall additional EPG sync for source: ${source.name}`, 'epg');

  // Find channels that currently have no programs
  let channelsWithPrograms = await getStreamIdsWithPrograms(source.id);
  let channelsNeedingEpg = channels.filter(ch => !channelsWithPrograms.has(ch.stream_id));

  console.log(`[EPG] Additional EPG sync starting: ${channelsNeedingEpg.length} channels out of ${channels.length} need EPG.`);
  
  debugLog(
    `${channelsNeedingEpg.length}/${channels.length} channels need EPG from additional sources`,
    'epg'
  );

  if (channelsNeedingEpg.length === 0) {
    console.log(`[EPG] Additional EPG sync skipped: All channels already have EPG.`);
    debugLog('All channels already have EPG, skipping additional EPGs', 'epg');
    return 0;
  }

  // Load user-applied EPG channel ID overrides
  const epgOverrideMap = await loadEpgChannelOverrideMap();
  let totalInserted = 0;

  for (let i = 0; i < source.additional_epg_urls.length; i++) {
    if (channelsNeedingEpg.length === 0) break;

    const epgUrl = source.additional_epg_urls[i].trim();
    if (!epgUrl) continue;

    debugLog(
      `Additional EPG ${i + 1}/${source.additional_epg_urls.length}: ${epgUrl.substring(0, 80)}...`,
      'epg'
    );
    onProgress?.(`Updating EPG (additional ${i + 1}/${source.additional_epg_urls.length})...`);

    try {
      // Build channel mappings for Rust parser
      // We only pass channels that STILL need EPGs
      const channelMappings = channelsNeedingEpg
        .filter((ch) => epgOverrideMap.has(ch.stream_id) || ch.epg_channel_id || ch.name)
        .map((ch) => ({
          epg_channel_id: epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || ch.name || '',
          stream_id: ch.stream_id,
          channel_name: ch.name || '',
        }));

      if (channelMappings.length === 0) {
        debugLog(`No channels with EPG IDs remaining for additional EPG ${i + 1}`, 'epg');
        continue;
      }

      console.log(`[EPG] Additional EPG ${i + 1}: Built channel map with ${channelMappings.length} unique mappings`);

      // Use streaming EPG parser (with clearExisting = false to preserve waterfall)
      const result = await epgStreaming.streamParseEpg(
        source.id,
        source.name || source.id,
        epgUrl,
        channelMappings,
        onProgress
          ? (progress) => {
              debugLog(epgStreaming.formatProgress(progress), 'epg');
              onProgress(epgStreaming.formatProgress(progress));
            }
          : undefined,
        source.advanced_epg_matching,
        source.epg_timeshift_hours ?? 0,
        false, // clearExisting = false
        source.user_agent
      );

      console.log(`[EPG] Additional EPG ${i + 1}: Matched ${result.matched_programs}/${result.total_programs} programs. Inserted: ${result.inserted_programs}`);

      debugLog(
        `Additional EPG ${i + 1}: inserted ${result.inserted_programs} programs`,
        'epg'
      );

      if (result.inserted_programs === 0) {
        console.warn(`[EPG] Additional EPG ${i + 1}: No programs inserted!`);
        continue;
      }

      totalInserted += result.inserted_programs;

      // After streaming insertion, we need to know which channels ACTUALLY got programs
      // so we can filter them out of channelsNeedingEpg for the next additional URL.
      // Easiest way is just to re-query the DB for channelsWithPrograms!
      channelsWithPrograms = await getStreamIdsWithPrograms(source.id);
      channelsNeedingEpg = channels.filter(ch => !channelsWithPrograms.has(ch.stream_id));

      debugLog(
        `${channelsNeedingEpg.length} channels still need EPG after additional ${i + 1}`,
        'epg'
      );

      // Notify UI of new programs
      dbEvents.notify('programs', 'add');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[EPG] Additional EPG ${i + 1} failed: ${errMsg}`);
      debugLog(`Additional EPG ${i + 1} failed: ${errMsg}`, 'epg');
      // Continue to next additional EPG
    }
  }

  debugLog(
    `Waterfall additional EPG complete: ${totalInserted} programs inserted total`,
    'epg'
  );
  return totalInserted;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Global EPG links helper ─────────────────────────────────────────────────
/**
 * Sync global EPG links that are linked to a specific source.
 * Each global EPG only fills in channels that have no programs yet.
 */
/**
 * Apply global EPG links to a single source.
 * ALWAYS applies (no freshness check) — intended for manual single-source sync
 * where the primary EPG just cleared all programs.
 */
export async function applyGlobalEpgToSource(
  source: Source,
  channels: Channel[],
  onProgress?: (msg: string) => void
): Promise<number> {
  if (!window.storage) {
    debugLog('Storage API not available, skipping global EPG links', 'epg');
    return 0;
  }

  try {
    const settingsResult = await window.storage.getSettings();
    const globalEpgLinks = settingsResult.data?.globalEpgLinks || [];

    // Filter to links that include this source, sorted by display_order (lower = higher priority)
    const linksForSource = globalEpgLinks
      .filter(link => link.sourceIds.includes(source.id))
      .sort((a, b) => (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER));

    if (linksForSource.length === 0) {
      debugLog(`No global EPG links for source: ${source.name}`, 'epg');
      return 0;
    }

    if (channels.length === 0) {
      debugLog(`No channels for global EPG sync on source: ${source.name}`, 'epg');
      return 0;
    }

    debugLog(`Applying global EPG to source: ${source.name} (${linksForSource.length} links, waterfall order)`, 'epg');

    // Find channels that currently have no programs
    let channelsWithPrograms = await getStreamIdsWithPrograms(source.id);
    let channelsNeedingEpg = channels.filter(ch => !channelsWithPrograms.has(ch.stream_id));

    console.log(`[EPG] Global EPG sync starting: ${channelsNeedingEpg.length} channels out of ${channels.length} need EPG.`);

    if (channelsNeedingEpg.length === 0) {
      console.log(`[EPG] Global EPG sync skipped: All channels already have EPG.`);
      debugLog('All channels already have EPG, skipping global EPG links', 'epg');
      return 0;
    }

    // Load user-applied EPG channel ID overrides
    const epgOverrideMap = await loadEpgChannelOverrideMap();
    let totalInserted = 0;
    // Track per-link insertion counts so we can update lastSyncResult in settings
    const linkResultCounts = new Map<string, { programs: number; channels: number; matchedStreamIds: string[] }>();

    for (let i = 0; i < linksForSource.length; i++) {
      if (channelsNeedingEpg.length === 0) break;

      const link = linksForSource[i];
      const epgUrl = link.url.trim();
      if (!epgUrl) continue;

      debugLog(
        `Global EPG ${i + 1}/${linksForSource.length}: ${link.name} - ${epgUrl.substring(0, 80)}...`,
        'epg'
      );
      onProgress?.(`Updating EPG (global ${i + 1}/${linksForSource.length})...`);

      try {
        // Build channel mappings for Rust parser
        // We only pass channels that STILL need EPGs
        const channelMappings = channelsNeedingEpg
          .filter((ch) => epgOverrideMap.has(ch.stream_id) || ch.epg_channel_id || ch.name)
          .map((ch) => ({
            epg_channel_id: epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || ch.name || '',
            stream_id: ch.stream_id,
            channel_name: ch.name || '',
          }));

        if (channelMappings.length === 0) {
          debugLog(`No channels with EPG IDs remaining for global EPG ${i + 1}`, 'epg');
          continue;
        }

        console.log(`[EPG] Global EPG ${i + 1}: Built channel map with ${channelMappings.length} unique mappings`);

        let resultInsertedPrograms = 0;
        let resultMatchedChannels = 0;

        if (link.saveEntireEpg) {
          console.log(`[EPG] Global EPG ${i + 1}: Querying from local SQLite cache...`);
          onProgress?.(`Querying EPG from local cache...`);
          try {
            const cacheDbName = `epg_cache_${link.id}`;
            const Database = (await import('@tauri-apps/plugin-sql')).default;
            const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);

            // 1. Fetch EPG channels from cacheDb
            const epgChannels = await cacheDb.select('SELECT id, display_name FROM epg_channels') as { id: string, display_name: string }[];
            
            // 2. Build displayNameToEpgIdMap
            const displayNameToEpgIdMap = new Map<string, string>();
            const epgChannelIdsSet = new Set<string>();
            for (const ec of epgChannels) {
              const lowerId = ec.id.toLowerCase();
              displayNameToEpgIdMap.set(lowerId, ec.id);
              epgChannelIdsSet.add(lowerId);
              
              if (ec.display_name) {
                const lowerName = ec.display_name.toLowerCase();
                displayNameToEpgIdMap.set(lowerName, ec.id);
                const normEpg = normalizeChannelName(ec.display_name);
                if (normEpg) {
                  displayNameToEpgIdMap.set(normEpg, ec.id);
                }
              }
            }

            // 3. Map M3U channels to EPG channel IDs
            const epgIdToStreamIdMap = new Map<string, string[]>();
            const advancedEpgMatching = source.advanced_epg_matching ?? false;
            const overridesToSave: any[] = [];

            for (const ch of channelsNeedingEpg) {
              let matchedEpgId: string | undefined = undefined;

              // Override always wins first
              const overrideId = epgOverrideMap.get(ch.stream_id);
              if (overrideId) {
                const lowerOverride = overrideId.toLowerCase();
                if (epgChannelIdsSet.has(lowerOverride)) {
                  matchedEpgId = displayNameToEpgIdMap.get(lowerOverride);
                } else {
                  matchedEpgId = overrideId; // Pass through override even if not in cache (could be synced later/fallback)
                }
              } else {
                // Try tvg-id (epg_channel_id)
                const tvgId = ch.epg_channel_id?.trim();
                if (tvgId) {
                  const lowerTvg = tvgId.toLowerCase();
                  if (epgChannelIdsSet.has(lowerTvg)) {
                    matchedEpgId = displayNameToEpgIdMap.get(lowerTvg);
                  } else if (advancedEpgMatching) {
                    const normTvg = normalizeChannelName(tvgId);
                    matchedEpgId = displayNameToEpgIdMap.get(lowerTvg) || displayNameToEpgIdMap.get(normTvg);
                  }
                }

                // Try channel name if tvg-id didn't match
                if (!matchedEpgId && ch.name?.trim()) {
                  const name = ch.name.trim();
                  const lowerName = name.toLowerCase();
                  if (epgChannelIdsSet.has(lowerName)) {
                    matchedEpgId = displayNameToEpgIdMap.get(lowerName);
                  } else if (advancedEpgMatching) {
                    const normName = normalizeChannelName(name);
                    matchedEpgId = displayNameToEpgIdMap.get(lowerName) || displayNameToEpgIdMap.get(normName);
                  }
                }
              }

              if (matchedEpgId) {
                if (!epgIdToStreamIdMap.has(matchedEpgId)) {
                  epgIdToStreamIdMap.set(matchedEpgId, []);
                }
                epgIdToStreamIdMap.get(matchedEpgId)!.push(ch.stream_id);

                if (!epgOverrideMap.has(ch.stream_id)) {
                  overridesToSave.push({
                    stream_id: ch.stream_id,
                    epg_channel_id: matchedEpgId
                  });
                }
              }
            }

            if (overridesToSave.length > 0) {
              await db.epgChannelOverrides.bulkPut(overridesToSave);
            }

            const uniqueEpgIds = Array.from(epgIdToStreamIdMap.keys());
            const programsToInsert: any[] = [];
            const matchedStreamIdsSet = new Set<string>();

            const CHUNK_SIZE = 500;
            for (let idx = 0; idx < uniqueEpgIds.length; idx += CHUNK_SIZE) {
              const chunk = uniqueEpgIds.slice(idx, idx + CHUNK_SIZE);
              const placeholders = chunk.map((_, i) => `$${i + 1}`).join(',');
              
              const progs = await cacheDb.select(
                `SELECT * FROM programs WHERE stream_id IN (${placeholders})`,
                chunk
              ) as any[];

              for (const p of progs) {
                const streamIds = epgIdToStreamIdMap.get(p.stream_id);
                if (streamIds) {
                  for (const streamId of streamIds) {
                    if (!matchedStreamIdsSet.has(streamId)) {
                      matchedStreamIdsSet.add(streamId);
                      resultMatchedChannels++;
                    }
                    programsToInsert.push({
                      id: `${streamId}_${p.start}`,
                      stream_id: streamId,
                      title: p.title,
                      subtitle: p.subtitle,
                      description: p.description,
                      start: p.start,
                      end: p.end,
                      source_id: source.id
                    });
                  }
                }
              }
            }

            if (programsToInsert.length > 0) {
              await db.programs.bulkPut(programsToInsert);
              dbEvents.notify('programs', 'add');
              resultInsertedPrograms = programsToInsert.length;
            }
          } catch (e) {
            console.error(`[EPG] Failed to map from SQLite cache for global EPG ${link.name}:`, e);
          }
        } else {
          // Use streaming EPG parser (with clearExisting = false to preserve waterfall)
          const result = await epgStreaming.streamParseEpg(
            source.id,
            source.name || source.id,
            epgUrl,
            channelMappings,
            onProgress
              ? (progress) => {
                  debugLog(epgStreaming.formatProgress(progress), 'epg');
                  onProgress(epgStreaming.formatProgress(progress));
                }
              : undefined,
            source.advanced_epg_matching,
            source.epg_timeshift_hours ?? 0,
            false, // clearExisting = false
            source.user_agent
          );
          resultInsertedPrograms = result.inserted_programs;
          resultMatchedChannels = result.matched_channels ?? 0;
        }

        console.log(`[EPG] Global EPG ${i + 1}: Matched/inserted: ${resultInsertedPrograms} programs`);

        debugLog(
          `Global EPG ${i + 1}: inserted ${resultInsertedPrograms} programs`,
          'epg'
        );

        if (resultInsertedPrograms === 0) {
          console.warn(`[EPG] Global EPG ${i + 1}: No programs inserted!`);
          continue;
        }

        const newlyMatched: string[] = [];
        const channelsWithProgramsAfter = await getStreamIdsWithPrograms(source.id);
        for (const mapping of channelMappings) {
          if (channelsWithProgramsAfter.has(mapping.stream_id)) {
            newlyMatched.push(mapping.stream_id);
          }
        }

        totalInserted += resultInsertedPrograms;
        linkResultCounts.set(link.id, {
          programs: resultInsertedPrograms,
          channels: resultMatchedChannels,
          matchedStreamIds: newlyMatched,
        });

        // Re-query which channels now have programs
        channelsWithPrograms = channelsWithProgramsAfter;
        channelsNeedingEpg = channels.filter(ch => !channelsWithPrograms.has(ch.stream_id));

        debugLog(
          `${channelsNeedingEpg.length} channels still need EPG after global ${i + 1}`,
          'epg'
        );

        // Notify UI of new programs
        dbEvents.notify('programs', 'add');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[EPG] Global EPG ${i + 1} failed: ${errMsg}`);
        debugLog(`Global EPG ${i + 1} failed: ${errMsg}`, 'epg');
        // Continue to next global EPG
      }
    }

    // Update lastSyncResult on each affected link (merge with existing perSource data)
    if (linkResultCounts.size > 0 && window.storage) {
      try {
        const settingsResult = await window.storage.getSettings();
        const existingLinks = settingsResult.data?.globalEpgLinks || [];
        const updatedLinks = existingLinks.map((link: GlobalEpgLink) => {
          const statsForThisSource = linkResultCounts.get(link.id);
          if (statsForThisSource === undefined) return link;

          const existingResult = link.lastSyncResult;
          const existingPerSource = existingResult?.perSource || {};
          const updatedPerSource = {
            ...existingPerSource,
            [source.id]: statsForThisSource.programs,
          };
          const newTotal = Object.values(updatedPerSource).reduce(
            (sum, c) => sum + (typeof c === 'number' ? c : 0),
            0
          );

          const existingPerSourceChannels = existingResult?.perSourceChannels || {};
          const updatedPerSourceChannels = {
            ...existingPerSourceChannels,
            [source.id]: statsForThisSource.channels,
          };
          const newTotalChannels = Object.values(updatedPerSourceChannels).reduce(
            (sum, c) => sum + (typeof c === 'number' ? c : 0),
            0
          );

          // Merge matchedStreamIds
          const previouslyMatched = existingResult?.matchedStreamIds || [];
          const matchedSet = new Set<string>(previouslyMatched);
          for (const id of statsForThisSource.matchedStreamIds) {
            matchedSet.add(id);
          }

          return {
            ...link,
            lastSynced: Date.now(),
            lastSyncResult: {
              timestamp: Date.now(),
              totalInserted: newTotal,
              perSource: updatedPerSource,
              channelsMatched: newTotalChannels,
              perSourceChannels: updatedPerSourceChannels,
              matchedStreamIds: Array.from(matchedSet),
            },
          };
        });
        await window.storage.updateSettings({ globalEpgLinks: updatedLinks });
        console.log(`[Global EPG] Updated lastSyncResult for ${linkResultCounts.size} link(s) after manual sync of ${source.name}`);
      } catch (err) {
        console.warn(`[Global EPG] Failed to update lastSyncResult after manual sync:`, err);
      }
    }

    debugLog(
      `Global EPG links complete: ${totalInserted} programs inserted total`,
      'epg'
    );
    return totalInserted;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[EPG] Failed to load global EPG links: ${errMsg}`);
    debugLog(`Failed to load global EPG links: ${errMsg}`, 'epg');
    return 0;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sync all stale global EPG links.
 * Intended as a post-batch-sync step: after all sources have synced their primary EPGs,
 * this downloads each stale global EPG once and applies it to all linked sources.
 * Skips links that were synced recently (within GLOBAL_EPG_FRESH_MS).
 */
let globalEpgPostSyncInFlight: Promise<number> | null = null;
const globalEpgLinkSyncsInFlight = new Map<string, Promise<number>>();

export async function syncAllStaleGlobalEpgLinks(
  onProgress?: (msg: string) => void,
  sourceIds?: string[]
): Promise<number> {
  if (globalEpgPostSyncInFlight) {
    console.log('[Global EPG] Post-sync already in progress; joining existing run');
    onProgress?.(i18n.t('common:globalEpgInProgress'));
    return globalEpgPostSyncInFlight;
  }

  globalEpgPostSyncInFlight = syncAllStaleGlobalEpgLinksImpl(onProgress, sourceIds).finally(() => {
    globalEpgPostSyncInFlight = null;
  });

  return globalEpgPostSyncInFlight;
}

async function syncAllStaleGlobalEpgLinksImpl(
  onProgress?: (msg: string) => void,
  sourceIds?: string[]
): Promise<number> {
  if (!window.storage) {
    debugLog('Storage API not available, skipping stale global EPG sync', 'epg');
    return 0;
  }

  try {
    const settingsResult = await window.storage.getSettings();
    const globalEpgLinks = settingsResult.data?.globalEpgLinks || [];
    const sourceIdFilter = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;
    // Sort by display_order so higher priority EPGs are synced first
    const staleLinks = globalEpgLinks
      .filter(link => !sourceIdFilter || link.sourceIds.some(sourceId => sourceIdFilter.has(sourceId)))
      .filter(link => !isGlobalEpgFresh(link))
      .sort((a, b) => (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER));

    if (staleLinks.length === 0) {
      debugLog(
        sourceIdFilter
          ? 'No stale global EPG links are tied to the synced sources, skipping post-sync'
          : 'All global EPG links are fresh, skipping post-sync',
        'epg'
      );
      return 0;
    }

    console.log(`[Global EPG] Post-sync: ${staleLinks.length} stale global EPG link(s)`);
    debugLog(`Post-syncing ${staleLinks.length} stale global EPG links (waterfall order)`, 'epg');

    let totalInserted = 0;
    for (let i = 0; i < staleLinks.length; i++) {
      const link = staleLinks[i];
      onProgress?.(`Syncing global EPG ${i + 1}/${staleLinks.length}: ${link.name}...`);
      try {
        const count = await syncGlobalEpgLinkStandalone(link, (msg) => {
          onProgress?.(`[${link.name}] ${msg}`);
        });
        totalInserted += count;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Global EPG] Post-sync failed for ${link.name}: ${errMsg}`);
      }
    }

    console.log(`[Global EPG] Post-sync complete: ${totalInserted} total programs inserted`);
    return totalInserted;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Global EPG] Post-sync failed: ${errMsg}`);
    return 0;
  }
}

// ─── Standalone Global EPG Sync ──────────────────────────────────────────────
/**
 * Sync a global EPG link standalone using the Rust multi-source streaming parser.
 * Downloads the EPG ONCE and applies it to all linked sources in a single Rust call.
 * Each source only receives programmes for channels that don't already have EPG.
 * @returns total programs inserted across all linked sources
 */
export async function syncGlobalEpgLinkStandalone(
  epgLink: GlobalEpgLink,
  onProgress?: (msg: string) => void
): Promise<number> {
  const inFlight = globalEpgLinkSyncsInFlight.get(epgLink.id);
  if (inFlight) {
    console.log(`[Global EPG] Sync already in progress for ${epgLink.name}; joining existing run`);
    onProgress?.(`Global EPG ${epgLink.name} is already syncing...`);
    return inFlight;
  }

  const syncPromise = syncGlobalEpgLinkStandaloneImpl(epgLink, onProgress).finally(() => {
    globalEpgLinkSyncsInFlight.delete(epgLink.id);
  });
  globalEpgLinkSyncsInFlight.set(epgLink.id, syncPromise);

  return syncPromise;
}

async function syncGlobalEpgLinkStandaloneImpl(
  epgLink: GlobalEpgLink,
  onProgress?: (msg: string) => void
): Promise<number> {
  if (!window.storage) {
    debugLog('Storage API not available, skipping standalone global EPG sync', 'epg');
    return 0;
  }

  const url = epgLink.url.trim();
  if (!url) {
    console.warn(`[Global EPG] Empty URL for link: ${epgLink.name}`);
    return 0;
  }

  console.log(`[Global EPG] Starting standalone multi-source sync for: ${epgLink.name}`);
  debugLog(`Standalone sync for global EPG: ${epgLink.name} (${url.substring(0, 80)}...)`, 'epg');
  onProgress?.(`Preparing ${epgLink.sourceIds.length} source(s)...`);

  // Fetch all sources from storage
  const sourcesResult = await window.storage.getSources();
  const allSources = sourcesResult.data || [];
  const sourceMap = new Map(allSources.map(s => [s.id, s]));

  // Load user-applied EPG channel ID overrides (shared across all sources)
  const epgOverrideMap = await loadEpgChannelOverrideMap();

  // Build per-source channel mappings (only channels that still need EPG)
  const sourceConfigs: import('../services/epg-streaming').SourceEpgConfig[] = [];
  const channelsNeedingEpgMap = new Map<string, string[]>();

  for (const sourceId of epgLink.sourceIds) {
    const source = sourceMap.get(sourceId);
    if (!source) {
      debugLog(`Source ${sourceId} not found in storage, skipping`, 'epg');
      continue;
    }

    const sourceChannels = await db.channels.where('source_id').equals(sourceId).toArray();
    if (sourceChannels.length === 0) {
      debugLog(`Source ${sourceId} has no channels, skipping`, 'epg');
      continue;
    }

    const channelsWithPrograms = await getStreamIdsWithPrograms(sourceId);
    const channelsNeedingEpg = sourceChannels.filter(ch => !channelsWithPrograms.has(ch.stream_id));

    if (channelsNeedingEpg.length === 0) {
      console.log(`[Global EPG] Source ${sourceId}: all channels already have EPG`);
      debugLog(`Source ${sourceId}: all ${sourceChannels.length} channels already have EPG`, 'epg');
      continue;
    }

    const channelMappings = channelsNeedingEpg
      .filter((ch) => epgOverrideMap.has(ch.stream_id) || ch.epg_channel_id || ch.name)
      .map((ch) => ({
        epg_channel_id: epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || ch.name || '',
        stream_id: ch.stream_id,
        channel_name: ch.name || '',
      }));

    if (channelMappings.length === 0) {
      debugLog(`Source ${sourceId}: no channels have EPG IDs`, 'epg');
      continue;
    }

    console.log(`[Global EPG] Source ${sourceId}: ${channelMappings.length} channel mappings prepared`);
    channelsNeedingEpgMap.set(sourceId, channelMappings.map(m => m.stream_id));

    sourceConfigs.push({
      sourceId,
      sourceName: source.name || sourceId,
      channelMappings,
      advancedEpgMatching: source.advanced_epg_matching ?? false,
      timeshiftHours: source.epg_timeshift_hours ?? 0,
      clearExisting: false,
    });
  }

  // Find first custom user agent among the linked sources
  let userAgent: string | undefined = undefined;
  for (const sourceId of epgLink.sourceIds) {
    const source = sourceMap.get(sourceId);
    if (source && source.user_agent?.trim()) {
      userAgent = source.user_agent.trim();
      break;
    }
  }

  if (!userAgent && window.storage) {
    try {
      const settingsResult = await window.storage.getSettings();
      const globalUa = settingsResult.data?.globalLiveTvUserAgent;
      if (globalUa && globalUa.trim()) {
        userAgent = globalUa.trim();
      }
    } catch (e) {
      console.error('[Global EPG] Failed to load global user agent settings:', e);
    }
  }

  if (sourceConfigs.length === 0) {
    console.log(`[Global EPG] No sources need EPG from ${epgLink.name}`);
    // Mark as synced so we don't retry every 10 min, but only for 30 min freshness window
    await updateGlobalEpgLastSynced(epgLink.id, 0, {});
    return 0;
  }

  onProgress?.(`Applying EPG to ${sourceConfigs.length} source(s)...`);

  let totalInserted = 0;
  const perSourceCounts: Record<string, number> = {};
  let totalChannelsMatched = 0;
  const perSourceChannels: Record<string, number> = {};
  let syncSucceeded = false;

  if (epgLink.saveEntireEpg) {
    onProgress?.(`Caching entire EPG database locally...`);
    try {
      // 1. Rust syncs and caches EPG XML to local cache DB
      await invoke('cache_entire_epg_db', {
        epgUrl: url,
        epgLinkId: epgLink.id,
        userAgent
      });
      syncSucceeded = true;
      console.log(`[Global EPG] Entire EPG cached locally for link ${epgLink.id}`);

      // 2. Load the SQLite cache database
      const cacheDbName = `epg_cache_${epgLink.id}`;
      const Database = (await import('@tauri-apps/plugin-sql')).default;
      const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);

      // Fetch EPG channels once
      const epgChannels = await cacheDb.select('SELECT id, display_name FROM epg_channels') as { id: string, display_name: string }[];
      const displayNameToEpgIdMap = new Map<string, string>();
      const epgChannelIdsSet = new Set<string>();
      for (const ec of epgChannels) {
        const lowerId = ec.id.toLowerCase();
        displayNameToEpgIdMap.set(lowerId, ec.id);
        epgChannelIdsSet.add(lowerId);
        
        if (ec.display_name) {
          const lowerName = ec.display_name.toLowerCase();
          displayNameToEpgIdMap.set(lowerName, ec.id);
          const normEpg = normalizeChannelName(ec.display_name);
          if (normEpg) {
            displayNameToEpgIdMap.set(normEpg, ec.id);
          }
        }
      }

      // 3. For each source, extract matched programs from the cache DB
      for (const sourceId of epgLink.sourceIds) {
        const source = sourceMap.get(sourceId);
        if (!source) continue;

        const sourceChannels = await db.channels.where('source_id').equals(sourceId).toArray();
        if (sourceChannels.length === 0) continue;

        const channelsWithPrograms = await getStreamIdsWithPrograms(sourceId);
        const channelsNeedingEpg = sourceChannels.filter(ch => !channelsWithPrograms.has(ch.stream_id));
        if (channelsNeedingEpg.length === 0) continue;

        const epgIdToStreamIdMap = new Map<string, string[]>();
        const advancedEpgMatching = source.advanced_epg_matching ?? false;
        const overridesToSave: any[] = [];

        for (const ch of channelsNeedingEpg) {
          let matchedEpgId: string | undefined = undefined;

          // Override always wins first
          const overrideId = epgOverrideMap.get(ch.stream_id);
          if (overrideId) {
            const lowerOverride = overrideId.toLowerCase();
            if (epgChannelIdsSet.has(lowerOverride)) {
              matchedEpgId = displayNameToEpgIdMap.get(lowerOverride);
            } else {
              matchedEpgId = overrideId;
            }
          } else {
            // Try tvg-id (epg_channel_id)
            const tvgId = ch.epg_channel_id?.trim();
            if (tvgId) {
              const lowerTvg = tvgId.toLowerCase();
              if (epgChannelIdsSet.has(lowerTvg)) {
                matchedEpgId = displayNameToEpgIdMap.get(lowerTvg);
              } else if (advancedEpgMatching) {
                const normTvg = normalizeChannelName(tvgId);
                matchedEpgId = displayNameToEpgIdMap.get(lowerTvg) || displayNameToEpgIdMap.get(normTvg);
              }
            }

            // Try channel name if tvg-id didn't match
            if (!matchedEpgId && ch.name?.trim()) {
              const name = ch.name.trim();
              const lowerName = name.toLowerCase();
              if (epgChannelIdsSet.has(lowerName)) {
                matchedEpgId = displayNameToEpgIdMap.get(lowerName);
              } else if (advancedEpgMatching) {
                const normName = normalizeChannelName(name);
                matchedEpgId = displayNameToEpgIdMap.get(lowerName) || displayNameToEpgIdMap.get(normName);
              }
            }
          }

          if (matchedEpgId) {
            if (!epgIdToStreamIdMap.has(matchedEpgId)) {
              epgIdToStreamIdMap.set(matchedEpgId, []);
            }
            epgIdToStreamIdMap.get(matchedEpgId)!.push(ch.stream_id);

            if (!epgOverrideMap.has(ch.stream_id)) {
              overridesToSave.push({
                stream_id: ch.stream_id,
                epg_channel_id: matchedEpgId
              });
            }
          }
        }

        if (overridesToSave.length > 0) {
          await db.epgChannelOverrides.bulkPut(overridesToSave);
        }

        const uniqueEpgIds = Array.from(epgIdToStreamIdMap.keys());
        const programsToInsert: any[] = [];
        let channelsMatchedCount = 0;
        const matchedStreamIdsSet = new Set<string>();

        const CHUNK_SIZE = 500;
        for (let idx = 0; idx < uniqueEpgIds.length; idx += CHUNK_SIZE) {
          const chunk = uniqueEpgIds.slice(idx, idx + CHUNK_SIZE);
          const placeholders = chunk.map((_, i) => `$${i + 1}`).join(',');
          
          const progs = await cacheDb.select(
            `SELECT * FROM programs WHERE stream_id IN (${placeholders})`,
            chunk
          ) as any[];

          for (const p of progs) {
            const streamIds = epgIdToStreamIdMap.get(p.stream_id);
            if (streamIds) {
              for (const streamId of streamIds) {
                if (!matchedStreamIdsSet.has(streamId)) {
                  matchedStreamIdsSet.add(streamId);
                  channelsMatchedCount++;
                }
                programsToInsert.push({
                  id: `${streamId}_${p.start}`,
                  stream_id: streamId,
                  title: p.title,
                  subtitle: p.subtitle,
                  description: p.description,
                  start: p.start,
                  end: p.end,
                  source_id: sourceId
                });
              }
            }
          }
        }

        if (programsToInsert.length > 0) {
          await db.programs.bulkPut(programsToInsert);
          dbEvents.notify('programs', 'add');
          
          totalInserted += programsToInsert.length;
          perSourceCounts[sourceId] = programsToInsert.length;
          perSourceChannels[sourceId] = channelsMatchedCount;
          totalChannelsMatched += channelsMatchedCount;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Global EPG] Cache sync failed: ${errMsg}`);
      debugLog(`Cache sync failed: ${errMsg}`, 'epg');
    }
  } else {
    try {
      const results = await epgStreaming.streamParseEpgMulti(url, sourceConfigs, userAgent);
      syncSucceeded = true;

      for (const result of results) {
        totalInserted += result.inserted_programs;
        perSourceCounts[result.source_id] = result.inserted_programs;
        const channelsMatched = result.matched_channels ?? 0;
        perSourceChannels[result.source_id] = channelsMatched;
        totalChannelsMatched += channelsMatched;
        console.log(`[Global EPG] Source ${result.source_id}: ${result.inserted_programs} programs inserted, ${channelsMatched} channels matched`);

        if (result.inserted_programs > 0) {
          dbEvents.notify('programs', 'add');
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Global EPG] Multi-source Rust parser failed: ${errMsg}`);
      debugLog(`Multi-source Rust parser failed: ${errMsg}`, 'epg');
    }
  }

  // Only mark as synced if the Rust call succeeded (even if 0 programmes inserted)
  if (syncSucceeded) {
    let matchedStreamIds: string[] | undefined = undefined;
    try {
      const newlyMatchedStreamIds: string[] = [];
      for (const sourceId of epgLink.sourceIds) {
        const neededIds = channelsNeedingEpgMap.get(sourceId) || [];
        if (neededIds.length === 0) continue;
        
        const channelsWithProgramsAfter = await getStreamIdsWithPrograms(sourceId);
        for (const streamId of neededIds) {
          if (channelsWithProgramsAfter.has(streamId)) {
            newlyMatchedStreamIds.push(streamId);
          }
        }
      }
      const previouslyMatched = epgLink.lastSyncResult?.matchedStreamIds || [];
      const matchedSet = new Set<string>(previouslyMatched);
      for (const id of newlyMatchedStreamIds) {
        matchedSet.add(id);
      }
      matchedStreamIds = Array.from(matchedSet);
    } catch (e) {
      console.warn('[Global EPG] Failed to calculate matchedStreamIds:', e);
    }

    await updateGlobalEpgLastSynced(
      epgLink.id,
      totalInserted,
      perSourceCounts,
      totalChannelsMatched,
      perSourceChannels,
      matchedStreamIds
    );
  }

  console.log(`[Global EPG] Standalone sync complete for ${epgLink.name}: ${totalInserted} total programs inserted`);
  debugLog(`Standalone sync complete: ${totalInserted} programs across ${sourceConfigs.length} sources`, 'epg');
  return totalInserted;
}

/**
 * Update lastSynced and lastSyncResult for a global EPG link.
 */
async function updateGlobalEpgLastSynced(
  epgLinkId: string,
  totalInserted: number,
  perSourceCounts: Record<string, number>,
  totalChannelsMatched?: number,
  perSourceChannels?: Record<string, number>,
  matchedStreamIds?: string[]
): Promise<void> {
  if (!window.storage) return;
  try {
    const settingsResult = await window.storage.getSettings();
    const existingLinks = settingsResult.data?.globalEpgLinks || [];
    const updatedLinks = existingLinks.map((link: GlobalEpgLink) =>
      link.id === epgLinkId
        ? {
            ...link,
            lastSynced: Date.now(),
            lastSyncResult: {
              timestamp: Date.now(),
              totalInserted,
              perSource: perSourceCounts,
              channelsMatched: totalChannelsMatched,
              perSourceChannels,
              matchedStreamIds,
            },
          }
        : link
    );
    await window.storage.updateSettings({ globalEpgLinks: updatedLinks });
    console.log(`[Global EPG] Updated lastSynced for link ${epgLinkId}`);
  } catch (err) {
    console.warn(`[Global EPG] Failed to update lastSynced:`, err);
  }
}

// How recently a global EPG must have been synced to be considered fresh (ms)
const GLOBAL_EPG_FRESH_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check if a global EPG link was synced recently enough to skip re-downloading.
 */
function isGlobalEpgFresh(epgLink: GlobalEpgLink): boolean {
  if (!epgLink.lastSynced) return false;
  return Date.now() - epgLink.lastSynced < GLOBAL_EPG_FRESH_MS;
}
// ─────────────────────────────────────────────────────────────────────────────

// Check if EPG needs refresh
// refreshHours: 0 = manual only (never auto-stale), default 6 hours
export async function isEpgStale(sourceId: string, refreshHours: number = DEFAULT_EPG_STALE_HOURS): Promise<boolean> {
  let resolvedRefreshHours = refreshHours;
  if (window.storage) {
    try {
      const result = await window.storage.getSources();
      const source = result.data?.find((s: any) => s.id === sourceId);
      if (source && source.custom_refresh_interval !== undefined && source.custom_refresh_interval !== null) {
        resolvedRefreshHours = source.custom_refresh_interval;
      }
    } catch (e) {
      console.error('[Sync] Failed to fetch source for EPG stale check:', e);
    }
  }

  // 0 means manual-only, never consider stale for auto-refresh
  if (resolvedRefreshHours === 0) return false;

  const meta = await db.sourcesMeta.get(sourceId);
  if (!meta?.last_synced) return true;

  const staleMs = resolvedRefreshHours * 60 * 60 * 1000;
  return Date.now() - new Date(meta.last_synced).getTime() > staleMs;
}

// Check if VOD needs refresh
// refreshHours: 0 = manual only (never auto-stale), default 24 hours
export async function isVodStale(sourceId: string, refreshHours: number = DEFAULT_VOD_STALE_HOURS): Promise<boolean> {
  let resolvedRefreshHours = refreshHours;
  if (window.storage) {
    try {
      const result = await window.storage.getSources();
      const source = result.data?.find((s: any) => s.id === sourceId);
      if (source && source.custom_vod_refresh_interval !== undefined && source.custom_vod_refresh_interval !== null) {
        resolvedRefreshHours = source.custom_vod_refresh_interval;
      }
    } catch (e) {
      console.error('[Sync] Failed to fetch source for VOD stale check:', e);
    }
  }

  // 0 means manual-only, never consider stale for auto-refresh
  if (resolvedRefreshHours === 0) return false;

  const meta = await db.sourcesMeta.get(sourceId);
  if (!meta?.vod_last_synced) return true;

  // Force sync if counts are missing (indicates schema/sync corruption)
  if (meta.vod_movie_count === undefined || meta.vod_series_count === undefined) {
    debugLog(`Source ${sourceId} VOD counts missing, forcing sync`, 'vod');
    return true;
  }

  const staleMs = resolvedRefreshHours * 60 * 60 * 1000;
  return Date.now() - new Date(meta.vod_last_synced).getTime() > staleMs;
}

// Exported sync wrapper with backup URL failover support
/**
 * Enrich M3U channels with Xtream catchup data.
 * For M3U sources with xtream_catchup config, fetches XC live streams
 * and updates tv_archive / xtream_stream_id on channels.
 * Matching priority: xtream_stream_id → channel name → epg_channel_id
 */
export async function enrichM3uWithXtreamCatchup(
  source: Source,
  channels: Channel[],
  onProgress?: (msg: string) => void
): Promise<Channel[]> {
  const xtreamCatchup = (source as any).xtream_catchup as { url: string; username: string; password: string } | undefined;
  if (!xtreamCatchup || !xtreamCatchup.url || !xtreamCatchup.username || !xtreamCatchup.password) {
    return channels;
  }

  debugLog(`Enriching M3U channels with Xtream catchup data from ${xtreamCatchup.url}`, 'sync');
  onProgress?.(i18n.t('common:fetchingCatchupData'));

  try {
    const { extractXtreamStreamId } = await import('@ynotv/local-adapter');
    const client = new XtreamClient({
      baseUrl: xtreamCatchup.url,
      username: xtreamCatchup.username,
      password: xtreamCatchup.password,
      userAgent: source.user_agent,
    }, source.id);

    // Fetch and store user info (expiry date, connections) from the Xtream catchup provider
    try {
      debugLog('Fetching Xtream catchup user info...', 'sync');
      const userInfo = await client.getUserInfo();
      if (userInfo.expiry_date) {
        (source as any)._xtream_expiry = userInfo.expiry_date;
      }
      if (userInfo.active_cons) {
        (source as any)._xtream_active_cons = userInfo.active_cons;
      }
      if (userInfo.max_connections) {
        (source as any)._xtream_max_connections = userInfo.max_connections;
      }
    } catch (infoErr) {
      console.warn('[Sync] Failed to fetch user info for Xtream catchup:', infoErr);
    }

    const xcChannels = await client.getLiveStreams();
    debugLog(`Got ${xcChannels.length} Xtream channels for catchup matching`, 'sync');

    // Build lookup maps:
    // 1. By xtream stream_id (numeric)
    const xcById = new Map<string, { tv_archive: boolean; name: string }>();
    // 2. By lowercased channel name (for name fallback matching)
    const xcByName = new Map<string, { tv_archive: boolean; stream_id: string }>();

    for (const xcCh of xcChannels) {
      const rawId = xcCh.stream_id.replace(`${source.id}_`, '');
      xcById.set(rawId, {
        tv_archive: !!xcCh.tv_archive,
        name: xcCh.name,
      });
      xcByName.set(xcCh.name.toLowerCase(), {
        tv_archive: !!xcCh.tv_archive,
        stream_id: rawId,
      });
    }

    // Match M3U channels by priority: stream_id → name → epg_channel_id
    let matchedCount = 0;
    const enrichedChannels = channels.map(ch => {
      // 1. Try xtream_stream_id (from URL extraction or previous sync)
      let streamId = (ch as any).xtream_stream_id as string | undefined;
      if (streamId && xcById.has(streamId)) {
        const xcData = xcById.get(streamId)!;
        matchedCount++;
        return { ...ch, tv_archive: xcData.tv_archive ? 1 : 0, xtream_stream_id: streamId };
      }

      // 2. Try extracting stream_id from direct_url (handles channels stored before code update)
      if (!streamId) {
        streamId = extractXtreamStreamId(ch.direct_url) || undefined;
        if (streamId && xcById.has(streamId)) {
          const xcData = xcById.get(streamId)!;
          matchedCount++;
          return { ...ch, tv_archive: xcData.tv_archive ? 1 : 0, xtream_stream_id: streamId };
        }
      }

      // 3. Try matching by channel name
      const nameMatch = xcByName.get(ch.name.toLowerCase());
      if (nameMatch) {
        matchedCount++;
        return { ...ch, tv_archive: nameMatch.tv_archive ? 1 : 0, xtream_stream_id: nameMatch.stream_id };
      }

      // 4. Try matching by epg_channel_id (might be the numeric stream_id as string)
      if (ch.epg_channel_id && xcById.has(ch.epg_channel_id)) {
        const xcData = xcById.get(ch.epg_channel_id)!;
        matchedCount++;
        return { ...ch, tv_archive: xcData.tv_archive ? 1 : 0, xtream_stream_id: ch.epg_channel_id };
      }

      return ch;
    });

    debugLog(`Matched ${matchedCount}/${channels.length} M3U channels to Xtream catchup data`, 'sync');
    return enrichedChannels;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Sync] Xtream catchup enrichment failed: ${errMsg}`);
    debugLog(`Xtream catchup enrichment failed: ${errMsg}`, 'sync');
    return channels; // Proceed without catchup data
  }
}

export async function syncSource(source: Source, onProgress?: (msg: string) => void): Promise<SyncResult> {
  source = await resolveSourceUserAgent(source);
  // Try primary URL first
  const result = await _doSyncSourceImpl(source, onProgress);
  if (result.success) return result;

  // If primary failed and we have backup URLs, try them in order
  if (source.backup_urls && source.backup_urls.length > 0) {
    for (const backupUrl of source.backup_urls) {
      const trimmedUrl = backupUrl.trim();
      if (!trimmedUrl) continue;

      debugLog(`Primary URL failed. Trying backup URL: ${trimmedUrl}`, 'sync');
      onProgress?.(i18n.t('common:primaryUrlFailedTryingBackup', { url: trimmedUrl }));

      const backupSource: Source = { ...source, url: trimmedUrl };
      const backupResult = await _doSyncSourceImpl(backupSource, onProgress);

      if (backupResult.success) {
        // Swap: working backup becomes primary, old primary moves to backup list
        const newBackups = source.backup_urls.filter(u => u !== backupUrl);
        newBackups.unshift(source.url);
        const updatedSource: Source = {
          ...source,
          url: trimmedUrl,
          backup_urls: newBackups,
        };

        try {
          if (window.storage) {
            await window.storage.saveSource(updatedSource);
            debugLog(`Backup URL succeeded. Swapped primary to ${trimmedUrl} and moved old primary to backups.`, 'sync');
          }
        } catch (saveErr) {
          debugLog(`Failed to save updated source after backup swap: ${saveErr}`, 'sync');
        }

        return backupResult;
      }
    }
  }

  return result;
}

// Internal sync implementation
async function _doSyncSourceImpl(source: Source, onProgress?: (msg: string) => void): Promise<SyncResult> {
  debugLog(`Starting sync for source: ${source.name} (${source.type})`, 'sync');
  onProgress?.(`Starting sync for ${source.name}...`);
  const startTime = performance.now();
  console.time('sync-total');
  try {
    // Wait, we need to fetch settings BEFORE clearing data


    // 1. Fetch existing data for incremental sync
    debugLog(`Fetching existing data for incremental sync: ${source.id}`, 'sync');
    onProgress?.(i18n.t('common:checkingExistingData'));

    // Get existing categories to preserve settings
    const existingCategories = await db.categories.where('source_id').equals(source.id).toArray();
    const categorySettingsMap = new Map(existingCategories.map(c => [
      c.category_id,
      { enabled: c.enabled, display_order: c.display_order, filter_words: c.filter_words }
    ]));
    const existingCategoryIds = new Set(existingCategories.map(c => c.category_id));

    // Get existing channels with their settings (favorites, etc.)
    const existingChannels = await db.channels.where('source_id').equals(source.id).toArray();
    const existingChannelMap = new Map(existingChannels.map(c => [c.stream_id, c]));
    const favoriteChannelsSet = new Set(
      existingChannels.filter(c => c.is_favorite).map(c => c.stream_id)
    );

    let channels: Channel[] = [];
    let categories: Category[] = [];
    let epgUrl: string | undefined;

    let nativeSyncComplete = false;
    let nativeChannelsCount = 0;
    let nativeCategoriesCount = 0;

    // ----- NATIVE RUST SYNC (Xtream & M3U only) -----
    if ((window as any).__TAURI__ && !source.vod_only && !source.url.startsWith('imported:')) {
      try {
        if (source.type === 'm3u') {
          debugLog(`Native Rust Sync for M3U: ${source.url}`, 'sync');
          onProgress?.(i18n.t('common:syncingNativeEngine'));
          const result = await invoke<any>('sync_m3u_source', {
            sourceId: source.id,
            url: source.url,
            userAgent: source.user_agent || null
          });

          // Process fast deletions natively
          onProgress?.(i18n.t('common:cleaningStaleChannels'));
          const existingChannels = await db.channels.where('source_id').equals(source.id).toArray();
          const existingChannelIds = existingChannels.map(c => c.stream_id);
          const newChannelIdSet = new Set(result.parsed_channel_ids || []);
          const staleChannelIds = (existingChannelIds as string[]).filter(id => !newChannelIdSet.has(id));
          if (staleChannelIds.length > 0) {
            await bulkOps.deleteChannels(staleChannelIds);
            channels = existingChannels.filter(c => newChannelIdSet.has(c.stream_id)) as Channel[];
          } else {
            channels = existingChannels as Channel[];
          }

          const existingCategories = await db.categories.where('source_id').equals(source.id).toArray();
          const existingCategoryIds = existingCategories.map(c => c.category_id);
          const newCategoryIdSet = new Set(result.parsed_category_ids || []);
          const staleCategoryIds = (existingCategoryIds as string[]).filter(id => !newCategoryIdSet.has(id));
          if (staleCategoryIds.length > 0) await bulkOps.deleteCategories(staleCategoryIds);

          epgUrl = result.epg_url || undefined;
          nativeChannelsCount = result.parsed_channel_ids?.length || 0;
          nativeCategoriesCount = result.parsed_category_ids?.length || 0;
          nativeSyncComplete = true;

          // Enrich with Xtream catchup data if configured
          const xtreamCatchup = (source as any).xtream_catchup;
          if (xtreamCatchup && channels.length > 0) {
            // Extract xtream_stream_id from URLs (Rust native sync doesn't do this)
            const { extractXtreamStreamId } = await import('@ynotv/local-adapter');
            channels = channels.map(ch => ({
              ...ch,
              xtream_stream_id: (ch as any).xtream_stream_id || extractXtreamStreamId(ch.direct_url) || undefined,
            })) as Channel[];
            channels = await enrichM3uWithXtreamCatchup(source, channels, onProgress);
            // Write updated tv_archive / xtream_stream_id back to DB
            const catchupUpdates = channels
              .filter(ch => (ch as any).xtream_stream_id)
              .map(ch => ({
                ...ch,
                tv_archive: (ch as any).tv_archive ? 1 : 0,
              }));
            if (catchupUpdates.length > 0) {
              await bulkOps.upsertChannels(catchupUpdates as any);
            }
          }

        } else if (source.type === 'xtream' && source.username && source.password) {
          debugLog('Testing Xtream connection to get server_info...', 'sync');
          onProgress?.(i18n.t('common:connectingXtream'));
          const client = new XtreamClient({ baseUrl: source.url, username: source.username, password: source.password, userAgent: source.user_agent }, source.id);
          const connTest = await client.testConnection();
          if (!connTest.success) throw new Error(translateNativeError(connTest.error) || i18n.t('common:connectionFailed'));

          const userInfo = await client.getUserInfo();
          (source as any)._xtream_expiry = userInfo.expiry_date;
          (source as any)._xtream_active_cons = userInfo.active_cons;
          (source as any)._xtream_max_connections = userInfo.max_connections;

          if (connTest.info?.server_info) {
            let { url, port, server_protocol } = connTest.info.server_info;
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
              url = `${server_protocol === 'https' ? 'https' : 'http'}://${url}`;
            }
            epgUrl = `${url}:${port}/xmltv.php?username=${source.username}&password=${source.password}`;
          }

          debugLog(`Native Rust Sync for Xtream: ${source.url}`, 'sync');
          onProgress?.(i18n.t('common:syncingNativeEngine'));
          const result = await invoke<any>('sync_xtream_source', {
            sourceId: source.id,
            baseUrl: source.url,
            username: source.username,
            password: source.password,
            userAgent: source.user_agent || null
          });

          // Process fast deletions
          onProgress?.(i18n.t('common:cleaningStaleChannels'));
          const existingChannels = await db.channels.where('source_id').equals(source.id).toArray();
          const existingChannelIds = existingChannels.map(c => c.stream_id);
          const newChannelIdSet = new Set(result.parsed_channel_ids || []);
          const staleChannelIds = (existingChannelIds as string[]).filter(id => !newChannelIdSet.has(id));
          if (staleChannelIds.length > 0) {
            await bulkOps.deleteChannels(staleChannelIds);
            channels = existingChannels.filter(c => newChannelIdSet.has(c.stream_id)) as Channel[];
          } else {
            channels = existingChannels as Channel[];
          }

          const existingCategories = await db.categories.where('source_id').equals(source.id).toArray();
          const existingCategoryIds = existingCategories.map(c => c.category_id);
          const newCategoryIdSet = new Set(result.parsed_category_ids || []);
          const staleCategoryIds = (existingCategoryIds as string[]).filter(id => !newCategoryIdSet.has(id));
          if (staleCategoryIds.length > 0) await bulkOps.deleteCategories(staleCategoryIds);

          nativeChannelsCount = result.parsed_channel_ids?.length || 0;
          nativeCategoriesCount = result.parsed_category_ids?.length || 0;
          nativeSyncComplete = true;
        }
      } catch (err: any) {
         debugLog(`Native sync failed: ${err.message}, falling back to legacy JS parser...`, 'sync');
      }
    }

    if (!nativeSyncComplete) {
    if (source.type === 'm3u') {
      // Check if this is a local imported file (not a remote URL)
      if (source.url.startsWith('imported:')) {
        // Local imported M3U - channels are already in DB, just fetch existing
        debugLog(`Local imported M3U detected: ${source.url}`, 'sync');
        onProgress?.(i18n.t('common:loadingLocalPlaylist'));

        // Get existing channels from database
        const existingChannels = await db.channels.where('source_id').equals(source.id).toArray();
        const existingCategories = await db.categories.where('source_id').equals(source.id).toArray();

        // Get EPG URL from source meta if available
        const sourceMeta = await db.sourcesMeta.get(source.id);

        channels = existingChannels as Channel[];
        categories = existingCategories as Category[];
        epgUrl = sourceMeta?.epg_url;

        debugLog(`Loaded ${channels.length} channels from local import`, 'sync');
      } else {
        // Remote M3U URL - fetch and parse
        debugLog(`Fetching M3U from: ${source.url}`, 'sync');
        onProgress?.(i18n.t('common:fetchingM3uPlaylist'));
        const result = await fetchAndParseM3U(source.url, source.id, source.user_agent);
        channels = result.channels;
        categories = result.categories;
        epgUrl = result.epgUrl ?? undefined;
        debugLog(`M3U parsed: ${channels.length} channels, ${categories.length} categories`, 'sync');
      }

      // Enrich M3U channels with Xtream catchup data (for both remote and imported M3U)
      channels = await enrichM3uWithXtreamCatchup(source, channels, onProgress);

    } else if (source.type === 'xtream') {
      // Xtream source - use client
      if (!source.username || !source.password) {
        throw new Error(i18n.t('common:xtreamRequiresCredentials'));
      }

      debugLog(`Initializing Xtream client for: ${source.url} (UA: ${source.user_agent || 'none'})`, 'sync');
      onProgress?.(i18n.t('common:connectingXtream'));
      const client = new XtreamClient(
        {
          baseUrl: source.url,
          username: source.username,
          password: source.password,
          userAgent: source.user_agent,
        },
        source.id
      );

      // Test connection first
      debugLog('Testing Xtream connection...', 'sync');
      const connTest = await client.testConnection();
      if (!connTest.success) {
        debugLog(`Connection test failed: ${connTest.error}`, 'sync');
        throw new Error(translateNativeError(connTest.error) || i18n.t('common:connectionFailed'));
      }
      debugLog('Connection test passed', 'sync');

      // Fetch user info (expiry date, connections)
      debugLog('Fetching Xtream user info...', 'sync');
      const userInfo = await client.getUserInfo();
      if (userInfo.expiry_date) {
        debugLog(`Account expiry: ${userInfo.expiry_date}`, 'sync');
      }
      if (userInfo.active_cons && userInfo.max_connections) {
        debugLog(`Connections: ${userInfo.active_cons}/${userInfo.max_connections}`, 'sync');
      }

      // Store user info temporarily on source object for later use in meta
      (source as any)._xtream_expiry = userInfo.expiry_date;
      (source as any)._xtream_active_cons = userInfo.active_cons;
      (source as any)._xtream_max_connections = userInfo.max_connections;

      // Fetch categories and channels
      debugLog('Fetching live categories...', 'sync');
      onProgress?.(i18n.t('common:fetchingCategories'));
      categories = await client.getLiveCategories();
      debugLog(`Got ${categories.length} categories`, 'sync');

      debugLog('Fetching live streams...', 'sync');
      onProgress?.(i18n.t('common:fetchingChannels'));
      channels = await client.getLiveStreams();
      debugLog(`Got ${channels.length} channels`, 'sync');

      // Get server info for EPG URL if available
      if (connTest.info?.server_info) {
        let { url, port, server_protocol } = connTest.info.server_info;
        // Ensure url has scheme - server_info.url might be just hostname
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          const scheme = server_protocol === 'https' ? 'https' : 'http';
          url = `${scheme}://${url}`;
        }
        // Xtream typically serves EPG at /xmltv.php
        epgUrl = `${url}:${port}/xmltv.php?username=${source.username}&password=${source.password}`;
        debugLog(`Constructed EPG URL from server_info: ${epgUrl}`, 'sync');
      }
    } else if (source.type === 'stalker') {
      // Stalker Portal source
      if (!source.mac) {
        throw new Error(i18n.t('common:stalkerRequiresMac'));
      }

      debugLog(`Initializing Stalker client for: ${source.url}`, 'sync');
      onProgress?.(i18n.t('common:connectingStalker'));
      const client = new StalkerClient(
        { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
        source.id
      );

      debugLog('Testing Stalker connection...', 'sync');
      const connTest = await client.testConnection();
      if (!connTest.success) {
        throw new Error(translateNativeError(connTest.error) || i18n.t('common:connectionFailed'));
      }

      // Fetch account info to get expiry date
      debugLog('Fetching Stalker account info...', 'sync');
      const accountInfo = await client.getAccountInfo();
      const expiryDate = accountInfo.expiry;

      debugLog('Fetching Stalker live categories...', 'sync');
      onProgress?.(i18n.t('common:fetchingCategories'));
      categories = await client.getLiveCategories();
      debugLog(`Got ${categories.length} categories`, 'sync');
      if (categories.length > 0) {
        debugLog(`First category: ${JSON.stringify(categories[0])}`, 'sync');
      }

      debugLog('Fetching Stalker live streams...', 'sync');
      onProgress?.(i18n.t('common:fetchingChannels'));
      channels = await client.getLiveStreams();
      debugLog(`Got ${channels.length} channels`, 'sync');
      if (channels.length > 0) {
        debugLog(`First channel: ${JSON.stringify(channels[0])}`, 'sync');
      } else {
        debugLog('WARNING: No channels returned from Stalker client!', 'sync');
      }

      // Store expiry date in a variable to use later when updating sourcesMeta
      (source as any)._stalker_expiry = expiryDate;
    } else {
      throw new Error(i18n.t('common:unsupportedSourceType', { type: source.type }));
    }

    // Check if source was deleted during sync
    if (isSourceDeleted(source.id)) {
      debugLog(`Source ${source.id} was deleted during sync, skipping write`, 'sync');
      return { success: false, channelCount: 0, categoryCount: 0, programCount: 0, error: 'Source deleted' };
    }

    // If vod_only is enabled, skip channel and category sync entirely
    if (source.vod_only) {
      debugLog(`Source ${source.name} is VOD-only, skipping ${channels.length} channels and ${categories.length} categories`, 'sync');
      onProgress?.(i18n.t('common:vodOnlySkipping'));
      channels = [];
      categories = [];
    }

    // Apply preserved settings to new data
    debugLog(`Applying preserved settings: ${favoriteChannelsSet.size} favorites, ${categorySettingsMap.size} category settings`, 'sync');
    onProgress?.(i18n.t('common:applyingSettings'));

    // Apply channel settings
    if (favoriteChannelsSet.size > 0) {
      channels = channels.map(ch => ({
        ...ch,
        is_favorite: favoriteChannelsSet.has(ch.stream_id)
      }));
    }

    // Apply category settings
    if (categorySettingsMap.size > 0) {
      categories = categories.map(cat => {
        const settings = categorySettingsMap.get(cat.category_id);
        if (settings) {
          return {
            ...cat,
            enabled: settings.enabled,
            display_order: settings.display_order,
            filter_words: settings.filter_words,
          };
        }
        return cat;
      });
    }

    // Incremental sync: Calculate changes
    debugLog(`Calculating incremental changes for ${channels.length} channels and ${categories.length} categories...`, 'sync');
    onProgress?.(i18n.t('common:calculatingChanges'));

    // Find new and updated channels
    const newChannelIds = new Set(channels.map(c => c.stream_id));
    const channelsToAdd: any[] = [];
    const channelsToUpdate: any[] = [];

    const CHUNK_SIZE = 5000;
    for (let i = 0; i < channels.length; i++) {
      if (i > 0 && i % CHUNK_SIZE === 0) {
        await new Promise(r => setTimeout(r, 0)); // Yield to paint UI Frame!
      }
      const channel = channels[i];
      const existing = existingChannelMap.get(channel.stream_id);
      if (!existing) {
        // New channel
        channelsToAdd.push(channel);
      } else {
        // Check if channel data changed (compare key fields)
        const categoriesChanged = channel.category_ids?.length !== existing.category_ids?.length || 
            (channel.category_ids && existing.category_ids && channel.category_ids[0] !== existing.category_ids[0]);
            
        const hasChanged =
          existing.name !== channel.name ||
          existing.direct_url !== channel.direct_url ||
          existing.channel_num !== channel.channel_num ||
          existing.provider_order !== channel.provider_order ||
          existing.epg_channel_id !== channel.epg_channel_id ||
          existing.tv_archive !== channel.tv_archive ||
          existing.tv_archive_duration !== channel.tv_archive_duration ||
          categoriesChanged;

        if (hasChanged) {
          // Preserve user settings using in-place mutation to skip object recreation garbage collection
          (channel as any).is_favorite = existing.is_favorite;
          channelsToUpdate.push(channel);
        }
      }
    }

    // Find deleted channels
    const channelsToDelete = existingChannels
      .filter(c => !newChannelIds.has(c.stream_id))
      .map(c => c.stream_id);

    // Find new and existing categories
    const newCategoryIds = new Set(categories.map(c => c.category_id));
    const categoriesToAdd: Category[] = [];
    const categoriesToUpdate: (Category & { enabled?: boolean; display_order?: number; filter_words?: string[]; folder_id?: string | null })[] = [];

    for (const cat of categories) {
      const existing = existingCategories.find(c => c.category_id === cat.category_id);
      if (!existing) {
        // New category
        categoriesToAdd.push(cat);
      } else {
        const nameChanged = existing.category_name !== cat.category_name;
        const needsDisplayOrder = existing.display_order === null || existing.display_order === undefined;

        if (nameChanged || needsDisplayOrder) {
          // Existing category with different name or missing display_order - update while preserving user settings
          categoriesToUpdate.push({
            ...cat,
            enabled: existing.enabled,
            // Preserve user's manual order if defined, otherwise backfill from the parser
            display_order: existing.display_order ?? cat.display_order,
            filter_words: existing.filter_words,
            folder_id: existing.folder_id,
          });
        }
      }
    }

    // Find deleted categories
    const categoriesToDelete = existingCategories
      .filter(c => !newCategoryIds.has(c.category_id))
      .map(c => c.category_id);

    debugLog(`Changes: ${channelsToAdd.length} new channels, ${channelsToUpdate.length} updated, ${channelsToDelete.length} deleted`, 'sync');
    debugLog(`Changes: ${categoriesToAdd.length} new categories, ${categoriesToUpdate.length} updated, ${categoriesToDelete.length} deleted`, 'sync');

    // Apply changes using optimized bulk operations
    onProgress?.(i18n.t('common:applyingChanges'));

    // Convert to BulkChannel format for optimized Rust operations
    const convertToBulkChannel = (ch: any): BulkChannel => ({
      stream_id: ch.stream_id ?? '',
      source_id: ch.source_id ?? '',
      category_ids: Array.isArray(ch.category_ids)
        ? JSON.stringify(ch.category_ids)
        : (ch.category_ids ?? '[]'),
      name: ch.name ?? 'Unknown Channel',
      channel_num: ch.channel_num ?? 0,
      provider_order: ch.provider_order ?? null,
      is_favorite: ch.is_favorite ?? false,
      enabled: ch.enabled ?? true,
      stream_type: ch.stream_type ?? null,
      stream_icon: ch.stream_icon ?? null,
      epg_channel_id: ch.epg_channel_id ?? null,
      added: ch.added ?? null,
      custom_sid: ch.custom_sid ?? null,
      tv_archive: ch.tv_archive ?? 0,
      tv_archive_duration: ch.tv_archive_duration ?? null,
      direct_source: ch.direct_source ?? null,
      direct_url: ch.direct_url ?? null,
      xmltv_id: ch.xmltv_id ?? null,
      series_no: ch.series_no ?? null,
      live: ch.live ?? 1,
      xtream_stream_id: ch.xtream_stream_id ?? null,
    });

    // Convert to BulkCategory format
    const convertToBulkCategory = (cat: any): BulkCategory => ({
      category_id: cat.category_id ?? '',
      source_id: cat.source_id ?? '',
      category_name: cat.category_name ?? 'Unknown Category',
      parent_id: cat.parent_id ?? null,
      enabled: cat.enabled ?? true,
      display_order: cat.display_order ?? null,
      channel_count: cat.channel_count ?? null,
      filter_words: Array.isArray(cat.filter_words)
        ? JSON.stringify(cat.filter_words)
        : (cat.filter_words ?? null),
      folder_id: cat.folder_id ?? null,
    });

    // Combine add and update (upsert handles both)
    const allChannels: BulkChannel[] = [
      ...channelsToAdd.map(convertToBulkChannel),
      ...channelsToUpdate.map(convertToBulkChannel)
    ];

    const allCategories: BulkCategory[] = [
      ...categoriesToAdd.map(convertToBulkCategory),
      ...categoriesToUpdate.map(convertToBulkCategory)
    ];

    // Execute optimized bulk operations
    const promises: Promise<any>[] = [];

    if (allChannels.length > 0) {
      promises.push(bulkOps.upsertChannels(allChannels));
    }

    if (allCategories.length > 0) {
      promises.push(bulkOps.upsertCategories(allCategories));
    }

    if (channelsToDelete.length > 0) {
      promises.push(bulkOps.deleteChannels(channelsToDelete));
    }

    if (categoriesToDelete.length > 0) {
      promises.push(bulkOps.deleteCategories(categoriesToDelete));
    }

    await Promise.all(promises);
    } // END OF !nativeSyncComplete BLOCK

    // Store sync metadata (without last_synced — that gets written after EPG sync completes)
    // This ensures that if EPG sync fails, the source is not marked as fresh and will
    // be retried on the next startup autosync cycle.
    
    const finalChannelCount = nativeSyncComplete ? nativeChannelsCount : channels.length;
    const finalCategoryCount = nativeSyncComplete ? nativeCategoriesCount : categories.length;

    const meta: SourceMeta = {
      source_id: source.id,
      epg_url: epgUrl,
      channel_count: finalChannelCount,
      category_count: finalCategoryCount,
    };

    // Add Stalker-specific metadata
    if (source.type === 'stalker' && (source as any)._stalker_expiry) {
      meta.expiry_date = (source as any)._stalker_expiry;
    }

    // Add Xtream-specific metadata
    const hasXtreamCatchup = (source as any).xtream_catchup &&
      (source as any).xtream_catchup.url &&
      (source as any).xtream_catchup.username &&
      (source as any).xtream_catchup.password;

    if (source.type === 'xtream' || hasXtreamCatchup) {
      if ((source as any)._xtream_expiry) {
        meta.expiry_date = (source as any)._xtream_expiry;
      }
      if ((source as any)._xtream_active_cons) {
        meta.active_cons = (source as any)._xtream_active_cons;
      }
      if ((source as any)._xtream_max_connections) {
        meta.max_connections = (source as any)._xtream_max_connections;
      }
    }

    // Write channel/category counts and connection metadata — but NOT last_synced yet
    await bulkOps.updateSourceMeta({
      source_id: meta.source_id,
      epg_url: meta.epg_url,
      channel_count: meta.channel_count,
      category_count: meta.category_count,
      expiry_date: meta.expiry_date,
      active_cons: meta.active_cons,
      max_connections: meta.max_connections,
      error: meta.error,
      epg_timeshift_hours: source.epg_timeshift_hours ?? 0,
    });
    debugLog('Channels and categories stored successfully', 'sync');

    // Notify UI that categories, channels, and sourcesMeta updated so in-memory index & live queries refresh
    dbEvents.notify('categories', 'update');
    dbEvents.notify('channels', 'update');
    dbEvents.notify('sourcesMeta', 'update');

    // Restore user customizations (folder assignments, favorites, enabled state, etc.)
    // as soon as channels/categories exist, BEFORE EPG sync — a later EPG failure
    // must not leave categories un-restored (empty folders) after a cache clear.
    try {
      await restoreUserCustomizations();
    } catch (err) {
      console.error('[Sync] Failed to restore user customizations:', err);
    }

    // Fetch EPG if enabled (skip for VOD-only sources)
    let programCount = 0;
    const shouldLoadEpg = !source.vod_only && (source.auto_load_epg ?? (source.type === 'xtream'));

    console.log(`[EPG] EPG sync decision for ${source.name}: vod_only=${source.vod_only}, auto_load_epg=${source.auto_load_epg}, shouldLoadEpg=${shouldLoadEpg}`);
    console.log(`[EPG] Debug - epgUrl (from sourceMeta/M3U): ${epgUrl || 'undefined'}`);
    console.log(`[EPG] Debug - source.epg_url (manual override, raw): ${source.epg_url || 'undefined'}`);
    console.log(`[EPG] Debug - source.epg_url (manual override, fixed): ${fixDuplicatedUrl(source.epg_url) || 'undefined'}`);

    if (shouldLoadEpg && source.type === 'xtream' && source.username && source.password) {
      // Xtream: use built-in EPG endpoint (or override if provided)
      console.log(`[EPG] Starting Xtream EPG sync...`);
      debugLog('Syncing EPG for Xtream source...', 'epg');
      onProgress?.(i18n.t('common:updatingEpgShort'));
      console.time('sync-epg-insert');
      // Pass the correctly constructed EPG URL (with server info from connection test)
      programCount = await syncEpgForSource(source, channels, epgUrl);
      console.timeEnd('sync-epg-insert');
      debugLog(`EPG sync complete: ${programCount} programs`, 'epg');
    } else if (shouldLoadEpg && source.type === 'stalker' && source.mac) {
      // Stalker: use get_epg_info endpoint
      debugLog('Syncing EPG for Stalker source...', 'epg');
      onProgress?.(i18n.t('common:updatingEpgShort'));
      console.time('sync-epg-insert');
      programCount = await syncEpgForStalker(source, channels);
      console.timeEnd('sync-epg-insert');
      debugLog(`Stalker EPG sync complete: ${programCount} programs`, 'epg');
    } else if (shouldLoadEpg && epgUrl) {
      // M3U with EPG URL: fetch XMLTV from the EPG URL
      debugLog('Syncing EPG for M3U source...', 'epg');
      onProgress?.(i18n.t('common:updatingEpgShort'));
      console.time('sync-epg-insert');
      programCount = await syncEpgFromUrl(source, epgUrl, channels);
      console.timeEnd('sync-epg-insert');
      debugLog(`M3U EPG sync complete: ${programCount} programs`, 'epg');
    }

    // If user provided a manual EPG URL override, use that (skip for VOD-only sources)
    const fixedEpgUrl = fixDuplicatedUrl(source.epg_url);
    if (fixedEpgUrl && !shouldLoadEpg && !source.vod_only) {
      debugLog('Syncing EPG from manual URL override...', 'epg');
      console.log(`[EPG] Debug - About to call syncEpgFromUrl with manual URL: ${fixedEpgUrl}`);
      onProgress?.(i18n.t('common:updatingEpgManualUrl'));
      console.time('sync-epg-manual');
      programCount = await syncEpgFromUrl(source, fixedEpgUrl, channels);
      console.timeEnd('sync-epg-manual');
      debugLog(`Manual EPG sync complete: ${programCount} programs`, 'epg');
    }

    // Waterfall: fill in gaps with additional EPG URLs (skip for VOD-only sources)
    if (!source.vod_only && source.additional_epg_urls && source.additional_epg_urls.length > 0) {
      debugLog('Syncing additional EPG URLs (waterfall)...', 'epg');
      onProgress?.(i18n.t('common:updatingEpgAdditional'));
      console.time('sync-epg-additional');
      const additionalCount = await syncAdditionalEpgUrls(source, channels, onProgress);
      console.timeEnd('sync-epg-additional');
      programCount += additionalCount;
      debugLog(`Additional EPG waterfall complete: ${additionalCount} programs`, 'epg');
    }

    debugLog(`Sync complete for ${source.name}: ${channels.length} channels, ${categories.length} categories, ${programCount} programs`, 'sync');
    console.timeEnd('sync-total');
    debugLog(`Total sync time: ${((performance.now() - startTime) / 1000).toFixed(2)}s`, 'sync');

    // NOW stamp last_synced — EPG sync has completed (or was skipped for sources without EPG).
    // Writing this after EPG ensures a failed/empty EPG sync will cause the next autosync
    // cycle to retry the source rather than treating it as fresh.
    await bulkOps.updateSourceMeta({
      source_id: source.id,
      last_synced: new Date().toISOString(),
    });
    dbEvents.notify('sourcesMeta', 'update');
    debugLog('Source marked as synced after EPG step completed', 'sync');

    // Automatically align/fill programs for manually overridden channels in this source
    await alignOverriddenChannelPrograms(source.id);

    // Checkpoint WAL after sync completes to reclaim space
    // TRUNCATE mode = wait for all readers/writers, then checkpoint and truncate WAL to 0
    try {
      await db.checkpoint('TRUNCATE');
    } catch (err) {
      console.error(`[Sync] TRUNCATE checkpoint failed for ${source.name}:`, err);
    }

    return {
      success: true,
      channelCount: channels.length,
      categoryCount: categories.length,
      programCount,
      epgUrl,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';
    debugLog(`Sync FAILED for ${source.name}: ${errorMsg}`, 'sync');
    debugLog(`Stack trace: ${errorStack}`, 'sync');

    // Don't write error if source was deleted during sync
    if (!isSourceDeleted(source.id)) {
      try {
        // Use bulkOps.updateSourceMeta to preserve existing fields
        await bulkOps.updateSourceMeta({
          source_id: source.id,
          last_synced: new Date().toISOString(),
          channel_count: 0,
          category_count: 0,
          error: errorMsg,
        });
      } catch (dbError) {
        debugLog(`Failed to write error to sourcesMeta: ${dbError}`, 'sync');
      }
    } else {
      debugLog(`Source ${source.id} was deleted during sync, skipping error write`, 'sync');
    }

    return {
      success: false,
      channelCount: 0,
      categoryCount: 0,
      programCount: 0,
      error: errorMsg,
    };
  }
}

// NEW: Lazy Load Stalker Category
// Called when user clicks a category in VodBrowse
export async function syncStalkerCategory(
  sourceId: string,
  categoryId: string,
  type: 'movies' | 'series',
  onProgress?: (percent: number, message: string) => void
): Promise<number> {
  debugLog(`[LazyLoad] Syncing Stalker category: ${categoryId} (${type})`, 'sync');

  // Sources are in Tauri Store, not SQLite
  if (!window.storage) {
    throw new Error(i18n.t('common:storageApiUnavailable'));
  }

  const result = await window.storage.getSource(sourceId);
  let source = result.data;

  if (source) {
    source = await resolveSourceUserAgent(source);
  }

  if (!source || source.type !== 'stalker' || !source.mac) {
    throw new Error(i18n.t('common:invalidStalkerSource'));
  }

  const client = new StalkerClient(
    { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
    source.id
  );

  try {
    const fetchType = type === 'movies' ? 'vod' : 'series';
    // Use the new getCategoryItems method with progress
    const items = await client.getCategoryItems(categoryId, fetchType, onProgress);

    if (items.length === 0) {
      debugLog(`[LazyLoad] No items found in category ${categoryId}`, 'sync');
      return 0;
    }

    debugLog(`[LazyLoad] Storing ${items.length} items for category ${categoryId}`, 'sync');
    if (onProgress) onProgress(100, i18n.t('common:savingToDatabase'));

    // Removed db.transaction mock wrapper to prevent inner lock deadlocks
    if (true) {
      if (type === 'movies') {
        // Sanitize items to ensure they match StoredMovie schema
        const movieItems = items.map((item: any) => sanitizeMovie(item));
        await db.vodMovies.bulkPut(movieItems);
      } else {
        // Map Channel items to StoredSeries
        const seriesItems = items.map((item: any) => {
          // Destructure to exclude movie-specific fields from series object
          const { stream_id: _stream_id, epg_channel_id: _epg_channel_id, channel_num: _channel_num, container_extension: _container_extension, ...rest } = item;
          // Extract raw Stalker ID from direct_url for episode fetching
          // Some portals use compound IDs like "15754:15754" - use first part
          const rawIdFromUrl = item.direct_url?.replace('stalker_series:', '') || item.id;
          const rawStalkerId = rawIdFromUrl?.toString().split(':')[0];

          return {
            ...rest,
            series_id: item.series_id || item.stream_id?.toString() || '',
            cover: item.cover || item.stream_icon || '',
            plot: item.plot || '',
            cast: item.cast || '',
            director: item.director || '',
            genre: item.genre || '',
            releaseDate: item.releaseDate || '',
            last_modified: item.last_modified || '',
            rating: item.rating || '',
            rating_5based: item.rating_5based || 0,
            backdrop_path: item.backdrop_path || undefined,
            youtube_trailer: item.youtube_trailer || '',
            episode_run_time: item.episode_run_time || '',
            // category_ids is already set by Stalker client as an array, just need to stringify it
            category_ids: Array.isArray(item.category_ids)
              ? JSON.stringify(item.category_ids)
              : JSON.stringify([categoryId]),
            // Store raw Stalker ID for episode fetching
            _stalker_raw_id: rawStalkerId
          };
        });

        await db.vodSeries.bulkPut(seriesItems as any[]);
      }
    } // End removed transaction block

    debugLog(`[LazyLoad] Sync complete`, 'sync');
    return items.length;

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugLog(`[LazyLoad] Failed: ${msg}`, 'sync');
    throw e;
  }
}

// Sync all enabled sources
// concurrency: number of sources to sync in parallel (0 = all at once, default = all)
export async function syncAllSources(
  onProgress?: (msg: string) => void,
  concurrency = 0
): Promise<Map<string, SyncResult>> {
  debugLog('Starting syncAllSources...', 'sync');
  onProgress?.(i18n.t('common:initializingSync'));
  const results = new Map<string, SyncResult>();

  // Get sources from Tauri Store
  if (!window.storage) {
    debugLog('ERROR: Storage API not available', 'sync');
    throw new Error(i18n.t('common:storageApiUnavailable'));
  }

  debugLog('Fetching sources from storage...', 'sync');
  const sourcesResult = await window.storage.getSources();
  if (!sourcesResult.data) {
    debugLog(`ERROR: Failed to get sources: ${sourcesResult.error}`, 'sync');
    throw new Error(sourcesResult.error || i18n.t('common:failedToGetSources'));
  }
  debugLog(`Found ${sourcesResult.data.length} sources`, 'sync');

  const enabledSources = sourcesResult.data.filter(s => s.enabled);
  debugLog(`${enabledSources.length} sources enabled for sync`, 'sync');

  // concurrency=0 means run all sources in parallel (each source is a different provider)
  // SQLite WAL mode handles concurrent writes by serializing them internally — no lock errors.
  const CONCURRENCY_LIMIT = concurrency > 0 ? concurrency : enabledSources.length || 1;

  for (let i = 0; i < enabledSources.length; i += CONCURRENCY_LIMIT) {
    const batch = enabledSources.slice(i, i + CONCURRENCY_LIMIT);
    const batchNum = Math.floor(i / CONCURRENCY_LIMIT) + 1;
    const totalBatches = Math.ceil(enabledSources.length / CONCURRENCY_LIMIT);

    debugLog(`Processing batch ${batchNum}/${totalBatches} (${batch.length} sources)`, 'sync');
    onProgress?.(`Batch ${batchNum}/${totalBatches}: ${batch.map(s => s.name).join(', ')}`);

    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map(async (source, batchIndex) => {
        const overallIndex = i + batchIndex + 1;
        const prefix = `[${overallIndex}/${enabledSources.length}] ${source.name}`;

        debugLog(`Syncing source: ${source.name} (${source.type})`, 'sync');

        // Create a specific progress handler for this source
        const sourceProgress = (msg: string) => {
          onProgress?.(`${prefix}: ${msg}`);
        };

        const result = await syncSource(source, sourceProgress);
        debugLog(`Source ${source.name}: ${result.success ? 'OK' : 'FAILED'} - ${result.channelCount} channels, ${result.categoryCount} categories`, 'sync');
        return { sourceId: source.id, result };
      })
    );

    // Store results
    for (const { sourceId, result } of batchResults) {
      results.set(sourceId, result);
    }
  }

  debugLog('syncAllSources complete', 'sync');
  const syncedSourceIds = Array.from(results.entries())
    .filter(([, result]) => result.success)
    .map(([sourceId]) => sourceId);

  // Post-sync: apply stale global EPG links to all linked sources
  // (primary EPGs have already cleared + inserted; now fill gaps with shared EPGs)
  if (syncedSourceIds.length > 0) {
    try {
      debugLog('Running post-sync global EPG...', 'sync');
      onProgress?.(i18n.t('common:updatingGlobalEpgLinks'));
      const globalCount = await syncAllStaleGlobalEpgLinks(onProgress, syncedSourceIds);
      if (globalCount > 0) {
        debugLog(`Post-sync global EPG: ${globalCount} programs inserted`, 'sync');
      }
    } catch (err) {
      console.error('[Sync] Post-sync global EPG failed:', err);
    }
  }

  // Final checkpoint after all sources synced
  // TRUNCATE mode ensures WAL file is actually truncated to 0 bytes
  try {
    await db.checkpoint('TRUNCATE');
  } catch (err) {
    console.error('[Sync] Final TRUNCATE checkpoint failed:', err);
  }

  return results;
}

// Get sync status for all sources
export async function getSyncStatus(): Promise<SourceMeta[]> {
  return db.sourcesMeta.toArray();
}

// ===========================================================================
// VOD Sync Functions
// ===========================================================================

// Sync VOD movies for a single source (Xtream or Stalker)
// Uses safe update pattern: fetch new data first, only update if successful
export async function syncVodMovies(
  source: Source,
  sharedClient?: XtreamClient | StalkerClient
): Promise<{ count: number; categoryCount: number; skipped?: boolean }> {
  source = await resolveSourceUserAgent(source);
  if (!['xtream', 'stalker'].includes(source.type)) {
    return { count: 0, categoryCount: 0 };
  }

  // --- NATIVE RUST VOD SYNC (Xtream Only) ---
  if ((window as any).__TAURI__ && source.type === 'xtream') {
    try {
      debugLog(`[Native VOD] Starting Rust sync for ${source.name} movies`, 'vod');
      // @ts-ignore - invoke is globally available in tauri context or can use window
      const { invoke } = await import('@tauri-apps/api/core');
      
      const result: any = await invoke('sync_xtream_vod_movies', {
        sourceId: source.id,
        baseUrl: source.url,
        username: source.username,
        password: source.password,
        userAgent: source.user_agent || null
      });

      debugLog(`[Native VOD] Successfully parsed ${result.parsed_content_ids.length} movies`, 'vod');

      // 1. Delete stale categories
      const existingCategories = await db.vodCategories.whereRaw('source_id = ? AND type = ?', [source.id, 'movie']).toArray();
      const existingCategoryIds = existingCategories.map(c => c.category_id);
      const newCategoryIds = new Set(result.parsed_category_ids || []);
      const staleCategoryIds = existingCategoryIds.filter(id => !newCategoryIds.has(id));
      if (staleCategoryIds.length > 0) {
        debugLog(`[Native VOD] Removing ${staleCategoryIds.length} stale movie categories`, 'vod');
        await db.vodCategories.bulkDelete(staleCategoryIds);
      }

      // 2. Delete stale movies
      const existingMovies = await db.vodMovies.where('source_id').equals(source.id).select(['stream_id']).toArray();
      const existingMovieIds = existingMovies.map(m => m.stream_id);
      const newMovieIds = new Set(result.parsed_content_ids || []);
      const staleMovieIds = existingMovieIds.filter(id => !newMovieIds.has(id));
      if (staleMovieIds.length > 0) {
        debugLog(`[Native VOD] Removing ${staleMovieIds.length} stale movies`, 'vod');
        await db.vodMovies.bulkDelete(staleMovieIds);
      }

      // Notify UI
      dbEvents.notify('vodMovies', 'add');
      dbEvents.notify('vodCategories', 'add');

      return { 
        count: result.content.inserted + result.content.updated, 
        categoryCount: result.categories.inserted + result.categories.updated 
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Native VOD] Rust movies sync failed, falling back to JS: ${msg}`);
      // Fall through to JS legacy logic below
    }
  }

  // Fetch categories and movies FIRST (before any deletes)
  let categories: any[] = [];
  let movies: any[] = [];

  try {
    if (source.type === 'xtream') {
      if (!source.username || !source.password) return { count: 0, categoryCount: 0 };
      const client = sharedClient instanceof XtreamClient ? sharedClient : new XtreamClient(
        { baseUrl: source.url, username: source.username, password: source.password, userAgent: source.user_agent },
        source.id
      );
      categories = await client.getVodCategories();
      movies = await client.getVodStreams();
    } else if (source.type === 'stalker') {
      if (!source.mac) return { count: 0, categoryCount: 0 };
      const client = sharedClient instanceof StalkerClient ? sharedClient : new StalkerClient(
        { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
        source.id
      );
      // Lazy Load: Only fetch categories, do NOT fetch streams yet
      debugLog('[VOD Movies] Stalker source detected - using lazy loading (categories only)', 'vod');
      categories = await client.getVodCategories();
      movies = []; // Empty streams for now, will be loaded on demand via syncStalkerCategory
    }
  } catch (err) {
    console.warn('[VOD Movies] Fetch failed, keeping existing data:', err);
    // If backup URLs are configured, throw so the caller can try backups
    if (source.backup_urls && source.backup_urls.length > 0) {
      throw err;
    }
    return { count: 0, categoryCount: 0, skipped: true };
  }

  // Check if fetch returned empty when we have existing data
  const existingCount = await db.vodMovies.where('source_id').equals(source.id).count();
  if (movies.length === 0 && existingCount > 0) {
    console.warn('[VOD Movies] Fetch returned empty but we have existing data, keeping it');
    return { count: existingCount, categoryCount: 0, skipped: true };
  }

  // Fetch existing categories to preserve user settings (enabled, display_order)
  const existingCategories = await db.vodCategories
    .whereRaw('source_id = ? AND type = ?', [source.id, 'movie'])
    .toArray();
  const existingCategorySettings = new Map(existingCategories.map(c => [
    c.category_id, 
    { enabled: c.enabled, display_order: c.display_order }
  ]));

  // Convert categories to VodCategory format
  const vodCategories: VodCategory[] = categories.map(cat => {
    const settings = existingCategorySettings.get(cat.category_id);
    return {
      category_id: cat.category_id,
      source_id: source.id,
      name: cat.category_name,
      type: 'movie' as const,
      enabled: settings?.enabled ?? true,
      display_order: settings?.display_order ?? cat.display_order,
    };
  });

  // Get only enriched existing movies to preserve tmdb_id and other enrichments
  // This is much faster than loading ALL movies - only movies with enrichments matter
  const existingMovies = await db.vodMovies
    .whereRaw(
      "source_id = ? AND (tmdb_id IS NOT NULL OR imdb_id IS NOT NULL OR backdrop_path IS NOT NULL)",
      [source.id]
    )
    .select(['stream_id', 'tmdb_id', 'imdb_id', 'added', 'backdrop_path', 'popularity', 'match_attempted'])
    .toArray();
  const existingMap = new Map(existingMovies.map(m => [m.stream_id, m]));

  // Convert movies to StoredMovie format, preserving existing enrichments
  const storedMovies: StoredMovie[] = movies.map(movie => {
    const existing = existingMap.get(movie.stream_id);

    // Map loose fields
    if ((movie as any).rating_5based && !movie.rating) {
      movie.rating = (movie as any).rating_5based;
    }

    const item = {
      ...movie,
      // Preserve existing enrichments if present
      tmdb_id: existing?.tmdb_id,
      imdb_id: existing?.imdb_id,
      backdrop_path: existing?.backdrop_path,
      popularity: existing?.popularity,
      added: movie.added || movie.last_modified || existing?.added,
    };

    return sanitizeMovie(item, existing);
  });

  // Replace categories atomically (delete old, insert new)
  // Use whereRaw for SQL-level filtering instead of loading all into memory
  await db.vodCategories.whereRaw('source_id = ? AND type = ?', [source.id, 'movie']).delete();
  if (vodCategories.length > 0) {
    await db.vodCategories.bulkPut(vodCategories);
  }

    // Upsert all movies using optimized bulk operation
    const bulkMovies = storedMovies.map(movie => ({
      stream_id: movie.stream_id,
      source_id: movie.source_id,
      category_ids: movie.category_ids,
      name: movie.name,
      tmdb_id: movie.tmdb_id,
      imdb_id: movie.imdb_id,
      added: typeof movie.added === 'string' ? movie.added : movie.added?.toISOString(),
      backdrop_path: movie.backdrop_path,
      popularity: movie.popularity,
      match_attempted: typeof movie.match_attempted === 'string'
        ? movie.match_attempted
        : movie.match_attempted?.toISOString(),
      // Ensure container_extension has a fallback value (mp4) for providers that return null
      container_extension: (movie as any).container_extension || 'mp4',
      rating: (movie as any).rating,
      director: (movie as any).director,
      year: typeof (movie as any).year === 'string'
        ? parseInt((movie as any).year, 10) || undefined
        : (movie as any).year,
      cast: (movie as any).cast,
      plot: (movie as any).plot,
      genre: (movie as any).genre,
      duration_secs: (movie as any).duration_secs,
      duration: (movie as any).duration,
      stream_icon: (movie as any).stream_icon,
      direct_url: (movie as any).direct_url,
      release_date: (movie as any).release_date,
      title: (movie as any).title,
    }));
  await bulkOps.upsertMovies(bulkMovies);

  // Remove movies that no longer exist in source using database query (much faster than loading all IDs)
  // Build a list of current stream_ids as a subquery would be ideal, but we use chunked comparison
  if (movies.length > 0) {
    const newIds = new Set(movies.map(m => m.stream_id));
    // Get all existing IDs for this source (just the IDs, not full rows)
    const allExistingIds = await db.vodMovies
      .where('source_id')
      .equals(source.id)
      .select(['stream_id'])
      .toArray();
    const toRemove = allExistingIds.filter(m => !newIds.has(m.stream_id)).map(m => m.stream_id);
    if (toRemove.length > 0) {
      await db.vodMovies.bulkDelete(toRemove);
      console.log(`[VOD Movies] Removed ${toRemove.length} movies no longer in source`);
    }
  }

  // Restore user customizations if we had a backup
  try {
    await restoreUserCustomizations();
  } catch (err) {
    console.error('[Sync] Failed to restore VOD movie customizations:', err);
  }

  return { count: storedMovies.length, categoryCount: vodCategories.length };
}

// Sync VOD series for a single source (Xtream or Stalker)
// Uses safe update pattern: fetch new data first, only update if successful
export async function syncVodSeries(
  source: Source,
  sharedClient?: XtreamClient | StalkerClient
): Promise<{ count: number; categoryCount: number; skipped?: boolean }> {
  source = await resolveSourceUserAgent(source);
  if (!['xtream', 'stalker'].includes(source.type)) {
    return { count: 0, categoryCount: 0 };
  }

  // --- NATIVE RUST VOD SYNC (Xtream Only) ---
  if ((window as any).__TAURI__ && source.type === 'xtream') {
    try {
      debugLog(`[Native VOD] Starting Rust sync for ${source.name} series`, 'vod');
      const { invoke } = await import('@tauri-apps/api/core');
      
      const result: any = await invoke('sync_xtream_vod_series', {
        sourceId: source.id,
        baseUrl: source.url,
        username: source.username,
        password: source.password,
        userAgent: source.user_agent || null
      });

      debugLog(`[Native VOD] Successfully parsed ${result.parsed_content_ids.length} series`, 'vod');

      // 1. Delete stale categories
      const existingCategories = await db.vodCategories.whereRaw('source_id = ? AND type = ?', [source.id, 'series']).toArray();
      const existingCategoryIds = existingCategories.map(c => c.category_id);
      const newCategoryIds = new Set(result.parsed_category_ids || []);
      const staleCategoryIds = existingCategoryIds.filter(id => !newCategoryIds.has(id));
      if (staleCategoryIds.length > 0) {
        debugLog(`[Native VOD] Removing ${staleCategoryIds.length} stale series categories`, 'vod');
        await db.vodCategories.bulkDelete(staleCategoryIds);
      }

      // 2. Delete stale series
      const existingSeries = await db.vodSeries.where('source_id').equals(source.id).select(['series_id']).toArray();
      const existingSeriesIds = existingSeries.map(s => s.series_id);
      const newSeriesIds = new Set(result.parsed_content_ids || []);
      const staleSeriesIds = existingSeriesIds.filter(id => !newSeriesIds.has(id));
      if (staleSeriesIds.length > 0) {
        debugLog(`[Native VOD] Removing ${staleSeriesIds.length} stale series`, 'vod');
        await db.vodSeries.bulkDelete(staleSeriesIds);
      }

      // Notify UI
      dbEvents.notify('vodSeries', 'add');
      dbEvents.notify('vodCategories', 'add');

      return { 
        count: result.content.inserted + result.content.updated, 
        categoryCount: result.categories.inserted + result.categories.updated 
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Native VOD] Rust series sync failed, falling back to JS: ${msg}`);
      // Fall through to JS legacy logic below
    }
  }

  // Fetch categories and series FIRST (before any deletes)
  let categories: any[] = [];
  let series: any[] = [];

  try {
    if (source.type === 'xtream') {
      if (!source.username || !source.password) return { count: 0, categoryCount: 0 };
      debugLog(`Initializing Xtream client (UA: ${source.user_agent || 'default'})`, 'sync');
      const client = sharedClient instanceof XtreamClient ? sharedClient : new XtreamClient(
        { baseUrl: source.url, username: source.username, password: source.password, userAgent: source.user_agent },
        source.id
      );
      categories = await client.getSeriesCategories();
      series = await client.getSeries();
    } else if (source.type === 'stalker') {
      if (!source.mac) return { count: 0, categoryCount: 0 };
      debugLog(`Initializing Stalker client (UA: ${source.user_agent || 'default'})`, 'sync');
      const client = sharedClient instanceof StalkerClient ? sharedClient : new StalkerClient(
        { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
        source.id
      );
      // Lazy Load: Only fetch categories, do NOT fetch streams yet
      debugLog('[VOD Series] Stalker source detected - using lazy loading (categories only)', 'vod');
      categories = await client.getSeriesCategories();
      series = []; // Empty streams for now, will be loaded on demand
    }
  } catch (err) {
    console.warn('[VOD Series] Fetch failed, keeping existing data:', err);
    // If backup URLs are configured, throw so the caller can try backups
    if (source.backup_urls && source.backup_urls.length > 0) {
      throw err;
    }
    return { count: 0, categoryCount: 0, skipped: true };
  }

  // Check if fetch returned empty when we have existing data
  const existingCount = await db.vodSeries.where('source_id').equals(source.id).count();
  if (series.length === 0 && existingCount > 0) {
    console.warn('[VOD Series] Fetch returned empty but we have existing data, keeping it');
    return { count: existingCount, categoryCount: 0, skipped: true };
  }

  // Fetch existing categories to preserve user settings (enabled, display_order)
  const existingSeriesCategories = await db.vodCategories
    .whereRaw('source_id = ? AND type = ?', [source.id, 'series'])
    .toArray();
  const existingSeriesCategorySettings = new Map(existingSeriesCategories.map(c => [
    c.category_id, 
    { enabled: c.enabled, display_order: c.display_order }
  ]));

  // Convert categories to VodCategory format
  const vodCategories: VodCategory[] = categories.map(cat => {
    const settings = existingSeriesCategorySettings.get(cat.category_id);
    return {
      category_id: cat.category_id,
      source_id: source.id,
      name: cat.category_name,
      type: 'series' as const,
      enabled: settings?.enabled ?? true,
      display_order: settings?.display_order ?? cat.display_order,
    };
  });

  // Get only enriched existing series to preserve tmdb_id and other enrichments
  const existingSeries = await db.vodSeries
    .whereRaw(
      "source_id = ? AND (tmdb_id IS NOT NULL OR imdb_id IS NOT NULL OR backdrop_path IS NOT NULL OR _stalker_category IS NOT NULL)",
      [source.id]
    )
    .select(['series_id', 'tmdb_id', 'imdb_id', 'added', 'backdrop_path', 'popularity', 'match_attempted', '_stalker_category'])
    .toArray();
  const existingMap = new Map(existingSeries.map(s => [s.series_id, s]));

  // Convert series to StoredSeries format, preserving existing enrichments
  const storedSeries: StoredSeries[] = series.map(s => {
    const existing = existingMap.get(s.series_id);

    const item = {
      ...s,
      // Preserve existing enrichments if present
      tmdb_id: existing?.tmdb_id,
      imdb_id: existing?.imdb_id,
      backdrop_path: existing?.backdrop_path,
      popularity: existing?.popularity,
      added: s.added || s.last_modified || existing?.added,
    };

    const sanitized = sanitizeSeries(item, existing);
    debugLog(`Series ${s.series_id} - Input cover: ${s.cover}, Sanitized cover: ${sanitized.cover}`, 'sync');
    return sanitized;
  });

  // Replace categories atomically (delete old, insert new)
  // Use whereRaw to delete only series categories for this source directly in SQL
  await db.vodCategories.whereRaw('source_id = ? AND type = ?', [source.id, 'series']).delete();
  if (vodCategories.length > 0) {
    await db.vodCategories.bulkPut(vodCategories);
  }

  // Upsert all series using optimized bulk operation
  const bulkSeries = storedSeries.map(s => ({
    series_id: s.series_id,
    source_id: s.source_id,
    category_ids: Array.isArray(s.category_ids)
      ? JSON.stringify(s.category_ids)
      : s.category_ids,
    name: s.name,
    tmdb_id: s.tmdb_id,
    imdb_id: s.imdb_id,
    added: typeof s.added === 'string' ? s.added : s.added?.toISOString(),
    backdrop_path: s.backdrop_path,
    popularity: s.popularity,
    match_attempted: typeof s.match_attempted === 'string'
      ? s.match_attempted
      : s.match_attempted?.toISOString(),
    _stalker_category: (s as any)._stalker_category,
    cover: (s as any).cover,
    plot: (s as any).plot,
    cast: (s as any).cast,
    director: (s as any).director,
    genre: (s as any).genre,
    release_date: (s as any).releaseDate || (s as any).release_date,
    rating: (s as any).rating,
    youtube_trailer: (s as any).youtube_trailer,
    episode_run_time: (s as any).episode_run_time,
    title: (s as any).title,
    last_modified: (s as any).last_modified,
    year: (s as any).year,
    stream_type: (s as any).stream_type,
    stream_icon: (s as any).stream_icon,
    direct_url: (s as any).direct_url,
    rating_5based: (s as any).rating_5based,
    category_id: (s as any).category_id,
    _stalker_raw_id: (s as any)._stalker_raw_id,
  }));
  await bulkOps.upsertSeries(bulkSeries);

  // Debug: Verify first series was stored correctly
  if (storedSeries.length > 0) {
    const firstId = storedSeries[0].series_id;
    const verify = await db.vodSeries.get(firstId);
    debugLog(`Post-sync verification: Series ${firstId} cover = ${verify?.cover?.substring(0, 50)}...`, 'sync');
  }

  // Remove series that no longer exist in source (and their episodes)
  if (series.length > 0) {
    const newIds = new Set(series.map(s => s.series_id));
    // Get all existing IDs for this source (just the IDs)
    const allExistingIds = await db.vodSeries
      .where('source_id')
      .equals(source.id)
      .select(['series_id'])
      .toArray();
    const toRemove = allExistingIds.filter(s => !newIds.has(s.series_id)).map(s => s.series_id);
    if (toRemove.length > 0) {
      // Delete orphaned episodes first (they reference series_id)
      await db.vodEpisodes.where('series_id').anyOf(toRemove).delete();
      await db.vodSeries.bulkDelete(toRemove);
      console.log(`[VOD Series] Removed ${toRemove.length} series (and their episodes) no longer in source`);
    }
  }

  // Restore user customizations if we had a backup
  try {
    await restoreUserCustomizations();
  } catch (err) {
    console.error('[Sync] Failed to restore VOD series customizations:', err);
  }

  return { count: storedSeries.length, categoryCount: vodCategories.length };
}

// Sync episodes for a specific series (on-demand when user views series details)
export async function syncSeriesEpisodes(source: Source, seriesId: string): Promise<number> {
  source = await resolveSourceUserAgent(source);
  // Support both Xtream and Stalker
  if (!['xtream', 'stalker'].includes(source.type)) {
    return 0;
  }

  let seasons: any[] = [];
  let xtreamSeriesInfo: any = null;
  let xtreamClient: XtreamClient | null = null;

  try {
    if (source.type === 'xtream') {
      if (!source.username || !source.password) return 0;
      xtreamClient = new XtreamClient(
        { baseUrl: source.url, username: source.username, password: source.password },
        source.id
      );
      // Single get_series_info request that returns episodes AND series metadata
      // (avoids a second round-trip for the tmdb_id backfill below).
      const seriesData = await xtreamClient.getSeriesInfoWithMeta(seriesId);
      if (seriesData) {
        seasons = seriesData.seasons;
        xtreamSeriesInfo = seriesData.info;
      }
    } else if (source.type === 'stalker') {
      if (!source.mac) return 0;
      const client = new StalkerClient(
        { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
        source.id
      );
      // Fetch the series to get the stored raw ID (for episode fetching)
      const series = await db.vodSeries.get(seriesId);
      // Use raw Stalker ID if available, otherwise fall back to seriesId
      const stalkerSeriesId = series?._stalker_raw_id || seriesId;
      seasons = await client.getSeriesInfo(stalkerSeriesId);

      // Fallback for single-video series: if no seasons are found but we have a direct play command
      if (seasons.length === 0 && series && series.direct_url) {
        const parts = series.direct_url.split(':');
        const cmd = parts.slice(2).join(':');
        if (cmd) {
          console.log(`[Sync episodes] Creating dummy single-video season for series ${seriesId} with cmd: ${cmd}`);
          seasons = [{
            id: '1',
            name: 'Season 1',
            season_number: 1,
            episodes: [{
              id: `${seriesId}_ep_1`,
              title: series.title || series.name || 'Play',
              episode_num: 1,
              season_num: 1,
              direct_url: `stalker_episode:${parts[1]}:1:1:${cmd}`,
              info: { season_name: 'Season 1' }
            }]
          }];
        }
      }
    }
  } catch (err) {
    console.warn(`[Sync episodes] Failed to fetch episodes for ${seriesId}:`, err);
    return 0;
  }

  // Flatten episodes from all seasons
  const storedEpisodes: StoredEpisode[] = [];
  for (const season of seasons) {
    for (const ep of season.episodes) {
      storedEpisodes.push({
        ...ep,
        series_id: seriesId,
      });
    }
  }

  // Store episodes.
  // Removed db.transaction wrapper to allow sqlite string queue mutex.
  // Merge instead of delete-all-then-reinsert: existing episodes stay visible
  // while the fresh provider data lands (no empty flash on re-sync), and
  // episodes that are no longer on the provider get pruned. Only prune when
  // the fetch came back non-empty so a transient empty/partial provider
  // response never wipes the cached episode list.
  if (storedEpisodes.length > 0) {
    const fetchedIds = new Set(storedEpisodes.map(e => e.id));
    const existing = await db.vodEpisodes.where('series_id').equals(seriesId).toArray();
    const staleIds = existing.filter(e => !fetchedIds.has(e.id)).map(e => e.id);
    if (staleIds.length > 0) {
      await db.vodEpisodes.bulkDelete(staleIds);
    }
    await db.vodEpisodes.bulkPut(storedEpisodes);
  }

  // Some providers blank the series-level tmdb_id in the get_series list but
  // expose it via get_series_info.info.tmdb / info.tmdb_id (see
  // XtreamClient.getSeriesInfoMeta). Backfill the series row so the
  // plot/backdrop/extras hooks can resolve the correct TMDB series without
  // searching on the pretext-prefixed name.
  if (source.type === 'xtream' && xtreamSeriesInfo) {
    const seriesRow = await db.vodSeries.get(seriesId);
    // Revalidate when the id is missing OR stale so a provider-supplied
    // tmdb_id (added/fixed after the original match) replaces a cached id
    // that may have come from a fuzzy title search. Stamps match_attempted so
    // a provider with no id isn't hammered on every open.
    if (seriesRow && (!seriesRow.tmdb_id || isTmdbMatchStale(seriesRow.match_attempted))) {
      try {
        const tmdb = xtreamSeriesInfo.tmdb_id ? Number(xtreamSeriesInfo.tmdb_id) || null : null;
        const updates: any = { match_attempted: new Date().toISOString() };
        if (tmdb && Number(seriesRow.tmdb_id) !== tmdb) updates.tmdb_id = tmdb;
        await db.vodSeries.update(seriesId, updates);
      } catch (metaErr) {
        console.warn('[Sync episodes] Failed to backfill series tmdb_id:', metaErr);
      }
    }
  }

  return storedEpisodes.length;
}

const TMDB_ID_REVALIDATE_DAYS = 7;

/**
 * Whether a cached TMDB id should be revalidated against the provider.
 *
 * Returns true when the id was never resolved, or was resolved longer ago than
 * TMDB_ID_REVALIDATE_DAYS. Enrichment hooks use this so provider-supplied
 * tmdb_ids (added or fixed in get_vod_info / get_series_info after the
 * original fuzzy-search match) are picked up instead of being locked in
 * forever. `match_attempted` is preserved across playlist syncs.
 */
export function isTmdbMatchStale(matchAttempted?: string | Date | null): boolean {
  if (!matchAttempted) return true;
  const t = typeof matchAttempted === 'string' ? new Date(matchAttempted) : matchAttempted;
  if (isNaN(t.getTime())) return true;
  return Date.now() - t.getTime() > TMDB_ID_REVALIDATE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * fetchVodProviderTmdbId - Fetch provider tmdb_id for a movie via get_vod_info
 * and persist it back to DB. Currently only Xtream exposes this field.
 * Returns the tmdb_id, or null if unavailable.
 */
export async function fetchVodProviderTmdbId(source: Source, movieId: string): Promise<number | null> {
  try {
    source = await resolveSourceUserAgent(source);
  } catch {
    return null;
  }

  if (source.type !== 'xtream' || !source.username || !source.password) {
    return null;
  }

  try {
    const client = new XtreamClient(
      { baseUrl: source.url, username: source.username, password: source.password },
      source.id
    );
    const info = await client.getVodInfo(movieId);
    const tmdbId = info?.tmdb_id ? Number(info.tmdb_id) : null;
    if (tmdbId && !isNaN(tmdbId)) {
      await db.vodMovies.update(movieId, { tmdb_id: tmdbId });
      return tmdbId;
    }
  } catch (err) {
    console.warn(`[fetchVodProviderTmdbId] Failed to fetch provider tmdb_id for ${movieId}:`, err);
  }

  return null;
}

/**
 * Fetch provider-supplied trailer metadata (tmdb_id + youtube_trailer) for a
 * VOD movie or series via get_vod_info / get_series_info. This works without a
 * TMDB API key and is the source-preferred trailer.
 *
 * Returns { tmdbId, youtubeTrailer }, both null if the provider doesn't expose
 * them or the source isn't Xtream.
 */
export interface ProviderTrailerInfo {
  tmdbId: number | null;
  youtubeTrailer: string | null;
}

export async function fetchVodProviderTrailerInfo(
  source: Source,
  type: 'movie' | 'series',
  id: string
): Promise<ProviderTrailerInfo> {
  const empty: ProviderTrailerInfo = { tmdbId: null, youtubeTrailer: null };
  try {
    source = await resolveSourceUserAgent(source);
  } catch {
    return empty;
  }

  if (source.type !== 'xtream' || !source.username || !source.password) {
    return empty;
  }

  try {
    const client = new XtreamClient(
      { baseUrl: source.url, username: source.username, password: source.password },
      source.id
    );

    let info: any = null;
    if (type === 'movie') {
      info = await client.getVodInfo(id);
    } else {
      info = await client.getSeriesInfoMeta(id);
    }

    if (!info) return empty;

    const rawTmdb = info.tmdb_id ?? info.tmdb;
    // Number('...') → NaN for garbage, and NaN is falsy, so the `|| null` collapses
    // invalid/unset values in one step without a separate isNaN check.
    const tmdbId = rawTmdb ? Number(rawTmdb) || null : null;
    const rawTrailer = info.youtube_trailer;

    const result: ProviderTrailerInfo = {
      tmdbId,
      youtubeTrailer:
        rawTrailer && typeof rawTrailer === 'string' && rawTrailer.trim() ? rawTrailer.trim() : null,
    };

    // Persist what we can back to the DB so detail pages don't re-fetch.
    try {
      if (type === 'movie') {
        const updates: any = {};
        if (result.tmdbId) updates.tmdb_id = result.tmdbId;
        if (result.youtubeTrailer) updates.youtube_trailer = result.youtubeTrailer;
        if (Object.keys(updates).length > 0) await db.vodMovies.update(id, updates);
      } else if (type === 'series') {
        const updates: any = {};
        if (result.tmdbId) updates.tmdb_id = result.tmdbId;
        if (result.youtubeTrailer) updates.youtube_trailer = result.youtubeTrailer;
        if (Object.keys(updates).length > 0) await db.vodSeries.update(id, updates);
      }
    } catch (dbErr) {
      console.warn('[fetchVodProviderTrailerInfo] Failed to persist provider trailer info:', dbErr);
    }

    return result;
  } catch (err) {
    console.warn(`[fetchVodProviderTrailerInfo] Failed for ${type} ${id}:`, err);
    return empty;
  }
}

// Exported VOD sync wrapper with backup URL failover support
export async function syncVodForSource(source: Source): Promise<VodSyncResult> {
  source = await resolveSourceUserAgent(source);
  if (source.live_tv_only) {
    return {
      success: true,
      movieCount: 0,
      seriesCount: 0,
      movieCategoryCount: 0,
      seriesCategoryCount: 0,
    };
  }
  const result = await _doSyncVodForSource(source);
  if (result.success) return result;

  // If primary failed and we have backup URLs, try them in order
  if (source.backup_urls && source.backup_urls.length > 0) {
    for (const backupUrl of source.backup_urls) {
      const trimmedUrl = backupUrl.trim();
      if (!trimmedUrl) continue;

      debugLog(`VOD primary URL failed. Trying backup URL: ${trimmedUrl}`, 'vod');

      const backupSource: Source = { ...source, url: trimmedUrl };
      const backupResult = await _doSyncVodForSource(backupSource);

      if (backupResult.success) {
        // Swap: working backup becomes primary, old primary moves to backup list
        const newBackups = source.backup_urls.filter(u => u !== backupUrl);
        newBackups.unshift(source.url);
        const updatedSource: Source = {
          ...source,
          url: trimmedUrl,
          backup_urls: newBackups,
        };

        try {
          if (window.storage) {
            await window.storage.saveSource(updatedSource);
            debugLog(`VOD backup URL succeeded. Swapped primary to ${trimmedUrl} and moved old primary to backups.`, 'vod');
          }
        } catch (saveErr) {
          debugLog(`Failed to save updated source after VOD backup swap: ${saveErr}`, 'vod');
        }

        return backupResult;
      }
    }
  }

  return result;
}

// Internal VOD sync implementation
async function _doSyncVodForSource(source: Source): Promise<VodSyncResult> {
  try {
    // For Stalker sources, create a shared client to avoid token conflicts
    // from parallel handshakes invalidating each other's tokens
    let sharedClient: XtreamClient | StalkerClient | undefined;
    if (source.type === 'stalker' && source.mac) {
      sharedClient = new StalkerClient(
        { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
        source.id
      );
      // Do initial handshake once before parallel operations
      await (sharedClient as StalkerClient).ensureToken();
      console.log('[VOD Sync] Created shared StalkerClient for token reuse');
    }

    const [moviesResult, seriesResult] = await Promise.all([
      syncVodMovies(source, sharedClient),
      syncVodSeries(source, sharedClient),
    ]);

    await bulkOps.updateSourceMeta({
      source_id: source.id,
      vod_movie_count: moviesResult.count,
      vod_series_count: seriesResult.count,
      vod_last_synced: new Date().toISOString(),
    });

    return {
      success: true,
      movieCount: moviesResult.count,
      seriesCount: seriesResult.count,
      movieCategoryCount: moviesResult.categoryCount,
      seriesCategoryCount: seriesResult.categoryCount,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[VOD Sync] Error:', error);
    debugLog(`VOD sync failed: ${errorMsg}`, 'vod');
    return {
      success: false,
      movieCount: 0,
      seriesCount: 0,
      movieCategoryCount: 0,
      seriesCategoryCount: 0,
      error: errorMsg,
    };
  }
}

// Sync VOD for all Xtream sources
export async function syncAllVod(): Promise<Map<string, VodSyncResult>> {
  const results = new Map<string, VodSyncResult>();

  if (!window.storage) {
    console.error('Storage API not available');
    return results;
  }

  const sourcesResult = await window.storage.getSources();
  if (!sourcesResult.data) {
    console.error('Failed to get sources:', sourcesResult.error);
    return results;
  }

  // Get enabled VOD sources (Xtream or Stalker) that are not LiveTV-only
  const vodSources = sourcesResult.data.filter(
    s => s.enabled && (s.type === 'xtream' || s.type === 'stalker') && !s.live_tv_only
  );

  // Sync VOD with concurrency limit of 5
  const CONCURRENCY_LIMIT = 5;

  for (let i = 0; i < vodSources.length; i += CONCURRENCY_LIMIT) {
    const batch = vodSources.slice(i, i + CONCURRENCY_LIMIT);
    const batchNum = Math.floor(i / CONCURRENCY_LIMIT) + 1;
    const totalBatches = Math.ceil(vodSources.length / CONCURRENCY_LIMIT);

    console.log(`VOD Sync batch ${batchNum}/${totalBatches}: ${batch.map(s => s.name).join(', ')}`);

    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map(async (source) => {
        console.log(`Syncing VOD for source: ${source.name}`);
        const result = await syncVodForSource(source);
        console.log(`  → ${source.name}: ${result.success ? 'OK' : 'FAILED'}: ${result.movieCount} movies, ${result.seriesCount} series`);
        return { sourceId: source.id, result };
      })
    );

    // Store results
    for (const { sourceId, result } of batchResults) {
      results.set(sourceId, result);
    }
  }

  // Checkpoint WAL after all VOD syncs complete
  // TRUNCATE mode ensures WAL file is actually truncated to 0 bytes
  try {
    await db.checkpoint('TRUNCATE');
  } catch (err) {
    console.error('[Sync] VOD TRUNCATE checkpoint failed:', err);
  }

  return results;
}

export async function enrichSourceMetadata(source?: Source, _force?: boolean) {
  startTmdbMatching();
  try {
    let accessToken: string | null = null;
    if (window.storage) {
      const settingsResult = await window.storage.getSettings();
      if (settingsResult.data && 'tmdbApiKey' in settingsResult.data) {
        accessToken = (settingsResult.data as { tmdbApiKey?: string }).tmdbApiKey ?? null;
      }
    }
    const [movieCount, seriesCount] = await Promise.all([
      matchAllMoviesLazy(accessToken),
      matchAllSeriesLazy(accessToken),
    ]);
    if (accessToken) {
      console.log(`[Lazy Match] Matched ${movieCount} movies, ${seriesCount} series`);
    }
  } catch (error) {
    console.error('[Lazy Match] Error:', error);
  } finally {
    endTmdbMatching();
  }
}

export async function cleanupGlobalEpgCache(epgLinkId: string): Promise<void> {
  try {
    const dbName = `epg_cache_${epgLinkId}`;
    const Database = (await import('@tauri-apps/plugin-sql')).default;
    const cacheDb = await Database.load(`sqlite:${dbName}.db`);
    
    // Drop tables if they exist
    await cacheDb.execute('DROP TABLE IF EXISTS epg_channels');
    await cacheDb.execute('DROP TABLE IF EXISTS programs');
    
    // Reclaim disk space
    await cacheDb.execute('VACUUM');
    console.log(`[Global EPG] Cleaned up cache database for link ${epgLinkId}`);
  } catch (err) {
    console.warn(`[Global EPG] Failed to cleanup cache database ${epgLinkId}:`, err);
  }
}

async function executeWithRetry(
  dbInstance: any,
  sql: string,
  args: any[] = [],
  maxRetries = 15,
  delayMs = 150
): Promise<any> {
  let attempt = 0;
  while (true) {
    try {
      return await dbInstance.execute(sql, args);
    } catch (err: any) {
      attempt++;
      const errMsg = err?.message || String(err);
      if (attempt < maxRetries && (errMsg.includes('locked') || errMsg.includes('code: 5') || errMsg.includes('busy'))) {
        console.warn(`[Sync DB Retry] Database locked (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

async function selectWithRetry(
  dbInstance: any,
  sql: string,
  args: any[] = [],
  maxRetries = 15,
  delayMs = 150
): Promise<any> {
  let attempt = 0;
  while (true) {
    try {
      return await dbInstance.select(sql, args);
    } catch (err: any) {
      attempt++;
      const errMsg = err?.message || String(err);
      if (attempt < maxRetries && (errMsg.includes('locked') || errMsg.includes('code: 5') || errMsg.includes('busy'))) {
        console.warn(`[Sync DB Retry] Database locked during select (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
}

export async function alignOverriddenChannelPrograms(sourceId: string): Promise<void> {
  try {
    const dbInstance = await (db as any).dbPromise;
    
    // Check if there are any overrides that target or are sourced by this source ID (using index-friendly UNION)
    const countResult = await selectWithRetry(
      dbInstance,
      `SELECT COUNT(*) as count FROM (
         SELECT eco.stream_id FROM epg_channel_overrides eco
         JOIN channels tc ON tc.stream_id = eco.stream_id
         JOIN channels sc ON sc.epg_channel_id = eco.epg_channel_id AND sc.stream_id != eco.stream_id
         WHERE tc.source_id = $1 OR sc.source_id = $1
         UNION
         SELECT eco.stream_id FROM epg_channel_overrides eco
         JOIN channels tc ON tc.stream_id = eco.stream_id
         JOIN channels sc ON sc.name = eco.epg_channel_id AND sc.stream_id != eco.stream_id
         WHERE tc.source_id = $1 OR sc.source_id = $1
       )`,
      [sourceId]
    ) as { count: number }[];
    
    if (countResult[0]?.count === 0) return;

    const start = performance.now();
    debugLog(`[Sync] Starting bulk EPG alignment for source: ${sourceId}...`, 'epg');

    // 1. Delete existing copied programs for target channels in this alignment to avoid stale overlaps (using index-friendly UNION subquery)
    await executeWithRetry(
      dbInstance,
      `DELETE FROM programs
       WHERE stream_id IN (
         SELECT eco.stream_id FROM epg_channel_overrides eco
         JOIN channels tc ON tc.stream_id = eco.stream_id
         JOIN channels sc ON sc.epg_channel_id = eco.epg_channel_id AND sc.stream_id != eco.stream_id
         WHERE tc.source_id = $1 OR sc.source_id = $1
         UNION
         SELECT eco.stream_id FROM epg_channel_overrides eco
         JOIN channels tc ON tc.stream_id = eco.stream_id
         JOIN channels sc ON sc.name = eco.epg_channel_id AND sc.stream_id != eco.stream_id
         WHERE tc.source_id = $1 OR sc.source_id = $1
       )`,
      [sourceId]
    );

    // 2. Insert fresh programs from native provider channels to target channels
    // We execute two separate, ultra-fast index-friendly insert statements to prevent unindexed OR joins from blocking the DB.
    
    // Step 2a: Match by epg_channel_id (uses idx_channels_epg index)
    await executeWithRetry(
      dbInstance,
      `INSERT OR REPLACE INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
       SELECT 
         eco.stream_id || '_' || CAST(CAST(strftime('%s', p.start) AS INTEGER) * 1000 AS TEXT) AS id,
         eco.stream_id AS stream_id,
         p.title, p.subtitle, p.description, p.start, p.end, tc.source_id AS source_id
       FROM epg_channel_overrides eco
       JOIN channels tc ON tc.stream_id = eco.stream_id
       JOIN channels sc ON sc.epg_channel_id = eco.epg_channel_id
                        AND sc.stream_id != eco.stream_id
                        AND sc.stream_id NOT IN (SELECT stream_id FROM epg_channel_overrides)
       JOIN programs p ON p.stream_id = sc.stream_id
       WHERE (tc.source_id = $1 OR sc.source_id = $1)
         AND p.end >= datetime('now', '-1 hour')
       GROUP BY eco.stream_id, p.start`,
      [sourceId]
    );

    // Step 2b: Match by name fallback (uses idx_channels_name index)
    await executeWithRetry(
      dbInstance,
      `INSERT OR REPLACE INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
       SELECT 
         eco.stream_id || '_' || CAST(CAST(strftime('%s', p.start) AS INTEGER) * 1000 AS TEXT) AS id,
         eco.stream_id AS stream_id,
         p.title, p.subtitle, p.description, p.start, p.end, tc.source_id AS source_id
       FROM epg_channel_overrides eco
       JOIN channels tc ON tc.stream_id = eco.stream_id
       JOIN channels sc ON sc.name = eco.epg_channel_id
                        AND sc.stream_id != eco.stream_id
                        AND sc.stream_id NOT IN (SELECT stream_id FROM epg_channel_overrides)
       JOIN programs p ON p.stream_id = sc.stream_id
       WHERE (tc.source_id = $1 OR sc.source_id = $1)
         AND p.end >= datetime('now', '-1 hour')
       GROUP BY eco.stream_id, p.start`,
      [sourceId]
    );
    
    debugLog(`[Sync] Bulk EPG alignment complete in ${(performance.now() - start).toFixed(2)}ms`, 'epg');
    const { dbEvents } = await import('./sqlite-adapter');
    dbEvents.notify('programs', 'clear');
    dbEvents.notify('programs', 'add');
  } catch (err) {
    console.error('[Sync] Failed to align overridden channel programs:', err);
  }
}
