import { useLiveQuery } from './useSqliteLiveQuery';
import { db, getLastCategory, setLastCategory, getFavoriteSourceOrder } from '../db';
import { normalizeRow } from '../db/sqlite-adapter';
import type { StoredChannel, StoredCategory, SourceMeta, StoredProgram } from '../db';
import { decompressEpgDescription } from '../utils/compression';
import { epgTimeMs, pickCurrentProgram, EPG_WINDOW_BACK_MS, EPG_WINDOW_FWD_MS } from '../utils/epgTime';
import { getRecentChannels, onRecentChannelsUpdate } from '../utils/recentChannels';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSourceVersion } from '../contexts/SourceVersionContext';
import { applyFilterWordsDetailed } from './useFilterWords';
import { useCategorySortOrder } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { Source } from '@ynotv/core';
import { buildSearchQueryClauses, getSearchVariants } from '../utils/searchNormalization';
import { parseCategoryIds } from '../utils/channelPath';
// Hook to get enabled source IDs (for filtering data from disabled sources)
// Returns null during loading to avoid hiding all data
export function useEnabledSources(): Set<string> | null {
  const { version } = useSourceVersion(); // Track source changes

  const sources = useLiveQuery(async () => {
    if (!window.storage) return null;
    const result = await window.storage.getSources();
    if (!result.data) return null;
    return result.data.filter(s => s.enabled !== false);
  }, [version], undefined, 0,
    // Reads the source list (Tauri store), which only changes on source
    // syncs/manual edits. Scoping to sourcesMeta keeps it from re-running on
    // every DB write anywhere; the `version` dep above covers source changes.
    'sourcesMeta'); // Re-run when version changes

  // Memoize the Set creation based on sources array
  return useMemo(() => {
    if (sources === undefined || sources === null) return null;
    return new Set(sources.map(s => s.id));
  }, [sources]);
}

// Cached source names map to avoid repeated Tauri calls
let cachedSourceNameMap: Map<string, string> | null = null;
let cachedSourceVersion = -1;

// Hook to get source name map - cached to avoid repeated Tauri calls
export function useSourceNameMap(): Map<string, string> | null {
  const { version } = useSourceVersion();
  const [sourceMap, setSourceMap] = useState<Map<string, string> | null>(cachedSourceNameMap);

  useEffect(() => {
    // Return cached version if still valid
    if (cachedSourceNameMap && cachedSourceVersion === version) {
      setSourceMap(cachedSourceNameMap);
      return;
    }

    async function fetchSources() {
      if (!window.storage) return;
      const result = await window.storage.getSources();
      if (result.data) {
        const map = new Map<string, string>();
        map.set('local', 'Local');
        for (const source of result.data) {
          if (source.enabled !== false) {
            map.set(source.id, source.name);
          }
        }
        cachedSourceNameMap = map;
        cachedSourceVersion = version;
        setSourceMap(map);
      }
    }

    fetchSources();
  }, [version]);

  return sourceMap;
}

// Cached category names map to avoid repeated DB calls
let cachedCategoryNameMap: Map<string, string> | null = null;
let cachedCategoryVersion = -1;

