import { db, clearSourceData, clearVodData, restoreUserCustomizations, type SourceMeta, type StoredProgram, type StoredMovie, type StoredSeries, type StoredEpisode, type VodCategory } from './index';
import i18n, { translateNativeError } from '../i18n';
import { fetchAndParseM3U, parseM3U, XtreamClient, StalkerClient } from '@ynotv/local-adapter';
import {
  isLocalPlaylistSource,
  isLegacyLocalImport,
  localPlaylistPath,
  localPlaylistUnreadableMessage,
  planLocalPlaylistSync,
  resolveLocalPlaylist,
  writeLocalPlaylistSnapshot,
} from '../services/local-playlist';
import type { Source, Channel, Category, Movie, Series } from '@ynotv/core';
import { useUIStore } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { bulkOps, type BulkChannel, type BulkCategory } from '../services/bulk-ops';
import { epgStreaming, getEpgUrlCandidates, type EpgProgressCallback, type EpgParseResult } from '../services/epg-streaming';
import { dbEvents, withSyncGate } from './sqlite-adapter';
import { matchAllMoviesLazy, matchAllSeriesLazy } from '../services/title-match';
import type { GlobalEpgLink } from '../types/app';
import {
  attachedEpgSourceIds,
  clearGlobalEpgSourceStamps,
  linkNeedsSyncForAnySource,
} from '../utils/globalEpgFreshness';
import {
  dropUnservableFeedPins,
  globalEpgPinRef,
  isGlobalEpgPin,
  GLOBAL_EPG_PIN_PREFIX,
  type ServableFeedIds,
} from '../utils/epgBackupSanitize';
import { effectiveMatchName, buildAliasMatchNames } from '../utils/epgMatchName';

import { invoke } from '@tauri-apps/api/core';

// Slowest per-source bulk EPG alignment of the current sync-all run, reported
// in the run summary row written by epgStreaming.timingRunEnd().
let lastRunAlignmentMaxMs = 0;

// ── Staggered bulk EPG alignment scheduler (sync-all only) ────────────────
// Each source's alignment is queued the moment its own EPG lands, so the work
// overlaps the remaining sources' downloads/inserts instead of forming a
// post-sync tail. The concurrency cap keeps queued alignments from retrying
// 15x against each other on the single-writer SQLite connection.
const ALIGNMENT_MAX_CONCURRENT = 2;
let alignmentQueue: string[] = [];
let alignmentInFlight = 0;
let alignmentDrainResolve: (() => void) | null = null;

function pumpAlignmentQueue(): void {
  while (alignmentInFlight < ALIGNMENT_MAX_CONCURRENT && alignmentQueue.length > 0) {
    const sourceId = alignmentQueue.shift()!;
    alignmentInFlight++;
    alignOverriddenChannelPrograms(sourceId)
      .finally(() => {
        alignmentInFlight--;
        pumpAlignmentQueue();
      })
      .catch(() => {});
  }
  if (alignmentQueue.length === 0 && alignmentInFlight === 0 && alignmentDrainResolve) {
    const resolve = alignmentDrainResolve;
    alignmentDrainResolve = null;
    resolve();
  }
}

function queueAlignment(sourceId: string): void {
  alignmentQueue.push(sourceId);
  pumpAlignmentQueue();
}

function drainAlignments(): Promise<void> {
  if (alignmentQueue.length === 0 && alignmentInFlight === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    alignmentDrainResolve = resolve;
  });
}

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

/**
 * Load `epg_channel_overrides.epg_source_id` as a streamId → feed map.
 * A pinned channel may only be filled by the feed it names, so every waterfall
 * stage skips it (see `load_channel_mappings_from_db` on the Rust side, which
 * enforces the same rule for the global-EPG passes).
 */
async function loadEpgFeedPinMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    // Only the pinned rows are needed, and most override rows carry no pin at
    // all (a manual tvg-id, a logo, a timeshift). Filtering in SQL keeps this to
    // the pin set rather than the whole overrides table, which matters because
    // every pass in a sync round asks for it.
    const dbInstance = await (db as any).dbPromise;
    const rows = await dbInstance.select(
      `SELECT stream_id AS stream_id, epg_source_id AS epg_source_id
         FROM epg_channel_overrides
        WHERE epg_source_id IS NOT NULL AND TRIM(epg_source_id) != ''`
    ) as { stream_id: string; epg_source_id: string }[];
    for (const row of rows) {
      if (row.epg_source_id) map.set(row.stream_id, row.epg_source_id);
    }
  } catch {
    // Column/table may be missing on an old DB — silently ignore
  }
  return map;
}

/**
 * The feed pins a pass may honour, plus the feed refs nothing can serve.
 *
 * A pin names one of exactly two things: a playlist, or a global EPG link. Both
 * are read from where the settings UI writes them, and a pin naming neither is
 * dropped here rather than honoured — a lock no feed can satisfy would reserve
 * the channel for nobody and leave it blank for good (the cleanup in
 * `releasePinsForFeed` covers the paths in the app; this covers the rest).
 *
 * Sources are read defensively: if that read fails, every pin is kept. A lock
 * the user chose is better left alone than mass-released on a storage hiccup.
 */
let lastIgnoredPinsLogKey = '';

async function loadServableFeedPins(): Promise<{
  pins: Map<string, string>;
  unservableFeeds: string[];
  unpinnedStreamIds: string[];
}> {
  const pinMap = await loadEpgFeedPinMap();
  if (pinMap.size === 0) {
    return { pins: pinMap, unservableFeeds: [], unpinnedStreamIds: [] };
  }

  let sourceIds: string[];
  try {
    const result = await window.storage?.getSources?.();
    if (!result?.data) throw new Error('playlist list unavailable');
    sourceIds = result.data.map((s: { id: string }) => s.id);
  } catch (e) {
    console.warn('[EPG] Could not read the playlist list; keeping every feed lock as stored:', e);
    return { pins: pinMap, unservableFeeds: [], unpinnedStreamIds: [] };
  }

  const feeds: ServableFeedIds = {
    sourceIds: new Set(sourceIds),
    linkIds: new Set(useSettingsStore.getState().globalEpgLinks.map((link) => link.id)),
  };

  const resolved = dropUnservableFeedPins(pinMap, feeds);
  if (resolved.unpinnedStreamIds.length > 0) {
    // Every pass in a sync round resolves this, so the same finding would be
    // logged eight times over. Log it once per distinct outcome instead; a
    // changed count (more channels pinned to the dead feed) logs again.
    const key = `${resolved.unpinnedStreamIds.length}:${resolved.unservableFeeds.join(',')}`;
    if (key !== lastIgnoredPinsLogKey) {
      lastIgnoredPinsLogKey = key;
      console.log(
        `[EPG] ${resolved.unpinnedStreamIds.length} channel(s) pinned to a feed that no longer exists ` +
        `(${resolved.unservableFeeds.join(', ')}); treating them as unpinned`
      );
      debugLog(
        `${resolved.unpinnedStreamIds.length} channel(s) left unlocked: their feed(s) ` +
        `${resolved.unservableFeeds.join(', ')} no longer exist, so the pin is ignored and the ` +
        `normal waterfall fills them`,
        'epg'
      );
    }
  }

  return {
    pins: resolved.pins,
    unservableFeeds: resolved.unservableFeeds,
    unpinnedStreamIds: resolved.unpinnedStreamIds,
  };
}

/**
 * stream_id → the name EPG matching must use, for channels that opted into
 * matching on their renamed name (`epg_channel_overrides.match_by_alias`).
 *
 * Loaded from the DB rather than read off the passed channel array: sync passes
 * the *provider's* fresh list for Xtream/Stalker, which carries no alias of its
 * own, so a rename made in the app would otherwise be invisible here.
 * Only channels that are flagged *and* have a usable alias appear — a flagged
 * channel with no alias keeps its provider name (see effectiveMatchName).
 */
async function loadEpgAliasMatchNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const dbInstance = await (db as any).dbPromise;
    const rows = await dbInstance.select(
      `SELECT c.stream_id AS stream_id, c.alias AS alias
       FROM channels c
       JOIN epg_channel_overrides o ON o.stream_id = c.stream_id
       WHERE o.match_by_alias IS NOT NULL AND o.match_by_alias != 0
         AND c.alias IS NOT NULL AND TRIM(c.alias) != ''`
    ) as { stream_id: string; alias: string }[];
    return buildAliasMatchNames(rows);
  } catch {
    // Columns may be missing on an old DB — silently ignore
    return map;
  }
}

/**
 * Channels a feed must not write: those the user locked to a *different* feed.
 *
 * The source's own EPG is a wipe-and-replace, not a waterfall stage, so without
 * this a provider feed re-writes the very channels the user pinned elsewhere
 * (the id it matches on is shared). The wipe itself is deliberately left alone:
 * it has to empty the channel so the pinned feed's programmes replace the
 * provider's, and an emptied channel is exactly what the gap-fill passes pick up
 * ("needs EPG" means no programme ending in the future).
 *
 * `feedRef` is the source's own id for a provider feed — a channel pinned to
 * that same source is still eligible.
 */
function filterChannelsForFeed<T extends { stream_id: string }>(
  channels: T[],
  pinMap: Map<string, string>,
  feedRef: string
): T[] {
  return channels.filter(ch => (pinMap.get(ch.stream_id) ?? feedRef) === feedRef);
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

export async function resolveSourceUserAgent(source: any): Promise<any> {
  if (!source) return source;
  if (source.user_agent && source.user_agent.trim()) {
    return source; // source user agent overrides global
  }
  try {
    // globalLiveTvUserAgent is a settings-store field — read it synchronously
    // instead of paying an IPC getSettings round-trip per source resolution.
    const globalUa = useSettingsStore.getState().globalLiveTvUserAgent;
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

export function mapStalkerSeriesRow(item: any, categoryId: string | null): any {
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
}

/**
 * Categories a search hit should end up in, given whatever the row already carried.
 *
 * A search is not a sync: the portal answers with one item per match, so writing
 * `category_ids` straight through would drop a cached title out of every list it was
 * in — and a whole-library search (no category selected) would leave it in none, which
 * hides it from "All Movies" too, since that view requires the row to share at least one
 * enabled category. Union instead: the row keeps what it had and gains what the hit
 * brought. Exported for its own sake — this is the part that can silently lose a title.
 */
export function mergeSearchCategoryIds(existing: unknown, incoming: unknown): string {
  const parse = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string' && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
        return [];
      } catch {
        return [value.trim()];
      }
    }
    return [];
  };

  const ids = new Set([...parse(existing), ...parse(incoming)]);
  return JSON.stringify([...ids]);
}

