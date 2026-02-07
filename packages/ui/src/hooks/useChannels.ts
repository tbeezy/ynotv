import { useLiveQuery } from 'dexie-react-hooks';
import { db, getLastCategory, setLastCategory } from '../db';
import type { StoredChannel, StoredCategory, SourceMeta, StoredProgram } from '../db';
import { useState, useEffect, useCallback } from 'react'; 
import { useSourceVersion } from '../contexts/SourceVersionContext';

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
  const categories = useLiveQuery(
    async () => {
      // Don't filter if sources haven't loaded yet
      if (!enabledSourceIds) return db.categories.orderBy('category_name').toArray();

      const allCategories = await db.categories.filter(cat => enabledSourceIds.has(cat.source_id)).sortBy('category_name');

      // Filter out disabled categories (enabled defaults to true if not set)
      const enabledCategories = allCategories.filter(cat => cat.enabled !== false);

      // Check if we have any favorited channels
      const allChannels = await db.channels.toArray();
      const favoriteCount = allChannels.filter(ch => ch.is_favorite === true).length;

      // Add virtual "Favorites" category at the beginning if there are favorites
      if (favoriteCount > 0) {
        const favoritesCategory: StoredCategory = {
          category_id: '__favorites__',
          category_name: '⭐ Favorites',
          source_id: '__virtual__',
          channel_count: favoriteCount,
          enabled: true,
        };
        return [favoritesCategory, ...enabledCategories];
      }

      return enabledCategories;
    },
    [enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']
  );
  return categories ?? [];
}


// Hook to get categories for a specific source
export function useCategoriesForSource(sourceId: string | null) {
  const categories = useLiveQuery(
    () => (sourceId ? db.categories.where('source_id').equals(sourceId).sortBy('category_name') : db.categories.orderBy('category_name').toArray()),
    [sourceId]
  );
  return categories ?? [];
}

// Hook to get channels for a category (or all if categoryId is null)
// sortOrder: 'alphabetical' (default) or 'number' (by channel_num from provider)
// Filters out channels from disabled sources
export function useChannels(categoryId: string | null, sortOrder: 'alphabetical' | 'number' = 'alphabetical') {
  const enabledSourceIds = useEnabledSources();
  const channels = useLiveQuery(
    async () => {
      let results: StoredChannel[];

      // Handle virtual Favorites category
      if (categoryId === '__favorites__') {
        results = await db.channels.toArray();
        results = results.filter(ch => ch.is_favorite === true);
      } else if (!categoryId) {
        results = await db.channels.toArray();
      } else {
        // Channels in this category
        results = await db.channels.where('category_ids').equals(categoryId).toArray();
      }

      // Filter out channels from disabled sources (only if sources have loaded)
      if (enabledSourceIds) {
        results = results.filter(ch => enabledSourceIds.has(ch.source_id));
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
    [categoryId, sortOrder, enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']
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

// Hook to search channels by name
export function useChannelSearch(query: string, limit = 50) {
  const channels = useLiveQuery(
    () => {
      if (!query || query.length < 2) {
        return [];
      }
      const lowerQuery = query.toLowerCase();
      return db.channels
        .filter((ch) => ch.name.toLowerCase().includes(lowerQuery))
        .limit(limit)
        .toArray();
    },
    [query, limit]
  );
  return channels ?? [];
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
  const data = useLiveQuery(
    async () => {
      // Don't filter if sources haven't loaded yet
      const allCategories = await db.categories.orderBy('category_name').toArray();
      const categories = enabledSourceIds
        ? allCategories.filter(cat => enabledSourceIds.has(cat.source_id) && cat.enabled !== false)
        : allCategories.filter(cat => cat.enabled !== false);

      const withCounts: CategoryWithCount[] = await Promise.all(
        categories.map(async (cat) => {
          const count = await db.channels.where('category_ids').equals(cat.category_id).count();
          return { ...cat, channelCount: count };
        })
      );

      // Group by source_id
      const grouped = withCounts.reduce((acc, cat) => {
        const sourceId = cat.source_id;
        if (!acc[sourceId]) {
          acc[sourceId] = [];
        }
        acc[sourceId].push(cat);
        return acc;
      }, {} as Record<string, CategoryWithCount[]>);

      // Sort categories within each source by display_order, then category_name
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

      return Object.entries(grouped).map(([sourceId, categories]) => ({
        sourceId,
        categories,
      }));
    },
    [enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading']
  );

  return data ?? [];
}

// Hook to get categories with their channel counts (filtered by enabled sources)
export function useCategoriesWithCounts(): CategoryWithCount[] {
  const enabledSourceIds = useEnabledSources();
  const data = useLiveQuery(
    async () => {
      // Don't filter if sources haven't loaded yet
      const allCategories = await db.categories.orderBy('category_name').toArray();
      const categories = enabledSourceIds
        ? allCategories.filter(cat => enabledSourceIds.has(cat.source_id))
        : allCategories;

      const withCounts: CategoryWithCount[] = await Promise.all(
        categories.map(async (cat) => {
          const count = await db.channels.where('category_ids').equals(cat.category_id).count();
          return { ...cat, channelCount: count };
        })
      );
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
      const programs = await db.programs
        .where('stream_id')
        .equals(streamId)
        .filter((p) => p.start <= now && p.end > now)
        .first();
      return programs ?? null;
    },
    [streamId]
  );
  return program ?? null;
}

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

      // Fetch all programs that overlap with the time window
      // A program overlaps if: program.start < windowEnd AND program.end > windowStart
      const allPrograms = await db.programs
        .where('stream_id')
        .anyOf(streamIds)
        .filter((p) => {
          const start = p.start instanceof Date ? p.start : new Date(p.start);
          const end = p.end instanceof Date ? p.end : new Date(p.end);
          return start < windowEnd && end > windowStart;
        })
        .toArray();

      // Group by stream_id and sort by start time
      for (const prog of allPrograms) {
        const existing = result.get(prog.stream_id) ?? [];
        existing.push(prog);
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

      for (const id of streamIds) {
        const program = await db.programs
          .where('stream_id')
          .equals(id)
          .filter((p) => {
            const start = p.start instanceof Date ? p.start : new Date(p.start);
            const end = p.end instanceof Date ? p.end : new Date(p.end);
            return start <= now && end > now;
          })
          .first();
        result.set(id, program ?? null);
      }
      return result;
    },
    [streamIds.join(',')]
  );
  return programs ?? new Map();
}