// Hook to get category name map - cached to avoid repeated DB calls
function useCategoryNameMap(): Map<string, string> | null {
  const { version } = useSourceVersion();
  const [categoryMap, setCategoryMap] = useState<Map<string, string> | null>(cachedCategoryNameMap);

  useEffect(() => {
    // Return cached version if still valid
    if (cachedCategoryNameMap && cachedCategoryVersion === version) {
      setCategoryMap(cachedCategoryNameMap);
      return;
    }

    async function fetchCategories() {
      const allCategories = await db.categories.toArray();
      const map = new Map<string, string>();
      for (const cat of allCategories) {
        map.set(cat.category_id, cat.alias || cat.category_name);
      }
      try {
        const allLinks = await db.playlistCategoryLinks.toArray();
        for (const link of allLinks) {
          const cat = allCategories.find(c => c.category_id === link.category_id);
          const displayName = link.custom_name || cat?.alias || cat?.category_name || link.category_id;
          map.set(`link:${link.id}`, displayName);
          if (link.custom_name && link.category_id) {
            map.set(link.category_id, link.custom_name);
          }
        }
      } catch (e) {
        console.warn('[useCategoryNameMap] Failed to fetch playlist category links:', e);
      }
      cachedCategoryNameMap = map;
      cachedCategoryVersion = version;
      setCategoryMap(map);
    }

    fetchCategories();
  }, [version]);

  return categoryMap;
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

  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );

  const categories = useLiveQuery(
    async () => {
      // Don't filter if sources haven't loaded yet
      if (!enabledSourceIds) return db.categories.orderBy('category_name').toArray();

      // Parallel loading: categories, custom groups, and favorite count all at once
      const [allCategoriesResult, customGroupsResult, favoriteCountResult, recentChannelsResult] = await Promise.all([
        // Load categories for enabled sources. SQL-side source filter + sort so
        // we don't pull every category across ALL sources into JS just to drop
        // most of them (the old filter().sortBy() path did a full table read).
        (async () => {
          const idsList = Array.from(enabledSourceIds);
          if (idsList.length === 0) return [];
          const placeholders = idsList.map(() => '?').join(',');
          return await db.categories.whereRaw(
            `source_id IN (${placeholders}) ORDER BY category_name`,
            idsList
          ).toArray();
        })().catch(err => {
          console.error('[useCategories] Failed to load categories:', err);
          return [];
        }),
        // Load custom groups
        db.customGroups.orderBy('display_order').toArray().catch(err => {
          console.error('[useCategories] Failed to load custom groups:', err);
          return [];
        }),
        // Count favorites
        (async () => {
          if (!enabledSourceIds) return 0;
          const idsList = Array.from(enabledSourceIds);
          if (idsList.length === 0) return 0;
          const placeholders = idsList.map(() => '?').join(',');
          return await db.channels.countWhere(
            `(is_favorite = 1 OR is_favorite = true) AND source_id IN (${placeholders})`,
            idsList
          );
        })().catch(err => {
          console.error('[useCategories] Failed to count favorites:', err);
          return 0;
        }),
        // Get recent channels (sync, just reads from array)
        Promise.resolve(getRecentChannels())
      ]);

      const allCategories = allCategoriesResult;
      const customGroups = customGroupsResult;
      const favoriteCount = favoriteCountResult;
      const recentChannels = recentChannelsResult;

      // Filter out disabled categories (enabled defaults to true if not set)
      const enabledCategories = allCategories.filter(cat => cat.enabled !== false);

      const virtualCategories: StoredCategory[] = [];

      // Count how many recent channels are active
      let activeRecentCount = 0;
      if (recentChannels.length > 0) {
        try {
          const streamIds = recentChannels.map(e => e.streamId);
          const activeChannels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
          const activeStreamIds = new Set(
            activeChannels
              .filter(c => enabledSourceIds.has(c.source_id))
              .map(c => c.stream_id)
          );
          activeRecentCount = streamIds.filter(id => activeStreamIds.has(id)).length;
        } catch (err) {
          console.error('[useCategories] Failed to count active recent channels:', err);
        }
      }

      // Always show Recently Viewed category
      const recentCategory: StoredCategory = {
        category_id: '__recent__',
        category_name: '🕐 Recently Viewed',
        source_id: '__virtual__',
        channel_count: activeRecentCount,
        enabled: true,
      };
      virtualCategories.push(recentCategory);

      // Batch count custom group channels with single SQL query
      if (customGroups.length > 0) {
        try {
          const dbInstance = await (db as any).dbPromise;
          const groupIds = customGroups.map(g => g.group_id);
          const placeholders = groupIds.map(() => '?').join(',');
          const enabledSourceIdsList = Array.from(enabledSourceIds || []);
          
          let countRows = [];
          if (enabledSourceIdsList.length > 0) {
            const enabledPlaceholders = enabledSourceIdsList.map(() => '?').join(',');
            countRows = await dbInstance.select(
              `SELECT cgc.group_id, COUNT(*) as cnt 
               FROM custom_group_channels cgc
               JOIN channels c ON cgc.stream_id = c.stream_id
               WHERE cgc.group_id IN (${placeholders}) AND c.source_id IN (${enabledPlaceholders})
               GROUP BY cgc.group_id`,
              [...groupIds, ...enabledSourceIdsList]
            );
          }
          
          // Build count map
          const countMap = new Map<string, number>();
          for (const row of countRows) {
            countMap.set(row.group_id, row.cnt);
          }
          
          // Build virtual categories with counts
          const customGroupCategories = customGroups.map(g => ({
            category_id: g.group_id,
            category_name: `📂 ${g.name}`,
            source_id: '__custom_group__',
            channel_count: countMap.get(g.group_id) || 0,
            enabled: true
          } as StoredCategory));
          
          virtualCategories.push(...customGroupCategories);
        } catch (err) {
          console.error('[useCategories] Failed to count custom group channels:', err);
          // Still show custom groups but with 0 count
          const customGroupCategories = customGroups.map(g => ({
            category_id: g.group_id,
            category_name: `📂 ${g.name}`,
            source_id: '__custom_group__',
            channel_count: 0,
            enabled: true
          } as StoredCategory));
          virtualCategories.push(...customGroupCategories);
        }
      }

      // Add Favorites category if there are favorites
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
    [enabledSourceKey, recentVersion],
    undefined, // defaultResult
    30000, // staleTime: 30 seconds - categories rarely change during session
    // Watch only the tables this query reads: categories (main), custom_groups
    // + custom_group_channels (virtual custom-group categories + their counts),
    // and channels (favorite/recent counts). Previously watched every table,
    // so e.g. EPG or watch-progress writes re-ran the whole category pipeline.
    // NOTE: names must be the raw SQLite table names dbEvents notifies with.
    ['categories', 'custom_groups', 'channels', 'custom_group_channels']
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

/**
 * Apply filter words to a channel's display name (alias if set, otherwise
 * name) and its original name, recording which words actually matched so the
 * UI can explain why a name looks trimmed on hover.
 */
function applyFilterWordsToChannel(ch: StoredChannel, filterWords: string[]): StoredChannel {
  const matched: string[] = [];
  const collect = (words: string[]) => {
    for (const w of words) {
      if (!matched.includes(w)) matched.push(w);
    }
  };

  const next: StoredChannel = { ...ch };
  if (ch.alias) {
    const res = applyFilterWordsDetailed(ch.alias, filterWords);
    next.alias = res.text;
    collect(res.matched);
  }
  const nameRes = applyFilterWordsDetailed(ch.name, filterWords);
  next.name = nameRes.text;
  collect(nameRes.matched);

  if (matched.length > 0) {
    next.applied_filter_words = matched;
  }
  return next;
}

/**
 * Apply each channel's home-category filter words to its name, mirroring what
 * the standard category view does. The virtual Favorites views span many
 * categories, so they have no single category filter_words to apply — instead
 * we look up each channel's own categories and apply their words.
 */
export async function applyHomeCategoryFilterWords(results: StoredChannel[]): Promise<StoredChannel[]> {
  if (results.length === 0) return results;

  const categoryIds = new Set<string>();
  for (const ch of results) {
    for (const id of parseCategoryIds(ch.category_ids)) {
      categoryIds.add(id);
    }
  }
  if (categoryIds.size === 0) return results;

  const cats = await db.categories.where('category_id').anyOf(Array.from(categoryIds)).toArray();
  const wordsByCategory = new Map<string, string[]>();
  for (const cat of cats) {
    if (cat.filter_words && cat.filter_words.length > 0) {
      wordsByCategory.set(cat.category_id, cat.filter_words);
    }
  }
  if (wordsByCategory.size === 0) return results;

  return results.map(ch => {
    const words = new Set<string>();
    for (const id of parseCategoryIds(ch.category_ids)) {
      const fw = wordsByCategory.get(id);
      if (fw) {
        for (const w of fw) {
          if (w && w.trim()) words.add(w.trim());
        }
      }
    }
    if (words.size === 0) return ch;
    return applyFilterWordsToChannel(ch, Array.from(words));
  });
}

// Hook to get channels for a category (or all if categoryId is null)
// sortOrder: 'alphabetical' (default), 'number' (by channel_num from provider), or 'provider' (M3U file order)
// Filters out channels from disabled sources
export function useChannels(categoryId: string | null, sortOrder: 'alphabetical' | 'number' | 'provider' = 'alphabetical', options?: { skip?: boolean }) {
  const enabledSourceIds = useEnabledSources();
  const epgPreferEpgLogos = useSettingsStore((s) => s.epgPreferEpgLogos);
  // When enabled, Favorites views ignore the custom fav_order and always show
  // channels in A-Z order (global, per-source, and both modes alike).
  const alwaysSortFavoritesAlphabetically = useSettingsStore((s) => s.alwaysSortFavoritesAlphabetically);
  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );
  
  // Tables this query reads for the active category type — subscribe only to
  // those so unrelated DB writes (watch progress, EPG sync, VOD tables) don't
  // re-run the whole channel pipeline on every change. epg_channel_overrides
  // is always read (logo overrides); epg_channels only when EPG logos are
  // preferred. NOTE: names must be the raw SQLite table names dbEvents
  // notifies with (custom_groups, playlist_category_links, …).
  const watchedTables = useMemo(() => {
    const tables: string[] = ['channels', 'epg_channel_overrides'];
    if (categoryId === '__recent__' || categoryId === '__favorites__' || (categoryId?.startsWith('__favsrc_') ?? false)) {
      // applyHomeCategoryFilterWords() reads categories
      tables.push('categories');
    } else if (categoryId?.startsWith('__plcat_') || categoryId?.startsWith('__allsrc_pl_')) {
      tables.push('playlist_category_links', 'playlist_individual_channels');
    } else if (categoryId?.startsWith('__plindiv_')) {
      tables.push('playlist_individual_channels');
    } else if (categoryId && !categoryId.startsWith('__allsrc_')) {
      // Native category or custom group: category lookup/filter words, manual
      // additions, and custom-group membership.
      tables.push('categories', 'playlist_individual_channels', 'custom_groups', 'custom_group_channels');
    }
    if (epgPreferEpgLogos) tables.push('epg_channels');
    return tables;
  }, [categoryId, epgPreferEpgLogos]);
  
  const channels = useLiveQuery(
    async () => {
      if (options?.skip) return [];
      let results: StoredChannel[];
      // Set to true in branches that manage their own ordering so the final sort is skipped
      let orderingIsFixed = false;

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
          if (enabledSourceIds) {
            results = results.filter(ch => enabledSourceIds.has(ch.source_id));
          }
          orderingIsFixed = true;
        }
        // Apply each channel's home-category filter words so Recently Viewed
        // names match the category and Favorites views.
        results = await applyHomeCategoryFilterWords(results);
      } else if (categoryId === '__favorites__') {
        // Use SQL WHERE for better performance
        if (enabledSourceIds) {
          const idsList = Array.from(enabledSourceIds);
          if (idsList.length === 0) {
            results = [];
          } else {
            const placeholders = idsList.map(() => '?').join(',');
            results = await db.channels.whereRaw(
              `(is_favorite = 1 OR is_favorite = true) AND source_id IN (${placeholders})`,
              idsList
            ).toArray();
          }
        } else {
          results = await db.channels.whereRaw('(is_favorite = 1 OR is_favorite = true)').toArray();
        }
        // Apply filter words from each channel's home category before sorting,
        // so the sort uses the same cleaned names as the category view.
        results = await applyHomeCategoryFilterWords(results);
        // Sort by fav_order (nulls last, then by name for items without order).
        // When 'always sort favorites alphabetically' is enabled, ignore the
        // custom order and keep the whole list in A-Z order instead.
        if (alwaysSortFavoritesAlphabetically) {
          results.sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name));
        } else {
          results.sort((a, b) => {
            if (a.fav_order != null && b.fav_order != null) return a.fav_order - b.fav_order;
            if (a.fav_order != null) return -1;
            if (b.fav_order != null) return 1;
            return (a.alias || a.name).localeCompare(b.alias || b.name);
          });
        }
        orderingIsFixed = true;
      } else if (categoryId && categoryId.startsWith('__favsrc_')) {
        // Per-source favorites: favorites scoped to a single source
        const sourceId = categoryId.replace('__favsrc_', '');
        results = await db.channels.whereRaw(
          `(is_favorite = 1 OR is_favorite = true) AND source_id = ?`,
          [sourceId]
        ).toArray();
        // Apply filter words from each channel's home category before ordering,
        // matching the global Favorites and standard category views.
        results = await applyHomeCategoryFilterWords(results);
        // Per-source custom order (stored independently per provider).
        // When 'always sort favorites alphabetically' is enabled, A-Z sort
        // overrides any per-source custom order.
        if (alwaysSortFavoritesAlphabetically) {
          results.sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name));
        } else {
          const savedOrder = await getFavoriteSourceOrder(sourceId);
          if (savedOrder.length > 0) {
            const byId = new Map(results.map(ch => [ch.stream_id, ch]));
            const ordered: StoredChannel[] = [];
            for (const id of savedOrder) {
              const ch = byId.get(id);
              if (ch) {
                ordered.push(ch);
                byId.delete(id);
              }
            }
            const remaining = Array.from(byId.values()).sort((a, b) => {
              if (a.fav_order != null && b.fav_order != null) return a.fav_order - b.fav_order;
              if (a.fav_order != null) return -1;
              if (b.fav_order != null) return 1;
              return (a.alias || a.name).localeCompare(b.alias || b.name);
            });
            results = [...ordered, ...remaining];
          } else {
            // Sort by fav_order (nulls last, then by name for items without order)
            results.sort((a, b) => {
              if (a.fav_order != null && b.fav_order != null) return a.fav_order - b.fav_order;
              if (a.fav_order != null) return -1;
              if (b.fav_order != null) return 1;
              return (a.alias || a.name).localeCompare(b.alias || b.name);
            });
          }
        }
        orderingIsFixed = true;
      } else if (categoryId && categoryId.startsWith('__plcat_')) {
        const linkId = parseInt(categoryId.replace('__plcat_', ''), 10);
        if (isNaN(linkId)) {
          results = [];
        } else {
          const link = await db.playlistCategoryLinks.get(linkId);
          if (!link) {
            results = [];
          } else {
            results = await db.query<StoredChannel>(
              `SELECT c.* FROM channels c
               JOIN channel_categories cc ON cc.stream_id = c.stream_id
               WHERE cc.source_id = ? AND cc.category_id = ?
                 AND (c.enabled IS NULL OR c.enabled NOT IN (0, '0', 'false'))`,
              [link.source_id, link.category_id]
            ).then(rows => rows.map(r => normalizeRow(r, 'channels') as StoredChannel));

            // Fetch manually added individual channels for this category link
            let manualMappings = await db.playlistIndividualChannels
              .whereRaw('playlist_id = ? AND parent_category_id = ?', [link.playlist_id, `link:${link.id}`])
              .toArray();
            if (manualMappings.length === 0) {
              // Fallback inheritance: load mappings from target category
              manualMappings = await db.playlistIndividualChannels
                .whereRaw('playlist_id = ? AND parent_category_id = ?', [link.source_id, link.category_id])
                .toArray();
            }
            if (manualMappings.length > 0) {
              const streamIds = manualMappings.map(m => m.stream_id);
              const manualChannels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
              const manualMap = new Map(manualChannels.map(ch => [ch.stream_id, ch]));
              const orderedManual = manualMappings
                .sort((a, b) => a.display_order - b.display_order)
                .map(m => manualMap.get(m.stream_id))
                .filter((ch): ch is StoredChannel => ch !== undefined);

              const manualStreamIds = new Set(manualMappings.map(m => m.stream_id));
              const remainingDynamic = results.filter(ch => !manualStreamIds.has(ch.stream_id));
              results = [...orderedManual, ...remainingDynamic];
              orderingIsFixed = true;
            }
          }
        }
      } else if (categoryId && categoryId.startsWith('__plindiv_')) {
        const playlistId = categoryId.replace('__plindiv_', '');
        const mappings = await db.playlistIndividualChannels
          .where('playlist_id').equals(playlistId)
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
        orderingIsFixed = true;
      } else if (categoryId && categoryId.startsWith('__allsrc_pl_')) {
        // All Channels for a custom playlist
        const playlistId = categoryId.replace('__allsrc_pl_', '');
        const links = await db.playlistCategoryLinks.where('playlist_id').equals(playlistId).toArray();
        if (links.length === 0) {
          results = [];
        } else {
          // Collect all source_id + category_id pairs
          const allResults: StoredChannel[] = [];
          const seenStreamIds = new Set<string>();
          for (const link of links) {
            const linkChannels = await db.query<StoredChannel>(
              `SELECT c.* FROM channels c
               JOIN channel_categories cc ON cc.stream_id = c.stream_id
               WHERE cc.source_id = ? AND cc.category_id = ?
                 AND (c.enabled IS NULL OR c.enabled NOT IN (0, '0', 'false'))`,
              [link.source_id, link.category_id]
            ).then(rows => rows.map(r => normalizeRow(r, 'channels') as StoredChannel));
            for (const ch of linkChannels) {
              if (!seenStreamIds.has(ch.stream_id)) {
                seenStreamIds.add(ch.stream_id);
                allResults.push(ch);
              }
            }
          }
          // Also include individual channels for this playlist
          const individualMappings = await db.playlistIndividualChannels
            .where('playlist_id').equals(playlistId)
            .sortBy('display_order');
          if (individualMappings.length > 0) {
            const streamIds = individualMappings.map(m => m.stream_id);
            const indivChannels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
            const indivMap = new Map(indivChannels.map(ch => [ch.stream_id, ch]));
            for (const m of individualMappings) {
              const ch = indivMap.get(m.stream_id);
              if (ch && !seenStreamIds.has(ch.stream_id)) {
                seenStreamIds.add(ch.stream_id);
                allResults.push(ch);
              }
            }
          }
          results = allResults;
        }
      } else if (categoryId && categoryId.startsWith('__allsrc_')) {
        // All Channels for a single source
        const sourceId = categoryId.replace('__allsrc_', '');
        results = await db.channels.whereRaw(
          `source_id = ? AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`,
          [sourceId]
        ).toArray();
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
            if (enabledSourceIds) {
              results = results.filter(ch => enabledSourceIds.has(ch.source_id));
            }
          }
          orderingIsFixed = true; // order comes from customGroupChannels.display_order
        } else {
          // Channels in this category
          const category = await db.categories.get(categoryId);
          if (category) {              // Fetch this category's channels via the channel_categories map:
              // an index seek on (source_id, category_id) instead of scanning
              // every row of the source with a per-row json_each match. The
              // enabled filter stays in SQL so disabled rows aren't transferred.
              // ORDER BY c.rowid keeps table (insertion) order for the provider
              // sort. Rows are normalized to match whereRaw().toArray() output.
              results = await db.query<StoredChannel>(
                `SELECT c.* FROM channels c
                 JOIN channel_categories cc ON cc.stream_id = c.stream_id
                 WHERE cc.source_id = ? AND cc.category_id = ?
                   AND (c.enabled IS NULL OR c.enabled NOT IN (0, '0', 'false'))
                 ORDER BY c.rowid`,
                [category.source_id, category.category_id]
              ).then(rows => rows.map(r => normalizeRow(r, 'channels') as StoredChannel));
            if (enabledSourceIds) {
              results = results.filter(ch => enabledSourceIds.has(ch.source_id));
            }

            // Fetch manually added individual channels for this native category
            const manualMappings = await db.playlistIndividualChannels
              .whereRaw('playlist_id = ? AND parent_category_id = ?', [category.source_id, categoryId])
              .toArray();
            if (manualMappings.length > 0) {
              const streamIds = manualMappings.map(m => m.stream_id);
              const manualChannels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
              const manualMap = new Map(manualChannels.map(ch => [ch.stream_id, ch]));
              const orderedManual = manualMappings
                .sort((a, b) => a.display_order - b.display_order)
                .map(m => manualMap.get(m.stream_id))
                .filter((ch): ch is StoredChannel => ch !== undefined);

              const manualStreamIds = new Set(manualMappings.map(m => m.stream_id));
              const remainingDynamic = results.filter(ch => !manualStreamIds.has(ch.stream_id));
              results = [...orderedManual, ...remainingDynamic];
              orderingIsFixed = true;
            }
          } else {
            results = [];
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

      // Apply filter words to channel names (and aliases) so the guide matches
      // the ChannelManager preview, and record which words matched for hover.
      if (filterWords.length > 0) {
        results = results.map(ch => applyFilterWordsToChannel(ch, filterWords));
      }

      // Apply logo overrides from epg_channel_overrides so the guide shows
      // the user-set channel icon without needing a full sync.
      try {
        const logoMap = new Map<string, string>();
        const logoBgMap = new Map<string, string>();
        const logoPaddingMap = new Map<string, string>();
        const epgIdMap = new Map<string, string>();

        // Load overrides with a single query: join on json_each over the ids so
        // there's no SQLite variable-count limit and no chunked round-trips
        // (the old loop made one IPC query per 500 channels).
        const overrideRows = await db.query<{
          stream_id: string;
          stream_icon: string | null;
          logo_background: string | null;
          logo_padding: string | null;
          epg_channel_id: string | null;
        }>(
          `SELECT stream_id, stream_icon, logo_background, logo_padding, epg_channel_id
           FROM epg_channel_overrides
           WHERE stream_id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(results.map(ch => ch.stream_id))]
        );
        for (const o of overrideRows) {
          if (o.stream_icon) logoMap.set(o.stream_id, o.stream_icon);
          if (o.logo_background) logoBgMap.set(o.stream_id, o.logo_background);
          if (o.logo_padding) logoPaddingMap.set(o.stream_id, o.logo_padding);
          if (o.epg_channel_id) epgIdMap.set(o.stream_id, o.epg_channel_id);
        }

        let epgIconMap = new Map<string, string>();
        if (epgPreferEpgLogos) {
          try {
            // Only id/icon_url are used for the logo map — don't pull every
            // column of every EPG channel row across the IPC boundary.
            const epgChannels = await db.epgChannels.select(['id', 'icon_url']).toArray();
            for (const ec of epgChannels) {
              if (ec.icon_url) epgIconMap.set(ec.id, ec.icon_url);
            }
          } catch { /* ignore */ }

          // Query cached global EPG logos
          const epgIdsToQuery = new Set<string>();
          for (const ch of results) {
            const epgId = epgIdMap.get(ch.stream_id) || ch.epg_channel_id;
            if (epgId) epgIdsToQuery.add(epgId);
          }

          if (window.storage && epgIdsToQuery.size > 0) {
            try {
              const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
              const cacheLinks = globalEpgLinks.filter((link: any) => link.saveEntireEpg);
              
              if (cacheLinks.length > 0) {
                const Database = (await import('@tauri-apps/plugin-sql')).default;
                const idsArray = Array.from(epgIdsToQuery);
                
                for (const link of cacheLinks) {
                  try {
                    const cacheDbName = `epg_cache_${link.id}`;
                    const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
                    
                    const CHUNK_SIZE = 500;
                    for (let idx = 0; idx < idsArray.length; idx += CHUNK_SIZE) {
                      const chunk = idsArray.slice(idx, idx + CHUNK_SIZE);
                      const placeholders = chunk.map((_, i) => `$${i + 1}`).join(',');
                      
                      const rows = await cacheDb.select(
                        `SELECT id, icon_url FROM epg_channels WHERE id IN (${placeholders})`,
                        chunk
                      ) as { id: string; icon_url: string | null }[];
                      
                      for (const r of rows) {
                        if (r.icon_url) epgIconMap.set(r.id, r.icon_url);
                      }
                    }
                  } catch { /* ignore */ }
                }
              }
            } catch { /* ignore */ }
          }
        }

        results = results.map(ch => {
          const customIcon = logoMap.get(ch.stream_id);
          const logoBg = logoBgMap.get(ch.stream_id);
          const logoPad = logoPaddingMap.get(ch.stream_id);
          let effectiveIcon = customIcon;

          if (!effectiveIcon && epgPreferEpgLogos) {
            const epgId = epgIdMap.get(ch.stream_id) || ch.epg_channel_id;
            if (epgId && epgIconMap.has(epgId)) {
              effectiveIcon = epgIconMap.get(epgId);
            }
          }

          if (effectiveIcon || logoBg !== undefined || logoPad !== undefined) {
            return {
              ...ch,
              ...(effectiveIcon ? { stream_icon: effectiveIcon } : {}),
              ...(logoBg !== undefined ? { logo_background: logoBg } : {}),
              ...(logoPad !== undefined ? { logo_padding: logoPad } : {}),
            };
          }
          return ch;
        });
      } catch { /* ignore if overrides table not yet created */ }

      // Virtual categories and custom groups self-order; skip the sort below for them.
      if (orderingIsFixed) {
        return results;
      }

      // Standard category: respect display_order if any channels have been manually ordered.
      const hasAnyManualOrder = results.some(ch => ch.display_order != null);

      if (hasAnyManualOrder) {
        return results.sort((a, b) => {
          const aHas = a.display_order != null;
          const bHas = b.display_order != null;
          if (aHas && bHas) return a.display_order! - b.display_order!;
          if (aHas) return -1; // manually ordered items first
          if (bHas) return 1;
          // Both unordered — fall back to sortOrder
          if (sortOrder === 'provider') {
            const aOrder = a.provider_order;
            const bOrder = b.provider_order;
            if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
            if (aOrder !== undefined) return -1;
            if (bOrder !== undefined) return 1;
            return 0;
          }
          if (sortOrder === 'number') {
            const aNum = a.channel_num;
            const bNum = b.channel_num;
            if (aNum !== undefined && bNum !== undefined) return aNum - bNum;
            if (aNum !== undefined) return -1;
            if (bNum !== undefined) return 1;
          }
          return (a.alias || a.name).localeCompare(b.alias || b.name);
        });
      }

      // No manual ordering — use sortOrder preference
      if (sortOrder === 'provider') {
        return results.sort((a, b) => {
          const aOrder = a.provider_order;
          const bOrder = b.provider_order;
          if (aOrder !== undefined && bOrder !== undefined) return aOrder - bOrder;
          if (aOrder !== undefined) return -1;
          if (bOrder !== undefined) return 1;
          return 0;
        });
      }
      if (sortOrder === 'number') {
        return results.sort((a, b) => {
          const aNum = a.channel_num;
          const bNum = b.channel_num;
          if (aNum !== undefined && bNum !== undefined) return aNum - bNum;
          if (aNum !== undefined) return -1;
          if (bNum !== undefined) return 1;
          return (a.alias || a.name).localeCompare(b.alias || b.name);
        });
      }
      // Default: alphabetical
      results = results.sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name));

      return results;
    },
    [categoryId, sortOrder, enabledSourceKey, options?.skip, epgPreferEpgLogos, alwaysSortFavoritesAlphabetically],
    undefined, // defaultResult  
    15000, // staleTime: 15 seconds - instant switching between recently viewed categories
    // Watch only the tables this category type reads (channels + the lookup
    // tables for links/manual additions/ordering) instead of every table, so
    // unrelated DB writes don't re-run the whole channel pipeline.
    watchedTables
  );
  return channels ?? [];
}

// Hook to get total channel count
export function useChannelCount() {
  // Scoped: only re-run when channels change (cheap COUNT either way).
  const count = useLiveQuery(() => db.channels.count(), [], undefined, 0, 'channels');
  return count ?? 0;
}

// Hook to get sync metadata for all sources
export function useSyncStatus() {
  // Only re-run when sourcesMeta changes (it's the only table this reads)
  const status = useLiveQuery(() => db.sourcesMeta.toArray(), [], undefined, 0, 'sourcesMeta');
  return status ?? [];
}

// Hook to manage selected category with persistence
export function useSelectedCategory() {
  const [categoryId, setCategoryIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load the default category on mount. When the user picked a fixed default
  // (Settings -> LiveTV -> Sort & Channels -> Default Category) that wins over
  // the last-opened category; otherwise restore the last category as before.
  useEffect(() => {
    const mode = useSettingsStore.getState().defaultCategory;
    if (mode && mode !== '__last__') {
      setCategoryIdState(mode === '__all__' ? null : mode);
      setLoading(false);
      return;
    }
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

// Helper to parse category IDs from JSON string or array (canonical implementation in channelPath)
export { parseCategoryIds };

// Helper to resolve category IDs (native, category links, or custom categories) into native category IDs and explicit stream IDs
async function resolveSearchCategoryFilters(
  filterCategoryIds?: string[],
  filterSourceIds?: string[]
): Promise<{
  isCategoryFiltered: boolean;
  nativeCategoryIds: string[];
  explicitStreamIds: string[];
  extraRealSourceIds: string[];
}> {
  const nativeCategorySet = new Set<string>();
  const explicitStreamSet = new Set<string>();
  const extraRealSourceSet = new Set<string>();

  const linkIds: number[] = [];
  const customCatIds: string[] = [];
  const playlistIds: string[] = [];

  if (filterSourceIds && filterSourceIds.length > 0) {
    for (const srcId of filterSourceIds) {
      if (srcId.startsWith('playlist:')) {
        playlistIds.push(srcId.replace('playlist:', ''));
      }
    }
  }

  if (filterCategoryIds && filterCategoryIds.length > 0) {
    for (const catId of filterCategoryIds) {
      if (catId.startsWith('link:')) {
        const parsedId = parseInt(catId.replace('link:', ''), 10);
        if (!isNaN(parsedId)) linkIds.push(parsedId);
      } else if (catId.startsWith('custom:')) {
        customCatIds.push(catId);
      } else {
        nativeCategorySet.add(catId);
      }
    }
  }

  // Fetch playlistCategoryLinks for linkIds
  if (linkIds.length > 0) {
    const links = await db.playlistCategoryLinks.where('id').anyOf(linkIds).toArray();
    for (const link of links) {
      if (link.source_id !== 'custom' && !link.category_id.startsWith('custom:')) {
        nativeCategorySet.add(link.category_id);
        extraRealSourceSet.add(link.source_id);
      }
      const linkParentIds = [`link:${link.id}`, link.category_id];
      const mappings = await db.playlistIndividualChannels
        .where('parent_category_id')
        .anyOf(linkParentIds)
        .toArray();
      for (const m of mappings) {
        explicitStreamSet.add(m.stream_id);
      }
    }
  }

  // Fetch for custom playlist IDs
  if (playlistIds.length > 0) {
    for (const plId of playlistIds) {
      const links = await db.playlistCategoryLinks.where('playlist_id').equals(plId).toArray();
      for (const link of links) {
        if (link.source_id !== 'custom' && !link.category_id.startsWith('custom:')) {
          nativeCategorySet.add(link.category_id);
          extraRealSourceSet.add(link.source_id);
        }
      }
      const indivMappings = await db.playlistIndividualChannels.where('playlist_id').equals(plId).toArray();
      for (const m of indivMappings) {
        explicitStreamSet.add(m.stream_id);
      }
    }
  }

  // Fetch playlistIndividualChannels for customCatIds
  if (customCatIds.length > 0) {
    const mappings = await db.playlistIndividualChannels
      .where('parent_category_id')
      .anyOf(customCatIds)
      .toArray();
    for (const m of mappings) {
      explicitStreamSet.add(m.stream_id);
    }
  }

  // Fetch playlistIndividualChannels for nativeCategorySet
  if (nativeCategorySet.size > 0) {
    const nativeIds = Array.from(nativeCategorySet);
    const mappings = await db.playlistIndividualChannels
      .where('parent_category_id')
      .anyOf(nativeIds)
      .toArray();
    for (const m of mappings) {
      explicitStreamSet.add(m.stream_id);
    }
  }

  const isCategoryFiltered = Boolean(
    (filterCategoryIds && filterCategoryIds.length > 0) ||
    (filterSourceIds && filterSourceIds.some(id => id.startsWith('playlist:')))
  );

  return {
    isCategoryFiltered,
    nativeCategoryIds: Array.from(nativeCategorySet),
    explicitStreamIds: Array.from(explicitStreamSet),
    extraRealSourceIds: Array.from(extraRealSourceSet)
  };
}

// Hook to search channels by name - only searches enabled categories
// Optionally filter by specific sourceIds and categoryIds
export function useChannelSearch(
  query: string,
  limit = 50,
  includeSourceInSearch = false,
  order: 'default' | 'alphabetical' = 'default',
  filterSourceIds?: string[],
  filterCategoryIds?: string[]
) {
  const enabledSourceIds = useEnabledSources();
  const epgPreferEpgLogos = useSettingsStore((s) => s.epgPreferEpgLogos);
  const sourceNameMap = useSourceNameMap();
  const categoryNameMap = useCategoryNameMap();

  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );

  const filterKey = useMemo(
    () => `${filterSourceIds?.sort().join(',') || 'all'}_${filterCategoryIds?.sort().join(',') || 'all'}`,
    [filterSourceIds, filterCategoryIds]
  );

  const channels = useLiveQuery(
    async () => {
      if (!query || query.length < 2) {
        return [];
      }

      // Debug logging
      console.log('[useChannelSearch] order parameter:', order);

      // If no enabled sources, return empty results
      if (!enabledSourceIds || enabledSourceIds.size === 0) {
        return [];
      }

      const dbInstance = await (db as any).dbPromise;

      // Determine which source IDs to use: intersection of enabled and filtered
      let effectiveSourceIds: string[];
      if (filterSourceIds && filterSourceIds.length > 0) {
        const realFilters = filterSourceIds.filter(id => !id.startsWith('playlist:'));
        if (realFilters.length > 0) {
          effectiveSourceIds = realFilters.filter(id => enabledSourceIds.has(id));
        } else {
          effectiveSourceIds = Array.from(enabledSourceIds);
        }
      } else {
        effectiveSourceIds = Array.from(enabledSourceIds);
      }

      // Resolve category filters (including custom categories & category links)
      const { nativeCategoryIds, explicitStreamIds, extraRealSourceIds } =
        await resolveSearchCategoryFilters(filterCategoryIds, filterSourceIds);

      for (const extraId of extraRealSourceIds) {
        if (enabledSourceIds.has(extraId) && !effectiveSourceIds.includes(extraId)) {
          effectiveSourceIds.push(extraId);
        }
      }

      const sourcePlaceholders = effectiveSourceIds.length > 0
        ? effectiveSourceIds.map(() => '?').join(',')
        : null;

      const isFilteredBySourceOrCategory = Boolean(
        (filterSourceIds && filterSourceIds.length > 0) ||
        (filterCategoryIds && filterCategoryIds.length > 0)
      );

      let activeNativeCategoryIds = nativeCategoryIds;
      let activeExplicitStreamIds = explicitStreamIds;
      let hasNativeJoin = false;

      if (isFilteredBySourceOrCategory) {
        hasNativeJoin = activeNativeCategoryIds.length > 0;
      } else {
        // General search across enabled categories + custom mapped streams
        if (sourcePlaceholders) {
          const enabledCatRows = await dbInstance.select(
            `SELECT category_id FROM categories 
             WHERE source_id IN (${sourcePlaceholders}) 
             AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`,
            effectiveSourceIds
          );
          const enabledCatIds = enabledCatRows.map((r: any) => r.category_id);

          const linkedCatRows = await dbInstance.select(
            `SELECT category_id FROM playlist_category_links WHERE source_id != 'custom'`
          );
          const linkedCatIds = linkedCatRows.map((r: any) => r.category_id);

          activeNativeCategoryIds = Array.from(new Set([...enabledCatIds, ...linkedCatIds]));
        }

        const mappedStreamRows = await dbInstance.select(
          `SELECT DISTINCT stream_id FROM playlist_individual_channels`
        );
        const mappedStreamIds = mappedStreamRows.map((r: any) => r.stream_id);
        activeExplicitStreamIds = Array.from(new Set([...explicitStreamIds, ...mappedStreamIds]));

        hasNativeJoin = activeNativeCategoryIds.length > 0;
      }

      // Get source name matches for search (using cached map)
      let sourceNameMatches: string[] = [];
      if (includeSourceInSearch && sourceNameMap) {
        for (const [sourceId, sourceName] of sourceNameMap.entries()) {
          if (sourceName.toLowerCase().includes(query.toLowerCase())) {
            sourceNameMatches.push(sourceId);
          }
        }
      }

      // Split query into individual words with Cyrillic/multi-language variants for AND matching
      const { sql: wordLikeClauses, params: wordLikeParams } = buildSearchQueryClauses('c.name', query);

      let catMatchSql = '';
      let catMatchParams: any[] = [];

      const hasNative = activeNativeCategoryIds.length > 0;
      const hasExplicit = activeExplicitStreamIds.length > 0;

      if (hasNative && hasExplicit) {
        const nativePlaceholders = activeNativeCategoryIds.map(() => '?').join(',');
        const explicitPlaceholders = activeExplicitStreamIds.map(() => '?').join(',');
        catMatchSql = `AND (cat.value IN (${nativePlaceholders}) OR c.stream_id IN (${explicitPlaceholders}))`;
        catMatchParams = [...activeNativeCategoryIds, ...activeExplicitStreamIds];
      } else if (hasNative) {
        const nativePlaceholders = activeNativeCategoryIds.map(() => '?').join(',');
        catMatchSql = `AND cat.value IN (${nativePlaceholders})`;
        catMatchParams = [...activeNativeCategoryIds];
      } else if (hasExplicit) {
        const explicitPlaceholders = activeExplicitStreamIds.map(() => '?').join(',');
        catMatchSql = `AND c.stream_id IN (${explicitPlaceholders})`;
        catMatchParams = [...activeExplicitStreamIds];
      }

      // Ensure we always filter by enabled real sources
      const allEnabledSourceIds = Array.from(enabledSourceIds);
      const enabledSourcePlaceholders = allEnabledSourceIds.length > 0 ? allEnabledSourceIds.map(() => '?').join(',') : null;

      let sourceMatchSql = '';
      let sourceMatchParams: any[] = [];

      if (enabledSourcePlaceholders) {
        if (sourcePlaceholders && hasExplicit) {
          const explicitPlaceholders = activeExplicitStreamIds.map(() => '?').join(',');
          sourceMatchSql = `AND c.source_id IN (${enabledSourcePlaceholders}) AND (c.source_id IN (${sourcePlaceholders}) OR c.stream_id IN (${explicitPlaceholders})) ${catMatchSql}`;
          sourceMatchParams = [...allEnabledSourceIds, ...effectiveSourceIds, ...activeExplicitStreamIds, ...catMatchParams];
        } else if (sourcePlaceholders) {
          sourceMatchSql = `AND c.source_id IN (${enabledSourcePlaceholders}) AND c.source_id IN (${sourcePlaceholders}) ${catMatchSql}`;
          sourceMatchParams = [...allEnabledSourceIds, ...effectiveSourceIds, ...catMatchParams];
        } else if (hasExplicit) {
          const explicitPlaceholders = activeExplicitStreamIds.map(() => '?').join(',');
          sourceMatchSql = `AND c.source_id IN (${enabledSourcePlaceholders}) AND c.stream_id IN (${explicitPlaceholders})`;
          sourceMatchParams = [...allEnabledSourceIds, ...activeExplicitStreamIds];
        } else {
          sourceMatchSql = `AND c.source_id IN (${enabledSourcePlaceholders}) ${catMatchSql}`;
          sourceMatchParams = [...allEnabledSourceIds, ...catMatchParams];
        }
      }

      let filteredChannels: any[];
      const orderByClause = order === 'alphabetical' ? 'ORDER BY c.name COLLATE NOCASE ASC' : '';

      if (includeSourceInSearch && sourceNameMatches.length > 0) {
        const sourceMatchPlaceholders = sourceNameMatches.map(() => '?').join(',');
        console.log('[useChannelSearch] Building query with orderByClause:', orderByClause);
        const queryStr = `SELECT DISTINCT c.*
           FROM channels c ${hasNativeJoin ? 'CROSS JOIN json_each(c.category_ids) AS cat' : ''}
           WHERE ((${wordLikeClauses}) OR c.source_id IN (${sourceMatchPlaceholders}))
           ${sourceMatchSql}
           AND (c.enabled IS NULL OR c.enabled NOT IN (0, '0', 'false'))
           ${orderByClause}
           LIMIT ?`;
        console.log('[useChannelSearch] Full query:', queryStr);
        filteredChannels = await dbInstance.select(
          queryStr,
          [...wordLikeParams, ...sourceNameMatches, ...sourceMatchParams, limit]
        );
      } else {
        console.log('[useChannelSearch] Building query with orderByClause:', orderByClause);
        const queryStr = `SELECT DISTINCT c.*
           FROM channels c ${hasNativeJoin ? 'CROSS JOIN json_each(c.category_ids) AS cat' : ''}
           WHERE (${wordLikeClauses})
           ${sourceMatchSql}
           AND (c.enabled IS NULL OR c.enabled NOT IN (0, '0', 'false'))
           ${orderByClause}
           LIMIT ?`;
        console.log('[useChannelSearch] Full query:', queryStr);
        filteredChannels = await dbInstance.select(
          queryStr,
          [...wordLikeParams, ...sourceMatchParams, limit]
        );
      }

      // Add source_name and source_category_display to channels if includeSourceInSearch is enabled
      if (includeSourceInSearch && sourceNameMap) {
        try {
          const allCategories = await db.categories.toArray();
          const enabledCatSet = new Set(
            allCategories.filter(c => c.enabled !== false).map(c => c.category_id)
          );
          const customPlaylists = await db.customPlaylists.toArray();
          const customPlaylistMap = new Map(customPlaylists.map(p => [p.playlist_id, p.name]));
          const individualMappings = await db.playlistIndividualChannels.toArray();
          const categoryLinks = await db.playlistCategoryLinks.toArray();

          filteredChannels = filteredChannels.map(ch => {
            const sourceName = sourceNameMap.get(ch.source_id);
            let sourceCategoryDisplay: string | undefined;

            if (categoryNameMap) {
              const catIds = parseCategoryIds(ch.category_ids);
              // Find first ENABLED native category
              const enabledCatId = catIds.find(id => enabledCatSet.has(id));

              if (enabledCatId) {
                const catName = categoryNameMap.get(enabledCatId) || enabledCatId;
                sourceCategoryDisplay = sourceName ? `${sourceName} → ${catName}` : catName;
              } else {
                // No enabled native category found for this channel.
                // Check if mapped via playlistIndividualChannels
                const indiv = individualMappings.find(m => m.stream_id === ch.stream_id);
                if (indiv) {
                  const plName = customPlaylistMap.get(indiv.playlist_id) || sourceNameMap.get(indiv.playlist_id) || indiv.playlist_id;
                  let catName: string | undefined;
                  if (indiv.parent_category_id) {
                    if (indiv.parent_category_id.startsWith('link:')) {
                      const linkId = parseInt(indiv.parent_category_id.replace('link:', ''), 10);
                      const link = categoryLinks.find(l => l.id === linkId);
                      if (link) {
                        const nativeCat = allCategories.find(c => c.category_id === link.category_id);
                        catName = link.custom_name || nativeCat?.alias || nativeCat?.category_name || link.category_id;
                      }
                    } else {
                      catName = categoryNameMap.get(indiv.parent_category_id) || indiv.parent_category_id;
                    }
                  }
                  sourceCategoryDisplay = catName ? `${plName} → ${catName}` : plName;
                } else {
                  // Check if mapped via playlistCategoryLinks
                  const link = categoryLinks.find(l => catIds.includes(l.category_id));
                  if (link) {
                    const plName = customPlaylistMap.get(link.playlist_id) || sourceNameMap.get(link.playlist_id) || link.playlist_id;
                    const nativeCat = allCategories.find(c => c.category_id === link.category_id);
                    const catName = link.custom_name || nativeCat?.alias || nativeCat?.category_name || link.category_id;
                    sourceCategoryDisplay = `${plName} → ${catName}`;
                  } else if (catIds.length > 0) {
                    const catName = categoryNameMap.get(catIds[0]) || catIds[0];
                    sourceCategoryDisplay = sourceName ? `${sourceName} → ${catName}` : catName;
                  }
                }
              }
            }

            return {
              ...ch,
              source_name: sourceName || undefined,
              source_category_display: sourceCategoryDisplay
            };
          });
        } catch (e) {
          console.warn('[useChannelSearch] Failed to resolve custom playlist display names:', e);
        }
      }

      // Apply logo overrides from epg_channel_overrides and epgPreferEpgLogos setting
      try {
        const logoMap = new Map<string, string>();
        const logoBgMap = new Map<string, string>();
        const logoPaddingMap = new Map<string, string>();
        const epgIdMap = new Map<string, string>();

        // Load overrides with a single query: join on json_each over the ids so
        // there's no SQLite variable-count limit and no chunked round-trips
        // (the old loop made one IPC query per 500 channels).
        const overrideRows = await db.query<{
          stream_id: string;
          stream_icon: string | null;
          logo_background: string | null;
          logo_padding: string | null;
          epg_channel_id: string | null;
        }>(
          `SELECT stream_id, stream_icon, logo_background, logo_padding, epg_channel_id
           FROM epg_channel_overrides
           WHERE stream_id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(filteredChannels.map(ch => ch.stream_id))]
        );
        for (const o of overrideRows) {
          if (o.stream_icon) logoMap.set(o.stream_id, o.stream_icon);
          if (o.logo_background) logoBgMap.set(o.stream_id, o.logo_background);
          if (o.logo_padding) logoPaddingMap.set(o.stream_id, o.logo_padding);
          if (o.epg_channel_id) epgIdMap.set(o.stream_id, o.epg_channel_id);
        }

        let epgIconMap = new Map<string, string>();
        if (epgPreferEpgLogos) {
          try {
            // Only id/icon_url are used for the logo map — don't pull every
            // column of every EPG channel row across the IPC boundary.
            const epgChannels = await db.epgChannels.select(['id', 'icon_url']).toArray();
            for (const ec of epgChannels) {
              if (ec.icon_url) epgIconMap.set(ec.id, ec.icon_url);
            }
          } catch { /* ignore */ }

          // Query cached global EPG logos
          const epgIdsToQuery = new Set<string>();
          for (const ch of filteredChannels) {
            const epgId = epgIdMap.get(ch.stream_id) || ch.epg_channel_id;
            if (epgId) epgIdsToQuery.add(epgId);
          }

          if (window.storage && epgIdsToQuery.size > 0) {
            try {
              const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
              const cacheLinks = globalEpgLinks.filter(link => link.saveEntireEpg);
              
              if (cacheLinks.length > 0) {
                const Database = (await import('@tauri-apps/plugin-sql')).default;
                const idsArray = Array.from(epgIdsToQuery);
                
                for (const link of cacheLinks) {
                  try {
                    const cacheDbName = `epg_cache_${link.id}`;
                    const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
                    
                    const CHUNK_SIZE = 500;
                    for (let idx = 0; idx < idsArray.length; idx += CHUNK_SIZE) {
                      const chunk = idsArray.slice(idx, idx + CHUNK_SIZE);
                      const placeholders = chunk.map((_, i) => `$${i + 1}`).join(',');
                      
                      const rows = await cacheDb.select(
                        `SELECT id, icon_url FROM epg_channels WHERE id IN (${placeholders})`,
                        chunk
                      ) as { id: string; icon_url: string | null }[];
                      
                      for (const r of rows) {
                        if (r.icon_url) epgIconMap.set(r.id, r.icon_url);
                      }
                    }
                  } catch { /* ignore */ }
                }
              }
            } catch { /* ignore */ }
          }
        }

        filteredChannels = filteredChannels.map(ch => {
          const customIcon = logoMap.get(ch.stream_id);
          const logoBg = logoBgMap.get(ch.stream_id);
          const logoPad = logoPaddingMap.get(ch.stream_id);
          let effectiveIcon = customIcon;

          if (!effectiveIcon && epgPreferEpgLogos) {
            const epgId = epgIdMap.get(ch.stream_id) || ch.epg_channel_id;
            if (epgId && epgIconMap.has(epgId)) {
              effectiveIcon = epgIconMap.get(epgId);
            }
          }

          if (effectiveIcon || logoBg !== undefined || logoPad !== undefined) {
            return {
              ...ch,
              ...(effectiveIcon ? { stream_icon: effectiveIcon } : {}),
              ...(logoBg !== undefined ? { logo_background: logoBg } : {}),
              ...(logoPad !== undefined ? { logo_padding: logoPad } : {}),
            };
          }
          return ch;
        });
      } catch { /* ignore */ }

      console.log('[useChannelSearch] Returning', filteredChannels.length, 'channels, first few:', filteredChannels.slice(0, 3).map((c: any) => c.name));

      return filteredChannels as StoredChannel[];
    },
    [query, limit, includeSourceInSearch, order, sourceNameMap, categoryNameMap, enabledSourceKey, filterKey, epgPreferEpgLogos],
    undefined, // defaultResult
    0, // staleTime
    // Watch only the tables this search reads (channels, category/link lookup
    // tables, logo overrides); unrelated writes (programs, watch progress,
    // VOD tables) shouldn't re-run the search. NOTE: raw SQLite table names.
    [
      'channels',
      'categories',
      'playlist_category_links',
      'playlist_individual_channels',
      'custom_playlists',
      'epg_channel_overrides',
      ...(epgPreferEpgLogos ? ['epg_channels'] : []),
    ]
  );
  return channels ?? [];
}


