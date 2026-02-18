import { db, clearSourceData, clearVodData, type SourceMeta, type StoredProgram, type StoredMovie, type StoredSeries, type StoredEpisode, type VodCategory } from './index';
import { fetchAndParseM3U, XtreamClient, StalkerClient, type XmltvProgram } from '@ynotv/local-adapter';
import type { Source, Channel, Category, Movie, Series } from '@ynotv/core';
import { useUIStore } from '../stores/uiStore';
import { bulkOps, type BulkChannel, type BulkCategory } from '../services/bulk-ops';
import { epgStreaming, type EpgProgressCallback } from '../services/epg-streaming';
import { dbEvents } from './sqlite-adapter';
import { matchAllMoviesLazy, matchAllSeriesLazy } from '../services/title-match';

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { compressEpgDescription, decompressEpgDescription } from '../utils/compression';

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
  '_stalker_category', 'cover', 'plot', 'cast', 'director', 'genre',
  'releaseDate', 'rating', 'youtube_trailer', 'episode_run_time',
  'title', 'last_modified', 'year', 'stream_type'
];

function sanitizeMovie(movie: any, existingMovie?: any): any {
  const clean: any = {};

  // 1. Map known aliases/mismatches and apply defaults
  clean.added = existingMovie?.added ? (existingMovie.added instanceof Date ? existingMovie.added.toISOString() : existingMovie.added) : new Date().toISOString();
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

  return clean;
}

function sanitizeSeries(series: any, existingSeries?: any): any {
  const clean: any = {};

  // 1. Map known aliases/mismatches and apply defaults
  clean.added = existingSeries?.added ? (existingSeries.added instanceof Date ? existingSeries.added.toISOString() : existingSeries.added) : new Date().toISOString();
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

  return clean;
}

const MAX_COMPRESSED_SIZE_MB = 50;   // Max 50MB compressed (~500MB uncompressed)
const MAX_COMPRESSED_BYTES = MAX_COMPRESSED_SIZE_MB * 1024 * 1024;

// EPG Parser Web Worker - handles decompression and parsing off main thread
let epgWorker: Worker | null = null;
let epgWorkerIdCounter = 0;
const epgWorkerCallbacks = new Map<number, { resolve: (programs: XmltvProgram[]) => void; reject: (err: Error) => void }>();

function getEpgWorker(): Worker {
  if (!epgWorker) {
    epgWorker = new Worker(new URL('../workers/epg-parser.worker.ts', import.meta.url), { type: 'module' });
    epgWorker.onmessage = (event) => {
      const { type, id, programs, error } = event.data;
      const callback = epgWorkerCallbacks.get(id);
      if (callback) {
        epgWorkerCallbacks.delete(id);
        if (type === 'result') {
          callback.resolve(programs || []);
        } else {
          callback.reject(new Error(error || 'Worker error'));
        }
      }
    };
    epgWorker.onerror = (err) => {
      debugLog(`EPG Worker error: ${err.message}`, 'epg');
      // Reject all pending callbacks - worker is dead
      for (const [, callback] of epgWorkerCallbacks) {
        callback.reject(new Error(`EPG Worker crashed: ${err.message}`));
      }
      epgWorkerCallbacks.clear();
      epgWorker = null; // Force recreation on next use
    };
  }
  return epgWorker;
}

// Convert string to Uint8Array in chunks (avoids blocking for large strings)
async function stringToBufferChunked(str: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const CHUNK_SIZE = 1_000_000; // 1MB chunks

  if (str.length <= CHUNK_SIZE) {
    return encoder.encode(str);
  }

  // For large strings, encode in chunks with yields
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < str.length; i += CHUNK_SIZE) {
    const chunk = str.slice(i, i + CHUNK_SIZE);
    chunks.push(encoder.encode(chunk));
    // Yield to event loop
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Combine chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}



// ... existing imports

// ...

// Parse EPG data using Web Worker (off main thread)
// Uses Transferable for large data to avoid blocking structured clone
async function parseEpgInWorker(data: string | Uint8Array, isGzipped: boolean): Promise<XmltvProgram[]> {
  return new Promise(async (resolve, reject) => {
    const id = ++epgWorkerIdCounter;
    epgWorkerCallbacks.set(id, { resolve, reject });

    if (data instanceof Uint8Array) {
      getEpgWorker().postMessage(
        { type: 'parse', id, buffer: data, isGzipped, isBuffer: true },
        [data.buffer]
      );
      return;
    }

    // For large data, convert to ArrayBuffer and transfer (avoids copy)
    if (data.length > 1_000_000) { // > 1MB
      debugLog(`Large EPG data (${Math.round(data.length / 1024 / 1024)}MB), using chunked transfer...`, 'epg');
      const buffer = await stringToBufferChunked(data);
      getEpgWorker().postMessage(
        { type: 'parse', id, buffer, isGzipped, isBuffer: true },
        [buffer.buffer] // Transfer ownership
      );
    } else {
      getEpgWorker().postMessage({ type: 'parse', id, data, isGzipped });
    }
  });
}

