import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { vodCategories, toArray, equals } = vi.hoisted(() => ({
  vodCategories: { where: vi.fn() },
  toArray: vi.fn(async () => [] as any[]),
  equals: vi.fn(),
}));

vi.mock('@ynotv/local-adapter', () => ({ StalkerClient: class {} }));
vi.mock('../../db', () => ({ db: { vodCategories } }));
vi.mock('../../db/sync', () => ({ storeStalkerServerSearchHits: vi.fn() }));

import {
  getAllStalkerSearchCategoryNames,
  mergeStalkerServerSearchPages,
  type StalkerServerSearchPage,
} from '../stalkerServerSearch';
import { useStalkerSearchStore } from '../../stores/stalkerSearchStore';

const categoriesAnswer = (rows: any[]) => {
  toArray.mockResolvedValue(rows);
  equals.mockReset().mockReturnValue({ toArray });
  vodCategories.where.mockReset().mockReturnValue({ equals });
};

beforeEach(() => {
  vodCategories.where.mockReset();
  equals.mockReset();
  toArray.mockReset().mockResolvedValue([]);
  useStalkerSearchStore.getState().reset('movies');
  useStalkerSearchStore.getState().reset('series');
});

describe('getAllStalkerSearchCategoryNames', () => {
  it('aggregates category names across all Stalker sources', async () => {
    categoriesAnswer([
      { source_id: 'srcA', category_id: 'srcA_vod_1', name: 'Action', type: 'movie' },
      { source_id: 'srcB', category_id: 'srcB_vod_2', name: 'Comedy', type: 'movie' },
      { source_id: 'srcC', category_id: 'srcC_vod_3', name: 'Drama', type: 'movie' },
      // Category with empty name should be skipped
      { source_id: 'srcA', category_id: 'srcA_vod_4', name: '', type: 'movie' },
    ]);

    const names = await getAllStalkerSearchCategoryNames('movies');
    expect(names).toEqual({
      srcA_vod_1: 'Action',
      srcB_vod_2: 'Comedy',
      srcC_vod_3: 'Drama',
    });
  });
});