// Hook to search programs (EPG) by title - only searches enabled categories
// Optionally filter by specific sourceIds and categoryIds
export function useProgramSearch(
  query: string,
  limit = 50,
  order: 'default' | 'alphabetical' = 'default',
  filterSourceIds?: string[],
  filterCategoryIds?: string[]
) {
  const enabledSourceIds = useEnabledSources();

  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );

  const filterKey = useMemo(
    () => `${filterSourceIds?.sort().join(',') || 'all'}_${filterCategoryIds?.sort().join(',') || 'all'}`,
    [filterSourceIds, filterCategoryIds]
  );

  const programs = useLiveQuery(
    async () => {
      if (!query || query.length < 2) {
        return [];
      }

      console.log('[useProgramSearch] order parameter:', order);

      if (!enabledSourceIds || enabledSourceIds.size === 0) {
        return [];
      }

      const dbInstance = await (db as any).dbPromise;

      // Determine which source IDs to use: intersection of enabled and filtered
      let effectiveSourceIds: string[];
      if (filterSourceIds && filterSourceIds.length > 0) {
        const realFilters = filterSourceIds.filter(id => !id.startsWith('playlist:'));
        if (realFilters.length > 0) {
          effectiveSourceIds = realFilters.filter(id => enabledSourceIds.has(id));
        } else {
          effectiveSourceIds = Array.from(enabledSourceIds);
        }
      } else {
        effectiveSourceIds = Array.from(enabledSourceIds);
      }

      // Resolve category filters (including custom categories & category links)
      const { nativeCategoryIds, explicitStreamIds, extraRealSourceIds } =
        await resolveSearchCategoryFilters(filterCategoryIds, filterSourceIds);

      for (const extraId of extraRealSourceIds) {
        if (enabledSourceIds.has(extraId) && !effectiveSourceIds.includes(extraId)) {
          effectiveSourceIds.push(extraId);
        }
      }

      const sourcePlaceholders = effectiveSourceIds.length > 0
        ? effectiveSourceIds.map(() => '?').join(',')
        : null;

      const isFilteredBySourceOrCategory = Boolean(
        (filterSourceIds && filterSourceIds.length > 0) ||
        (filterCategoryIds && filterCategoryIds.length > 0)
      );

      let activeNativeCategoryIds = nativeCategoryIds;
      let activeExplicitStreamIds = explicitStreamIds;

      if (isFilteredBySourceOrCategory) {
        activeNativeCategoryIds = nativeCategoryIds;
        activeExplicitStreamIds = explicitStreamIds;
      } else {
        // General search across enabled categories + custom mapped streams
        if (sourcePlaceholders) {
          const enabledCatRows = await dbInstance.select(
            `SELECT category_id FROM categories 
             WHERE source_id IN (${sourcePlaceholders}) 
             AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`,
            effectiveSourceIds
          );
          const enabledCatIds = enabledCatRows.map((r: any) => r.category_id);

          const linkedCatRows = await dbInstance.select(
            `SELECT category_id FROM playlist_category_links WHERE source_id != 'custom'`
          );
          const linkedCatIds = linkedCatRows.map((r: any) => r.category_id);

          activeNativeCategoryIds = Array.from(new Set([...enabledCatIds, ...linkedCatIds]));
        }

        const mappedStreamRows = await dbInstance.select(
          `SELECT DISTINCT stream_id FROM playlist_individual_channels`
        );
        const mappedStreamIds = mappedStreamRows.map((r: any) => r.stream_id);
        activeExplicitStreamIds = Array.from(new Set([...explicitStreamIds, ...mappedStreamIds]));
      }

      const hasNative = activeNativeCategoryIds.length > 0;
      const hasExplicit = activeExplicitStreamIds.length > 0;

      let channelSubquery: string;

      let catMatchSql = '';
      let catMatchParams: any[] = [];

      if (hasNative && hasExplicit) {
        const nativePlaceholders = activeNativeCategoryIds.map(() => '?').join(',');
        const explicitPlaceholders = activeExplicitStreamIds.map(() => '?').join(',');
        catMatchSql = `AND (cat.value IN (${nativePlaceholders}) OR c.stream_id IN (${explicitPlaceholders}))`;
        catMatchParams = [...activeNativeCategoryIds, ...activeExplicitStreamIds];
      } else if (hasNative) {
        const nativePlaceholders = activeNativeCategoryIds.map(() => '?').join(',');
        catMatchSql = `AND cat.value IN (${nativePlaceholders})`;
        catMatchParams = [...activeNativeCategoryIds];
      } else if (hasExplicit) {
        const explicitPlaceholders = activeExplicitStreamIds.map(() => '?').join(',');
        catMatchSql = `AND c.stream_id IN (${explicitPlaceholders})`;
        catMatchParams = [...activeExplicitStreamIds];
      }

      const allEnabledSourceIds = Array.from(enabledSourceIds);
      const enabledSourcePlaceholders = allEnabledSourceIds.length > 0 ? allEnabledSourceIds.map(() => '?').join(',') : null;

      let sourceMatchSql = '';
      let sourceMatchParams: any[] = [];

      if (enabledSourcePlaceholders) {
        if (sourcePlaceholders && hasExplicit) {
          const explicitPlaceholders = activeExplicitStreamIds.map(() => '?').join(',');
          sourceMatchSql = `WHERE c.source_id IN (${enabledSourcePlaceholders}) AND (c.source_id IN (${sourcePlaceholders}) OR c.stream_id IN (${explicitPlaceholders})) ${catMatchSql}`;
          sourceMatchParams = [...allEnabledSourceIds, ...effectiveSourceIds, ...activeExplicitStreamIds, ...catMatchParams];
        } else if (sourcePlaceholders) {
          sourceMatchSql = `WHERE c.source_id IN (${enabledSourcePlaceholders}) AND c.source_id IN (${sourcePlaceholders}) ${catMatchSql}`;
          sourceMatchParams = [...allEnabledSourceIds, ...effectiveSourceIds, ...catMatchParams];
        } else if (hasExplicit) {
          const explicitPlaceholders = activeExplicitStreamIds.map(() => '?').join(',');
          sourceMatchSql = `WHERE c.source_id IN (${enabledSourcePlaceholders}) AND c.stream_id IN (${explicitPlaceholders})`;
          sourceMatchParams = [...allEnabledSourceIds, ...activeExplicitStreamIds];
        } else {
          sourceMatchSql = `WHERE c.source_id IN (${enabledSourcePlaceholders}) ${catMatchSql}`;
          sourceMatchParams = [...allEnabledSourceIds, ...catMatchParams];
        }
      }

      channelSubquery = `
        SELECT DISTINCT c.stream_id${order === 'alphabetical' ? ', c.name' : ''}
        FROM channels c ${hasNative ? ', json_each(c.category_ids) AS cat' : ''}
        ${sourceMatchSql}
        ${sourceMatchSql ? 'AND' : 'WHERE'} (c.enabled IS NULL OR c.enabled NOT IN (0, '0', 'false'))
      `;

      // Split query into individual words with Cyrillic/multi-language variants for AND matching across all words
      const queryWords = query.trim().split(/\s+/).filter(w => w.length > 0);
      const wordSqlParts: string[] = [];
      const wordLikeParams: string[] = [];
      for (const word of queryWords) {
        const variants = getSearchVariants(word);
        const fieldClauses: string[] = [];
        for (const v of variants) {
          fieldClauses.push(`p.title LIKE ?`, `p.subtitle LIKE ?`);
          wordLikeParams.push(`%${v}%`, `%${v}%`);
        }
        wordSqlParts.push(`(${fieldClauses.join(' OR ')})`);
      }
      const wordLikeClauses = wordSqlParts.join(' AND ');

      const nowIso = new Date().toISOString();
      const orderByClause = order === 'alphabetical' 
        ? 'ORDER BY c.name COLLATE NOCASE ASC, p.start ASC' 
        : '';
      console.log('[useProgramSearch] Building query with orderByClause:', orderByClause);
      
      const programResults = order === 'alphabetical'
        ? await dbInstance.select(
            `SELECT p.*, c.name as channel_name
             FROM programs_effective p
             INNER JOIN (
               ${channelSubquery}
             ) c ON p.stream_id = c.stream_id
             WHERE (${wordLikeClauses}) AND p.end > ?
             ${orderByClause}
             LIMIT ?`,
            [...sourceMatchParams, ...wordLikeParams, nowIso, limit * 2]
          )
        : await dbInstance.select(
            `SELECT p.* 
             FROM programs_effective p
             INNER JOIN (
               ${channelSubquery}
             ) ec ON p.stream_id = ec.stream_id
             WHERE (${wordLikeClauses}) AND p.end > ?
             LIMIT ?`,
            [...sourceMatchParams, ...wordLikeParams, nowIso, limit * 2]
          );
      console.log('[useProgramSearch] Query returned', programResults.length, 'results');

      // Step 4: Decompress descriptions for exactly the valid programs
      const filteredPrograms: StoredProgram[] = [];
      for (const prog of programResults) {
        filteredPrograms.push({
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        });
        if (filteredPrograms.length >= limit) break;
      }

      console.log('[useProgramSearch] Returning', filteredPrograms.length, 'programs, first few channel names:', filteredPrograms.slice(0, 3).map((p: any) => p.channel_name || 'N/A'));

      return filteredPrograms;
    },
    [query, limit, order, enabledSourceKey, filterKey],
    undefined, // defaultResult
    0, // staleTime: 0 - always refresh on search
    'programs' // tableName: only re-run when programs table changes
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
  const categorySortOrder = useCategorySortOrder();

  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );

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
            SELECT cc.category_id as cat_id, COUNT(*) as cnt
            FROM channel_categories cc
            JOIN channels c ON c.stream_id = cc.stream_id
            WHERE cc.source_id IN (${sourcePlaceholders})
            AND (c.enabled IS NULL OR c.enabled != 0)
            GROUP BY cc.category_id
          `;
          countParams = sourceIdsList;
        } else {
          countQuery = `
            SELECT cc.category_id as cat_id, COUNT(*) as cnt
            FROM channel_categories cc
            JOIN channels c ON c.stream_id = cc.stream_id
            WHERE (c.enabled IS NULL OR c.enabled != 0)
            GROUP BY cc.category_id
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

      // Sort INDIVIDUAL categories inside each source based on user preference
      Object.values(grouped).forEach(cats => {
        if (categorySortOrder === 'alphabetical') {
          cats.sort((a, b) => (a.alias || a.category_name).localeCompare(b.alias || b.category_name));
        } else {
          // Default: use display_order if available, otherwise alphabetical
          cats.sort((a, b) => {
            if (a.display_order !== undefined && b.display_order !== undefined) {
              return a.display_order - b.display_order;
            }
            if (a.display_order !== undefined) return -1;
            if (b.display_order !== undefined) return 1;
            return (a.alias || a.category_name).localeCompare(b.alias || b.category_name);
          });
        }
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
    [enabledSourceKey, version, categorySortOrder],
    undefined, // defaultResult
    0, // staleTime
    // Reads categories + channels (count join) and source order from storage
    // (covered by the `version` dep). Scoped so EPG/VOD writes don't re-run it.
    ['categories', 'channels']
  );

  return data ?? [];
}

