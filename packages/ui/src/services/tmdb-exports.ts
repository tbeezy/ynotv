/**
 * TMDB Daily Exports Service
 *
 * Downloads and caches TMDB daily ID exports for efficient local matching.
 * Avoids API rate limits by using pre-generated export files.
 *
 * Export files: https://developer.themoviedb.org/docs/daily-id-exports
 * Format: Line-delimited JSON (gzipped)
 * Fields: { id, original_title, adult, video, popularity }
 *
 * Also supports enriched exports with year data from GitHub cache.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { saveTmdbExportCache, loadTmdbExportCache } from '../db';
// LRU Cache removed to prevent data loss


// ===========================================================================
// Types
// ===========================================================================

export interface TmdbExportEntry {
  id: number;
  original_title: string;  // For movies
  original_name?: string;  // For TV shows
  adult: boolean;
  video?: boolean;
  popularity: number;
  year?: number;           // Added from enriched data
}

export interface TmdbExportData {
  entries: Map<string, TmdbExportEntry[]>;  // normalized title -> entries
  byId: Map<number, TmdbExportEntry>;       // id -> entry
  lastUpdated: Date;
}

// Enriched data format from GitHub cache: { i: id, t: title, y: year, p: popularity }
interface EnrichedEntry {
  i: number;   // TMDB ID
  t: string;   // Title
  y: number;   // Year
  p: number;   // Popularity
}

interface EnrichedData {
  generated_at: string;
  count: number;
  entries: EnrichedEntry[];
}

// Parameters extracted from VOD item for matching
export interface MatchParams {
  title: string;
  year?: number;
}

// ===========================================================================
// Cache
// ===========================================================================

let movieExportCache: TmdbExportData | null = null;
let tvExportCache: TmdbExportData | null = null;

// Enriched data caches (with year info from GitHub)
let enrichedMovieCache: TmdbExportData | null = null;
let enrichedTvCache: TmdbExportData | null = null;

// Cache for 24 hours
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// GitHub cache URLs for enriched data (NDJSON format for streaming)
const ENRICHED_MOVIE_URL = 'https://raw.githubusercontent.com/thesubtleties/sbtlTV-tmdb-cache/main/data/tmdb-movies-enriched.ndjson';
const ENRICHED_TV_URL = 'https://raw.githubusercontent.com/thesubtleties/sbtlTV-tmdb-cache/main/data/tmdb-tvs-enriched.ndjson';

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Normalize title for matching
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    // Remove year patterns
    .replace(/\s*\(\d{4}\)\s*/g, ' ')
    .replace(/\s*\[\d{4}\]\s*/g, ' ')
    .replace(/\s+\d{4}$/g, '')
    // Remove quality markers
    .replace(/\s*(4k|uhd|hd|sd|1080p|720p|480p|bluray|web-dl|hdrip|dvdrip)\s*/gi, ' ')
    // Remove special chars
    .replace(/[^\w\s]/g, ' ')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract title and year from VOD item for TMDB matching
 * Priority: title+year fields → parse from name → name only
 */
export function extractMatchParams(item: { name: string; title?: string; year?: string }): MatchParams {
  // 1. Best case: structured fields from Xtream API
  if (item.title && item.year) {
    const year = parseInt(item.year, 10);
    return {
      title: item.title,
      year: !isNaN(year) ? year : undefined,
    };
  }

  // 2. Has title but no year - check if name has (YEAR) pattern
  if (item.title) {
    const yearMatch = item.name.match(/\((\d{4})\)/);
    return {
      title: item.title,
      year: yearMatch ? parseInt(yearMatch[1], 10) : undefined,
    };
  }

  // 3. No title field - parse from name: "Movie Title (1962)"
  const nameMatch = item.name.match(/^(.+?)\s*\((\d{4})\)\s*$/);
  if (nameMatch) {
    return {
      title: nameMatch[1].trim(),
      year: parseInt(nameMatch[2], 10),
    };
  }

  // 4. Fallback: just use name as title, no year
  return { title: item.name };
}

/**
 * Download and parse enriched TMDB data from GitHub cache (NDJSON format)
 * Uses streaming to avoid blocking main thread with 1M+ entries
 * Yields control every 1000 entries to keep UI responsive
 * Returns null if unavailable (will fall back to regular exports)
 */

