import { db, clearSourceData, clearVodData, type SourceMeta, type StoredProgram, type StoredMovie, type StoredSeries, type StoredEpisode, type VodCategory } from './index';
import { fetchAndParseM3U, XtreamClient, StalkerClient, type XmltvProgram } from '@sbtltv/local-adapter';
import type { Source, Channel, Category, Movie, Series } from '@sbtltv/core';
import { getEnrichedMovieExports, getEnrichedTvExports, findBestMatch, extractMatchParams } from '../services/tmdb-exports';
import { useUIStore } from '../stores/uiStore';

// Debug logging helper - logs to console and optionally to debug file
function debugLog(message: string, category = 'sync'): void {
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

// Parse EPG data using Web Worker (off main thread)
// Uses Transferable for large data to avoid blocking structured clone
async function parseEpgInWorker(data: string, isGzipped: boolean): Promise<XmltvProgram[]> {
  return new Promise(async (resolve, reject) => {
    const id = ++epgWorkerIdCounter;
    epgWorkerCallbacks.set(id, { resolve, reject });

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

// Sync EPG from XMLTV URL(s) for M3U sources
async function syncEpgFromUrl(source: Source, epgUrl: string, channels: Channel[]): Promise<number> {
  debugLog(`Starting M3U EPG sync`, 'epg');

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
    debugLog(`${channelsWithEpgId}/${channels.length} channels have epg_channel_id`, 'epg');

    // Convert XMLTV programs to stored format (yield periodically for large datasets)
    const storedPrograms: StoredProgram[] = [];
    const unmatchedChannels = new Set<string>();
    const YIELD_EVERY = 10000; // Yield every 10k items

    for (let i = 0; i < xmltvPrograms.length; i++) {
      const prog = xmltvPrograms[i];
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
      // Yield to event loop periodically
      if (i > 0 && i % YIELD_EVERY === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    debugLog(`Matched ${storedPrograms.length}/${xmltvPrograms.length} programs (${unmatchedChannels.size} unmatched EPG channels)`, 'epg');

    // SAFETY: Only clear old data if we have new data to replace it
    if (storedPrograms.length === 0) {
      debugLog('WARNING: No programs matched! Keeping existing EPG data to avoid data loss', 'epg');
      return 0;
    }

    // Clear old and store new
    debugLog('Clearing old EPG data and storing new...', 'epg');
    await db.programs.where('source_id').equals(source.id).delete();

    // Store in batches with yields to keep UI responsive
    const BATCH_SIZE = 500;
    for (let i = 0; i < storedPrograms.length; i += BATCH_SIZE) {
      const batch = storedPrograms.slice(i, i + BATCH_SIZE);
      await db.programs.bulkPut(batch);
      // Yield every few batches
      if ((i / BATCH_SIZE) % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    debugLog(`M3U EPG sync complete: ${storedPrograms.length} programs stored`, 'epg');
    return storedPrograms.length;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    debugLog(`M3U EPG fetch FAILED: ${errMsg}`, 'epg');
    return 0;
  }
}

// Sync EPG for Xtream source using built-in endpoint
async function syncEpgForSource(source: Source, channels: Channel[]): Promise<number> {
  if (!source.username || !source.password) return 0;

  debugLog(`Starting EPG sync for source: ${source.name || source.id}`, 'epg');

  const client = new XtreamClient(
    { baseUrl: source.url, username: source.username, password: source.password },
    source.id
  );

  try {
    // Fetch full XMLTV data FIRST (don't delete old data until we have new)
    debugLog('Fetching XMLTV data...', 'epg');
    const xmltvPrograms = await client.getXmltvEpg();
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
          description: prog.description,
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

    // Clear old and store new
    debugLog('Clearing old EPG data and storing new...', 'epg');
    await db.programs.where('source_id').equals(source.id).delete();

    // Store in batches
    const BATCH_SIZE = 1000;
    for (let i = 0; i < storedPrograms.length; i += BATCH_SIZE) {
      const batch = storedPrograms.slice(i, i + BATCH_SIZE);
      await db.programs.bulkPut(batch);
    }

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
    debugLog('Clearing old EPG data and storing new...', 'epg');
    await db.programs.where('source_id').equals(source.id).delete();

    // Store in batches
    const BATCH_SIZE = 1000;
    for (let i = 0; i < storedPrograms.length; i += BATCH_SIZE) {
      const batch = storedPrograms.slice(i, i + BATCH_SIZE);
      await db.programs.bulkPut(batch);
    }

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
  return Date.now() - meta.last_synced.getTime() > staleMs;
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
  return Date.now() - meta.vod_last_synced.getTime() > staleMs;
}

// Sync a single source - fetches data and stores in Dexie
export async function syncSource(source: Source, onProgress?: (msg: string) => void): Promise<SyncResult> {
  debugLog(`Starting sync for source: ${source.name} (${source.type})`, 'sync');
  onProgress?.(`Starting sync for ${source.name}...`);
  try {
    // Fetches used to happen here, but we now fetch earlier or let individual handlers do it
    // Wait, we need to fetch settings BEFORE clearing data

    // 1. Fetch existing settings to preserve
    debugLog(`Fetching existing settings to preserve for source: ${source.id}`, 'sync');
    onProgress?.('Preserving settings...');
    const existingCategories = await db.categories.where('source_id').equals(source.id).toArray();
    const categorySettingsMap = new Map(existingCategories.map(c => [
      c.category_id,
      { enabled: c.enabled, display_order: c.display_order }
    ]));

    const existingChannels = await db.channels.where('source_id').equals(source.id).filter(c => c.is_favorite === true).toArray();
    const favoriteChannelsSet = new Set(existingChannels.map(c => c.stream_id));

    // Clear existing data for this source first
    debugLog(`Clearing existing data for source: ${source.id}`, 'sync');
    onProgress?.('Clearing old data...');
    await clearSourceData(source.id);

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
        const { url, port } = connTest.info.server_info;
        // Xtream typically serves EPG at /xmltv.php
        epgUrl = `${url}:${port}/xmltv.php?username=${source.username}&password=${source.password}`;
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

    // Store channels and categories in Dexie
    debugLog(`Storing ${channels.length} channels and ${categories.length} categories in DB...`, 'sync');
    onProgress?.('Saving to database...');
    await db.transaction('rw', [db.channels, db.categories, db.sourcesMeta], async () => {
      if (channels.length > 0) {
        await db.channels.bulkPut(channels);
      }
      if (categories.length > 0) {
        await db.categories.bulkPut(categories);
      }

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

      await db.sourcesMeta.put(meta);
    });
    debugLog('Channels and categories stored successfully', 'sync');

    // Fetch EPG if enabled
    let programCount = 0;
    const shouldLoadEpg = source.auto_load_epg ?? (source.type === 'xtream');

    if (shouldLoadEpg && source.type === 'xtream' && source.username && source.password) {
      // Xtream: use built-in EPG endpoint (or override if provided)
      debugLog('Syncing EPG for Xtream source...', 'epg');
      onProgress?.('Updating EPG...');
      programCount = await syncEpgForSource(source, channels);
      debugLog(`EPG sync complete: ${programCount} programs`, 'epg');
    } else if (shouldLoadEpg && source.type === 'stalker' && source.mac) {
      // Stalker: use get_epg_info endpoint
      debugLog('Syncing EPG for Stalker source...', 'epg');
      onProgress?.('Updating EPG...');
      programCount = await syncEpgForStalker(source, channels);
      debugLog(`Stalker EPG sync complete: ${programCount} programs`, 'epg');
    } else if (shouldLoadEpg && epgUrl) {
      // M3U with EPG URL: fetch XMLTV from the EPG URL
      debugLog('Syncing EPG for M3U source...', 'epg');
      onProgress?.('Updating EPG...');
      programCount = await syncEpgFromUrl(source, epgUrl, channels);
      debugLog(`M3U EPG sync complete: ${programCount} programs`, 'epg');
    }

    // If user provided a manual EPG URL override, use that
    if (source.epg_url && !shouldLoadEpg) {
      debugLog('Syncing EPG from manual URL override...', 'epg');
      onProgress?.('Updating EPG (manual URL)...');
      programCount = await syncEpgFromUrl(source, source.epg_url, channels);
      debugLog(`Manual EPG sync complete: ${programCount} programs`, 'epg');
    }

    debugLog(`Sync complete for ${source.name}: ${channels.length} channels, ${categories.length} categories, ${programCount} programs`, 'sync');
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
        await db.sourcesMeta.put({
          source_id: source.id,
          last_synced: new Date(),
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

  // Sources are in Electron store, not Dexie
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
        // Cast to any to bypass strict type check for now, trusting the structure
        await db.vodMovies.bulkPut(items as any[]);
      } else {
        // Map Channel items to StoredSeries
        const seriesItems = items.map((item: any) => ({
          ...item,
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
          category_id: categoryId
        }));
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

  // Get sources from electron storage
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

  // Sync each enabled source
  const enabledSources = sourcesResult.data.filter(s => s.enabled);
  debugLog(`${enabledSources.length} sources enabled for sync`, 'sync');

  for (let i = 0; i < enabledSources.length; i++) {
    const source = enabledSources[i];
    const prefix = `[${i + 1}/${enabledSources.length}] ${source.name}`;

    debugLog(`Syncing source: ${source.name} (${source.type})`, 'sync');
    onProgress?.(`${prefix}: Starting...`);

    // Create a specific progress handler for this source
    const sourceProgress = (msg: string) => {
      onProgress?.(`${prefix}: ${msg}`);
    };

    const result = await syncSource(source, sourceProgress);
    results.set(source.id, result);
    debugLog(`Source ${source.name}: ${result.success ? 'OK' : 'FAILED'} - ${result.channelCount} channels, ${result.categoryCount} categories`, 'sync');
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
      const result = await client.getVods();
      categories = result.categories;
      movies = result.streams;
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

  // Get existing movies to preserve tmdb_id and other enrichments
  const existingMovies = await db.vodMovies.where('source_id').equals(source.id).toArray();
  const existingMap = new Map(existingMovies.map(m => [m.stream_id, m]));

  // Convert movies to StoredMovie format, preserving existing enrichments
  const storedMovies: StoredMovie[] = movies.map(movie => {
    const existing = existingMap.get(movie.stream_id);
    return {
      ...movie,
      // Preserve existing enrichments if present
      tmdb_id: existing?.tmdb_id,
      imdb_id: existing?.imdb_id,
      backdrop_path: existing?.backdrop_path,
      popularity: existing?.popularity,
      added: existing?.added ?? new Date(),
    };
  });

  // Store in batches - use bulkPut to upsert (no delete needed)
  const BATCH_SIZE = 500;

  await db.transaction('rw', [db.vodMovies, db.vodCategories], async () => {
    // Replace categories atomically (delete old, insert new)
    await db.vodCategories.where('source_id').equals(source.id).filter(c => c.type === 'movie').delete();
    if (vodCategories.length > 0) {
      await db.vodCategories.bulkPut(vodCategories);
    }

    // Upsert movies in batches
    for (let i = 0; i < storedMovies.length; i += BATCH_SIZE) {
      const batch = storedMovies.slice(i, i + BATCH_SIZE);
      await db.vodMovies.bulkPut(batch);
    }

    // Remove movies that no longer exist in source (optional cleanup)
    const newIds = new Set(movies.map(m => m.stream_id));
    const toRemove = existingMovies.filter(m => !newIds.has(m.stream_id)).map(m => m.stream_id);
    if (toRemove.length > 0) {
      await db.vodMovies.bulkDelete(toRemove);
      console.log(`[VOD Movies] Removed ${toRemove.length} movies no longer in source`);
    }
  });

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
      const result = await client.getSeries();
      categories = result.categories;
      series = result.streams;
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

  // Get existing series to preserve tmdb_id and other enrichments
  const existingSeries = await db.vodSeries.where('source_id').equals(source.id).toArray();
  const existingMap = new Map(existingSeries.map(s => [s.series_id, s]));

  // Convert series to StoredSeries format, preserving existing enrichments
  const storedSeries: StoredSeries[] = series.map(s => {
    const existing = existingMap.get(s.series_id);
    return {
      ...s,
      // Preserve existing enrichments if present
      tmdb_id: existing?.tmdb_id,
      imdb_id: existing?.imdb_id,
      backdrop_path: existing?.backdrop_path,
      popularity: existing?.popularity,
      added: existing?.added ?? new Date(),
    };
  });

  // Store in batches - use bulkPut to upsert (no delete needed)
  const BATCH_SIZE = 500;

  await db.transaction('rw', [db.vodSeries, db.vodCategories, db.vodEpisodes], async () => {
    // Replace categories atomically (delete old, insert new)
    await db.vodCategories.where('source_id').equals(source.id).filter(c => c.type === 'series').delete();
    if (vodCategories.length > 0) {
      await db.vodCategories.bulkPut(vodCategories);
    }

    // Upsert series in batches
    for (let i = 0; i < storedSeries.length; i += BATCH_SIZE) {
      const batch = storedSeries.slice(i, i + BATCH_SIZE);
      await db.vodSeries.bulkPut(batch);
    }

    // Remove series that no longer exist in source (and their episodes)
    const newIds = new Set(series.map(s => s.series_id));
    const toRemove = existingSeries.filter(s => !newIds.has(s.series_id)).map(s => s.series_id);
    if (toRemove.length > 0) {
      // Delete orphaned episodes first (they reference series_id)
      await db.vodEpisodes.where('series_id').anyOf(toRemove).delete();
      await db.vodSeries.bulkDelete(toRemove);
      console.log(`[VOD Series] Removed ${toRemove.length} series (and their episodes) no longer in source`);
    }
  });

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
      // Fetch the series to get the stored category
      const series = await db.vodSeries.get(seriesId);
      const category = series?._stalker_category;
      seasons = await client.getSeriesInfo(seriesId, category);
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

// Match movies against TMDB exports (no API calls!)
// Uses enriched data with year info for more accurate matching
// Only matches items that haven't been attempted yet (incremental)
// Only matches items that haven't been attempted yet (incremental)
// Only matches items that haven't been attempted yet (incremental)
async function matchMoviesWithTmdb(sourceId: string, force?: boolean): Promise<number> {
  try {
    // Check if matching is enabled
    if (window.storage) {
      const settings = await window.storage.getSettings();
      if (settings.data?.tmdbMatchingEnabled === false) {
        // console.log('[TMDB Match] Matching disabled by user setting');
        return 0;
      }

      // Check 24h timer (unless forced)
      if (!force) {
        const lastRun = settings.data?.lastTmdbMatch || 0;
        const now = Date.now();
        if (now - lastRun < 24 * 60 * 60 * 1000) {
          console.log(`[TMDB Match] Skipping export (last run ${(now - lastRun) / 1000 / 60 / 60}h ago)`);
          return 0;
        }
      }
    }

    // Get only movies that haven't been matched AND haven't been attempted
    // Query by source_id, filter for unmatched (tmdb_id undefined means not in compound index)
    console.time('[TMDB Match] Query unmatched');
    const movies = await db.vodMovies
      .where('source_id')
      .equals(sourceId)
      .filter(m => !m.tmdb_id && !m.match_attempted)
      .toArray();
    console.timeEnd('[TMDB Match] Query unmatched');

    if (movies.length === 0) {
      console.log('[TMDB Match] No new movies to match');
      return 0;
    }

    console.log('[TMDB Match] Starting movie matching with year-aware lookup...');
    console.time('[TMDB Match] Download exports');
    const exports = await getEnrichedMovieExports();
    console.timeEnd('[TMDB Match] Download exports');

    console.log(`[TMDB Match] Matching ${movies.length} new movies...`);
    console.time('[TMDB Match] Matching loop');

    let matched = 0;
    let yearMatched = 0;
    const BATCH_SIZE = 500;
    const now = new Date();

    for (let i = 0; i < movies.length; i += BATCH_SIZE) {
      const batch = movies.slice(i, i + BATCH_SIZE);
      const toUpdate: StoredMovie[] = [];

      for (const movie of batch) {
        // Extract title and year from movie data
        const { title, year } = extractMatchParams(movie);
        const match = findBestMatch(exports, title, year);

        if (match) {
          // Track if we matched on year specifically
          if (year && match.year === year) {
            yearMatched++;
          }
          toUpdate.push({
            ...movie,
            tmdb_id: match.id,
            popularity: match.popularity,
            match_attempted: now,
          });
          matched++;
        } else {
          // Mark as attempted even if no match found (prevents re-trying)
          toUpdate.push({
            ...movie,
            match_attempted: now,
          });
        }
      }

      // Bulk update - much faster than individual updates
      if (toUpdate.length > 0) {
        await db.vodMovies.bulkPut(toUpdate);
      }

      console.log(`[TMDB Match] Progress: ${Math.min(i + BATCH_SIZE, movies.length)}/${movies.length}`);
    }

    console.timeEnd('[TMDB Match] Matching loop');
    console.log(`[TMDB Match] Matched ${matched}/${movies.length} movies (${yearMatched} with exact year match)`);

    // Update last match timestamp
    if (window.storage) {
      await window.storage.updateSettings({ lastTmdbMatch: Date.now() });
    }

    return matched;
  } catch (error) {
    console.error('[TMDB Match] Movie matching failed:', error);
    return 0;
  }
}

// Match series against TMDB exports (no API calls!)
// Uses enriched data with year info for more accurate matching
// Only matches items that haven't been attempted yet (incremental)
// Only matches items that haven't been attempted yet (incremental)
// Only matches items that haven't been attempted yet (incremental)
async function matchSeriesWithTmdb(sourceId: string, force?: boolean): Promise<number> {
  try {
    // Check if matching is enabled
    if (window.storage) {
      const settings = await window.storage.getSettings();
      if (settings.data?.tmdbMatchingEnabled === false) {
        return 0;
      }

      // Check 24h timer (unless forced)
      if (!force) {
        const lastRun = settings.data?.lastTmdbMatch || 0;
        const now = Date.now();
        if (now - lastRun < 24 * 60 * 60 * 1000) {
          // Already logged by movie matcher usually, but good to check
          return 0;
        }
      }
    }

    // Get only series that haven't been matched AND haven't been attempted
    // Query by source_id, filter for unmatched
    console.time('[TMDB Match] Query unmatched series');
    const series = await db.vodSeries
      .where('source_id')
      .equals(sourceId)
      .filter(s => !s.tmdb_id && !s.match_attempted)
      .toArray();
    console.timeEnd('[TMDB Match] Query unmatched series');

    if (series.length === 0) {
      console.log('[TMDB Match] No new series to match');
      return 0;
    }

    console.log('[TMDB Match] Starting series matching with year-aware lookup...');
    console.time('[TMDB Match] Download TV exports');
    const exports = await getEnrichedTvExports();
    console.timeEnd('[TMDB Match] Download TV exports');

    console.log(`[TMDB Match] Matching ${series.length} new series...`);
    console.time('[TMDB Match] Series matching loop');

    let matched = 0;
    let yearMatched = 0;
    const BATCH_SIZE = 500;
    const now = new Date();

    for (let i = 0; i < series.length; i += BATCH_SIZE) {
      const batch = series.slice(i, i + BATCH_SIZE);
      const toUpdate: StoredSeries[] = [];

      for (const s of batch) {
        // Extract title and year from series data
        const { title, year } = extractMatchParams(s);
        const match = findBestMatch(exports, title, year);

        if (match) {
          // Track if we matched on year specifically
          if (year && match.year === year) {
            yearMatched++;
          }
          toUpdate.push({
            ...s,
            tmdb_id: match.id,
            popularity: match.popularity,
            match_attempted: now,
          });
          matched++;
        } else {
          // Mark as attempted even if no match found (prevents re-trying)
          toUpdate.push({
            ...s,
            match_attempted: now,
          });
        }
      }

      // Bulk update - much faster than individual updates
      if (toUpdate.length > 0) {
        await db.vodSeries.bulkPut(toUpdate);
      }

      console.log(`[TMDB Match] Progress: ${Math.min(i + BATCH_SIZE, series.length)}/${series.length}`);
    }

    console.timeEnd('[TMDB Match] Series matching loop');
    console.log(`[TMDB Match] Matched ${matched}/${series.length} series (${yearMatched} with exact year match)`);
    return matched;
  } catch (error) {
    console.error('[TMDB Match] Series matching failed:', error);
    return 0;
  }
}

// Sync all VOD content for a source
export async function syncVodForSource(source: Source): Promise<VodSyncResult> {
  try {
    const [moviesResult, seriesResult] = await Promise.all([
      syncVodMovies(source),
      syncVodSeries(source),
    ]);

    // Update source meta with VOD counts and sync timestamp
    const meta = await db.sourcesMeta.get(source.id);
    if (meta) {
      await db.sourcesMeta.update(source.id, {
        vod_movie_count: moviesResult.count,
        vod_series_count: seriesResult.count,
        vod_last_synced: new Date(),
      });
    } else {
      // Create meta if it doesn't exist (shouldn't happen, but be safe)
      await db.sourcesMeta.put({
        source_id: source.id,
        channel_count: 0,
        category_count: 0,
        vod_movie_count: moviesResult.count,
        vod_series_count: seriesResult.count,
        vod_last_synced: new Date(),
      });
    }

    // Match against TMDB exports (runs in background, no API calls)
    // Match against TMDB exports (runs in background, no API calls)
    enrichSourceMetadata(source, true); // Force matching on manual sync

    return {
      success: true,
      movieCount: moviesResult.count,
      seriesCount: seriesResult.count,
      movieCategoryCount: moviesResult.categoryCount,
      seriesCategoryCount: seriesResult.categoryCount,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
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

  // Sync VOD for each enabled source (Xtream or Stalker)
  for (const source of sourcesResult.data) {
    if (source.enabled && (source.type === 'xtream' || source.type === 'stalker')) {
      console.log(`Syncing VOD for source: ${source.name}`);
      const result = await syncVodForSource(source);
      results.set(source.id, result);
      console.log(`  → ${result.success ? 'OK' : 'FAILED'}: ${result.movieCount} movies, ${result.seriesCount} series`);
    }
  }

  return results;
}

// Trigger TMDB matching for a source (runs in background)
export function enrichSourceMetadata(source: Source, force?: boolean) {
  startTmdbMatching();
  Promise.all([
    matchMoviesWithTmdb(source.id, force),
    matchSeriesWithTmdb(source.id, force),
  ])
    .catch(console.error)
    .finally(() => {
      endTmdbMatching();
    });
}