// Hook to get categories with their channel counts (filtered by enabled sources)
export function useCategoriesWithCounts(): CategoryWithCount[] {
  const enabledSourceIds = useEnabledSources();
  const enabledSourceKey = useMemo(
    () => (enabledSourceIds ? Array.from(enabledSourceIds).sort().join(',') : 'loading'),
    [enabledSourceIds]
  );
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
          SELECT cc.category_id as cat_id, COUNT(*) as cnt
          FROM channel_categories cc
          JOIN channels c ON c.stream_id = cc.stream_id
          GROUP BY cc.category_id
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
    [enabledSourceKey],
    undefined, // defaultResult
    0, // staleTime
    ['categories', 'channels'] // only tables this query reads
  );
  return data ?? [];
}

/**
 * Schedules re-querying at a programme boundary: returns a `refreshTick` that
 * increments shortly after `boundaryTime` passes, and a `scheduleBoundaryRefresh`
 * call that re-schedules based on the latest programme result. This is needed
 * because the EPG queries are time-based (start <= now < end) but the live-query
 * hook only re-runs on channel changes or DB events, so without this the overlay
 * would keep showing the previous programme after it ends.
 *
 * Some EPG providers also ship overlapping programmes (a filler block spanning a
 * whole morning alongside the real show, or near-duplicate rows shifted by an
 * hour). When a newer programme starts mid-way through the one already resolved,
 * the boundary timer armed at the old programme's end won't fire for a long
 * time, so a periodic re-query is needed too — otherwise the overlay keeps
 * showing the programme that was current when it last queried (the "previous"
 * one). 60s matches the guide's own current-time tick.
 */