async function downloadEnrichedExport(type: 'movie' | 'tv'): Promise<TmdbExportData | null> {
  const url = type === 'movie' ? ENRICHED_MOVIE_URL : ENRICHED_TV_URL;
  console.log(`[TMDB Export] Downloading enriched ${type} data from GitHub...`);

  try {
    // Build lookup maps with size limits (prevents unbounded memory growth)
    // Build lookup maps (unlimited size to prevent data loss)
    const entries = new Map<string, TmdbExportEntry[]>();
    const byId = new Map<number, TmdbExportEntry>();

    const isTauri = !!(window as any).__TAURI__;
    let response: Response;

    if (isTauri) {
      response = await tauriFetch(url);
      if (!response.ok) {
        console.warn(`[TMDB Export] Enriched ${type} not available: ${response.status}`);
        return null;
      }

    } else {
      response = await fetch(url);
      if (!response.ok) {
        console.warn(`[TMDB Export] Enriched ${type} not available: ${response.status}`);
        return null;
      }
    }

    // Stream and parse NDJSON to avoid loading entire file into memory
    console.log(`[TMDB Export] Streaming ${type} data...`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lineCount = 0;
    let lastYield = performance.now();
    const YIELD_INTERVAL_MS = 16; // Yield every 16ms (~1 frame) to keep UI responsive

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line for next chunk

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const e = JSON.parse(line) as EnrichedEntry;
          const normalized = normalizeTitle(e.t);
          if (!normalized) continue;

          const entry: TmdbExportEntry = {
            id: e.i,
            original_title: e.t,
            adult: false,
            popularity: e.p,
            year: e.y,
          };

          // Add to title index
          const existing = entries.get(normalized);
          if (existing) {
            existing.push(entry);
          } else {
            entries.set(normalized, [entry]);
          }

          // Add to ID index
          byId.set(e.i, entry);
          lineCount++;
        } catch {
          // Skip malformed lines
        }

        // Yield to event loop periodically to keep UI responsive
        if (lineCount % 1000 === 0) {
          const now = performance.now();
          if (now - lastYield > YIELD_INTERVAL_MS) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            lastYield = now;
          }
        }
      }
    }

    // Process any remaining content in buffer
    if (buffer.trim()) {
      try {
        const e = JSON.parse(buffer) as EnrichedEntry;
        const normalized = normalizeTitle(e.t);
        if (normalized) {
          const entry: TmdbExportEntry = {
            id: e.i,
            original_title: e.t,
            adult: false,
            popularity: e.p,
            year: e.y,
          };
          const existing = entries.get(normalized);
          if (existing) {
            existing.push(entry);
          } else {
            entries.set(normalized, [entry]);
          }
          byId.set(e.i, entry);
          lineCount++;
        }
      } catch {
        // Skip malformed final line
      }
    }

    console.log(`[TMDB Export] Indexed ${entries.size} unique enriched ${type} titles (${lineCount} total entries)`);

    return {
      entries,
      byId,
      lastUpdated: new Date(),
    };
  } catch (error) {
    console.warn(`[TMDB Export] Failed to load enriched ${type} data:`, error);
    return null;
  }
}

/**
 * Parse enriched data from text (fallback for non-streaming environments)
 */
async function parseEnrichedText(
  textContent: string,
  type: 'movie' | 'tv',
  entries: Map<string, TmdbExportEntry[]>,
  byId: Map<number, TmdbExportEntry>
): Promise<TmdbExportData | null> {
  const lines = textContent.split('\n');
  console.log(`[TMDB Export] Parsing ${lines.length} enriched ${type} entries...`);

  let lineCount = 0;
  let lastYield = performance.now();
  const YIELD_INTERVAL_MS = 16;

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const e = JSON.parse(line) as EnrichedEntry;
      const normalized = normalizeTitle(e.t);
      if (!normalized) continue;

      const entry: TmdbExportEntry = {
        id: e.i,
        original_title: e.t,
        adult: false,
        popularity: e.p,
        year: e.y,
      };

      const existing = entries.get(normalized);
      if (existing) {
        existing.push(entry);
      } else {
        entries.set(normalized, [entry]);
      }
      byId.set(e.i, entry);
      lineCount++;
    } catch {
      // Skip malformed lines
    }

    // Yield to event loop periodically
    if (lineCount % 1000 === 0) {
      const now = performance.now();
      if (now - lastYield > YIELD_INTERVAL_MS) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        lastYield = now;
      }
    }
  }

  console.log(`[TMDB Export] Indexed ${entries.size} unique enriched ${type} titles`);

  return {
    entries,
    byId,
    lastUpdated: new Date(),
  };
}

/**
 * Get today's date formatted for export filename
 */
function getExportDate(): string {
  const now = new Date();
  // Use yesterday's date to ensure the export is available
  now.setDate(now.getDate() - 1);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const year = now.getFullYear();
  return `${month}_${day}_${year}`;
}

/**
 * Build export URL
 */
function buildExportUrl(type: 'movie' | 'tv'): string {
  const date = getExportDate();
  const fileType = type === 'movie' ? 'movie_ids' : 'tv_series_ids';
  return `https://files.tmdb.org/p/exports/${fileType}_${date}.json.gz`;
}