describe('mergeStalkerServerSearchPages', () => {
  it('merges rows from multiple sources, sorts alphabetically, and deduplicates', () => {
    const pageA: StalkerServerSearchPage = {
      rows: [
        { stream_id: 'srcA_vod_10', name: 'The Matrix', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcA' } as any,
        { stream_id: 'srcA_vod_20', name: 'Avatar', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcA' } as any,
      ],
      total: 2,
      shown: 2,
      nextPage: 1,
      hasMore: true,
      unsupported: false,
      phrase: 'film',
      matchKind: 'verbatim',
      endpoint: 'vod',
    };

    const pageB: StalkerServerSearchPage = {
      rows: [
        // Duplicate row id safety check
        { stream_id: 'srcA_vod_20', name: 'Avatar', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcB' } as any,
        { stream_id: 'srcB_vod_30', name: 'Inception', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcB' } as any,
      ],
      total: 2,
      shown: 2,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'film',
      matchKind: 'verbatim',
      endpoint: 'vod',
    };

    const merged = mergeStalkerServerSearchPages({ srcA: pageA, srcB: pageB }, 'film');
    expect(merged.shown).toBe(3);
    expect(merged.rows.map(r => r.name)).toEqual(['Avatar', 'Inception', 'The Matrix']);
    expect(merged.total).toBe(4);
    expect(merged.hasMore).toBe(true);
    expect(merged.unsupported).toBe(false);
    expect(merged.matchKind).toBe('verbatim');
  });

  it('keeps distinct source-namespaced ids across portals', () => {
    const pageA: StalkerServerSearchPage = {
      rows: [
        { stream_id: 'srcA_vod_1', name: 'Title A', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcA' } as any,
      ],
      total: 1,
      shown: 1,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'test',
      matchKind: 'verbatim',
      endpoint: 'vod',
    };
    const pageB: StalkerServerSearchPage = {
      rows: [
        { stream_id: 'srcB_vod_1', name: 'Title B', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcB' } as any,
      ],
      total: 1,
      shown: 1,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'test',
      matchKind: 'verbatim',
      endpoint: 'vod',
    };

    const merged = mergeStalkerServerSearchPages({ srcA: pageA, srcB: pageB }, 'test');
    expect(merged.shown).toBe(2);
    expect(merged.rows.map(r => (r as any).stream_id)).toEqual(['srcA_vod_1', 'srcB_vod_1']);
  });

  it('excludes rows and totals from unsupported portals', () => {
    const supportedPage: StalkerServerSearchPage = {
      rows: [
        { stream_id: '1', name: 'Die Hard', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcA' } as any,
      ],
      total: 1,
      shown: 1,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'die hard',
      matchKind: 'verbatim',
      endpoint: 'vod',
    };

    const unsupportedPage: StalkerServerSearchPage = {
      rows: [
        { stream_id: '99', name: 'Browse Item 1', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcB' } as any,
        { stream_id: '98', name: 'Browse Item 2', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcB' } as any,
      ],
      total: 1000,
      shown: 2,
      nextPage: 1,
      hasMore: true,
      unsupported: true,
      phrase: 'die hard',
      matchKind: 'all-words',
      endpoint: 'vod',
    };

    const merged = mergeStalkerServerSearchPages({ srcA: supportedPage, srcB: unsupportedPage }, 'die hard');
    expect(merged.shown).toBe(1);
    expect(merged.rows.map(r => r.name)).toEqual(['Die Hard']);
    expect(merged.total).toBe(1);
    expect(merged.hasMore).toBe(false);
    expect(merged.unsupported).toBe(false);
  });

  it('excludes portals with error from merged rows and total', () => {
    const goodPage: StalkerServerSearchPage = {
      rows: [
        { stream_id: '1', name: 'Alien', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcA' } as any,
      ],
      total: 1,
      shown: 1,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'alien',
      matchKind: 'verbatim',
      endpoint: 'vod',
    };

    const errorPage: StalkerServerSearchPage = {
      rows: [],
      total: 0,
      shown: 0,
      nextPage: 0,
      hasMore: false,
      unsupported: false,
      phrase: 'alien',
      matchKind: 'all-words',
      endpoint: 'vod',
      error: 'Network timeout',
    };

    const merged = mergeStalkerServerSearchPages({ srcA: goodPage, srcB: errorPage }, 'alien');
    expect(merged.shown).toBe(1);
    expect(merged.rows[0].name).toBe('Alien');
    expect(merged.total).toBe(1);
    expect(merged.unsupported).toBe(false);
  });

  it('marks unsupported as true only if all portals are unsupported', () => {
    const unsupp1: StalkerServerSearchPage = {
      rows: [],
      total: 0,
      shown: 0,
      nextPage: 0,
      hasMore: false,
      unsupported: true,
      phrase: 'test',
      matchKind: 'all-words',
      endpoint: 'vod',
    };
    const unsupp2: StalkerServerSearchPage = {
      rows: [],
      total: 0,
      shown: 0,
      nextPage: 0,
      hasMore: false,
      unsupported: true,
      phrase: 'test',
      matchKind: 'all-words',
      endpoint: 'vod',
    };

    const merged = mergeStalkerServerSearchPages({ a: unsupp1, b: unsupp2 }, 'test');
    expect(merged.unsupported).toBe(true);
  });

  it('resolves matchKind: verbatim wins if any portal matched verbatim', () => {
    const verbatimPage: StalkerServerSearchPage = {
      rows: [{ stream_id: '1', name: 'Spider-Man 2', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcA' } as any],
      total: 1,
      shown: 1,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'spider man',
      matchKind: 'verbatim',
      endpoint: 'vod',
    };

    const allWordsPage: StalkerServerSearchPage = {
      rows: [{ stream_id: '2', name: 'The Amazing Spider-Man', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcB' } as any],
      total: 1,
      shown: 1,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'spider man',
      matchKind: 'all-words',
      endpoint: 'vod',
    };

    const merged = mergeStalkerServerSearchPages({ srcA: verbatimPage, srcB: allWordsPage }, 'spider man');
    expect(merged.matchKind).toBe('verbatim');
    expect(merged.phrase).toBe('spider man');
  });

  it('resolves matchKind: word if all portals used the same fallback phrase', () => {
    const pageA: StalkerServerSearchPage = {
      rows: [],
      total: 0,
      shown: 0,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'spider',
      matchKind: 'word',
      endpoint: 'vod',
    };
    const pageB: StalkerServerSearchPage = {
      rows: [],
      total: 0,
      shown: 0,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'spider',
      matchKind: 'word',
      endpoint: 'vod',
    };

    const merged = mergeStalkerServerSearchPages({ a: pageA, b: pageB }, 'spider-man 1994');
    expect(merged.matchKind).toBe('word');
    expect(merged.phrase).toBe('spider');
  });
});

describe('useStalkerSearchStore multi-source slice', () => {
  it('stores multi-source results, activeTab, and sourcePagesLoaded', () => {
    const store = useStalkerSearchStore.getState();
    expect(store.byType.movies.activeTab).toBe('all');
    expect(store.byType.movies.sourceResults).toEqual({});
    expect(store.byType.movies.sourcePagesLoaded).toEqual({});

    const pageA: StalkerServerSearchPage = {
      rows: [{ stream_id: 'srcA_vod_10', name: 'Spider-Man', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcA' } as any],
      total: 10,
      shown: 1,
      nextPage: 1,
      hasMore: true,
      unsupported: false,
      phrase: 'spider',
      matchKind: 'all-words',
      endpoint: 'vod',
    };

    const pageB: StalkerServerSearchPage = {
      rows: [{ stream_id: 'srcB_vod_20', name: 'Batman', stream_icon: '', category_ids: [], direct_url: '', source_id: 'srcB' } as any],
      total: 5,
      shown: 1,
      nextPage: 1,
      hasMore: false,
      unsupported: false,
      phrase: 'spider',
      matchKind: 'all-words',
      endpoint: 'vod',
    };

    store.patch('movies', {
      sourceId: '*',
      sourceResults: { srcA: pageA, srcB: pageB },
      sourcePagesLoaded: { srcA: 4, srcB: 4 },
      activeTab: 'srcA',
      pagesLoaded: 4,
      result: {
        rows: [...pageA.rows, ...pageB.rows],
        total: 15,
        shown: 2,
        nextPage: 1,
        hasMore: true,
        unsupported: false,
        phrase: 'spider',
        matchKind: 'all-words',
        endpoint: 'vod',
      },
    });

    const updated = useStalkerSearchStore.getState().byType.movies;
    expect(updated.sourceId).toBe('*');
    expect(updated.activeTab).toBe('srcA');
    expect(updated.sourceResults?.srcA.shown).toBe(1);
    expect(updated.sourceResults?.srcB.shown).toBe(1);
    expect(updated.sourcePagesLoaded?.srcA).toBe(4);
    expect(updated.sourcePagesLoaded?.srcB).toBe(4);
    expect(updated.result?.shown).toBe(2);

    // Switching activeTab
    store.patch('movies', { activeTab: 'all' });
    expect(useStalkerSearchStore.getState().byType.movies.activeTab).toBe('all');

    // Resetting cleans up
    store.reset('movies');
    const resetSlice = useStalkerSearchStore.getState().byType.movies;
    expect(resetSlice.sourceId).toBe('');
    expect(resetSlice.activeTab).toBe('all');
    expect(resetSlice.sourceResults).toEqual({});
    expect(resetSlice.sourcePagesLoaded).toEqual({});
    expect(resetSlice.result).toBeNull();
  });
});

describe('StalkerServerSearchView source contracts', () => {
  const viewSrc = readFileSync(
    new URL('../../components/vod/StalkerServerSearchView.tsx', import.meta.url),
    'utf8',
  );

  it('guards category fetch and reset so category is retained when switching to All', () => {
    // Regression check for Bug 5: Switching to All must not call getStalkerSearchCategories('*')
    // or reset categoryId to '*' while isAllSources is active.
    const effectIndex = viewSrc.indexOf('// Categories for the chosen portal');
    expect(effectIndex).toBeGreaterThan(-1);
    const effectSnippet = viewSrc.slice(effectIndex, effectIndex + 1200);
    expect(effectSnippet).toContain('if (!sourceId || isAllSources)');
    expect(effectSnippet).toContain('[sourceId, isAllSources, type, patch]');
  });

  it('falls back to all tab if activeTab is not found in sourceResults', () => {
    // Regression check for Bug 7: prevents blank pane if activeTab points to absent source
    expect(viewSrc).toContain('effectiveTab = (isAllSources && activeTab !== \'all\' && sourceResults?.[activeTab])');
    expect(viewSrc).toContain('? activeTab');
    expect(viewSrc).toContain(': \'all\'');
  });

  it('renders tab badges for error (!) and unsupported (—)', () => {
    // Tab badges must surface failure states
    expect(viewSrc).toContain("badgeClass = hasError ? 'error' : isUnsupported ? 'warning' : ''");
    expect(viewSrc).toContain("badgeText = hasError ? '!' : isUnsupported ? '—' : count");
  });

  it('calculates currentPagesLoaded per portal tab to prevent cross-portal budget drain', () => {
    // Regression check for Bug 6: per-portal tab reads its own pagesLoaded rather than shared
    expect(viewSrc).toContain('slice.sourcePagesLoaded?.[effectiveTab] ?? pagesLoaded');
  });
});
