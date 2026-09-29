/**
 * Session state for the Stalker Server Search view.
 *
 * The search is a paginated network walk, so its result set must survive leaving the
 * page: opening a movie/series detail, playing and stopping, or switching tabs all
 * unmount the view. The VOD category selection already lives in uiStore (which resets
 * on app restart), so the results live here for the same lifetime — in memory, not on
 * disk, because a result set is a view of the provider's catalogue rather than user data.
 */

import { create } from 'zustand';
import type { StalkerServerSearchPage } from '../services/stalkerServerSearch';

export type StalkerSearchType = 'movies' | 'series';

/** Sentinel category id used by the VOD sidebar/selected category state for this view. */
export const STALKER_SERVER_SEARCH_ID = '__stalker_server_search__';

export interface StalkerSearchSlice {
  /** Selected portal; '' until the source list loads and a default is picked. '*' = All Stalker sources. */
  sourceId: string;
  /** '*' = whole library, otherwise the app-namespaced category id. */
  categoryId: string;
  query: string;
  /** null until a search has been run for the current selection. */
  result: StalkerServerSearchPage | null;
  /** Per-source search page results when searching all sources or individual source. Keyed by sourceId. */
  sourceResults?: Record<string, StalkerServerSearchPage>;
  /** Pages loaded per source when searching all sources. Keyed by sourceId. */
  sourcePagesLoaded?: Record<string, number>;
  /** Selected results tab: 'all' or a specific sourceId. */
  activeTab?: string;
  /** Pages walked so far, used to bound "Load all". */
  pagesLoaded: number;
}

const emptySlice = (): StalkerSearchSlice => ({
  sourceId: '',
  categoryId: '*',
  query: '',
  result: null,
  sourceResults: {},
  sourcePagesLoaded: {},
  activeTab: 'all',
  pagesLoaded: 0,
});

interface StalkerSearchStore {
  byType: Record<StalkerSearchType, StalkerSearchSlice>;
  patch: (type: StalkerSearchType, partial: Partial<StalkerSearchSlice>) => void;
  reset: (type: StalkerSearchType) => void;
}

export const useStalkerSearchStore = create<StalkerSearchStore>()((set) => ({
  byType: { movies: emptySlice(), series: emptySlice() },

  patch: (type, partial) =>
    set((state) => ({
      byType: { ...state.byType, [type]: { ...state.byType[type], ...partial } },
    })),

  reset: (type) =>
    set((state) => ({ byType: { ...state.byType, [type]: emptySlice() } })),
}));