function useBoundaryRefresh(): [number, (boundaryTime: Date | string | number | null | undefined) => void] {
  const [refreshTick, setRefreshTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Periodic re-query so schedule changes that don't align with the current
  // programme's end (e.g. an overlapping programme starting mid-air) are
  // picked up within a minute instead of at the stale programme's boundary.
  useEffect(() => {
    const interval = setInterval(() => setRefreshTick((t) => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  const scheduleBoundaryRefresh = useCallback((boundaryTime: Date | string | number | null | undefined) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (boundaryTime == null) return;

    // Small buffer so we re-query after the old programme is fully past and
    // the next one is definitely queryable (start <= now).
    const delay = new Date(boundaryTime).getTime() - Date.now() + 2000;
    if (delay <= 0 || delay > 2147483647) return;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRefreshTick((t) => t + 1);
    }, delay);
  }, []);

  useEffect(() => () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return [refreshTick, scheduleBoundaryRefresh];
}

// Hook to get current program for a channel
export function useCurrentProgram(streamId: string | null): StoredProgram | null {
  const [refreshTick, scheduleBoundaryRefresh] = useBoundaryRefresh();

  const program = useLiveQuery(
    async () => {
      if (!streamId) return null;
      const now = Date.now();
      const fromIso = new Date(now - EPG_WINDOW_BACK_MS).toISOString();
      const toIso = new Date(now + EPG_WINDOW_FWD_MS).toISOString();

      // Query programs_effective so overrides + custom programs are reflected
      const dbInstance = await (db as any).dbPromise;
      const rows = await dbInstance.select(
        `SELECT * FROM programs_effective
         WHERE stream_id = ? AND start < ? AND end > ?`,
        [streamId, toIso, fromIso]
      ) as StoredProgram[];

      const prog = pickCurrentProgram(rows, now);
      if (prog) {
        return {
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        };
      }
      return null;
    },
    // refreshTick re-runs the query just after the programme's scheduled end,
    // so the overlay/now-playing info rolls over to the next programme
    // without needing a channel zap or EPG refresh.
    [streamId, refreshTick]
  );

  // Re-arm the boundary timer whenever the current programme changes.
  useEffect(() => {
    scheduleBoundaryRefresh(program?.end);
  }, [program, scheduleBoundaryRefresh]);

  return program ?? null;
}

// Hook to get the program airing after the current one on a channel
export function useNextProgram(streamId: string | null): StoredProgram | null {
  const [refreshTick, scheduleBoundaryRefresh] = useBoundaryRefresh();

  const program = useLiveQuery(
    async () => {
      if (!streamId) return null;
      const now = Date.now();
      const fromIso = new Date(now - EPG_WINDOW_BACK_MS).toISOString();
      const toIso = new Date(now + EPG_WINDOW_FWD_MS).toISOString();
      const dbInstance = await (db as any).dbPromise;

      const rows = await dbInstance.select(
        `SELECT * FROM programs_effective
         WHERE stream_id = ? AND start < ? AND end > ?`,
        [streamId, toIso, fromIso]
      ) as StoredProgram[];

      // Reference point for "next": the end of the programme currently airing,
      // falling back to now when nothing is airing.
      const current = pickCurrentProgram(rows, now);
      const afterMs = current ? epgTimeMs(current.end) : now;

      // Next programme = the one with the earliest start at/after that point.
      let prog: StoredProgram | null = null;
      let nextStartMs = Infinity;
      for (const row of rows) {
        const startMs = epgTimeMs(row.start);
        if (Number.isFinite(startMs) && startMs >= afterMs && startMs < nextStartMs) {
          prog = row;
          nextStartMs = startMs;
        }
      }

      if (prog) {
        return {
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        };
      }
      return null;
    },
    // Refresh just after the next programme's scheduled start, when the
    // current one has ended and a new "next" programme becomes available.
    [streamId, refreshTick]
  );

  // Re-arm the boundary timer whenever the next programme changes.
  useEffect(() => {
    scheduleBoundaryRefresh(program?.start);
  }, [program, scheduleBoundaryRefresh]);

  return program ?? null;
}

// Chunk size for SQLite IN clause limit (SQLite default max is 999, use 500 for safety)
const SQL_CHUNK_SIZE = 500;
// Upper bound on channels whose programs the merge cache may retain. Keeps the
// lazy-window benefit (small in-memory footprint) intact while still covering
// several scroll windows of adjacent channels.
const MAX_MERGED_PROGRAM_CHANNELS = 2000;

// Hook to get all programs for channels within a time range (for EPG grid)
export function useProgramsInRange(
  streamIds: string[],
  windowStart: Date,
  windowEnd: Date,
  options?: { skip?: boolean }
): Map<string, StoredProgram[]> {
  const skip = options?.skip ?? false;
  // Merge cache (mirrors usePrograms): keeps the previous window's programs so
  // scrolling the channel list back up renders instantly instead of a
  // blank-then-refill. Two guards:
  // 1. Keyed by the TIME window — when the grid's visible time range changes
  //    (goBack/goForward), cached data belongs to a different window and must
  //    NOT be merged (stale times would render).
  // 2. Bounded — only channels near the current window are retained, so
  //    scrolling a huge library doesn't accumulate every channel's programs in
  //    memory (which would defeat the lazy-EPG memory win).
  const prevRef = useRef<{ startMs: number; endMs: number; map: Map<string, StoredProgram[]> } | null>(null);

  const programs = useLiveQuery(
    async () => {
      if (skip || streamIds.length === 0) {
        // Never resurrect a stale window after a skip (or while nothing is
        // requested); the next real run starts from a clean slate.
        prevRef.current = null;
        return new Map<string, StoredProgram[]>();
      }

      const startIso = windowStart.toISOString();
      const endIso = windowEnd.toISOString();
      const startMs = windowStart.getTime();
      const endMs = windowEnd.getTime();

      const prev = prevRef.current;
      const sameTimeWindow = prev !== null && prev.startMs === startMs && prev.endMs === endMs;

      // Seed from the previous run only when the time window is unchanged;
      // null out the current window's ids so channels with no (or changed) EPG
      // don't keep stale rows, then refill them from the query below.
      const result = sameTimeWindow ? new Map(prev!.map) : new Map<string, StoredProgram[]>();
      for (const id of streamIds) result.set(id, []);

      // Query programs_effective in chunks to respect SQLite variable limit
      const dbInstance = await (db as any).dbPromise;
      const allPrograms: StoredProgram[] = [];
      for (let i = 0; i < streamIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = streamIds.slice(i, i + SQL_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await dbInstance.select(
          `SELECT * FROM programs_effective
           WHERE stream_id IN (${placeholders})
             AND start < ? AND end > ?
           ORDER BY start ASC`,
          [...chunk, endIso, startIso]
        ) as StoredProgram[];
        allPrograms.push(...rows);
      }

      for (const prog of allPrograms) {
        const existing = result.get(prog.stream_id) ?? [];
        existing.push({
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        });
        result.set(prog.stream_id, existing);
      }

      // Bound the merge cache: drop out-of-window channels (FIFO by insertion
      // order) until we're back under the cap.
      if (result.size > MAX_MERGED_PROGRAM_CHANNELS) {
        const currentIds = new Set(streamIds);
        for (const id of result.keys()) {
          if (result.size <= MAX_MERGED_PROGRAM_CHANNELS) break;
          if (!currentIds.has(id)) result.delete(id);
        }
      }

      // Sort only the current window's arrays; merged arrays are already sorted
      // and never mutate after being cached.
      for (const id of streamIds) {
        const progs = result.get(id);
        if (!progs) continue;
        progs.sort((a, b) => {
          const aStart = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
          const bStart = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
          return aStart - bStart;
        });
      }

      prevRef.current = { startMs, endMs, map: result };
      return result;
    },
    [streamIds.join(','), windowStart.getTime(), windowEnd.getTime(), skip],
    undefined, // defaultResult
    0, // staleTime
    // Only re-run when programs change — this hook reads programs_effective
    // exclusively, so unrelated DB writes shouldn't re-query it.
    'programs'
  );

  return programs ?? new Map();
}

// Hook to get programs for a list of channel IDs (queries local DB - EPG is synced upfront)
export function usePrograms(streamIds: string[]): Map<string, StoredProgram | null> {
  // Reference to the last returned map. Two jobs:
  // 1. MERGE, not replace: each live-query run only fetches the CURRENT
  //    window of ids, but the map persists across runs. Without this, rows
  //    that scrolled out of the window lose their entry (map is rebuilt with
  //    only the current window), and scrolling back to a range that was
  //    already queried doesn't re-run the query at all (the live-query deps
  //    are the id join, which is unchanged) — leaving those rows blank until
  //    the user scrolls somewhere new. With merge, channels keep their
  //    program and it's instantly available when they come back into view.
  // 2. STABILIZE references: fresh program objects are rebuilt from SQLite
  //    every run. Memoized rows (e.g. the alternate view's channel strip)
  //    compare programs by object identity, so reusing the previous object
  //    for an unchanged program (same id + times) keeps those rows still.
  const prevResultRef = useRef<Map<string, StoredProgram | null> | null>(null);

  const programs = useLiveQuery(
    async () => {
      if (streamIds.length === 0) return new Map();
      const now = Date.now();
      const fromIso = new Date(now - EPG_WINDOW_BACK_MS).toISOString();
      const toIso = new Date(now + EPG_WINDOW_FWD_MS).toISOString();
      // Start from the previous merged map so out-of-window channels keep
      // their program; null out the current window's ids so a channel that
      // no longer airs anything (or never had EPG) drops its stale program.
      const result = new Map<string, StoredProgram | null>(prevResultRef.current ?? []);
      for (const id of streamIds) result.set(id, null);

      const dbInstance = await (db as any).dbPromise;
      const allPrograms: StoredProgram[] = [];
      for (let i = 0; i < streamIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = streamIds.slice(i, i + SQL_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await dbInstance.select(
          `SELECT * FROM programs_effective
           WHERE stream_id IN (${placeholders})
             AND start < ? AND end > ?`,
          [...chunk, toIso, fromIso]
        ) as StoredProgram[];
        allPrograms.push(...rows);
      }

      // Latest-start programme covering `now` per channel, picked in JS so
      // mixed timestamp formats compare correctly.
      const prevResult = prevResultRef.current;
      const bestStart = new Map<string, number>();
      for (const prog of allPrograms) {
        const startMs = epgTimeMs(prog.start);
        const endMs = epgTimeMs(prog.end);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > now || endMs <= now) continue;
        const prev = bestStart.get(prog.stream_id);
        if (prev === undefined || startMs > prev) {
          bestStart.set(prog.stream_id, startMs);
          // Keep the previous object reference when this channel's current
          // program is unchanged, so memoized consumers skip re-rendering.
          const prevProg = prevResult?.get(prog.stream_id);
          result.set(
            prog.stream_id,
            prevProg && prevProg.id === prog.id
              ? epgTimeMs(prevProg.start) === startMs && epgTimeMs(prevProg.end) === endMs
                ? prevProg
                : prog
              : prog
          );
        }
      }

      prevResultRef.current = result;
      return result;
    },
    [streamIds.join(',')],
    undefined, // defaultResult
    0, // staleTime: 0 - time window changes need fresh data
    'programs' // tableName: only re-run when programs table changes
  );
  return programs ?? new Map();
}

// Hook to get ALL programs for channels (loads everything at once, no lazy loading by time window)
// Use this instead of useProgramsInRange when you want to load all EPG data upfront
export function useAllPrograms(
  streamIds: string[],
  options?: { skip?: boolean }
): Map<string, StoredProgram[]> {
  const skip = options?.skip ?? false;
  const programs = useLiveQuery(
    async () => {
      if (skip || streamIds.length === 0) return new Map<string, StoredProgram[]>();

      const result = new Map<string, StoredProgram[]>();
      for (const id of streamIds) result.set(id, []);

      const dbInstance = await (db as any).dbPromise;
      const allPrograms: StoredProgram[] = [];
      for (let i = 0; i < streamIds.length; i += SQL_CHUNK_SIZE) {
        const chunk = streamIds.slice(i, i + SQL_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = await dbInstance.select(
          `SELECT * FROM programs_effective
           WHERE stream_id IN (${placeholders})
           ORDER BY start ASC`,
          chunk
        ) as StoredProgram[];
        allPrograms.push(...rows);
      }

      for (const prog of allPrograms) {
        const existing = result.get(prog.stream_id) ?? [];
        existing.push({
          ...prog,
          description: decompressEpgDescription(prog.description) ?? prog.description,
        });
        result.set(prog.stream_id, existing);
      }

      // Already sorted by ORDER BY above, but keep sort for safety on merge
      for (const [, progs] of result) {
        progs.sort((a, b) => {
          const aStart = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
          const bStart = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
          return aStart - bStart;
        });
      }

      return result;
    },
    [streamIds.join(','), skip],
    undefined, // defaultResult
    0, // staleTime: 0 - streamIds changes need fresh data
    'programs' // tableName: only re-run when programs table changes
  );
  return programs ?? new Map();
}