/**
 * Persist the rows a Stalker server search loaded, through the same mapping the
 * lazy category loader uses.
 *
 * Writing them is what makes the results playable: the detail page, media-info
 * probe and stream resolver all read the database, and `vodMovies.stream_id` /
 * `vodSeries.series_id` are primary keys derived from the portal's own id, so a
 * title that was already cached is updated in place rather than duplicated.
 *
 * Unlike the lazy loader, though, this runs against rows the user already has, so it
 * reads them first: `category_ids` is unioned (see mergeSearchCategoryIds) and the
 * cached row is handed to `sanitizeMovie`, which is what keeps a matched tmdb_id from
 * being cleared by a search. A row's category membership and matches are not the
 * search's to change.
 */
export async function storeStalkerServerSearchHits(
  items: any[],
  type: 'movies' | 'series',
  categoryId: string | null
): Promise<Array<StoredMovie | StoredSeries>> {
  if (items.length === 0) return [];

  const isMovies = type === 'movies';
  const table = isMovies ? 'vodMovies' : 'vodSeries';
  const primaryKey = isMovies ? 'stream_id' : 'series_id';

  const existing = new Map<string, any>();
  try {
    const ids = items
      .map((item: any) => item?.[primaryKey])
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length > 0) {
      const dbInstance = await (db as any).dbPromise;
      const placeholders = ids.map(() => '?').join(',');
      const rows = await dbInstance.select(
        `SELECT * FROM ${table} WHERE ${primaryKey} IN (${placeholders})`,
        ids
      );
      for (const row of rows ?? []) existing.set(row[primaryKey], row);
    }
  } catch (e) {
    // Non-fatal: without the cached rows the hits are written as new ones, which is
    // exactly the behaviour before this lookup existed.
    console.warn('[StalkerServerSearch] Could not read cached rows; hits will be written as-is:', e);
  }

  if (isMovies) {
    const rows = items.map((item: any) => {
      const previous = existing.get(item.stream_id);
      const clean = sanitizeMovie(item, previous);
      clean.category_ids = mergeSearchCategoryIds(previous?.category_ids, clean.category_ids);
      return clean;
    });
    await db.vodMovies.bulkPut(rows);
    return rows as StoredMovie[];
  }

  const rows = items.map((item: any) => {
    const row = mapStalkerSeriesRow(item, categoryId);
    const previous = existing.get(row.series_id);
    // Enrichment (tmdb_id, imdb_id, backdrop_path, popularity, match_attempted) has to be
    // carried over explicitly: `bulkPut` upserts every column in the row, so a hit with no
    // tmdb_id of its own writes NULL over one the user already had. `sanitizeSeries` is the
    // same helper the series sync uses, which is what makes a search hit and a synced row
    // end up identical instead of merely similar.
    const sanitized = sanitizeSeries({
      ...row,
      // Membership the portal's search rows cannot carry. Without these a cached series can
      // drop out of the category it was browsed from — `useVod` matches on `category_id`
      // and `_stalker_category` as well as on `category_ids`.
      _stalker_category: row._stalker_category ?? previous?._stalker_category,
      category_id: row.category_id ?? previous?.category_id,
      added: row.added || previous?.added,
      year: row.year || previous?.year,
    }, previous);
    sanitized.category_ids = mergeSearchCategoryIds(previous?.category_ids, sanitized.category_ids);
    return sanitized;
  });
  await db.vodSeries.bulkPut(rows as any[]);
  return rows as StoredSeries[];
}

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

/**
 * Persists a working fallback EPG URL so subsequent syncs and the UI
 * automatically use the working URL as default.
 */