// ===========================================================================
// Download & Parse
// ===========================================================================

/**
 * Download and parse a TMDB export file
 */
async function downloadExport(type: 'movie' | 'tv'): Promise<TmdbExportData> {
  const url = buildExportUrl(type);
  console.log(`[TMDB Export] Downloading ${type} export from ${url}`);

  let gzippedData: ArrayBuffer;

  // Use Tauri's HTTP plugin (bypasses CORS)
  const isTauri = !!(window as any).__TAURI__;

  if (isTauri) {
    const response = await tauriFetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download TMDB export: ${response.status}`);
    }
    gzippedData = await response.arrayBuffer();

  } else {
    // Fallback to regular fetch (works in Node.js or when CORS is not an issue)
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download TMDB export: ${response.status}`);
    }
    gzippedData = await response.arrayBuffer();
  }

  // Decompress and parse using streaming
  const entries = new Map<string, TmdbExportEntry[]>();
  const byId = new Map<number, TmdbExportEntry>();

  // Create streaming pipeline: gzip → text decoder
  const decompressedStream = new Response(gzippedData).body!
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream());

  const reader = decompressedStream.getReader();
  let buffer = '';
  let lineCount = 0;

  console.log(`[TMDB Export] Parsing ${type} entries (streaming)...`);

  // Process chunks as they arrive
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line for next chunk

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as TmdbExportEntry;

        // Skip adult content
        if (entry.adult) continue;

        // Get the title based on type
        const title = type === 'movie' ? entry.original_title : entry.original_name;
        if (!title) continue;

        // Normalize and index
        const normalized = normalizeTitle(title);
        if (!normalized) continue;

        // Add to title index
        const existing = entries.get(normalized) || [];
        existing.push(entry);
        entries.set(normalized, existing);

        // Add to ID index
        byId.set(entry.id, entry);
        lineCount++;
      } catch {
        // Skip malformed lines
      }
    }
  }

  // Process any remaining content in buffer
  if (buffer.trim()) {
    try {
      const entry = JSON.parse(buffer) as TmdbExportEntry;
      if (!entry.adult) {
        const title = type === 'movie' ? entry.original_title : entry.original_name;
        if (title) {
          const normalized = normalizeTitle(title);
          if (normalized) {
            const existing = entries.get(normalized) || [];
            existing.push(entry);
            entries.set(normalized, existing);
            byId.set(entry.id, entry);
            lineCount++;
          }
        }
      }
    } catch {
      // Skip malformed final line
    }
  }

  console.log(`[TMDB Export] Indexed ${entries.size} unique titles, ${byId.size} total entries (${lineCount} lines)`);

  return {
    entries,
    byId,
    lastUpdated: new Date(),
  };
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Get movie export data (downloads if not cached)
 */
export async function getMovieExports(): Promise<TmdbExportData> {
  // Check cache
  if (movieExportCache) {
    const age = Date.now() - movieExportCache.lastUpdated.getTime();
    if (age < CACHE_TTL_MS) {
      return movieExportCache;
    }
  }

  // Download fresh data
  movieExportCache = await downloadExport('movie');
  return movieExportCache;
}

/**
 * Get TV export data (downloads if not cached)
 */
export async function getTvExports(): Promise<TmdbExportData> {
  // Check cache
  if (tvExportCache) {
    const age = Date.now() - tvExportCache.lastUpdated.getTime();
    if (age < CACHE_TTL_MS) {
      return tvExportCache;
    }
  }

  // Download fresh data
  tvExportCache = await downloadExport('tv');
  return tvExportCache;
}

/**
 * Get enriched movie exports with year data (from GitHub cache)
 * Falls back to regular exports if enriched data unavailable
 */
export async function getEnrichedMovieExports(): Promise<TmdbExportData> {
  // Check memory cache first (fastest)
  if (enrichedMovieCache) {
    const age = Date.now() - enrichedMovieCache.lastUpdated.getTime();
    if (age < CACHE_TTL_MS) {
      return enrichedMovieCache;
    }
  }

  // Check persistent disk cache
  const diskCache = await loadTmdbExportCache('enriched_movie_v2');
  if (diskCache) {
    console.log('[TMDB Export] Loading movie data from disk cache');
    // Reconstruct the Maps from serialized data
    const entries = new Map<string, TmdbExportEntry[]>();
    const byId = new Map<number, TmdbExportEntry>();

    // Restore entries from disk
    for (const [key, value] of diskCache.entries) {
      entries.set(key, value);
    }
    for (const [key, value] of diskCache.byId) {
      byId.set(key, value);
    }

    enrichedMovieCache = {
      entries,
      byId,
      lastUpdated: new Date(diskCache.lastUpdated),
    };
    return enrichedMovieCache;
  }

  // Try to download enriched data
  const enriched = await downloadEnrichedExport('movie');
  if (enriched) {
    enrichedMovieCache = enriched;
    // Save to disk cache
    await saveTmdbExportCache('enriched_movie_v2', {
      entries: Array.from(enriched.entries.entries()),
      byId: Array.from(enriched.byId.entries()),
      lastUpdated: enriched.lastUpdated.toISOString(),
    });
    return enrichedMovieCache;
  }

  // Fall back to regular exports (no year data)
  console.log('[TMDB Export] Falling back to regular movie exports (no year data)');
  return getMovieExports();
}

