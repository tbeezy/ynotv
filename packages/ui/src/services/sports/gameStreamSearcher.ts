import { db, type StoredChannel } from '../../db';
import { buildSearchQueryClauses } from '../../utils/searchNormalization';
import { useLeagueSearchConfigStore } from '../../stores/leagueSearchConfigStore';
import { useUIStore } from '../../stores/uiStore';

interface CacheEntry {
  channels: StoredChannel[];
  timestamp: number;
}

// In-memory cache for game streams (persists throughout session until sources re-sync)
const streamSearchCache = new Map<string, CacheEntry>();

export function getCachedGameStreams(cacheKey: string): StoredChannel[] | null {
  const entry = streamSearchCache.get(cacheKey);
  if (!entry) return null;
  return entry.channels;
}

export function setCachedGameStreams(cacheKey: string, channels: StoredChannel[]): void {
  streamSearchCache.set(cacheKey, {
    channels,
    timestamp: Date.now(),
  });
}

export function clearCachedGameStreams(): void {
  streamSearchCache.clear();
}

// Invalidate stream search cache whenever a source sync completes so fresh channels/EPG are queried
if (typeof window !== 'undefined') {
  useUIStore.subscribe((state, prev) => {
    if (prev.channelSyncing && !state.channelSyncing) {
      clearCachedGameStreams();
    }
  });
}

// Background prefetch queue: runs 1 game search at a time with 60ms polite yielding
let isPrefetching = false;
const prefetchQueue: Array<{ eventId: string; query: string; leagueId: string; limit: number }> = [];

export function queuePrefetchGameStreams(
  eventId: string,
  query: string,
  leagueId: string,
  limit = 15
): void {
  const cacheKey = `${eventId}_${query}_${leagueId}`;
  if (getCachedGameStreams(cacheKey)) return;
  if (prefetchQueue.some((item) => item.eventId === eventId)) return;

  prefetchQueue.push({ eventId, query, leagueId, limit });
  processPrefetchQueue();
}

async function processPrefetchQueue(): Promise<void> {
  if (isPrefetching) return;
  isPrefetching = true;

  while (prefetchQueue.length > 0) {
    // If a channel sync is currently running, pause and wait for it to complete
    if (useUIStore.getState().channelSyncing) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    const item = prefetchQueue.shift();
    if (!item) break;

    const cacheKey = `${item.eventId}_${item.query}_${item.leagueId}`;
    if (!getCachedGameStreams(cacheKey)) {
      try {
        const results = await searchGameStreams(item.query, item.leagueId, item.limit);
        setCachedGameStreams(cacheKey, results);
      } catch (err) {
        console.error('[gameStreamSearcher] Background prefetch failed for', item.eventId, err);
      }
    }

    // Yield 60ms between game searches so database and UI thread remain silky smooth
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  isPrefetching = false;
}

/**
 * Searches local channels database and EPG programs for matching matchup query,
 * scoped to the league's search configuration (sources and categories) if set.
 */
export async function searchGameStreams(
  query: string,
  leagueId?: string,
  limit = 20
): Promise<StoredChannel[]> {
  const queryWords = query.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (queryWords.length === 0) return [];

  const cacheKey = `${query}_${leagueId || 'all'}_${limit}`;
  const cached = getCachedGameStreams(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
    const allEnabledSources =
      sourcesResult.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || [];

    if (allEnabledSources.length === 0) return [];

    // Retrieve league search configuration if leagueId is provided
    let searchConfig = null;
    if (leagueId) {
      await useLeagueSearchConfigStore.getState().ensureLoaded();
      searchConfig = useLeagueSearchConfigStore.getState().getConfig(leagueId);
    }

    // Filter sources based on league search config
    let targetSourceIds = allEnabledSources;
    if (searchConfig?.sourceIds && searchConfig.sourceIds.length > 0) {
      targetSourceIds = allEnabledSources.filter((id) => searchConfig.sourceIds.includes(id));
      if (targetSourceIds.length === 0) return [];
    }

    const sourcePlaceholders = targetSourceIds.map(() => '?').join(',');

    // Filter categories based on league search config
    let targetCategoryIds: string[] = [];
    if (searchConfig?.categoryIds && searchConfig.categoryIds.length > 0) {
      targetCategoryIds = searchConfig.categoryIds;
    } else {
      const enabledCategoryRows = await db.query<{ category_id: string | number }>(
        `SELECT category_id FROM categories WHERE source_id IN (${sourcePlaceholders}) AND (enabled IS NULL OR enabled != 0)`,
        targetSourceIds
      );
      targetCategoryIds = enabledCategoryRows.map((r) => String(r.category_id));
    }

    if (targetCategoryIds.length === 0) return [];

    const categoryPlaceholders = targetCategoryIds.map(() => '?').join(',');
    const { sql: wordLikeClauses, params: wordParams } = buildSearchQueryClauses('c.name', query);
    const { sql: progLikeClauses, params: progParams } = buildSearchQueryClauses('p.title', query);
    const nowIso = new Date().toISOString();

    const channelMatches = await db.query<StoredChannel>(
      `SELECT DISTINCT c.* FROM channels c CROSS JOIN json_each(c.category_ids) AS cat WHERE (${wordLikeClauses}) AND c.source_id IN (${sourcePlaceholders}) AND (c.enabled IS NULL OR c.enabled != 0) AND cat.value IN (${categoryPlaceholders}) LIMIT ${limit}`,
      [...wordParams, ...targetSourceIds, ...targetCategoryIds]
    );

    const programMatches = await db.query<StoredChannel>(
      `SELECT DISTINCT c.* FROM channels c INNER JOIN programs p ON p.stream_id = c.stream_id CROSS JOIN json_each(c.category_ids) AS cat WHERE (${progLikeClauses}) AND p.end > ? AND c.source_id IN (${sourcePlaceholders}) AND (c.enabled IS NULL OR c.enabled != 0) AND cat.value IN (${categoryPlaceholders}) LIMIT ${limit}`,
      [...progParams, nowIso, ...targetSourceIds, ...targetCategoryIds]
    );

    const mergedMap = new Map<string, StoredChannel>();
    for (const ch of channelMatches) mergedMap.set(ch.stream_id, ch);
    for (const ch of programMatches) mergedMap.set(ch.stream_id, ch);

    const results = Array.from(mergedMap.values()).slice(0, limit);
    setCachedGameStreams(cacheKey, results);
    return results;
  } catch (err) {
    console.error('[gameStreamSearcher] Stream search error:', err);
    return [];
  }
}