// Fetch XMLTV from a single URL and parse it (parsing happens in worker)
async function fetchXmltvFromUrl(epgUrl: string): Promise<XmltvProgram[]> {
  const url = epgUrl.trim();
  debugLog(`Fetching XMLTV from: ${url}`, 'epg');

  if (!window.fetchProxy) {
    throw new Error('fetchProxy not available');
  }

  // Handle gzipped files
  if (url.endsWith('.gz')) {
    debugLog('Detected gzipped file, fetching binary...', 'epg');
    const response = await window.fetchProxy.fetchBinary(url);
    if (!response.data) {
      throw new Error(`Failed to fetch gzipped XMLTV: ${response.error || 'unknown error'}`);
    }

    // Check compressed size before processing (large files freeze UI)
    const estimatedCompressedSize = Math.floor(response.data.length * 0.75);
    if (estimatedCompressedSize > MAX_COMPRESSED_BYTES) {
      const sizeMB = Math.round(estimatedCompressedSize / 1024 / 1024);
      debugLog(`Skipping oversized EPG file: ${sizeMB}MB (max ${MAX_COMPRESSED_SIZE_MB}MB) - ${url}`, 'epg');
      throw new Error(`EPG file too large (${sizeMB}MB). Use a regional EPG instead of ALL_SOURCES.`);
    }

    debugLog(`Received ${response.data.length} bytes (base64), sending to worker for decompression...`, 'epg');
    const programs = await parseEpgInWorker(response.data, true);
    debugLog(`Worker parsed ${programs.length} programs`, 'epg');
    return programs;
  } else {
    const response = await window.fetchProxy.fetch(url);
    if (!response.data?.ok) {
      throw new Error(`Failed to fetch XMLTV: ${response.data?.status || 'unknown error'}`);
    }
    debugLog(`Received ${response.data.text.length} bytes, sending to worker for parsing...`, 'epg');
    const programs = await parseEpgInWorker(response.data.text, false);
    debugLog(`Worker parsed ${programs.length} programs`, 'epg');
    return programs;
  }
}

// Fetch XMLTV from potentially multiple URLs (comma-separated)
async function fetchXmltvFromUrls(epgUrlStr: string): Promise<XmltvProgram[]> {
  // Split by comma and trim each URL
  const urls = epgUrlStr.split(',').map(u => u.trim()).filter(u => u.length > 0);

  if (urls.length === 0) {
    return [];
  }

  if (urls.length === 1) {
    return fetchXmltvFromUrl(urls[0]);
  }

  // Multiple URLs - fetch in parallel batches to avoid overwhelming servers
  // Yields to event loop between batches to keep UI responsive
  debugLog(`Found ${urls.length} EPG URLs, fetching in parallel batches...`, 'epg');
  const BATCH_SIZE = 5;
  const allResults: XmltvProgram[][] = [];

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    debugLog(`Fetching batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(urls.length / BATCH_SIZE)} (${batch.length} URLs)`, 'epg');

    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          return await fetchXmltvFromUrl(url);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          debugLog(`Failed to fetch from ${url}: ${errMsg}`, 'epg');
          return []; // Return empty array on failure, continue with others
        }
      })
    );

    // Collect results without spreading (faster)
    for (const r of results) {
      if (r.length > 0) allResults.push(r);
    }

    // Yield to event loop between batches to keep UI responsive
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Flatten at the end (single operation)
  const allPrograms = allResults.flat();
  debugLog(`Total programs from all EPG sources: ${allPrograms.length}`, 'epg');
  return allPrograms;
}

