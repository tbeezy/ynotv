import { convertFileSrc, invoke } from '@tauri-apps/api/core';

export interface LogoCacheStats {
  total_files: number;
  total_bytes: number;
  enabled: boolean;
  max_bytes: number;
  ttl_days: number;
}

// In-memory cache map for fast instant lookup of already resolved URLs
const resolvedUrlCache = new Map<string, string>();
const inFlightRequests = new Map<string, Promise<string>>();

/**
 * Convert a remote logo URL to its cached local asset URL if caching is enabled.
 */
export async function getCachedLogoUrl(url: string, enabled = true): Promise<string> {
  if (!url || !enabled || typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
    return url;
  }

  // Check in-memory resolved map
  if (resolvedUrlCache.has(url)) {
    return resolvedUrlCache.get(url)!;
  }

  // Deduplicate in-flight promises
  if (inFlightRequests.has(url)) {
    return inFlightRequests.get(url)!;
  }

  const promise = (async () => {
    try {
      const dataUrl = await invoke<string>('get_cached_logo_path', { url });
      if (dataUrl) {
        resolvedUrlCache.set(url, dataUrl);
        return dataUrl;
      }
    } catch (e) {
      // Fallback silently to original URL on network/disk error
    }
    resolvedUrlCache.set(url, url);
    return url;
  })();

  inFlightRequests.set(url, promise);
  try {
    return await promise;
  } finally {
    inFlightRequests.delete(url);
  }
}

/**
 * Get logo cache statistics from Rust backend
 */
export async function getLogoCacheStats(
  enabled = true,
  maxMb = 250,
  ttlDays = 30
): Promise<LogoCacheStats> {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
    return {
      total_files: 0,
      total_bytes: 0,
      enabled,
      max_bytes: maxMb * 1024 * 1024,
      ttl_days: ttlDays,
    };
  }

  try {
    return await invoke<LogoCacheStats>('get_logo_cache_stats', {
      enabled,
      maxBytes: maxMb * 1024 * 1024,
      ttlDays,
    });
  } catch (e) {
    console.error('[logoCache] Failed to get stats:', e);
    return {
      total_files: 0,
      total_bytes: 0,
      enabled,
      max_bytes: maxMb * 1024 * 1024,
      ttl_days: ttlDays,
    };
  }
}

/**
 * Prune expired (TTL) and over-limit (max size) logo cache entries.
 * Pass 0 for ttlDays to skip TTL eviction, 0 for maxBytes to skip size eviction.
 */
export async function pruneLogoCache(maxBytes: number, ttlDays: number): Promise<boolean> {
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
    return false;
  }

  try {
    await invoke('prune_logo_cache', { maxBytes, ttlDays });
    return true;
  } catch (e) {
    console.error('[logoCache] Failed to prune cache:', e);
    return false;
  }
}

/**
 * Clear all cached logo files from disk and reset in-memory cache
 */
export async function clearLogoCache(): Promise<boolean> {
  resolvedUrlCache.clear();
  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
    return true;
  }

  try {
    await invoke('clear_logo_cache');
    return true;
  } catch (e) {
    console.error('[logoCache] Failed to clear cache:', e);
    return false;
  }
}

/**
 * Batch pre-fetch missing logos in background
 */
export async function prefetchLogos(urls: string[]): Promise<number> {
  if (!urls || urls.length === 0 || typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) {
    return 0;
  }

  try {
    const count = await invoke<number>('prefetch_logos', { urls });
    return count;
  } catch (e) {
    console.error('[logoCache] Failed to prefetch logos:', e);
    return 0;
  }
}