async function persistWorkingEpgUrl(source: Source, workingUrl: string, originalUrl?: string): Promise<void> {
  if (!workingUrl || !source?.id) return;

  try {
    // 1. Update sourcesMeta table in DB so UI immediately reflects working EPG URL
    await bulkOps.updateSourceMeta({
      source_id: source.id,
      epg_url: workingUrl,
    });
    dbEvents.notify('sourcesMeta', 'update');

    // 2. If source.epg_url was explicitly set or differs from workingUrl, update source storage
    if (window.storage?.saveSource && source.epg_url !== workingUrl) {
      const updatedSource = {
        ...source,
        epg_url: workingUrl,
      };
      await window.storage.saveSource(updatedSource);
      console.log(`[EPG] Persisted working EPG URL as default for source "${source.name || source.id}": ${workingUrl}`);
      debugLog(`Persisted working EPG URL as default for source "${source.name || source.id}": ${workingUrl}`, 'epg');
    }
  } catch (err) {
    console.warn(`[EPG] Failed to persist working EPG URL for source "${source.name || source.id}":`, err);
  }
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
    // Feed pins: a channel locked to another feed must not be written by this
    // source's own feed. The wipe leaves its current rows alone as well (see
    // `PIN_AWARE_SOURCE_PROGRAMS_WIPE`; expired ones are pruned), so the channel
    // holds the pinned feed's guide until that feed replaces it.
    const { pins: feedPinMap } = await loadServableFeedPins();
    const eligibleChannels = filterChannelsForFeed(channels, feedPinMap, source.id);
    if (eligibleChannels.length !== channels.length) {
      console.log(`[EPG] ${channels.length - eligibleChannels.length} channel(s) skipped by feed locks (pinned to another EPG source)`);
      debugLog(`${channels.length - eligibleChannels.length} channels pinned to another feed, excluded from this EPG pass`, 'epg');
    }

    // Channels that match on their renamed name instead of the provider's. When
    // one applies it REPLACES the provider name, so the raw name stops being a
    // matching key and a feed channel that happens to match it can no longer
    // fill this channel.
    const aliasMatchNames = await loadEpgAliasMatchNames();
    const matchName = (ch: { stream_id: string; name?: string | null }) =>
      effectiveMatchName({ name: ch.name, alias: aliasMatchNames.get(ch.stream_id) }, true);

    // Create channel mappings for Rust parser
    // Include all channels (even without epg_channel_id) for name-based fallback matching
    const channelMappings = eligibleChannels
      .filter((ch) => epgOverrideMap.has(ch.stream_id) || ch.epg_channel_id || matchName(ch))
      .map((ch) => ({
        epg_channel_id: epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || matchName(ch),
        stream_id: ch.stream_id,
        channel_name: matchName(ch),
      }));

    console.log(`[EPG] Channels with EPG mapping (tvg-id or name): ${channelMappings.length}/${eligibleChannels.length}`);

    // Log sample mappings for debugging
    if (channelMappings.length > 0) {
      console.log(`[EPG] Sample mappings:`, channelMappings.slice(0, 3).map(m =>
        `${m.epg_channel_id} -> ${m.stream_id}`
      ).join(', '));
    }

    debugLog(
      `${channelMappings.length}/${eligibleChannels.length} channels have EPG mapping (tvg-id or name); ` +
      `${channels.length - eligibleChannels.length} excluded by feed locks`,
      'epg'
    );

    if (channelMappings.length === 0) {
      console.warn(`[EPG] WARNING: No channels available for EPG matching - EPG sync skipped!`);
      console.warn(`[EPG] This means your M3U playlist doesn't have tvg-id attributes or channel names.`);
      debugLog('No channels for EPG matching, skipping EPG sync', 'epg');
      return 0;
    }

    // Use streaming EPG parser with candidate fallback
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

    // If a working URL was found, persist it as the default EPG URL for this source
    if (result.working_url) {
      await persistWorkingEpgUrl(source, result.working_url, epgUrl);
    }

    debugLog(
      `Matched ${result.matched_programs}/${result.total_programs} programs (${result.unmatched_channels} unmatched EPG channels)`,
      'epg'
    );

    console.log(`[EPG] Streaming parser result: ${result.matched_programs}/${result.total_programs} programs matched`);
    console.log(`[EPG] ${result.inserted_programs} programs inserted, ${result.unmatched_channels} unmatched EPG channels`);
    console.log(`[EPG] Duration: ${result.duration_ms}ms (download ${result.download_ms}ms, decompress ${result.decompress_ms}ms, parse ${result.parse_ms}ms, insert ${result.insert_ms}ms, lock-wait ${result.lock_wait_ms ?? 0}ms)`);

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
  const primaryXmltvUrl = epgUrl || `${source.url}/xmltv.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
  const candidateUrls = getEpgUrlCandidates(primaryXmltvUrl, source.url, source.username, source.password);

  console.log(`[EPG] Candidate URLs for ${source.name || source.id}:`, candidateUrls);
  debugLog(`Streaming XMLTV from candidates: ${candidateUrls[0]} (total ${candidateUrls.length} candidate(s))`, 'epg');

  try {
    // Load user-applied EPG channel ID overrides so they win over the raw channel value
    const epgOverrideMap = await loadEpgChannelOverrideMap();

    // Feed pins: exclude channels locked to another feed (see syncEpgFromUrl).
    const { pins: feedPinMap } = await loadServableFeedPins();
    const eligibleChannels = filterChannelsForFeed(channels, feedPinMap, source.id);
    if (eligibleChannels.length !== channels.length) {
      console.log(`[EPG] ${channels.length - eligibleChannels.length} channel(s) skipped by feed locks (pinned to another EPG source)`);
    }

    // Channels matching on their renamed name replace the provider name where
    // the user opted in (see syncEpgFromUrl).
    const aliasMatchNames = await loadEpgAliasMatchNames();
    const matchName = (ch: { stream_id: string; name?: string | null }) =>
      effectiveMatchName({ name: ch.name, alias: aliasMatchNames.get(ch.stream_id) }, true);

    // Build channel mappings for Rust parser (overrides take precedence)
    const channelMappings = eligibleChannels
      .filter(ch => epgOverrideMap.has(ch.stream_id) || ch.epg_channel_id || matchName(ch))
      .map(ch => ({
        epg_channel_id: epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || matchName(ch),
        stream_id: ch.stream_id,
        channel_name: matchName(ch),
      }));

    console.log(`[EPG] Channels with EPG mapping (tvg-id or name): ${channelMappings.length}/${eligibleChannels.length}`);
    // Report the real counts separately: `channelMappings` includes channels
    // that only have a *name* for matching, so logging it as "have
    // epg_channel_id" made it look like every channel carried a tvg-id.
    const channelsWithTvgId = eligibleChannels.filter(
      ch => (epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || '').length > 0
    ).length;
    debugLog(
      `${channelsWithTvgId}/${eligibleChannels.length} channels have a tvg-id; ` +
      `${channelMappings.length}/${eligibleChannels.length} usable for matching (name fallback included); ` +
      `${channels.length - eligibleChannels.length} excluded by feed locks`,
      'epg'
    );

    // Use native Rust streaming parser for maximum performance with automatic fallback retry
    const result = await epgStreaming.streamParseEpg(
      source.id,
      source.name || source.id,
      primaryXmltvUrl,
      channelMappings,
      undefined,
      source.advanced_epg_matching ?? false,
      source.epg_timeshift_hours ?? 0,
      true,
      source.user_agent,
      candidateUrls
    );

    // If a working URL was found, persist it as the default EPG URL for this source
    if (result.working_url) {
      await persistWorkingEpgUrl(source, result.working_url, epgUrl);
    }

    console.log(`[EPG] Rust streaming parser COMPLETE:`);
    console.log(`  - Total programs in XML: ${result.total_programs}`);
    console.log(`  - Matched to channels: ${result.matched_programs}`);
    console.log(`  - Inserted to DB: ${result.inserted_programs}`);
    console.log(`  - Duration: ${result.duration_ms}ms (download ${result.download_ms}ms, decompress ${result.decompress_ms}ms, parse ${result.parse_ms}ms, insert ${result.insert_ms}ms, lock-wait ${result.lock_wait_ms ?? 0}ms)`);

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

    // Feed pins: this payload is keyed by the portal's own channel ids, so both
    // the raw id and the prefixed stream id are matched. The source-wide replace
    // below leaves their current rows alone — the pinned feed replaces them.
    const { pins: feedPinMap } = await loadServableFeedPins();
    const pinnedElsewhere = new Set<string>();
    for (const ch of channels as any[]) {
      const pin = feedPinMap.get(ch.stream_id);
      if (pin && pin !== source.id) {
        pinnedElsewhere.add(ch.stream_id);
        pinnedElsewhere.add(String(ch.stream_id).replace(`${source.id}_`, ''));
      }
    }
    let skippedByPin = 0;

    // NOTE: Do NOT apply epg_timeshift_hours here.
    // Timestamps are stored as pure UTC. The programs_effective SQL view applies
    // (sm.epg_timeshift_hours + co.timeshift_hours) at read time, consistent with
    // M3U and Xtream sources. Baking the shift here would cause a double-application.

    for (const [channelId, programList] of epgMap.entries()) {
      if (pinnedElsewhere.has(channelId)) {
        skippedByPin++;
        continue;
      }
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

    console.log(`[EPG] Converted ${storedPrograms.length} programs from ${epgMap.size} channels${skippedByPin > 0 ? ` (${skippedByPin} skipped by feed locks)` : ''}`);
    debugLog(`Converted ${storedPrograms.length} programs from ${epgMap.size} channels${skippedByPin > 0 ? `; ${skippedByPin} pinned to another feed, excluded` : ''}`, 'epg');

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
  // Gate program notifications: this fetches EPG per-channel in a loop and
  // each batch would otherwise re-run every program query mid-fetch.
  return withSyncGate(() => syncStalkerShortEpgInternal(source, channels, categoryId, onProgress, force));
}

async function syncStalkerShortEpgInternal(
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

  // Feed pins: the portal's short EPG is this source's own feed, so it must not
  // fill a channel the user locked to a different EPG source.
  const { pins: feedPinMap } = await loadServableFeedPins();

  // Filter channels to only those not synced in the last 3 hours, unless forced
  const channelsToFetch = channels.filter(ch => {
    const pin = feedPinMap.get(ch.stream_id);
    if (pin && pin !== source.id) return false;
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



// ─── Additional EPG waterfall helper ─────────────────────────────────────────
/**
 * Get the set of stream_ids whose guide data is still current — i.e. that have
 * at least one program ending in the future.
 *
 * Deliberately NOT "has any programs at all". These waterfall passes never
 * re-visit a channel they consider filled, so an existence-only check freezes a
 * channel's guide at the horizon of the sync that first filled it: a few days
 * later every program has ended and the channel shows "no program information"
 * until the user assigns an EPG override by hand. Treating those channels as
 * needing EPG again lets the next sync extend the guide.
 *
 * Program start/end are stored as RFC 3339 UTC with milliseconds, so the same
 * format compares correctly as a plain string.
 */
async function getStreamIdsWithUpcomingPrograms(sourceId: string): Promise<Set<string>> {
  try {
    const dbInstance = await (db as any).dbPromise;
    const rows = await dbInstance.select(
      `SELECT DISTINCT stream_id FROM programs WHERE source_id = ? AND end >= ?`,
      [sourceId, new Date().toISOString()]
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

  // Feed pins: a channel the user matched to a specific feed may only be filled
  // by that feed. This waterfall's feed identity is the source itself (its own
  // primary EPG and these extra URLs).
  const { pins: feedPinMap } = await loadServableFeedPins();
  const feedRef = source.id;
  const eligibleForThisFeed = (streamId: string) => (feedPinMap.get(streamId) ?? feedRef) === feedRef;

  // Find channels whose guide has run out (never filled, or filled by an
  // earlier sync whose programs have all since ended), excluding channels the
  // user pinned to a different feed.
  let channelsWithPrograms = await getStreamIdsWithUpcomingPrograms(source.id);
  let channelsNeedingEpg = channels.filter(ch => !channelsWithPrograms.has(ch.stream_id) && eligibleForThisFeed(ch.stream_id));

  console.log(`[EPG] Additional EPG sync starting: ${channelsNeedingEpg.length} channels out of ${channels.length} need EPG.`);
  
  debugLog(
    `${channelsNeedingEpg.length}/${channels.length} channels need EPG from additional sources`,
    'epg'
  );

  if (channelsNeedingEpg.length === 0) {
    console.log(`[EPG] Additional EPG sync skipped: no channel needs EPG (all have current guide data).`);
    debugLog('No channel needs EPG, skipping additional EPGs', 'epg');
    return 0;
  }

  // Load user-applied EPG channel ID overrides
  const epgOverrideMap = await loadEpgChannelOverrideMap();
  let totalInserted = 0;

  const additionalUrls = source.additional_epg_urls;
  if (!additionalUrls || additionalUrls.length === 0) {
    return 0;
  }

  // Channels that match on their renamed name (see syncEpgFromUrl — the provider
  // name is replaced by the alias when the user opted in). Loaded once: it does
  // not depend on which channels still need EPG.
  const aliasMatchNames = await loadEpgAliasMatchNames();
  const matchName = (ch: { stream_id: string; name?: string | null }) =>
    effectiveMatchName({ name: ch.name, alias: aliasMatchNames.get(ch.stream_id) }, true);

  for (let i = 0; i < additionalUrls.length; i++) {
    if (channelsNeedingEpg.length === 0) break;

    const epgUrl = additionalUrls[i].trim();
    if (!epgUrl) continue;

    debugLog(
      `Additional EPG ${i + 1}/${additionalUrls.length}: ${epgUrl.substring(0, 80)}...`,
      'epg'
    );
    onProgress?.(`Updating EPG (additional ${i + 1}/${additionalUrls.length})...`);

    try {
      // Build channel mappings for Rust parser
      // We only pass channels that STILL need EPGs
      const channelMappings = channelsNeedingEpg
        .filter((ch) => epgOverrideMap.has(ch.stream_id) || ch.epg_channel_id || matchName(ch))
        .map((ch) => ({
          epg_channel_id: epgOverrideMap.get(ch.stream_id) || ch.epg_channel_id || matchName(ch),
          stream_id: ch.stream_id,
          channel_name: matchName(ch),
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

      console.log(`[EPG] Additional EPG ${i + 1}: Matched ${result.matched_programs}/${result.total_programs} programs. Inserted: ${result.inserted_programs}. Duration: ${result.duration_ms}ms (download ${result.download_ms}ms, decompress ${result.decompress_ms}ms, parse ${result.parse_ms}ms, insert ${result.insert_ms}ms, lock-wait ${result.lock_wait_ms ?? 0}ms)`);

      debugLog(
        `Additional EPG ${i + 1}: inserted ${result.inserted_programs} programs`,
        'epg'
      );

      // If a fallback URL was used and differs from the configured URL, persist it
      if (result.working_url && result.working_url !== epgUrl) {
        const updatedAdditional: string[] = [...additionalUrls];
        updatedAdditional[i] = result.working_url;
        source.additional_epg_urls = updatedAdditional;
        try {
          if (window.storage?.saveSource) {
            await window.storage.saveSource({
              ...source,
              additional_epg_urls: updatedAdditional,
            });
            console.log(`[EPG] Persisted working additional EPG URL (${i + 1}): ${result.working_url}`);
            debugLog(`Persisted working additional EPG URL (${i + 1}): ${result.working_url}`, 'epg');
          }
        } catch (saveErr) {
          console.warn('[EPG] Failed to persist working additional EPG URL:', saveErr);
        }
      }

      if (result.inserted_programs === 0) {
        console.warn(`[EPG] Additional EPG ${i + 1}: No programs inserted!`);
        continue;
      }

      totalInserted += result.inserted_programs;

      // After streaming insertion, we need to know which channels ACTUALLY got programs
      // so we can filter them out of channelsNeedingEpg for the next additional URL.
      // Easiest way is just to re-query the DB for channelsWithPrograms!
      channelsWithPrograms = await getStreamIdsWithUpcomingPrograms(source.id);
      channelsNeedingEpg = channels.filter(ch => !channelsWithPrograms.has(ch.stream_id) && eligibleForThisFeed(ch.stream_id));

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
    const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;

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

    // Pins naming a feed that no longer exists are ignored by the Rust passes
    // too — they read the pins from the DB themselves, so the list has to be
    // handed over. Resolved after the guards above: a source with no links or no
    // channels has nothing to hand it to.
    const { pins: feedPinMap, unservableFeeds } = await loadServableFeedPins();

    // Channels locked to one of these links. A lock bars every other feed, so a
    // link that owns locked channels must be consulted even when nothing needs
    // filling: it is their only writer, and the refresh that keeps their guide
    // moving comes from its own pass (the Rust needing-mappings always include a
    // channel pinned to the feed being parsed). Without this the "nothing needs
    // EPG" shortcut below skips the pass, and a locked channel keeps its first
    // fill until a link-level sync happens to run.
    const linkIds = new Set(linksForSource.map(link => link.id));
    const sourceStreamIds = new Set(channels.map(ch => ch.stream_id));
    const lockedByLink = new Map<string, number>();
    for (const [streamId, pin] of feedPinMap) {
      if (!sourceStreamIds.has(streamId)) continue;
      if (!isGlobalEpgPin(pin)) continue;
      const linkId = pin.slice(GLOBAL_EPG_PIN_PREFIX.length);
      if (!linkIds.has(linkId)) continue;
      lockedByLink.set(linkId, (lockedByLink.get(linkId) ?? 0) + 1);
    }
    const lockedTotal = [...lockedByLink.values()].reduce((sum, count) => sum + count, 0);

    // Find channels that currently have no programs
    let channelsWithPrograms = await getStreamIdsWithUpcomingPrograms(source.id);
    let channelsNeedingEpg = channels.filter(ch => !channelsWithPrograms.has(ch.stream_id));

    console.log(`[EPG] Global EPG sync starting: ${channelsNeedingEpg.length} channels out of ${channels.length} need EPG.`);

    if (channelsNeedingEpg.length === 0 && lockedTotal === 0) {
      console.log(`[EPG] Global EPG sync skipped: no channel needs EPG (all have current guide data).`);
      debugLog('No channel needs EPG and no channel is locked to a link, skipping global EPG links', 'epg');
      return 0;
    }
    if (channelsNeedingEpg.length === 0) {
      debugLog(
        `Nothing needs EPG on ${source.name}, but ${lockedTotal} channel(s) are locked to its links - running them for those channels`,
        'epg'
      );
    }

    let totalInserted = 0;
    // Track per-link insertion counts so we can update lastSyncResult in settings
    const linkResultCounts = new Map<string, { programs: number; channels: number; matchedStreamIds: string[] }>();

    for (let i = 0; i < linksForSource.length; i++) {
      const link = linksForSource[i];
      // Per link, not a loop-wide break: when nothing needs filling, later links
      // that own a locked channel still have work to do.
      const lockedHere = lockedByLink.get(link.id) ?? 0;
      if (channelsNeedingEpg.length === 0 && lockedHere === 0) {
        debugLog(
          `Global EPG ${i + 1}/${linksForSource.length}: ${link.name} skipped (nothing needs EPG, no channel locked to it)`,
          'epg'
        );
        continue;
      }

      const epgUrl = link.url.trim();
      if (!epgUrl) continue;

      debugLog(
        `Global EPG ${i + 1}/${linksForSource.length}: ${link.name} - ${epgUrl.substring(0, 80)}...` +
          (lockedHere > 0 ? ` (${lockedHere} channel(s) locked to it)` : ''),
        'epg'
      );
      onProgress?.(`Updating EPG (global ${i + 1}/${linksForSource.length})...`);

      try {
        // The needing-EPG channel mappings are computed in Rust for both
        // branches below (channels minus already-filled stream ids, user
        // overrides applied), so no mapping payload crosses IPC on this path
        // either. Sources with nothing needing EPG yield empty results and the
        // 0-insert `continue` below handles the skip.
        let resultInsertedPrograms = 0;
        let resultMatchedChannels = 0;

        if (link.saveEntireEpg) {
          try {
            // Rust cache pass: computes the needing-EPG mappings for this source
            // from the main DB, writes the full feed to the local cache, and
            // inserts matched programmes directly — no JS read-back or bulkPut
            // in this path anymore.
            const results = await invoke('cache_entire_epg_db', {
              epgUrl,
              epgLinkId: link.id,
              userAgent: source.user_agent || null,
              sources: [{
                sourceId: source.id,
                sourceName: source.name || source.id,
                advancedEpgMatching: source.advanced_epg_matching ?? false,
                timeshiftHours: source.epg_timeshift_hours ?? 0,
                clearExisting: false,
              }],
              unservableFeeds,
            }) as { source_id: string; inserted_programs: number; matched_channels?: number }[];
            const result = results[0];
            resultInsertedPrograms = result?.inserted_programs ?? 0;
            resultMatchedChannels = result?.matched_channels ?? 0;
          } catch (e) {
            console.error(`[EPG] Failed to apply EPG from local cache for ${link.name}:`, e);
          }
        } else {
          // Rust multi-source parser with a single source ref (clearExisting =
          // false preserves the waterfall) — it computes the needing-EPG
          // mappings from the main DB and downloads/parses/inserts in one pass.
          const results = await epgStreaming.streamParseEpgMulti(
            epgUrl,
            [{
              sourceId: source.id,
              sourceName: source.name || source.id,
              advancedEpgMatching: source.advanced_epg_matching ?? false,
              timeshiftHours: source.epg_timeshift_hours ?? 0,
              clearExisting: false,
            }],
            source.user_agent || undefined,
            // This pass IS this link, so channels pinned to it are included and
            // channels pinned to any other feed are left alone.
            `global_epg_${link.id}`,
            unservableFeeds
          );
          const result = results[0];
          resultInsertedPrograms = result?.inserted_programs ?? 0;
          resultMatchedChannels = result?.matched_channels ?? 0;
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

        // Newly-filled channels = stream ids that gained programmes during this
        // link's pass (after − before). No mapping payload needed in JS.
        const newlyMatched: string[] = [];
        const channelsWithProgramsAfter = await getStreamIdsWithUpcomingPrograms(source.id);
        for (const streamId of channelsWithProgramsAfter) {
          if (!channelsWithPrograms.has(streamId)) {
            newlyMatched.push(streamId);
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
        const existingLinks = useSettingsStore.getState().globalEpgLinks;
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
              // Per-source freshness: this pass covered exactly this source.
              perSourceSyncedAt: {
                ...(existingResult?.perSourceSyncedAt || {}),
                [source.id]: Date.now(),
              },
            },
          };
        });
        useSettingsStore.getState().setGlobalEpgLinks(updatedLinks);
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
 * Sync all global EPG links that need it.
 * Intended as a post-batch-sync step: after all sources have synced their primary EPGs,
 * this downloads each global EPG once and applies it to all linked sources.
 * A link is attempted when it's stale (within GLOBAL_EPG_FRESH_MS it's considered
 * fresh) OR its last sync inserted programs (it can fill gaps again) — the
 * per-link impl skips the download cheaply when no channels currently need EPG,
 * and links whose last sync matched nothing are backed off by the freshness
 * window so a no-match feed isn't re-downloaded every cycle.
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

  // Gate live-query notifications: a global EPG sync streams thousands of
  // program batches, and each batch would otherwise re-run every program query.
  globalEpgPostSyncInFlight = withSyncGate(() => syncAllStaleGlobalEpgLinksImpl(onProgress, sourceIds)).finally(() => {
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
    // Every source in `sourceIds` was just resynced, which means its programmes
    // were rewritten by its primary EPG pass. Clear those sources' freshness
    // stamps first so the links attached to them are reconsidered even if they
    // ran a moment ago (a link that filled source A must still be allowed to
    // fill source B when B syncs later in the round).
    const sourceIdFilter = sourceIds && sourceIds.length > 0 ? new Set(sourceIds) : null;
    let globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
    if (sourceIdFilter) {
      const cleared = clearGlobalEpgSourceStamps(globalEpgLinks, sourceIdFilter);
      if (cleared.changed) {
        globalEpgLinks = cleared.links;
        useSettingsStore.getState().setGlobalEpgLinks(globalEpgLinks);
      }
    }

    // A link is attempted when, for at least one attached source, it has never
    // run or it's stale (feed may have new data) or its last run actually
    // inserted programs (it can fill gaps again). Freshness is per source, so a
    // no-match pass for one source can't back off a second source's gap-fill.
    // The per-link impl also skips the download entirely when no channels
    // currently need EPG. Sort by display_order so higher priority EPGs go first.
    const linksToSync = globalEpgLinks
      .filter(link => !sourceIdFilter || link.sourceIds.some(sourceId => sourceIdFilter.has(sourceId)))
      .filter(link => linkNeedsSyncForAnySource(link, attachedEpgSourceIds(link, sourceIdFilter)))
      .sort((a, b) => (a.display_order ?? Number.MAX_SAFE_INTEGER) - (b.display_order ?? Number.MAX_SAFE_INTEGER));

    if (linksToSync.length === 0) {
      debugLog(
        sourceIdFilter
          ? 'No global EPG links tied to the synced sources need sync, skipping post-sync'
          : 'All global EPG links are fresh with no recent fills, skipping post-sync',
        'epg'
      );
      return 0;
    }

    console.log(`[Global EPG] Post-sync: ${linksToSync.length} global EPG link(s) need sync`);
    debugLog(`Post-syncing ${linksToSync.length} global EPG links (waterfall order)`, 'epg');

    let totalInserted = 0;
    for (let i = 0; i < linksToSync.length; i++) {
      const link = linksToSync[i];
      onProgress?.(`Syncing global EPG ${i + 1}/${linksToSync.length}: ${link.name}...`);
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
 * Each source only receives programmes for channels whose guide has run out
 * (never filled, or filled by an earlier sync whose programmes have all ended).
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

  // Gate live-query notifications while the streaming parser inserts programs.
  const syncPromise = withSyncGate(() => syncGlobalEpgLinkStandaloneImpl(epgLink, onProgress)).finally(() => {
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

  // Per-source refs — the needing-EPG channel mappings are computed in Rust
  // (channels minus already-filled stream ids, user overrides taking priority),
  // so the renderer no longer fetches every channel or ships ~20k-row mapping
  // payloads across IPC. Sources with nothing needing EPG are skipped inside
  // the Rust pass.
  const sourceRefs: import('../services/epg-streaming').EpgSourceRef[] = [];

  for (const sourceId of epgLink.sourceIds) {
    const source = sourceMap.get(sourceId);
    if (!source) {
      debugLog(`Source ${sourceId} not found in storage, skipping`, 'epg');
      continue;
    }

    sourceRefs.push({
      sourceId,
      sourceName: source.name || sourceId,
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

  if (!userAgent) {
    try {
      const globalUa = useSettingsStore.getState().globalLiveTvUserAgent;
      if (globalUa && globalUa.trim()) {
        userAgent = globalUa.trim();
      }
    } catch (e) {
      console.error('[Global EPG] Failed to load global user agent settings:', e);
    }
  }

  if (sourceRefs.length === 0) {
    console.log(`[Global EPG] No sources need EPG from ${epgLink.name}`);
    // Mark as attempted so we don't retry every 10 min, but only for the 30 min
    // freshness window. Every attached source is stamped: this pass covered all
    // of them (it simply found nothing to fill).
    await updateGlobalEpgLastSynced(epgLink.id, 0, {}, undefined, undefined, undefined, epgLink.sourceIds);
    return 0;
  }

  // Pins naming a feed that no longer exists are ignored by the two Rust passes
  // below too, which read the pins from the DB themselves. Resolved here, once
  // per link, after the passes that decide whether this link runs at all.
  const { unservableFeeds } = await loadServableFeedPins();

  onProgress?.(`Applying EPG to ${sourceRefs.length} source(s)...`);

  let totalInserted = 0;
  const perSourceCounts: Record<string, number> = {};
  let totalChannelsMatched = 0;
  const perSourceChannels: Record<string, number> = {};
  let syncSucceeded = false;

  // Channels locked to this link, read before and after the passes so the log
  // shows whether their guide was refreshed. The Rust pass includes them even
  // when they already have data, so counts alone can't tell whether it ran
  // (empty and cheap when no channel is locked to this link).
  const lockedBefore = await readLinkFeedLockedTargets(epgLink.id);

  // Snapshot which stream ids already have current guide data so newly-filled
  // channels can be attributed to this link afterwards
  // (lastSyncResult.matchedStreamIds).
  const beforeSets = new Map<string, Set<string>>();
  for (const ref of sourceRefs) {
    beforeSets.set(ref.sourceId, await getStreamIdsWithUpcomingPrograms(ref.sourceId));
  }

  if (epgLink.saveEntireEpg) {
    onProgress?.(`Caching entire EPG database locally...`);

    // Download, cache the ENTIRE feed, and apply matched programmes in ONE
    // Rust pass (cache_entire_epg_db computes the needing-EPG mappings from
    // the main DB and matches/inserts with the multi-source parser's exact
    // routing). There is no JS cache read-back fallback — the cache DB is only
    // ever written by this pass, so a failed refresh keeps the last-good cache
    // file intact and syncSucceeded stays false (link retried next cycle).
    try {
      const results = await invoke('cache_entire_epg_db', {
        epgUrl: url,
        epgLinkId: epgLink.id,
        userAgent,
        sources: sourceRefs,
        unservableFeeds
      }) as { source_id: string; inserted_programs: number; matched_channels?: number }[];
      syncSucceeded = true;
      console.log(`[Global EPG] Entire EPG cached locally for link ${epgLink.id}`);

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
      if (results.length === 0) {
        console.log(`[Global EPG] No sources need EPG from ${epgLink.name}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Global EPG] Failed to refresh EPG cache for ${epgLink.name}: ${errMsg}`);
      debugLog(`EPG cache refresh failed: ${errMsg}`, 'epg');
    }
  } else {
    try {
      const results = await epgStreaming.streamParseEpgMulti(
        url,
        sourceRefs,
        userAgent,
        `global_epg_${epgLink.id}`,
        unservableFeeds
      );
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

  // Report the channels this link is the only writer for, while its effect is
  // still attributable to it, before anything else writes rows.
  logLinkPinRefresh(
    epgLink.name,
    lockedBefore,
    await readLinkFeedLockedTargets(epgLink.id),
    syncSucceeded ? totalInserted : null
  );

  // Only mark as synced if the Rust call succeeded (even if 0 programmes inserted)
  if (syncSucceeded) {
    let matchedStreamIds: string[] | undefined = undefined;
    try {
      // Newly-filled channels = stream ids that gained programmes during this
      // link's pass (after − before), attributed per source. This no longer
      // needs the needing-EPG pool (which is computed in Rust now).
      const newlyMatchedStreamIds: string[] = [];
      for (const ref of sourceRefs) {
        const inserted = perSourceCounts[ref.sourceId] ?? 0;
        if (inserted <= 0) continue;
        const before = beforeSets.get(ref.sourceId) || new Set<string>();
        const channelsWithProgramsAfter = await getStreamIdsWithUpcomingPrograms(ref.sourceId);
        for (const streamId of channelsWithProgramsAfter) {
          if (!before.has(streamId)) {
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
      matchedStreamIds,
      // Only the sources this pass actually included get their stamp refreshed.
      sourceRefs.map(r => r.sourceId)
    );
  }

  console.log(`[Global EPG] Standalone sync complete for ${epgLink.name}: ${totalInserted} total programs inserted`);
  debugLog(`Standalone sync complete: ${totalInserted} programs across ${sourceRefs.length} sources`, 'epg');
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
  matchedStreamIds?: string[],
  /** Sources this pass covered — each gets its own freshness stamp. */
  syncedSourceIds?: string[]
): Promise<void> {
  if (!window.storage) return;
  try {
    const existingLinks = useSettingsStore.getState().globalEpgLinks;
    const updatedLinks = existingLinks.map((link: GlobalEpgLink) => {
      if (link.id !== epgLinkId) return link;
      const perSourceSyncedAt = { ...(link.lastSyncResult?.perSourceSyncedAt || {}) };
      const stamp = Date.now();
      for (const sourceId of syncedSourceIds || []) {
        perSourceSyncedAt[sourceId] = stamp;
      }
      return {
        ...link,
        lastSynced: stamp,
        lastSyncResult: {
          timestamp: stamp,
          totalInserted,
          perSource: perSourceCounts,
          channelsMatched: totalChannelsMatched,
          perSourceChannels,
          matchedStreamIds,
          perSourceSyncedAt,
        },
      };
    });
    useSettingsStore.getState().setGlobalEpgLinks(updatedLinks);
    console.log(`[Global EPG] Updated lastSynced for link ${epgLinkId}`);
  } catch (err) {
    console.warn(`[Global EPG] Failed to update lastSynced:`, err);
  }
}

// Freshness rules for global EPG links live in utils/globalEpgFreshness so they
// can be unit-tested without pulling in the store/db graph. Eligibility is per
// (link, source): `lastSynced` alone is a per-link field, which used to let one
// source's no-match pass back off every other attached source's gap-fill.

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

export async function syncSource(source: Source, onProgress?: (msg: string) => void, staggerAlignment = false): Promise<SyncResult> {
  // Gate live-query notifications for the duration of the sync: bulk channel +
  // EPG writes happen throughout, and we don't want every batch write to
  // re-run the channel/program queries mid-sync. One coalesced refresh fires
  // when the gate closes.
  return withSyncGate(() => syncSourceInternal(source, onProgress, staggerAlignment));
}

async function syncSourceInternal(source: Source, onProgress?: (msg: string) => void, staggerAlignment = false): Promise<SyncResult> {
  source = await resolveSourceUserAgent(source);
  // Try primary URL first
  const result = await _doSyncSourceImpl(source, onProgress, staggerAlignment);
  if (result.success) return result;

  // A playlist imported from a file has no URL to fall back to: a failure means
  // the file and the copy kept in the app are both unavailable, and rotating to
  // a backup URL would quietly turn the source into something else.
  const localPlaylistSource = isLocalPlaylistSource(source) || isLegacyLocalImport(source);

  // If primary failed and we have backup URLs, try them in order
  if (!localPlaylistSource && source.backup_urls && source.backup_urls.length > 0) {
    for (const backupUrl of source.backup_urls) {
      const trimmedUrl = backupUrl.trim();
      if (!trimmedUrl) continue;

      debugLog(`Primary URL failed. Trying backup URL: ${trimmedUrl}`, 'sync');
      onProgress?.(i18n.t('common:primaryUrlFailedTryingBackup', { url: trimmedUrl }));

      const backupSource: Source = { ...source, url: trimmedUrl };
      const backupResult = await _doSyncSourceImpl(backupSource, onProgress, staggerAlignment);

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
async function _doSyncSourceImpl(source: Source, onProgress?: (msg: string) => void, staggerAlignment = false): Promise<SyncResult> {
  debugLog(`Starting sync for source: ${source.name} (${source.type})`, 'sync');
  onProgress?.(`Starting sync for ${source.name}...`);
  const startTime = performance.now();
  // console.time labels are process-global: with sources syncing concurrently,
  // the same label collides (Chrome warns "Timer 'sync-total' already exists"
  // and the first timer's duration gets reported for the wrong source). Scope
  // the label per source so each concurrent sync gets its own timer.
  const timerLabel = (label: string) => `${label}: ${source.name}`;
  console.time(timerLabel('sync-total'));
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
    // Set when a local playlist couldn't be read as a playlist this time (its
    // file is missing and the kept copy carried it, or neither produced
    // channels): the source then keeps its stale stamp so the next cycle retries.
    let localPlaylistNeedsRetry = false;

    let nativeSyncComplete = false;
    let nativeChannelsCount = 0;
    let nativeCategoriesCount = 0;

    // A playlist imported from a file is rebuilt here rather than by the native
    // sync: its "URL" is a path on this machine, so there is nothing to fetch.
    const localPlaylistFile = isLocalPlaylistSource(source) ? localPlaylistPath(source) : null;
    const isLocalPlaylist = localPlaylistFile !== null;
    const isLegacyLocal = isLegacyLocalImport(source);

    // ----- NATIVE RUST SYNC (Xtream & M3U only) -----
    if ((window as any).__TAURI__ && !source.vod_only && !isLocalPlaylist && !isLegacyLocal) {
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
            if (url.startsWith('https://') && port === '80') {
              url = url.replace('https://', 'http://');
            } else if (url.startsWith('http://') && port === '443') {
              url = url.replace('http://', 'https://');
            }
            const isStandardPort = (url.startsWith('https://') && port === '443') || (url.startsWith('http://') && port === '80');
            const portSuffix = port && !isStandardPort ? `:${port}` : '';
            epgUrl = `${url}${portSuffix}/xmltv.php?username=${source.username}&password=${source.password}`;
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
         // Tauri v2 rejects with a string, not always an Error — extract the
         // real reason so lock failures aren't logged as "undefined".
         const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err ?? 'unknown error');
         debugLog(`Native sync failed: ${msg}, falling back to legacy JS parser...`, 'sync');
      }
    }

    if (!nativeSyncComplete) {
    if (source.type === 'm3u') {
      // Check if this is a local imported file (not a remote URL)
      if (isLocalPlaylist || isLegacyLocal) {
        if (isLocalPlaylist) {
          // Local imported M3U - rebuild from the file, or from the copy kept in
          // the app when the file has moved or been deleted.
          debugLog(`Local M3U file: ${localPlaylistFile}`, 'sync');
          onProgress?.(i18n.t('common:loadingLocalPlaylist'));

          const resolved = await resolveLocalPlaylist(source);
          const parsed = resolved.content ? parseM3U(resolved.content, source.id) : null;
          // `existingChannels` is this source's pre-sync set: what the app would
          // still be showing if the playlist has to be left alone.
          const plan = planLocalPlaylistSync({
            from: resolved.source,
            parsedChannelCount: parsed?.channels.length ?? 0,
            cachedChannelCount: existingChannelMap.size,
          });

          if (plan.use === 'parsed') {
            channels = parsed!.channels;
            categories = parsed!.categories;
            epgUrl = parsed!.epgUrl ?? undefined;
            debugLog(
              `Local M3U ${resolved.source === 'file' ? 'file read' : 'kept copy used'}` +
                `${resolved.error ? ` (${resolved.error})` : ''}: ` +
                `${channels.length} channels, ${categories.length} categories`,
              'sync'
            );
            if (plan.refreshCopy) {
              // Keep the copy current so a later restore has the latest edit.
              await writeLocalPlaylistSnapshot(source.id, resolved.content!);
            }
          } else {
            // Nothing usable to parse. Keep what is cached rather than deleting
            // channels for a playlist that produced nothing, and don't stamp the
            // source as fresh: it retries on the next cycle, or as soon as the
            // file is back (see keepStale below).
            const sourceMeta = await db.sourcesMeta.get(source.id);
            channels = existingChannels as Channel[];
            categories = existingCategories as Category[];
            epgUrl = sourceMeta?.epg_url;
            const reason =
              resolved.error ??
              (resolved.content ? 'the file listed no channels' : 'no playlist file or kept copy');
            console.warn(
              `[Sync] Local M3U unusable for "${source.name}" (${reason}): keeping ${channels.length} cached channel(s)`
            );
            debugLog(`Local M3U unusable (${reason}): kept ${channels.length} cached channels`, 'sync');
            if (plan.use === 'none') {
              throw new Error(localPlaylistUnreadableMessage(resolved.filePath));
            }
          }
          // Rebuilt from the copy, or not rebuilt at all: leave the source stale
          // so the file is looked for again instead of backing off for hours.
          localPlaylistNeedsRetry = plan.keepStale;
        } else {
          // A file import from before the path was recorded: the channels were
          // parsed into the database at import time and there is nothing left to
          // re-read, so this can only report what is cached.
          debugLog(`Legacy local import detected: ${source.url}`, 'sync');
          onProgress?.(i18n.t('common:loadingLocalPlaylist'));

          const cachedChannels = await db.channels.where('source_id').equals(source.id).toArray();
          const cachedCategories = await db.categories.where('source_id').equals(source.id).toArray();
          const sourceMeta = await db.sourcesMeta.get(source.id);

          channels = cachedChannels as Channel[];
          categories = cachedCategories as Category[];
          epgUrl = sourceMeta?.epg_url;

          debugLog(`Loaded ${channels.length} channels from local import`, 'sync');
          if (channels.length === 0) {
            throw new Error(i18n.t('common:localImportNeedsReimport'));
          }
        }
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
        if (url.startsWith('https://') && port === '80') {
          url = url.replace('https://', 'http://');
        } else if (url.startsWith('http://') && port === '443') {
          url = url.replace('http://', 'https://');
        }
        const isStandardPort = (url.startsWith('https://') && port === '443') || (url.startsWith('http://') && port === '80');
        const portSuffix = port && !isStandardPort ? `:${port}` : '';
        // Xtream typically serves EPG at /xmltv.php
        epgUrl = `${url}${portSuffix}/xmltv.php?username=${source.username}&password=${source.password}`;
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
      catchup_type: ch.catchup_type ?? null,
      catchup_source: ch.catchup_source ?? null,
      catchup_days: ch.catchup_days ?? null,
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

    // Write channel/category counts and connection metadata — but NOT last_synced yet.
    // This is status bookkeeping only: a failure here must NOT abort the sync — the
    // channels/categories are already stored, and aborting skips the EPG (the previous
    // symptom: sources marked FAILED with 0 counts even though the data landed, because
    // the status write raced a lock).
    try {
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
    } catch (metaErr) {
      debugLog(`Failed to persist channel counts for ${meta.source_id}: ${metaErr}`, 'sync');
    }
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
      console.time(timerLabel('sync-epg-insert'));
      // Pass the correctly constructed EPG URL (with server info from connection test)
      programCount = await syncEpgForSource(source, channels, epgUrl);
      console.timeEnd(timerLabel('sync-epg-insert'));
      debugLog(`EPG sync complete: ${programCount} programs`, 'epg');
    } else if (shouldLoadEpg && source.type === 'stalker' && source.mac) {
      // Stalker: use get_epg_info endpoint
      debugLog('Syncing EPG for Stalker source...', 'epg');
      onProgress?.(i18n.t('common:updatingEpgShort'));
      console.time(timerLabel('sync-epg-insert'));
      programCount = await syncEpgForStalker(source, channels);
      console.timeEnd(timerLabel('sync-epg-insert'));
      debugLog(`Stalker EPG sync complete: ${programCount} programs`, 'epg');
    } else if (shouldLoadEpg && epgUrl) {
      // M3U with EPG URL: fetch XMLTV from the EPG URL
      debugLog('Syncing EPG for M3U source...', 'epg');
      onProgress?.(i18n.t('common:updatingEpgShort'));
      console.time(timerLabel('sync-epg-insert'));
      programCount = await syncEpgFromUrl(source, epgUrl, channels);
      console.timeEnd(timerLabel('sync-epg-insert'));
      debugLog(`M3U EPG sync complete: ${programCount} programs`, 'epg');
    }

    // If user provided a manual EPG URL override, use that (skip for VOD-only sources)
    const fixedEpgUrl = fixDuplicatedUrl(source.epg_url);
    if (fixedEpgUrl && !shouldLoadEpg && !source.vod_only) {
      debugLog('Syncing EPG from manual URL override...', 'epg');
      console.log(`[EPG] Debug - About to call syncEpgFromUrl with manual URL: ${fixedEpgUrl}`);
      onProgress?.(i18n.t('common:updatingEpgManualUrl'));
      console.time(timerLabel('sync-epg-manual'));
      programCount = await syncEpgFromUrl(source, fixedEpgUrl, channels);
      console.timeEnd(timerLabel('sync-epg-manual'));
      debugLog(`Manual EPG sync complete: ${programCount} programs`, 'epg');
    }

    // Waterfall: fill in gaps with additional EPG URLs (skip for VOD-only sources)
    if (!source.vod_only && source.additional_epg_urls && source.additional_epg_urls.length > 0) {
      debugLog('Syncing additional EPG URLs (waterfall)...', 'epg');
      onProgress?.(i18n.t('common:updatingEpgAdditional'));
      console.time(timerLabel('sync-epg-additional'));
      const additionalCount = await syncAdditionalEpgUrls(source, channels, onProgress);
      console.timeEnd(timerLabel('sync-epg-additional'));
      programCount += additionalCount;
      debugLog(`Additional EPG waterfall complete: ${additionalCount} programs`, 'epg');
    }

    debugLog(`Sync complete for ${source.name}: ${channels.length} channels, ${categories.length} categories, ${programCount} programs`, 'sync');
    console.timeEnd(timerLabel('sync-total'));
    debugLog(`Total sync time: ${((performance.now() - startTime) / 1000).toFixed(2)}s`, 'sync');

    // NOW stamp last_synced — EPG sync has completed (or was skipped for sources without EPG).
    // Writing this after EPG ensures a failed/empty EPG sync will cause the next autosync
    // cycle to retry the source rather than treating it as fresh.
    // Non-fatal: the EPG data is already stored — a bookkeeping failure here must not flip
    // a fully-synced source to FAILED (it previously did, via lock contention).
    try {
      if (localPlaylistNeedsRetry) {
        // The playlist itself wasn't read this time, so the source isn't fresh:
        // leaving last_synced alone makes the next auto-sync cycle try again
        // (which is how a returned or re-linked file is picked up).
        debugLog(
          `Source ${source.id} left stale: its local playlist file could not be read`,
          'sync'
        );
      } else {
        await bulkOps.updateSourceMeta({
          source_id: source.id,
          last_synced: new Date().toISOString(),
        });
        dbEvents.notify('sourcesMeta', 'update');
      }
    } catch (metaErr) {
      debugLog(`Failed to mark source ${source.id} as synced: ${metaErr}`, 'sync');
    }
    debugLog('Source marked as synced after EPG step completed', 'sync');

    // Automatically align/fill programs for manually overridden channels in this source.
    // In sync-all the alignment is queued the moment this source's EPG lands so it
    // overlaps the remaining sources' downloads/inserts (staggered, capped at 2
    // concurrent) instead of forming a post-sync tail. Single-source syncs still
    // align inline so their result reflects the full work.
    if (staggerAlignment) {
      queueAlignment(source.id);
    } else {
      await alignOverriddenChannelPrograms(source.id);
    }

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

  // Pages fetched in parallel per batch (Settings -> Sources -> Stalker
  // Preferences; default 4). Defensive clamp in case a stale stored value
  // sneaks past hydration.
  const pageConcurrency = Math.min(12, Math.max(1, Math.round(useSettingsStore.getState().stalkerVodPageConcurrency) || 4));

  try {
    const fetchType = type === 'movies' ? 'vod' : 'series';
    // Use the new getCategoryItems method with progress. The client reports
    // page counts (1-indexed); localize them here so the UI can show
    // "Loading page X of Y..." while a Stalker category paginates (14/page).
    const items = await client.getCategoryItems(categoryId, fetchType, (percent, currentPage, totalPages) => {
      if (!onProgress) return;
      let msg = '';
      if (currentPage != null) {
        msg = totalPages != null
          ? i18n.t('vod:loadingPageOf', { current: currentPage, total: totalPages })
          : i18n.t('vod:loadingPage', { current: currentPage });
      }
      onProgress(percent, msg);
    }, pageConcurrency);

    if (items.length === 0) {
      debugLog(`[LazyLoad] No items found in category ${categoryId}`, 'sync');
      return 0;
    }

    debugLog(`[LazyLoad] Storing ${items.length} items for category ${categoryId}`, 'sync');
    if (onProgress) onProgress(100, i18n.t('common:savingToDatabase'));

    if (type === 'movies') {
      // Sanitize items to ensure they match StoredMovie schema
      const movieItems = items.map((item: any) => sanitizeMovie(item));
      await db.vodMovies.bulkPut(movieItems);
    } else {
      // Map Channel items to StoredSeries
      const seriesItems = items.map((item: any) => mapStalkerSeriesRow(item, categoryId));

      await db.vodSeries.bulkPut(seriesItems as any[]);
    }

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
  // Reset the alignment scheduler from any previous interrupted run.
  alignmentQueue = [];
  alignmentInFlight = 0;
  alignmentDrainResolve = null;

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

  // Bulk-load mode: drop the `programs` secondary indexes for the duration of
  // the run so every insert/update touches ONE B-tree per row instead of five
  // (the dominant cost of the serialized insert queue — ~1.7M rows this run),
  // then rebuild them once in the finally block. A failed drop is non-fatal
  // (just a slower run); a failed rebuild is logged loudly — the schema init
  // on next app start recreates them anyway (CREATE INDEX IF NOT EXISTS).
  try {
    await epgStreaming.bulkLoadStart();
    debugLog('[Sync] Dropped programs indexes for bulk EPG load', 'epg');
  } catch (err) {
    console.warn('[Sync] Failed to drop programs indexes (continuing without bulk load):', err);
  }

  try {
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

          const result = await syncSource(source, sourceProgress, true);
          debugLog(`Source ${source.name}: ${result.success ? 'OK' : 'FAILED'} - ${result.channelCount} channels, ${result.categoryCount} categories`, 'sync');
          return { sourceId: source.id, result };
        })
      );

      // Store results
      for (const { sourceId, result } of batchResults) {
        results.set(sourceId, result);
      }
    }

    // Staggered per-source EPG alignments: most finished in the background while
    // the remaining sources were still downloading/inserting. Wait for any
    // stragglers so the summary row and final checkpoint see all writes.
    const pendingAlignments = alignmentQueue.length + alignmentInFlight;
    if (pendingAlignments > 0) {
      debugLog(`[Sync] Waiting for ${pendingAlignments} staggered bulk EPG alignment(s) to finish...`, 'epg');
    }
    await drainAlignments();

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
  } finally {
    // Per-run summary row in epg_timings.jsonl (kind: "run") — written first,
    // before the index rebuild, so it reflects the sync itself rather than the
    // rebuild tail. Still inside the finally so even failed runs get a row.
    const runOk = Array.from(results.values()).filter(r => r.success).length;
    try {
      await epgStreaming.timingRunEnd({
        alignmentMaxMs: Math.round(lastRunAlignmentMaxMs),
        sourcesOk: runOk,
        sourcesFailed: results.size - runOk,
      });
    } catch (err) {
      console.error('[Sync] Failed to write run timing summary:', err);
    } finally {
      lastRunAlignmentMaxMs = 0;
    }

    // Always schedule the index rebuild, even when a source throws out of the
    // loop. Runs on a background Rust thread (non-blocking) so syncAllSources
    // resolves ~10s sooner; if the app exits before it completes, the schema
    // init recreates the indexes on next app start (self-healing).
    try {
      await epgStreaming.bulkLoadFinish();
      debugLog('[Sync] Scheduled programs index rebuild (background)', 'epg');
    } catch (err) {
      console.error('[Sync] Failed to schedule programs index rebuild (recreated on next app start):', err);
    }
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
  // Same gate as syncSource: bulk VOD writes shouldn't re-run live queries
  // (movies/series/episodes tables) on every batch, only once at the end.
  return withSyncGate(() => syncVodForSourceInternal(source));
}

async function syncVodForSourceInternal(source: Source): Promise<VodSyncResult> {
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
    const accessToken = useSettingsStore.getState().tmdbApiKey || null;
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

/**
 * Clear only EPG data (program listings, EPG channel metadata, and the
 * full-EPG offline caches for Global EPG links) without touching the channel
 * list, categories, VOD, or user settings. Sources are re-fetched on the next
 * sync; Global EPG links are marked stale so they re-download their cache.
 */
export async function clearEpgCacheOnly(): Promise<void> {
  // 1. Clear live EPG data from the main database.
  await db.programs.clear();
  await db.epgChannels.clear();
  dbEvents.notify('programs', 'clear');

  // 2. Clear offline full-EPG caches and reset their freshness so they are
  //    re-downloaded on the next global EPG sync.
  try {
    const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
    for (const link of globalEpgLinks) {
      await cleanupGlobalEpgCache(link.id);
    }
    if (globalEpgLinks.length > 0) {
      const resetLinks = globalEpgLinks.map((link) => ({
        ...link,
        lastSynced: undefined,
        lastSyncResult: undefined,
      }));
      useSettingsStore.getState().setGlobalEpgLinks(resetLinks);
    }
  } catch (err) {
    console.warn('[Global EPG] Failed to clear global EPG caches:', err);
  }

  // 3. Reclaim disk space.
  // TRUNCATE checkpoint copies WAL pages into the main DB and resets the WAL to 0 bytes.
  try {
    await db.checkpoint('TRUNCATE');
  } catch (err) {
    console.warn('[Sync] EPG cache checkpoint failed:', err);
  }

  // 4. Vacuum the database to reclaim disk space from the cleared rows.
  // VACUUM rebuilds the database file, repacking it into a minimal amount of disk space.
  try {
    await db.execute('VACUUM');
  } catch (err) {
    console.warn('[Sync] EPG cache vacuum failed:', err);
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

// Feed-pin predicate for the alignment queries (`sc` = the provider channel the
// programmes are copied from, `eco` = the override row):
//
//   * no pin            → unchanged behaviour (any provider channel with the id)
//   * pinned to a feed  → only a provider channel belonging to that feed may
//                         supply the copy
//   * pinned to a global EPG link → skipped entirely; those programmes are
//                         written by that link's own pass, never copied here.
//
// Without this the alignment re-copied a pinned channel from whichever source
// happened to own the id, silently undoing the feed the user chose.
//
// A pin naming a feed that no longer exists is ignored here exactly as it is in
// the mapping filters (both read the same list from `loadServableFeedPins`):
// otherwise the channel would stay reserved for a feed that can't write it, and
// the alignment — the only writer a playlist pin has — would never fill it.
function alignPinMatches(unservableFeeds: string[]): { sql: string; params: string[] } {
  const ignored = unservableFeeds.length > 0
    ? `\n           OR eco.epg_source_id IN (${unservableFeeds.map((_, i) => `$${i + 2}`).join(', ')})`
    : '';
  return {
    sql: `(
           eco.epg_source_id IS NULL${ignored}
           OR (substr(eco.epg_source_id, 1, 11) != 'global_epg_' AND eco.epg_source_id = sc.source_id)
         )`,
    params: unservableFeeds,
  };
}

/**
 * Freshness cutoff every alignment statement shares, so the rows the DELETE
 * claims are exactly the rows the INSERTs would write.
 */
export const ALIGN_GUIDE_CUTOFF_SQL = `datetime('now', '-1 hour')`;

/**
 * The `sc` (guide-providing channel) conditions the DELETE and both INSERTs in
 * `alignOverriddenChannelPrograms` must agree on: a carrier that is a different
 * channel, is not itself overridden (a carrier with its own override is written
 * by *its* pin, never used as a source) and holds at least one row inside the
 * current window.
 */
function alignCarrierSql(match: 'id' | 'name'): string {
  const byColumn = match === 'id'
    ? 'sc.epg_channel_id = eco.epg_channel_id'
    : 'sc.name = eco.epg_channel_id';
  return `${byColumn}
                          AND sc.stream_id != eco.stream_id
                          AND sc.stream_id NOT IN (SELECT stream_id FROM epg_channel_overrides)`;
}

/**
 * The three statements `alignOverriddenChannelPrograms` runs, in order: one
 * DELETE followed by the id-match and name-match INSERTs.
 *
 * The DELETE deliberately claims *only* the rows the INSERTs are about to write.
 * Without that, a target whose id exists only on a carrier that is itself
 * overridden, or that holds nothing in the current window (an empty or truncated
 * provider feed — the 108-byte XMLTV case), was emptied and never refilled: the
 * alignment deleted the rows the channel's own EPG pass had just written and put
 * nothing back, on every sync. The carrier conditions and the cutoff are shared
 * here rather than repeated, and `alignmentReplaceOnly.test.ts` runs all three
 * against a real SQLite asserting every channel the delete touches gets rows
 * back.
 */
export function buildAlignmentStatements(pinSql: string): {
  deleteProgramsSql: string;
  insertByIdSql: string;
  insertByNameSql: string;
} {
  const touched = `(tc.source_id = $1 OR sc.source_id = $1)
           AND ${pinSql}`;
  const carrierExists = `EXISTS (
             SELECT 1 FROM programs p
              WHERE p.stream_id = sc.stream_id
                AND p.end >= ${ALIGN_GUIDE_CUTOFF_SQL}
           )`;
  const insert = (carrier: string) => `INSERT OR REPLACE INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
       SELECT
         eco.stream_id || '_' || CAST(CAST(strftime('%s', p.start) AS INTEGER) * 1000 AS TEXT) AS id,
         eco.stream_id AS stream_id,
         p.title, p.subtitle, p.description, p.start, p.end, tc.source_id AS source_id
       FROM epg_channel_overrides eco
       JOIN channels tc ON tc.stream_id = eco.stream_id
       JOIN channels sc ON ${carrier}
       JOIN programs p ON p.stream_id = sc.stream_id
       WHERE (tc.source_id = $1 OR sc.source_id = $1)
         AND ${pinSql}
         AND p.end >= ${ALIGN_GUIDE_CUTOFF_SQL}
       GROUP BY eco.stream_id, p.start`;

  return {
    deleteProgramsSql: `DELETE FROM programs
       WHERE stream_id IN (
         SELECT eco.stream_id FROM epg_channel_overrides eco
         JOIN channels tc ON tc.stream_id = eco.stream_id
         JOIN channels sc ON ${alignCarrierSql('id')}
         WHERE ${touched}
           AND ${carrierExists}
         UNION
         SELECT eco.stream_id FROM epg_channel_overrides eco
         JOIN channels tc ON tc.stream_id = eco.stream_id
         JOIN channels sc ON ${alignCarrierSql('name')}
         WHERE ${touched}
           AND ${carrierExists}
       )`,
    insertByIdSql: insert(alignCarrierSql('id')),
    insertByNameSql: insert(alignCarrierSql('name')),
  };
}

/** A channel whose guide is pinned to a *different* feed than its own source. */
type CrossFeedPinTarget = {
  stream_id: string;
  channel_name: string | null;
  channel_source: string;
  match_key: string | null;
  pin: string;
  rows_now: number;
  end_now: string | null;
};

/**
 * Cross-feed pin targets this alignment touches, in either direction: channels of
 * this source pinned elsewhere, and other sources' channels pinned to this feed.
 * Restricted to real pins, so a library with thousands of plain tvg-id overrides
 * pays one small existence check and nothing more.
 */
async function readFeedLockedTargets(
  feedRef: string,
  direction: 'source' | 'link'
): Promise<CrossFeedPinTarget[]> {
  try {
    const dbInstance = await (db as any).dbPromise;

    const anyPins = (await selectWithRetry(
      dbInstance,
      `SELECT EXISTS(SELECT 1 FROM epg_channel_overrides
                      WHERE epg_source_id IS NOT NULL AND TRIM(epg_source_id) != '') AS has_pins`,
      []
    )) as { has_pins: number }[];
    if (!anyPins[0]?.has_pins) return [];

    // A source's sync serves pins in both directions (its own channels pinned
    // elsewhere, and other sources' channels pinned to it). A link's pass serves
    // exactly the pins naming that link.
    const scope =
      direction === 'source'
        ? `(tc.source_id = $1 OR eco.epg_source_id = $1)`
        : `eco.epg_source_id = $1`;

    return (await selectWithRetry(
      dbInstance,
      `SELECT eco.stream_id AS stream_id,
              tc.name AS channel_name,
              tc.source_id AS channel_source,
              eco.epg_channel_id AS match_key,
              eco.epg_source_id AS pin,
              (SELECT COUNT(*) FROM programs p WHERE p.stream_id = eco.stream_id) AS rows_now,
              (SELECT MAX(p.end) FROM programs p WHERE p.stream_id = eco.stream_id) AS end_now
         FROM epg_channel_overrides eco
         JOIN channels tc ON tc.stream_id = eco.stream_id
        WHERE eco.epg_source_id IS NOT NULL AND TRIM(eco.epg_source_id) != ''
          AND eco.epg_source_id != tc.source_id
          AND ${scope}`,
      [feedRef]
    )) as CrossFeedPinTarget[];
  } catch (err) {
    console.warn('[Sync] Could not read feed-locked EPG pins:', err);
    return [];
  }
}

/** Feed-locked targets a source's sync serves, in either direction. */
function readCrossFeedPinTargets(sourceId: string): Promise<CrossFeedPinTarget[]> {
  return readFeedLockedTargets(sourceId, 'source');
}

/** Channels locked to one global EPG link — the only targets its pass writes. */
function readLinkFeedLockedTargets(linkId: string): Promise<CrossFeedPinTarget[]> {
  return readFeedLockedTargets(globalEpgPinRef(linkId), 'link');
}

/**
 * Report what a global EPG link's pass did to the channels locked to it. The
 * link's Rust pass includes those channels even when they already have guide
 * data (they are never "covered" for their own feed), so this is where a pinned
 * channel's refresh is visible without querying the database afterwards.
 */
function logLinkPinRefresh(
  linkName: string,
  before: CrossFeedPinTarget[],
  after: CrossFeedPinTarget[],
  inserted: number | null
): void {
  if (before.length === 0 && after.length === 0) return;

  const toId = (ref: string) => (ref.length > 8 ? `${ref.slice(0, 8)}…` : ref);
  const beforeByStream = new Map(before.map((t) => [t.stream_id, t]));

  debugLog(
    `[Sync] Link ${linkName}: ${after.length} channel(s) feed-locked to it; ` +
      `inserted ${inserted ?? '?'} program(s) for its attached sources`,
    'epg'
  );
  for (const t of after.slice(0, 20)) {
    const was = beforeByStream.get(t.stream_id);
    debugLog(
      `[Sync]   ${t.channel_name ?? t.stream_id} (${toId(t.channel_source)}): ` +
        `rows ${was?.rows_now ?? '?'} → ${t.rows_now}, guide ends ${was?.end_now ?? '?'} → ${t.end_now ?? 'nowhere'}`,
      'epg'
    );
  }
  if (after.length > 20) {
    debugLog(`[Sync]   …and ${after.length - 20} more channel(s) locked to this link`, 'epg');
  }
}

/**
 * Report what this alignment did to channels pinned to another feed. Those are
 * the only targets the pin-aware wipe spares, so the log is where "did the
 * pinned channel get replaced by the feed that owns it" can be answered without
 * querying the database afterwards.
 */
function logCrossFeedPinAlignment(
  sourceId: string,
  before: CrossFeedPinTarget[],
  after: CrossFeedPinTarget[],
  unservableFeeds: string[],
  affected: { deleted: number | null; insertedById: number | null; insertedByName: number | null }
): void {
  if (before.length === 0 && after.length === 0) return;

  const toId = (ref: string) => (ref.length > 8 ? `${ref.slice(0, 8)}…` : ref);
  const beforeByStream = new Map(before.map((t) => [t.stream_id, t]));

  debugLog(
    `[Sync] Feed-locked channels for source ${toId(sourceId)}: ${after.length} target(s); ` +
      `deleted ${affected.deleted ?? '?'} row(s), inserted ${affected.insertedById ?? '?'} by tvg-id ` +
      `+ ${affected.insertedByName ?? '?'} by name`,
    'epg'
  );
  for (const t of after.slice(0, 20)) {
    const was = beforeByStream.get(t.stream_id);
    const pin = t.pin.startsWith('global_epg_') ? `global link ${toId(t.pin.slice(11))}` : toId(t.pin);
    const unservable = unservableFeeds.includes(t.pin) ? ' [pin unservable — ignored]' : '';
    debugLog(
      `[Sync]   ${t.channel_name ?? t.stream_id} (${toId(t.channel_source)}) pinned to ${pin}${unservable}: ` +
        `rows ${was?.rows_now ?? '?'} → ${t.rows_now}, guide ends ${was?.end_now ?? '?'} → ${t.end_now ?? 'nowhere'} ` +
        `(match key ${t.match_key ?? 'name'})`,
      'epg'
    );
  }
  if (after.length > 20) {
    debugLog(`[Sync]   …and ${after.length - 20} more feed-locked channel(s)`, 'epg');
  }
}

export async function alignOverriddenChannelPrograms(sourceId: string): Promise<void> {
  try {
    const dbInstance = await (db as any).dbPromise;

    // Check if there are any overrides that target or are sourced by this source ID.
    // EXISTS short-circuits on the first match, unlike COUNT(*) over a deduped UNION.
    const existsResult = await selectWithRetry(
      dbInstance,
      `SELECT
         EXISTS(SELECT 1 FROM epg_channel_overrides eco
                JOIN channels tc ON tc.stream_id = eco.stream_id
                JOIN channels sc ON sc.epg_channel_id = eco.epg_channel_id AND sc.stream_id != eco.stream_id
                WHERE tc.source_id = $1 OR sc.source_id = $1)
         OR
         EXISTS(SELECT 1 FROM epg_channel_overrides eco
                JOIN channels tc ON tc.stream_id = eco.stream_id
                JOIN channels sc ON sc.name = eco.epg_channel_id AND sc.stream_id != eco.stream_id
                WHERE tc.source_id = $1 OR sc.source_id = $1) AS has_overrides`,
      [sourceId]
    ) as { has_overrides: number }[];
    
    if (!existsResult[0]?.has_overrides) {
      debugLog(`[Sync] Skipping bulk EPG alignment for source: ${sourceId} (no overrides)`, 'epg');
      return;
    }

    // Pins the alignment must not honour, resolved after the bail-out above so a
    // source with nothing to align pays nothing for them. One resolution serves
    // all three statements below (they share `$1`, so the feed refs are `$2…$n`).
    const { unservableFeeds } = await loadServableFeedPins();
    const pinMatch = alignPinMatches(unservableFeeds);

    const start = performance.now();
    debugLog(`[Sync] Starting bulk EPG alignment for source: ${sourceId}...`, 'epg');

    // Cross-feed pins this source can serve, read before and after so the log
    // shows whether a feed-locked channel's guide was replaced, not just that
    // rows moved somewhere. Empty (and cheap) for a library without pins.
    const pinnedBefore = await readCrossFeedPinTargets(sourceId);

    // 1 & 2. Delete the target channels' rows and refill them from their guide
    // carrier (see `buildAlignmentStatements`: the delete claims only the rows the
    // inserts are about to write, and the two INSERTs are kept index-friendly and
    // separate to avoid an unindexed OR join blocking the DB).
    const { deleteProgramsSql, insertByIdSql, insertByNameSql } = buildAlignmentStatements(pinMatch.sql);
    const alignParams = [sourceId, ...pinMatch.params];

    const deletedResult = await executeWithRetry(dbInstance, deleteProgramsSql, alignParams);

    // Step 2a: Match by epg_channel_id (uses idx_channels_epg index)
    const insertedByIdResult = await executeWithRetry(dbInstance, insertByIdSql, alignParams);

    // Step 2b: Match by name fallback (uses idx_channels_name index)
    const insertedByNameResult = await executeWithRetry(dbInstance, insertByNameSql, alignParams);
    
    // Report the feed-locked targets while the alignment's effect is still
    // attributable to this source, before anything else writes rows.
    const pinnedAfter = await readCrossFeedPinTargets(sourceId);
    logCrossFeedPinAlignment(sourceId, pinnedBefore, pinnedAfter, unservableFeeds, {
      deleted: deletedResult?.rowsAffected ?? null,
      insertedById: insertedByIdResult?.rowsAffected ?? null,
      insertedByName: insertedByNameResult?.rowsAffected ?? null,
    });

    const alignmentMs = performance.now() - start;
    // Track the slowest alignment of the run for the per-run timing summary.
    lastRunAlignmentMaxMs = Math.max(lastRunAlignmentMaxMs, alignmentMs);
    debugLog(`[Sync] Bulk EPG alignment complete in ${alignmentMs.toFixed(2)}ms`, 'epg');
    const { dbEvents } = await import('./sqlite-adapter');
    dbEvents.notify('programs', 'clear');
    dbEvents.notify('programs', 'add');
  } catch (err) {
    console.error('[Sync] Failed to align overridden channel programs:', err);
  }
}