// Sync EPG from XMLTV URL(s) for M3U sources using streaming parser
async function syncEpgFromUrl(
  source: Source,
  epgUrl: string,
  channels: Channel[],
  onProgress?: EpgProgressCallback
): Promise<number> {
  debugLog(`Starting M3U EPG sync with streaming parser`, 'epg');

  try {
    // Create channel mappings for Rust parser
    const channelMappings = channels
      .filter((ch) => ch.epg_channel_id)
      .map((ch) => ({
        epg_channel_id: ch.epg_channel_id!,
        stream_id: ch.stream_id,
      }));

    debugLog(
      `${channelMappings.length}/${channels.length} channels have epg_channel_id`,
      'epg'
    );

    if (channelMappings.length === 0) {
      debugLog('No channels with EPG IDs, skipping EPG sync', 'epg');
      return 0;
    }

    // Use streaming EPG parser
    const result = await epgStreaming.streamParseEpg(
      source.id,
      epgUrl,
      channelMappings,
      onProgress
        ? (progress) => {
          debugLog(epgStreaming.formatProgress(progress), 'epg');
          onProgress(progress);
        }
        : undefined
    );

    debugLog(
      `Matched ${result.matched_programs}/${result.total_programs} programs (${result.unmatched_channels} unmatched EPG channels)`,
      'epg'
    );

    if (result.inserted_programs === 0) {
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

    debugLog(
      `M3U EPG sync complete: ${result.inserted_programs} programs stored in ${result.duration_ms}ms`,
      'epg'
    );
    return result.inserted_programs;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    debugLog(`M3U EPG sync FAILED: ${errMsg}`, 'epg');
    // Fallback to legacy method if streaming fails
    debugLog('Falling back to legacy EPG sync method', 'epg');
    return syncEpgFromUrlLegacy(source, epgUrl, channels);
  }
}

// Legacy EPG sync method (fallback)
async function syncEpgFromUrlLegacy(
  source: Source,
  epgUrl: string,
  channels: Channel[]
): Promise<number> {
  debugLog(`Starting legacy M3U EPG sync`, 'epg');

  try {
    const xmltvPrograms = await fetchXmltvFromUrls(epgUrl);

    if (xmltvPrograms.length === 0) {
      debugLog('No programs found in XMLTV, keeping existing data', 'epg');
      return 0;
    }

    // Build a map of epg_channel_id -> stream_id for matching
    const channelMap = new Map<string, string>();
    let channelsWithEpgId = 0;
    for (const ch of channels) {
      if (ch.epg_channel_id) {
        channelMap.set(ch.epg_channel_id, ch.stream_id);
        channelsWithEpgId++;
      }
    }
    debugLog(
      `${channelsWithEpgId}/${channels.length} channels have epg_channel_id`,
      'epg'
    );

    // Convert XMLTV programs to stored format
    const storedPrograms: StoredProgram[] = [];
    const unmatchedChannels = new Set<string>();

    for (const prog of xmltvPrograms) {
      const streamId = channelMap.get(prog.channel_id);
      if (streamId) {
        storedPrograms.push({
          id: `${source.id}-${streamId}-${prog.start.getTime()}`,
          stream_id: streamId,
          title: prog.title,
          description: prog.description,
          start: prog.start,
          end: prog.stop,
          source_id: source.id,
        });
      } else {
        unmatchedChannels.add(prog.channel_id);
      }
    }

    debugLog(
      `Matched ${storedPrograms.length}/${xmltvPrograms.length} programs`,
      'epg'
    );

    if (storedPrograms.length === 0) {
      debugLog(
        'WARNING: No programs matched! Keeping existing EPG data',
        'epg'
      );
      return 0;
    }

    // Store programs using optimized bulk operation
    const bulkPrograms = storedPrograms.map((p) => ({
      id: p.id,
      stream_id: p.stream_id,
      title: p.title,
      description:
        p.description?.length > 2000
          ? p.description.substring(0, 2000)
          : p.description || '',
      start: p.start instanceof Date ? p.start.toISOString() : p.start,
      end: p.end instanceof Date ? p.end.toISOString() : p.end,
      source_id: p.source_id,
    }));

    await bulkOps.replacePrograms(source.id, bulkPrograms);

    debugLog(
      `Legacy M3U EPG sync complete: ${storedPrograms.length} programs stored`,
      'epg'
    );
    return storedPrograms.length;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    debugLog(`Legacy M3U EPG fetch FAILED: ${errMsg}`, 'epg');
    return 0;
  }
}

// Sync EPG for Xtream source using built-in endpoint
async function syncEpgForSource(source: Source, channels: Channel[], epgUrl?: string): Promise<number> {
  if (!source.username || !source.password) return 0;

  debugLog(`Starting EPG sync for source: ${source.name || source.id}`, 'epg');
  if (epgUrl) {
    debugLog(`Using EPG URL: ${epgUrl}`, 'epg');
  }

  // Use the provided EPG URL or construct from source.url
  const xmltvUrl = epgUrl || `${source.url}/xmltv.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
  debugLog(`Fetching XMLTV from: ${xmltvUrl}`, 'epg');

  try {
    // Fetch full XMLTV data using the same method as M3U sources
    const xmltvPrograms = await fetchXmltvFromUrls(xmltvUrl);
    debugLog(`Received ${xmltvPrograms.length} programs from XMLTV`, 'epg');

    if (xmltvPrograms.length === 0) {
      debugLog('No programs found in XMLTV, keeping existing data', 'epg');
      return 0;
    }

    // Build a map of epg_channel_id -> stream_id for matching
    const channelMap = new Map<string, string>();
    let channelsWithEpgId = 0;
    for (const ch of channels) {
      if (ch.epg_channel_id) {
        channelMap.set(ch.epg_channel_id, ch.stream_id);
        channelsWithEpgId++;
      }
    }
    debugLog(`${channelsWithEpgId}/${channels.length} channels have epg_channel_id`, 'epg');

    // Convert XMLTV programs to stored format
    const storedPrograms: StoredProgram[] = [];
    const unmatchedChannels = new Set<string>();

    for (const prog of xmltvPrograms) {
      const streamId = channelMap.get(prog.channel_id);
      if (streamId) {
        storedPrograms.push({
          id: `${streamId}_${prog.start.getTime()}`,
          stream_id: streamId,
          title: prog.title,
          description: compressEpgDescription(prog.description) ?? '',
          start: prog.start,
          end: prog.stop,
          source_id: source.id,
        });
      } else {
        unmatchedChannels.add(prog.channel_id);
      }
    }

    debugLog(`Matched ${storedPrograms.length}/${xmltvPrograms.length} programs (${unmatchedChannels.size} unmatched EPG channels)`, 'epg');

    // SAFETY: Only clear old data if we have new data to replace it
    if (storedPrograms.length === 0) {
      debugLog('WARNING: No programs matched! Keeping existing EPG data to avoid data loss', 'epg');
      return 0;
    }

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

    await bulkOps.replacePrograms(source.id, bulkPrograms);

    debugLog(`EPG sync complete: ${storedPrograms.length} programs stored`, 'epg');
    return storedPrograms.length;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    debugLog(`EPG fetch FAILED: ${errMsg}`, 'epg');
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

  debugLog(`Starting EPG sync for Stalker source: ${source.name || source.id}`, 'epg');

  const client = new StalkerClient(
    { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
    source.id
  );

  try {
    // Fetch EPG data (72 hours by default)
    debugLog('Fetching EPG data from Stalker portal...', 'epg');
    const epgMap = await client.getEpg(72);
    debugLog(`Received EPG for ${epgMap.size} channels`, 'epg');

    if (epgMap.size === 0) {
      debugLog('No EPG data returned from Stalker portal, keeping existing data', 'epg');
      return 0;
    }

    // Convert Stalker EPG format to StoredProgram format
    const storedPrograms: StoredProgram[] = [];

    // Apply user-configured EPG timeshift (default to 0 if not set)
    const timeshiftHours = source.epg_timeshift_hours || 0;
    const timeshiftMs = timeshiftHours * 60 * 60 * 1000;

    for (const [channelId, programList] of epgMap.entries()) {
      for (const prog of programList) {
        // Apply timeshift offset to timestamps
        const startDate = new Date((prog.start_timestamp * 1000) + timeshiftMs);
        const stopDate = new Date((prog.stop_timestamp * 1000) + timeshiftMs);

        storedPrograms.push({
          id: `${channelId}_${prog.start_timestamp}`,
          stream_id: channelId,
          title: prog.name || '',
          description: prog.descr || '',
          start: startDate,
          end: stopDate,
          source_id: source.id,
        });
      }
    }

    debugLog(`Converted ${storedPrograms.length} programs from ${epgMap.size} channels`, 'epg');

    // SAFETY: Only clear old data if we have new data to replace it
    if (storedPrograms.length === 0) {
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

    await bulkOps.replacePrograms(source.id, bulkPrograms);

    debugLog(`Stalker EPG sync complete: ${storedPrograms.length} programs stored`, 'epg');
    return storedPrograms.length;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    debugLog(`Stalker EPG fetch FAILED: ${errMsg}`, 'epg');
    debugLog('Keeping existing EPG data', 'epg');
    return 0;
  }
}


// Check if EPG needs refresh
// refreshHours: 0 = manual only (never auto-stale), default 6 hours
export async function isEpgStale(sourceId: string, refreshHours: number = DEFAULT_EPG_STALE_HOURS): Promise<boolean> {
  // 0 means manual-only, never consider stale for auto-refresh
  if (refreshHours === 0) return false;

  const meta = await db.sourcesMeta.get(sourceId);
  if (!meta?.last_synced) return true;

  const staleMs = refreshHours * 60 * 60 * 1000;
  return Date.now() - new Date(meta.last_synced).getTime() > staleMs;
}

// Check if VOD needs refresh
// refreshHours: 0 = manual only (never auto-stale), default 24 hours
export async function isVodStale(sourceId: string, refreshHours: number = DEFAULT_VOD_STALE_HOURS): Promise<boolean> {
  // 0 means manual-only, never consider stale for auto-refresh
  if (refreshHours === 0) return false;

  const meta = await db.sourcesMeta.get(sourceId);
  if (!meta?.vod_last_synced) return true;

  // Force sync if counts are missing (indicates schema/sync corruption)
  if (meta.vod_movie_count === undefined || meta.vod_series_count === undefined) {
    debugLog(`Source ${sourceId} VOD counts missing, forcing sync`, 'vod');
    return true;
  }

  const staleMs = refreshHours * 60 * 60 * 1000;
  return Date.now() - new Date(meta.vod_last_synced).getTime() > staleMs;
}

// Sync a single source - fetches data and stores in SQLite
export async function syncSource(source: Source, onProgress?: (msg: string) => void): Promise<SyncResult> {
  debugLog(`Starting sync for source: ${source.name} (${source.type})`, 'sync');
  onProgress?.(`Starting sync for ${source.name}...`);
  const startTime = performance.now();
  console.time('sync-total');
  try {
    // Wait, we need to fetch settings BEFORE clearing data


    // 1. Fetch existing data for incremental sync
    debugLog(`Fetching existing data for incremental sync: ${source.id}`, 'sync');
    onProgress?.('Checking existing data...');

    // Get existing categories to preserve settings
    const existingCategories = await db.categories.where('source_id').equals(source.id).toArray();
    const categorySettingsMap = new Map(existingCategories.map(c => [
      c.category_id,
      { enabled: c.enabled, display_order: c.display_order }
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

    if (source.type === 'm3u') {
      // M3U source - fetch and parse
      debugLog(`Fetching M3U from: ${source.url}`, 'sync');
      onProgress?.('Fetching M3U playlist...');
      const result = await fetchAndParseM3U(source.url, source.id, source.user_agent);
      channels = result.channels;
      categories = result.categories;
      epgUrl = result.epgUrl ?? undefined;
      debugLog(`M3U parsed: ${channels.length} channels, ${categories.length} categories`, 'sync');
    } else if (source.type === 'xtream') {
      // Xtream source - use client
      if (!source.username || !source.password) {
        throw new Error('Xtream source requires username and password');
      }

      debugLog(`Initializing Xtream client for: ${source.url} (UA: ${source.user_agent || 'none'})`, 'sync');
      onProgress?.('Connecting to Xtream server...');
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
        throw new Error(connTest.error ?? 'Connection failed');
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
      onProgress?.('Fetching categories...');
      categories = await client.getLiveCategories();
      debugLog(`Got ${categories.length} categories`, 'sync');

      debugLog('Fetching live streams...', 'sync');
      onProgress?.('Fetching channels...');
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
        throw new Error('Stalker Portal requires a MAC address');
      }

      debugLog(`Initializing Stalker client for: ${source.url}`, 'sync');
      onProgress?.('Connecting to Stalker portal...');
      const client = new StalkerClient(
        { baseUrl: source.url, mac: source.mac, userAgent: source.user_agent },
        source.id
      );

      debugLog('Testing Stalker connection...', 'sync');
      const connTest = await client.testConnection();
      if (!connTest.success) {
        throw new Error(connTest.error ?? 'Connection failed');
      }

      // Fetch account info to get expiry date
      debugLog('Fetching Stalker account info...', 'sync');
      const accountInfo = await client.getAccountInfo();
      const expiryDate = accountInfo.expiry;

      debugLog('Fetching Stalker live categories...', 'sync');
      onProgress?.('Fetching categories...');
      categories = await client.getLiveCategories();
      debugLog(`Got ${categories.length} categories`, 'sync');
      if (categories.length > 0) {
        debugLog(`First category: ${JSON.stringify(categories[0])}`, 'sync');
      }

      debugLog('Fetching Stalker live streams...', 'sync');
      onProgress?.('Fetching channels...');
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
      throw new Error(`Unsupported source type: ${source.type}`);
    }

    // Check if source was deleted during sync
    if (isSourceDeleted(source.id)) {
      debugLog(`Source ${source.id} was deleted during sync, skipping write`, 'sync');
      return { success: false, channelCount: 0, categoryCount: 0, programCount: 0, error: 'Source deleted' };
    }

    // Apply preserved settings to new data
    debugLog(`Applying preserved settings: ${favoriteChannelsSet.size} favorites, ${categorySettingsMap.size} category settings`, 'sync');
    onProgress?.('Applying settings...');

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
            display_order: settings.display_order
          };
        }
        return cat;
      });
    }

    // Incremental sync: Calculate changes
    debugLog(`Calculating incremental changes for ${channels.length} channels and ${categories.length} categories...`, 'sync');
    onProgress?.('Calculating changes...');

    // Find new and updated channels
    const newChannelIds = new Set(channels.map(c => c.stream_id));
    const channelsToAdd: any[] = [];
    const channelsToUpdate: any[] = [];

    for (const channel of channels) {
      const existing = existingChannelMap.get(channel.stream_id);
      if (!existing) {
        // New channel
        channelsToAdd.push(channel);
      } else {
        // Check if channel data changed (compare key fields)
        const hasChanged =
          existing.name !== channel.name ||
          existing.direct_url !== channel.direct_url ||
          JSON.stringify(existing.category_ids) !== JSON.stringify(channel.category_ids);

        if (hasChanged) {
          // Preserve user settings (favorites, etc.)
          channelsToUpdate.push({
            ...channel,
            is_favorite: existing.is_favorite,
            // Keep any other user-specific fields
          });
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
    const categoriesToUpdate: (Category & { enabled?: boolean; display_order?: number })[] = [];

    for (const cat of categories) {
      const existing = existingCategories.find(c => c.category_id === cat.category_id);
      if (!existing) {
        // New category
        categoriesToAdd.push(cat);
      } else if (existing.category_name !== cat.category_name) {
        // Existing category with different name - update while preserving user settings
        categoriesToUpdate.push({
          ...cat,
          enabled: existing.enabled,
          display_order: existing.display_order,
        });
      }
    }

    // Find deleted categories
    const categoriesToDelete = existingCategories
      .filter(c => !newCategoryIds.has(c.category_id))
      .map(c => c.category_id);

    debugLog(`Changes: ${channelsToAdd.length} new channels, ${channelsToUpdate.length} updated, ${channelsToDelete.length} deleted`, 'sync');
    debugLog(`Changes: ${categoriesToAdd.length} new categories, ${categoriesToUpdate.length} updated, ${categoriesToDelete.length} deleted`, 'sync');

    // Apply changes using optimized bulk operations
    onProgress?.('Applying changes...');

    // Convert to BulkChannel format for optimized Rust operations
    const convertToBulkChannel = (ch: any): BulkChannel => ({
      stream_id: ch.stream_id,
      source_id: ch.source_id,
      category_ids: Array.isArray(ch.category_ids)
        ? JSON.stringify(ch.category_ids)
        : ch.category_ids,
      name: ch.name,
      channel_num: ch.channel_num,
      is_favorite: ch.is_favorite ?? false,
      enabled: ch.enabled ?? true,
      stream_type: ch.stream_type,
      stream_icon: ch.stream_icon,
      epg_channel_id: ch.epg_channel_id,
      added: ch.added,
      custom_sid: ch.custom_sid,
      tv_archive: ch.tv_archive,
      direct_source: ch.direct_source,
      direct_url: ch.direct_url,
      xmltv_id: ch.xmltv_id,
      series_no: ch.series_no,
      live: ch.live,
    });

    // Convert to BulkCategory format
    const convertToBulkCategory = (cat: any): BulkCategory => ({
      category_id: cat.category_id,
      source_id: cat.source_id,
      category_name: cat.category_name,
      parent_id: cat.parent_id,
      enabled: cat.enabled ?? true,
      display_order: cat.display_order,
      channel_count: cat.channel_count,
      filter_words: Array.isArray(cat.filter_words)
        ? JSON.stringify(cat.filter_words)
        : cat.filter_words,
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

    // Store sync metadata
    const meta: SourceMeta = {
      source_id: source.id,
      epg_url: epgUrl,
      last_synced: new Date(),
      channel_count: channels.length,
      category_count: categories.length,
    };

    // Add Stalker-specific metadata
    if (source.type === 'stalker' && (source as any)._stalker_expiry) {
      meta.expiry_date = (source as any)._stalker_expiry;
    }

    // Add Xtream-specific metadata
    if (source.type === 'xtream') {
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

    // Update source metadata using optimized operation
    await bulkOps.updateSourceMeta({
      source_id: meta.source_id,
      epg_url: meta.epg_url,
      last_synced: meta.last_synced instanceof Date ? meta.last_synced.toISOString() : meta.last_synced,
      channel_count: meta.channel_count,
      category_count: meta.category_count,
      expiry_date: meta.expiry_date,
      active_cons: meta.active_cons,
      max_connections: meta.max_connections,
      error: meta.error,
    });
    debugLog('Channels and categories stored successfully', 'sync');

    // Fetch EPG if enabled
    let programCount = 0;
    const shouldLoadEpg = source.auto_load_epg ?? (source.type === 'xtream');

    if (shouldLoadEpg && source.type === 'xtream' && source.username && source.password) {
      // Xtream: use built-in EPG endpoint (or override if provided)
      debugLog('Syncing EPG for Xtream source...', 'epg');
      onProgress?.('Updating EPG...');
      console.time('sync-epg-insert');
      // Pass the correctly constructed EPG URL (with server info from connection test)
      programCount = await syncEpgForSource(source, channels, epgUrl);
      console.timeEnd('sync-epg-insert');
      debugLog(`EPG sync complete: ${programCount} programs`, 'epg');
    } else if (shouldLoadEpg && source.type === 'stalker' && source.mac) {
      // Stalker: use get_epg_info endpoint
      debugLog('Syncing EPG for Stalker source...', 'epg');
      onProgress?.('Updating EPG...');
      console.time('sync-epg-insert');
      programCount = await syncEpgForStalker(source, channels);
      console.timeEnd('sync-epg-insert');
      debugLog(`Stalker EPG sync complete: ${programCount} programs`, 'epg');
    } else if (shouldLoadEpg && epgUrl) {
      // M3U with EPG URL: fetch XMLTV from the EPG URL
      debugLog('Syncing EPG for M3U source...', 'epg');
      onProgress?.('Updating EPG...');
      console.time('sync-epg-insert');
      programCount = await syncEpgFromUrl(source, epgUrl, channels);
      console.timeEnd('sync-epg-insert');
      debugLog(`M3U EPG sync complete: ${programCount} programs`, 'epg');
    }

    // If user provided a manual EPG URL override, use that
    if (source.epg_url && !shouldLoadEpg) {
      debugLog('Syncing EPG from manual URL override...', 'epg');
      onProgress?.('Updating EPG (manual URL)...');
      console.time('sync-epg-manual');
      programCount = await syncEpgFromUrl(source, source.epg_url, channels);
      console.timeEnd('sync-epg-manual');
      debugLog(`Manual EPG sync complete: ${programCount} programs`, 'epg');
    }

    debugLog(`Sync complete for ${source.name}: ${channels.length} channels, ${categories.length} categories, ${programCount} programs`, 'sync');
    console.timeEnd('sync-total');
    debugLog(`Total sync time: ${((performance.now() - startTime) / 1000).toFixed(2)}s`, 'sync');
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
    throw new Error('Storage API not available');
  }

  const result = await window.storage.getSource(sourceId);
  const source = result.data;

  if (!source || source.type !== 'stalker' || !source.mac) {
    throw new Error('Invalid Stalker source');
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
    if (onProgress) onProgress(100, 'Saving to database...');

    await db.transaction('rw', [db.vodMovies, db.vodSeries], async () => {
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
            backdrop_path: item.backdrop_path || [],
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
    });

    debugLog(`[LazyLoad] Sync complete`, 'sync');
    return items.length;

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugLog(`[LazyLoad] Failed: ${msg}`, 'sync');
    throw e;
  }
}

// Sync all enabled sources
export async function syncAllSources(onProgress?: (msg: string) => void): Promise<Map<string, SyncResult>> {
  debugLog('Starting syncAllSources...', 'sync');
  onProgress?.('Initializing sync...');
  const results = new Map<string, SyncResult>();

  // Get sources from Tauri Store
  if (!window.storage) {
    debugLog('ERROR: Storage API not available', 'sync');
    throw new Error('Storage API not available');
  }

  debugLog('Fetching sources from storage...', 'sync');
  const sourcesResult = await window.storage.getSources();
  if (!sourcesResult.data) {
    debugLog(`ERROR: Failed to get sources: ${sourcesResult.error}`, 'sync');
    throw new Error(sourcesResult.error || 'Failed to get sources');
  }
  debugLog(`Found ${sourcesResult.data.length} sources`, 'sync');

  // Sync each enabled source with concurrency limit of 3
  const enabledSources = sourcesResult.data.filter(s => s.enabled);
  debugLog(`${enabledSources.length} sources enabled for sync`, 'sync');

  const CONCURRENCY_LIMIT = 5;

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
export async function syncVodMovies(source: Source): Promise<{ count: number; categoryCount: number; skipped?: boolean }> {
  if (!['xtream', 'stalker'].includes(source.type)) {
    return { count: 0, categoryCount: 0 };
  }

  // Fetch categories and movies FIRST (before any deletes)
  let categories: any[] = [];
  let movies: any[] = [];

  try {
    if (source.type === 'xtream') {
      if (!source.username || !source.password) return { count: 0, categoryCount: 0 };
      const client = new XtreamClient(
        { baseUrl: source.url, username: source.username, password: source.password, userAgent: source.user_agent },
        source.id
      );
      categories = await client.getVodCategories();
      movies = await client.getVodStreams();
    } else if (source.type === 'stalker') {
      if (!source.mac) return { count: 0, categoryCount: 0 };
      const client = new StalkerClient(
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
    return { count: 0, categoryCount: 0, skipped: true };
  }

  // Check if fetch returned empty when we have existing data
  const existingCount = await db.vodMovies.where('source_id').equals(source.id).count();
  if (movies.length === 0 && existingCount > 0) {
    console.warn('[VOD Movies] Fetch returned empty but we have existing data, keeping it');
    return { count: existingCount, categoryCount: 0, skipped: true };
  }

  // Convert categories to VodCategory format
  const vodCategories: VodCategory[] = categories.map(cat => ({
    category_id: cat.category_id,
    source_id: source.id,
    name: cat.category_name,
    type: 'movie' as const,
  }));

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
      added: existing?.added ? (existing.added instanceof Date ? existing.added.toISOString() : existing.added) : new Date().toISOString(),
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
    container_extension: (movie as any).container_extension,
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

  return { count: storedMovies.length, categoryCount: vodCategories.length };
}

// Sync VOD series for a single source (Xtream or Stalker)
// Uses safe update pattern: fetch new data first, only update if successful
export async function syncVodSeries(source: Source): Promise<{ count: number; categoryCount: number; skipped?: boolean }> {
  if (!['xtream', 'stalker'].includes(source.type)) {
    return { count: 0, categoryCount: 0 };
  }

  // Fetch categories and series FIRST (before any deletes)
  let categories: any[] = [];
  let series: any[] = [];

  try {
    if (source.type === 'xtream') {
      if (!source.username || !source.password) return { count: 0, categoryCount: 0 };
      debugLog(`Initializing Xtream client (UA: ${source.user_agent || 'default'})`, 'sync');
      const client = new XtreamClient(
        { baseUrl: source.url, username: source.username, password: source.password, userAgent: source.user_agent },
        source.id
      );
      categories = await client.getSeriesCategories();
      series = await client.getSeries();
    } else if (source.type === 'stalker') {
      if (!source.mac) return { count: 0, categoryCount: 0 };
      debugLog(`Initializing Stalker client (UA: ${source.user_agent || 'default'})`, 'sync');
      const client = new StalkerClient(
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
    return { count: 0, categoryCount: 0, skipped: true };
  }

  // Check if fetch returned empty when we have existing data
  const existingCount = await db.vodSeries.where('source_id').equals(source.id).count();
  if (series.length === 0 && existingCount > 0) {
    console.warn('[VOD Series] Fetch returned empty but we have existing data, keeping it');
    return { count: existingCount, categoryCount: 0, skipped: true };
  }

  // Convert categories to VodCategory format
  const vodCategories: VodCategory[] = categories.map(cat => ({
    category_id: cat.category_id,
    source_id: source.id,
    name: cat.category_name,
    type: 'series' as const,
  }));

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
      added: existing?.added ? (existing.added instanceof Date ? existing.added.toISOString() : existing.added) : new Date().toISOString(),
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

  return { count: storedSeries.length, categoryCount: vodCategories.length };
}

// Sync episodes for a specific series (on-demand when user views series details)
export async function syncSeriesEpisodes(source: Source, seriesId: string): Promise<number> {
  // Support both Xtream and Stalker
  if (!['xtream', 'stalker'].includes(source.type)) {
    return 0;
  }

  let seasons: any[] = [];

  try {
    if (source.type === 'xtream') {
      if (!source.username || !source.password) return 0;
      const client = new XtreamClient(
        { baseUrl: source.url, username: source.username, password: source.password },
        source.id
      );
      seasons = await client.getSeriesInfo(seriesId);
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

  // Store episodes
  await db.transaction('rw', [db.vodEpisodes], async () => {
    // Clear existing episodes for this series
    await db.vodEpisodes.where('series_id').equals(seriesId).delete();

    if (storedEpisodes.length > 0) {
      await db.vodEpisodes.bulkPut(storedEpisodes);
    }
  });

  return storedEpisodes.length;
}

// Sync all VOD content for a source
export async function syncVodForSource(source: Source): Promise<VodSyncResult> {
  try {
    const [moviesResult, seriesResult] = await Promise.all([
      syncVodMovies(source),
      syncVodSeries(source),
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

  // Get enabled VOD sources (Xtream or Stalker)
  const vodSources = sourcesResult.data.filter(
    s => s.enabled && (s.type === 'xtream' || s.type === 'stalker')
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

  return results;
}

export async function enrichSourceMetadata(source?: Source, _force?: boolean) {
  startTmdbMatching();
  try {
    const [movieCount, seriesCount] = await Promise.all([
      matchAllMoviesLazy(),
      matchAllSeriesLazy(),
    ]);
    console.log(`[Lazy Match] Matched ${movieCount} movies, ${seriesCount} series`);
  } catch (error) {
    console.error('[Lazy Match] Error:', error);
  } finally {
    endTmdbMatching();
  }
}
