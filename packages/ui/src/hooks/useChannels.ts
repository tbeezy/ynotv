import { useLiveQuery } from './useSqliteLiveQuery';
import { db, getLastCategory, setLastCategory } from '../db';
import type { StoredChannel, StoredCategory, SourceMeta, StoredProgram } from '../db';
import { decompressEpgDescription } from '../utils/compression';
import { getRecentChannels, onRecentChannelsUpdate } from '../utils/recentChannels';
import { useState, useEffect, useCallback } from 'react';
import { useSourceVersion } from '../contexts/SourceVersionContext';
import { applyFilterWords } from './useFilterWords';

// Hook to get enabled source IDs (for filtering data from disabled sources)
// Returns null during loading to avoid hiding all data
export function useEnabledSources(): Set<string> | null {
  const { version } = useSourceVersion(); // Track source changes

  const sources = useLiveQuery(async () => {
    if (!window.storage) return null;
    const result = await window.storage.getSources();
    if (!result.data) return null;
    return result.data.filter(s => s.enabled !== false);
  }, [version]); // Re-run when version changes

  // Return null if still loading sources
  if (sources === undefined || sources === null) return null;

  return new Set(sources.map(s => s.id));
}

// Hook to get all categories across all sources (filtered by enabled sources and categories)
// Includes virtual "Favorites" category if any channels are favorited
export function useCategories() {
  const enabledSourceIds = useEnabledSources();
  const [recentVersion, setRecentVersion] = useState(0);

  // Listen for recent channels updates
  useEffect(() => {
    const unsubscribe = onRecentChannelsUpdate(() => {
      setRecentVersion(v => v + 1);
    });
    return unsubscribe;
  }, []);

  const categories = useLiveQuery(
    async () => {
      // Don't filter if sources haven't loaded yet
      if (!enabledSourceIds) return db.categories.orderBy('category_name').toArray();

      const allCategories = await db.categories.filter(cat => enabledSourceIds.has(cat.source_id)).sortBy('category_name');

      // Filter out disabled categories (enabled defaults to true if not set)
      const enabledCategories = allCategories.filter(cat => cat.enabled !== false);

      const virtualCategories: StoredCategory[] = [];

      // Always show Recently Viewed category (similar to Favorites)
      const recentChannels = getRecentChannels();
      const recentCategory: StoredCategory = {
        category_id: '__recent__',
        category_name: '🕐 Recently Viewed',
        source_id: '__virtual__',
        channel_count: recentChannels.length,
        enabled: true,
      };

      // Fetch Custom Groups
      const customGroups = await db.customGroups.orderBy('display_order').toArray();
      const customGroupCategories = await Promise.all(customGroups.map(async (g) => {
        const count = await db.customGroupChannels.where('group_id').equals(g.group_id).count();
        return {
          category_id: g.group_id,
          category_name: `📂 ${g.name}`,
          source_id: '__custom_group__',
          channel_count: count,
          enabled: true
        } as StoredCategory;
      }));

      virtualCategories.push(recentCategory);
      virtualCategories.push(...customGroupCategories);

      // Check if we have any favorited channels
      const favoriteCount = await db.channels.countWhere('(is_favorite = 1 OR is_favorite = true)');

      // Add virtual "Favorites" category if there are favorites
      if (favoriteCount > 0) {
        const favoritesCategory: StoredCategory = {
          category_id: '__favorites__',
          category_name: '⭐ Favorites',
          source_id: '__virtual__',
          channel_count: favoriteCount,
          enabled: true,
        };
        virtualCategories.push(favoritesCategory);
      }

      return [...virtualCategories, ...enabledCategories];
    },
    [enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading', recentVersion]
  );
  return categories ?? [];
}


// Hook to get categories for a specific source
export function useCategoriesForSource(sourceId: string | null) {
  const categories = useLiveQuery<StoredCategory[]>(
    async () => {
      if (sourceId) {
        // Use toArray() after sortBy since sortBy returns a Collection
        return await db.categories.where('source_id').equals(sourceId).sortBy('category_name');
      }
      return await db.categories.orderBy('category_name').toArray();
    },
    [sourceId]
  );
  return categories ?? [];
}

// Hook to get channels for a category (or all if categoryId is null)
// sortOrder: 'alphabetical' (default) or 'number' (by channel_num from provider)
// Filters out channels from disabled sources
export function useChannels(categoryId: string | null, sortOrder: 'alphabetical' | 'number' = 'alphabetical', options?: { skip?: boolean }) {
  const enabledSourceIds = useEnabledSources();
  const channels = useLiveQuery(
    async () => {
      if (options?.skip) return [];
      let results: StoredChannel[];

      // Handle virtual categories
      if (categoryId === '__recent__') {
        // Fetch recently viewed channels in order
        const recentEntries = getRecentChannels();
        const recentIds = recentEntries.map(e => e.streamId);

        if (recentIds.length === 0) {
          results = [];
        } else {
          // Optimized: Fetch only the channels we need using anyOf
          const channels = await db.channels.where('stream_id').anyOf(recentIds).toArray();
          const channelMap = new Map(channels.map(ch => [ch.stream_id, ch]));

          // Maintain order from recent list
          results = recentEntries
            .map(entry => channelMap.get(entry.streamId))
            .filter((ch): ch is StoredChannel => ch !== undefined);
        }
      } else if (categoryId === '__favorites__') {
        // Use SQL WHERE for better performance
        results = await db.channels.whereRaw('(is_favorite = 1 OR is_favorite = true)').toArray();
      } else if (!categoryId) {
        // All Channels view
        if (enabledSourceIds) {
          // Optimized: Filter source IDs in SQL IN clause
          const idsList = Array.from(enabledSourceIds);
          if (idsList.length === 0) return [];
          // Chunk the IN clause if too many sources (unlikely < 100, but safe)
          const placeholders = idsList.map(() => '?').join(',');
          results = await db.channels.whereRaw(`source_id IN (${placeholders})`, idsList).toArray();
        } else {
          // Sources loading or explicit all - might be slow if 40k+ channels, but unavoidable for "All"
          // We could consider LIMIT 1000? But user expects all.
          results = await db.channels.toArray();
        }
      } else {
        // Check if it is a Custom Group
        const customGroup = await db.customGroups.get(categoryId);
        if (customGroup) {
          const mappings = await db.customGroupChannels
            .where('group_id').equals(categoryId)
            .sortBy('display_order');

          const streamIds = mappings.map(m => m.stream_id);
          if (streamIds.length === 0) {
            results = [];
          } else {
            const channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
            const channelMap = new Map(channels.map(ch => [ch.stream_id, ch]));
            results = mappings
              .map(m => channelMap.get(m.stream_id))
              .filter((ch): ch is StoredChannel => ch !== undefined);
          }
        } else {
          // Channels in this category - uses index
          results = await db.channels.where('category_ids').equals(categoryId).toArray();
          // Still need to filter by enabled source if result contains mixed sources (unlikely for category)
          if (enabledSourceIds) {
            results = results.filter(ch => enabledSourceIds.has(ch.source_id));
          }
        }
      }

      // Filter out disabled channels (enabled === false)
      results = results.filter(ch => ch.enabled !== false);

      // Get filter words for this category and apply to channel names
      // This ensures filtered names are applied at the data level, preventing UI flicker
      // This ensures filtered names are applied at the data level, preventing UI flicker
      let filterWords: string[] = [];
      // Apply filter words only for standard categories (not virtual or custom groups)
      if (categoryId && !categoryId.startsWith('__')) {
        // Optimize: avoid DB call if we know it's a custom group (UUID like) or just accept the miss
        // Custom groups don't have filter words yet, so we can check db.categories
        const category = await db.categories.get(categoryId);
        if (category) {
          filterWords = category.filter_words || [];
        }
      }

      // Apply filter words to channel names
      if (filterWords.length > 0) {
        results = results.map(ch => ({
          ...ch,
          name: applyFilterWords(ch.name, filterWords)
        }));
      }

      // Sort based on preference
      if (sortOrder === 'number') {
        // Sort by channel_num, with channels lacking a number at the end (alphabetically)
        return results.sort((a, b) => {
          const aNum = a.channel_num;
          const bNum = b.channel_num;
          if (aNum !== undefined && bNum !== undefined) {
            return aNum - bNum;
          }
          if (aNum !== undefined) return -1; // a has number, b doesn't
          if (bNum !== undefined) return 1;  // b has number, a doesn't
          return a.name.localeCompare(b.name); // both lack numbers, sort alphabetically
        });
      }
      // Default: alphabetical
      return results.sort((a, b) => a.name.localeCompare(b.name));
    },
    [categoryId, sortOrder, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading', options?.skip]
  );
  return channels ?? [];
}

// Hook to get total channel count
export function useChannelCount() {
  const count = useLiveQuery(() => db.channels.count());
  return count ?? 0;
}

// Hook to get channel count for a category
export function useCategoryChannelCount(categoryId: string) {
  const count = useLiveQuery(() => db.channels.where('category_ids').equals(categoryId).count(), [categoryId]);
  return count ?? 0;
}

// Hook to get sync metadata for all sources
export function useSyncStatus() {
  const status = useLiveQuery(() => db.sourcesMeta.toArray());
  return status ?? [];
}

// Hook to manage selected category with persistence
export function useSelectedCategory() {
  const [categoryId, setCategoryIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load last category on mount
  useEffect(() => {
    getLastCategory().then((lastCat) => {
      setCategoryIdState(lastCat);
      setLoading(false);
    });
  }, []);

  // Wrapper that also persists
  const setCategoryId = useCallback((id: string | null) => {
    setCategoryIdState(id);
    if (id) {
      setLastCategory(id);
    }
  }, []);

  return { categoryId, setCategoryId, loading };
}

// Helper to parse category IDs from JSON string or array
function parseCategoryIds(categoryIdsJson: string | string[] | number[] | undefined): string[] {
  if (!categoryIdsJson) return [];
  if (Array.isArray(categoryIdsJson)) {
    return categoryIdsJson.map(String);
  }
  try {
    const parsed = JSON.parse(categoryIdsJson);
    if (Array.isArray(parsed)) {
      // Map all to strings to support numeric category IDs from Xtream/Stalker
      return parsed.map(String);
    }
  } catch {
    // Invalid JSON
  }
  return [];
}

// Hook to search channels by name - only searches enabled categories
export function useChannelSearch(query: string, limit = 50) {
  const enabledSourceIds = useEnabledSources();

  const channels = useLiveQuery(
    async () => {
      if (!query || query.length < 2) {
        return [];
      }

      // If no enabled sources, return empty results
      if (!enabledSourceIds || enabledSourceIds.size === 0) {
        return [];
      }

      const dbInstance = await (db as any).dbPromise;
      const sourceIdsList = Array.from(enabledSourceIds);
      const sourcePlaceholders = sourceIdsList.map(() => '?').join(',');

      // Get enabled category IDs via SQL (avoids full table scan to JS)
      const enabledCategoryRows = await dbInstance.select(
        `SELECT category_id FROM categories
         WHERE source_id IN (${sourcePlaceholders})
         AND (enabled IS NULL OR enabled != 0)`,
        sourceIdsList
      );
      const enabledCategoryIds = new Set<string>(enabledCategoryRows.map((r: any) => r.category_id));

      if (enabledCategoryIds.size === 0) return [];

      // Search channels that match the name and belong to an enabled category
      // json_each lets SQLite expand the category_ids JSON array inline
      const categoryPlaceholders = Array.from(enabledCategoryIds).map(() => '?').join(',');
      const filteredChannels = await dbInstance.select(
        `SELECT DISTINCT c.*
         FROM channels c, json_each(c.category_ids) AS cat
         WHERE c.name LIKE ?
         AND c.source_id IN (${sourcePlaceholders})
         AND (c.enabled IS NULL OR c.enabled != 0)
         AND cat.value IN (${categoryPlaceholders})
         LIMIT ?`,
        [`%${query}%`, ...sourceIdsList, ...Array.from(enabledCategoryIds), limit]
      );

      return filteredChannels as StoredChannel[];
    },
    [query, limit, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']
  );
  return channels ?? [];
}


// Hook to search programs (EPG) by title - only searches enabled categories
export function useProgramSearch(query: string, limit = 50) {
  const enabledSourceIds = useEnabledSources();

  const programs = useLiveQuery(
    async () => {
      if (!query || query.length < 2) {
        return [];
      }

      if (!enabledSourceIds || enabledSourceIds.size === 0) {
        return [];
      }

      const dbInstance = await (db as any).dbPromise;
      const sourceIdsList = Array.from(enabledSourceIds);
      const sourcePlaceholders = sourceIdsList.map(() => '?').join(',');

      // Step 1: Get enabled category IDs (single query)
      const enabledCategoriesQuery = `
        SELECT category_id FROM categories 
        WHERE source_id IN (${sourcePlaceholders})
        AND (enabled IS NULL OR enabled != 0)
      `;
      const enabledCategoryRows = await dbInstance.select(enabledCategoriesQuery, sourceIdsList);
      const enabledCategoryIds = enabledCategoryRows.map((row: any) => row.category_id);

      if (enabledCategoryIds.length === 0) {
        return [];
      }

      // Step 2: Get enabled channel IDs using json_each for efficient category matching
      // This filters channels that belong to at least one enabled category
      const categoryPlaceholders = enabledCategoryIds.map(() => '?').join(',');
      const enabledChannelsQuery = `
        SELECT DISTINCT c.stream_id 
        FROM channels c, json_each(c.category_ids) AS cat
        WHERE c.source_id IN (${sourcePlaceholders})
        AND (c.enabled IS NULL OR c.enabled != 0)
        AND cat.value IN (${categoryPlaceholders})
      `;
      const enabledChannelRows = await dbInstance.select(
        enabledChannelsQuery,
        [...sourceIdsList, ...enabledCategoryIds]
      );
      const enabledChannelIds = new Set(enabledChannelRows.map((row: any) => row.stream_id));

      if (enabledChannelIds.size === 0) {
        return [];
      }

      // Step 3: Search programs natively through an INNER JOIN on enabled channels
      // Also filter out any past programs (p.end <= now) so limits are accurate
      const nowIso = new Date().toISOString();
      const programResults = await dbInstance.select(
        `SELECT p.* 
         FROM programs p
         INNER JOIN (
           SELECT DISTINCT c.stream_id 
           FROM channels c, json_each(c.category_ids) AS cat
           WHERE c.source_id IN (${sourcePlaceholders})
           AND (c.enabled IS NULL OR c.enabled != 0)
           AND cat.value IN (${categoryPlaceholders})
         ) ec ON p.stream_id = ec.stream_id
         WHERE p.title LIKE ? AND p.end > ?
         LIMIT ?`,
        [...sourceIdsList, ...enabledCategoryIds, `%${query}%`, nowIso, limit * 2]
      );

      // Step 4: Decompress descriptions for exactly the valid programs
      const filteredPrograms: StoredProgram[] = [];
      for (const prog of programResults) {
        filteredPrograms.push({
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        });
        if (filteredPrograms.length >= limit) break;
      }

      return filteredPrograms;
    },
    [query, limit, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']
  );
  return programs ?? [];
}

// Combined search result type
export interface SearchResult {
  type: 'channel' | 'program';
  channel?: StoredChannel;
  program?: StoredProgram & { channel?: StoredChannel };
}

// Categories with channel counts
export interface CategoryWithCount extends StoredCategory {
  channelCount: number;
}

// Grouped categories by source
export interface SourceWithCategories {
  sourceId: string;
  categories: CategoryWithCount[];
}

// Hook to get categories grouped by source (filtered by enabled sources)
export function useCategoriesBySource(): SourceWithCategories[] {
  const enabledSourceIds = useEnabledSources();
  const { version } = useSourceVersion(); // Track reorders and edits

  const data = useLiveQuery(
    async () => {
      // 1. Fetch raw Source ordering from JSON layer
      const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
      const sourceOrderMap: Record<string, number> = {};

      if (sourcesResult.data) {
        // Map source ID to its true display position in settings
        sourcesResult.data
          // Ensure they are strictly sorted by display_order physically first
          .sort((a, b) => {
            const orderA = a.display_order ?? Number.MAX_SAFE_INTEGER;
            const orderB = b.display_order ?? Number.MAX_SAFE_INTEGER;
            if (orderA !== orderB) return orderA - orderB;
            return a.name.localeCompare(b.name);
          })
          .forEach((source, index) => {
            sourceOrderMap[source.id] = index;
          });
      }

      // 2. Get all categories
      const allCategories = await db.categories.orderBy('category_name').toArray();
      const categories = enabledSourceIds
        ? allCategories.filter(cat => enabledSourceIds.has(cat.source_id) && cat.enabled !== false)
        : allCategories.filter(cat => cat.enabled !== false);

      // Get all channel counts - chunk queries to avoid SQLite UNION ALL limit (~500 terms)
      const dbInstance = await (db as any).dbPromise;
      const categoryIds = categories.map(c => c.category_id);

      let channelCounts: Record<string, number> = {};

      if (categoryIds.length > 0) {
        // Count channels per category, filtered to only enabled sources
        const sourceIdsList = enabledSourceIds ? Array.from(enabledSourceIds) : [];
        let countQuery: string;
        let countParams: any[];

        if (sourceIdsList.length > 0) {
          const sourcePlaceholders = sourceIdsList.map(() => '?').join(',');
          countQuery = `
            SELECT cat.value as cat_id, COUNT(*) as cnt
            FROM channels c, json_each(c.category_ids) AS cat
            WHERE c.source_id IN (${sourcePlaceholders})
            AND (c.enabled IS NULL OR c.enabled != 0)
            GROUP BY cat.value
          `;
          countParams = sourceIdsList;
        } else {
          countQuery = `
            SELECT cat.value as cat_id, COUNT(*) as cnt
            FROM channels c, json_each(c.category_ids) AS cat
            WHERE (c.enabled IS NULL OR c.enabled != 0)
            GROUP BY cat.value
          `;
          countParams = [];
        }


        try {
          const countResults = await dbInstance.select(countQuery, countParams);
          countResults.forEach((row: any) => {
            channelCounts[row.cat_id] = row.cnt;
          });
        } catch (e) {
          console.warn("Failed to fetch categorized channel counts with JSON approach:", e);
        }
      }


      const withCounts: CategoryWithCount[] = categories.map(cat => ({
        ...cat,
        channelCount: channelCounts[cat.category_id] || 0
      }));

      // Group by source_id
      const grouped = withCounts.reduce((acc, cat) => {
        const sourceId = cat.source_id;
        if (!acc[sourceId]) {
          acc[sourceId] = [];
        }
        acc[sourceId].push(cat);
        return acc;
      }, {} as Record<string, CategoryWithCount[]>);

      // Sort INDIVIDUAL categories inside each source strictly by name (unless category has its own order)
      Object.values(grouped).forEach(cats => {
        cats.sort((a, b) => {
          if (a.display_order !== undefined && b.display_order !== undefined) {
            return a.display_order - b.display_order;
          }
          if (a.display_order !== undefined) return -1;
          if (b.display_order !== undefined) return 1;
          return a.category_name.localeCompare(b.category_name);
        });
      });

      // 3. Convert Object map into final Array, and SORT it by the Parent Source display order we mapped
      const finalArray = Object.entries(grouped).map(([sourceId, categories]) => ({
        sourceId,
        categories,
      }));

      finalArray.sort((a, b) => {
        const orderA = sourceOrderMap[a.sourceId] ?? Number.MAX_SAFE_INTEGER;
        const orderB = sourceOrderMap[b.sourceId] ?? Number.MAX_SAFE_INTEGER;
        return orderA - orderB;
      });

      return finalArray;
    },
    [enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading', version]
  );

  return data ?? [];
}

// Hook to get categories with their channel counts (filtered by enabled sources)
export function useCategoriesWithCounts(): CategoryWithCount[] {
  const enabledSourceIds = useEnabledSources();
  const data = useLiveQuery(
    async () => {
      // Get all categories first
      const allCategories = await db.categories.orderBy('category_name').toArray();
      const categories = enabledSourceIds
        ? allCategories.filter(cat => enabledSourceIds.has(cat.source_id))
        : allCategories;

      // Get all channel counts - chunk queries to avoid SQLite UNION ALL limit (~500 terms)
      const dbInstance = await (db as any).dbPromise;
      const categoryIds = categories.map(c => c.category_id);

      let channelCounts: Record<string, number> = {};

      if (categoryIds.length > 0) {
        const countQuery = `
          SELECT cat.value as cat_id, COUNT(*) as cnt
          FROM channels c, json_each(c.category_ids) AS cat
          GROUP BY cat.value
        `;

        try {
          const countResults = await dbInstance.select(countQuery);
          countResults.forEach((row: any) => {
            channelCounts[row.cat_id] = row.cnt;
          });
        } catch (e) {
          console.warn("Failed to fetch categorized channel counts with JSON approach:", e);
        }
      }

      const withCounts: CategoryWithCount[] = categories.map(cat => ({
        ...cat,
        channelCount: channelCounts[cat.category_id] || 0
      }));

      return withCounts;
    },
    [enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']
  );
  return data ?? [];
}

// Hook to get current program for a channel
export function useCurrentProgram(streamId: string | null): StoredProgram | null {
  const program = useLiveQuery(
    async () => {
      if (!streamId) return null;
      const now = new Date();
      // Find program where start <= now < end
      const prog = await db.programs
        .where('stream_id')
        .equals(streamId)
        .filter((p) => p.start <= now && p.end > now)
        .first();

      if (prog) {
        // Decompress description if needed
        return {
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        };
      }
      return null;
    },
    [streamId]
  );
  return program ?? null;
}

// Chunk size for SQLite IN clause limit (SQLite default max is 999, use 500 for safety)
const SQL_CHUNK_SIZE = 500;

// Hook to get all programs for channels within a time range (for EPG grid)
export function useProgramsInRange(
  streamIds: string[],
  windowStart: Date,
  windowEnd: Date
): Map<string, StoredProgram[]> {
  const programs = useLiveQuery(
    async () => {
      if (streamIds.length === 0) return new Map<string, StoredProgram[]>();

      const result = new Map<string, StoredProgram[]>();

      // Initialize empty arrays for all channels
      for (const id of streamIds) {
        result.set(id, []);
      }

      // Chunk streamIds to avoid SQLite "too many SQL variables" error
      const allPrograms: StoredProgram[] = [];
      for (let i = 0; i < streamIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = streamIds.slice(i, i + SQL_CHUNK_SIZE);
        const chunkPrograms = await db.programs
          .where('stream_id')
          .anyOf(chunk)
          .filter((p) => {
            const start = p.start instanceof Date ? p.start : new Date(p.start);
            const end = p.end instanceof Date ? p.end : new Date(p.end);
            return start < windowEnd && end > windowStart;
          })
          .toArray();
        allPrograms.push(...chunkPrograms);
      }

      // Group by stream_id, decompress descriptions, and sort by start time
      for (const prog of allPrograms) {
        const existing = result.get(prog.stream_id) ?? [];
        // Decompress description if needed
        const decompressedProg = {
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        };
        existing.push(decompressedProg);
        result.set(prog.stream_id, existing);
      }

      // Sort each channel's programs by start time
      for (const [, progs] of result) {
        progs.sort((a, b) => {
          const aStart = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
          const bStart = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
          return aStart - bStart;
        });
      }

      return result;
    },
    [streamIds.join(','), windowStart.getTime(), windowEnd.getTime()]
  );

  return programs ?? new Map();
}

// Hook to get programs for a list of channel IDs (queries local DB - EPG is synced upfront)
export function usePrograms(streamIds: string[]): Map<string, StoredProgram | null> {
  const programs = useLiveQuery(
    async () => {
      if (streamIds.length === 0) return new Map();
      const now = new Date();
      const result = new Map<string, StoredProgram | null>();

      // Initialize all to null so callers know these IDs were checked
      for (const id of streamIds) result.set(id, null);

      // Single batched query instead of N separate round-trips
      const allPrograms: StoredProgram[] = [];
      for (let i = 0; i < streamIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = streamIds.slice(i, i + SQL_CHUNK_SIZE);
        const chunkPrograms = await db.programs
          .where('stream_id')
          .anyOf(chunk)
          .filter((p) => {
            const start = p.start instanceof Date ? p.start : new Date(p.start);
            const end = p.end instanceof Date ? p.end : new Date(p.end);
            return start <= now && end > now;
          })
          .toArray();
        allPrograms.push(...chunkPrograms);
      }

      // Pick first current program per channel (channels rarely have overlapping programs)
      for (const prog of allPrograms) {
        if (!result.get(prog.stream_id)) {
          result.set(prog.stream_id, prog);
        }
      }

      return result;
    },
    [streamIds.join(',')]
  );
  return programs ?? new Map();
}

// Hook to get ALL programs for channels (loads everything at once, no lazy loading by time window)
// Use this instead of useProgramsInRange when you want to load all EPG data upfront
export function useAllPrograms(streamIds: string[]): Map<string, StoredProgram[]> {
  const programs = useLiveQuery(
    async () => {
      if (streamIds.length === 0) return new Map<string, StoredProgram[]>();

      const result = new Map<string, StoredProgram[]>();

      // Initialize empty arrays for all channels
      for (const id of streamIds) {
        result.set(id, []);
      }

      // Load ALL programs for these channels (no time window filtering)
      const allPrograms: StoredProgram[] = [];
      for (let i = 0; i < streamIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = streamIds.slice(i, i + SQL_CHUNK_SIZE);
        const chunkPrograms = await db.programs
          .where('stream_id')
          .anyOf(chunk)
          .toArray();
        allPrograms.push(...chunkPrograms);
      }

      // Group by stream_id, decompress descriptions, and sort by start time
      for (const prog of allPrograms) {
        const existing = result.get(prog.stream_id) ?? [];
        // Decompress description if needed
        const decompressedProg = {
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        };
        existing.push(decompressedProg);
        result.set(prog.stream_id, existing);
      }

      // Sort each channel's programs by start time
      for (const [, progs] of result) {
        progs.sort((a, b) => {
          const aStart = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
          const bStart = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
          return aStart - bStart;
        });
      }

      return result;
    },
    [streamIds.join(',')]
  );

  return programs ?? new Map();
}