/**
 * Get enriched TV exports with year data (from GitHub cache)
 * Falls back to regular exports if enriched data unavailable
 */
export async function getEnrichedTvExports(): Promise<TmdbExportData> {
  // Check memory cache first (fastest)
  if (enrichedTvCache) {
    const age = Date.now() - enrichedTvCache.lastUpdated.getTime();
    if (age < CACHE_TTL_MS) {
      return enrichedTvCache;
    }
  }

  // Check persistent disk cache
  const diskCache = await loadTmdbExportCache('enriched_tv_v2');
  if (diskCache) {
    console.log('[TMDB Export] Loading TV data from disk cache');
    // Reconstruct the Maps from serialized data
    const entries = new Map<string, TmdbExportEntry[]>();
    const byId = new Map<number, TmdbExportEntry>();

    // Restore entries from disk
    for (const [key, value] of diskCache.entries) {
      entries.set(key, value);
    }
    for (const [key, value] of diskCache.byId) {
      byId.set(key, value);
    }

    enrichedTvCache = {
      entries,
      byId,
      lastUpdated: new Date(diskCache.lastUpdated),
    };
    return enrichedTvCache;
  }

  // Try to download enriched data
  const enriched = await downloadEnrichedExport('tv');
  if (enriched) {
    enrichedTvCache = enriched;
    // Save to disk cache
    await saveTmdbExportCache('enriched_tv_v2', {
      entries: Array.from(enriched.entries.entries()),
      byId: Array.from(enriched.byId.entries()),
      lastUpdated: enriched.lastUpdated.toISOString(),
    });
    return enrichedTvCache;
  }

  // Fall back to regular exports (no year data)
  console.log('[TMDB Export] Falling back to regular TV exports (no year data)');
  return getTvExports();
}

/**
 * Find best TMDB match for a title using exports
 * Uses exact normalized title matching only (fast O(1) lookup)
 * When year is provided, prefers exact year match before falling back to most popular
 */
export function findBestMatch(
  exports: TmdbExportData,
  title: string,
  year?: number
): TmdbExportEntry | null {
  const normalized = normalizeTitle(title);
  if (!normalized) return null;

  // Helper to find best match from candidates
  const findFromCandidates = (matches: TmdbExportEntry[]): TmdbExportEntry | null => {
    if (!matches || matches.length === 0) return null;

    // If year provided, try exact year match first
    if (year) {
      const exactYear = matches.find(m => m.year === year);
      if (exactYear) return exactYear;
    }

    // Fall back to most popular
    return matches.reduce((best, current) =>
      current.popularity > best.popularity ? current : best
    );
  };

  // Exact match using Map lookup - O(1)
  const matches = exports.entries.get(normalized);
  const result = findFromCandidates(matches || []);
  if (result) return result;

  // Try without "the" prefix
  const withoutThe = normalized.replace(/^the\s+/, '');
  if (withoutThe !== normalized) {
    const matches2 = exports.entries.get(withoutThe);
    const result2 = findFromCandidates(matches2 || []);
    if (result2) return result2;
  }

  return null;
}

/**
 * Batch match movies against exports
 */
export async function batchMatchFromExports(
  titles: { id: string; title: string }[],
  type: 'movie' | 'tv',
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, number>> {
  const exports = type === 'movie' ? await getMovieExports() : await getTvExports();
  const results = new Map<string, number>();

  for (let i = 0; i < titles.length; i++) {
    const { id, title } = titles[i];
    const match = findBestMatch(exports, title);

    if (match) {
      results.set(id, match.id);
    }

    // Report progress every 100 items
    if (onProgress && (i + 1) % 100 === 0) {
      onProgress(i + 1, titles.length);
    }
  }

  onProgress?.(titles.length, titles.length);
  return results;
}

/**
 * Clear cached exports (force re-download)
 */
export function clearExportCache(): void {
  movieExportCache = null;
  tvExportCache = null;
  enrichedMovieCache = null;
  enrichedTvCache = null;
}
