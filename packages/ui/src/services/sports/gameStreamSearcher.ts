import { db, type StoredChannel } from '../../db';
import { buildSearchQueryClauses } from '../../utils/searchNormalization';
import { useLeagueSearchConfigStore } from '../../stores/leagueSearchConfigStore';

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

    return Array.from(mergedMap.values()).slice(0, limit);
  } catch (err) {
    console.error('[gameStreamSearcher] Stream search error:', err);
    return [];
  }
}
