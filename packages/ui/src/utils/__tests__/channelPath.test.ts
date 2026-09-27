import { describe, it, expect } from 'vitest';
import {
  resolveChannelCategoryName,
  resolveChannelSourceName,
  resolveSpecialViewSuffix,
  formatChannelFullPath,
  formatChannelDisplayPath,
  parseCategoryIds,
} from '../channelPath';

describe('channelPath utility', () => {
  const sampleCategories = [
    {
      category_id: 'cat_hu',
      category_name: 'MAGYARORSZÁG',
      alias: 'MAGYAR TV (filmek)',
      source_id: 'src_iptv',
    },
    {
      category_id: 'cat_doc',
      category_name: 'DOCUMENTARIES',
      source_id: 'src_iptv',
    },
  ];

  const sourceNames = new Map<string, string>([
    ['src_iptv', '- IPTV -'],
    ['src_cable', 'Cable Provider'],
  ]);

  describe('resolveChannelCategoryName', () => {
    it('uses renamed category alias over raw category_name', () => {
      const name = resolveChannelCategoryName({
        channel: {
          category_ids: ['cat_hu'],
          source_id: 'src_iptv',
        },
        categoryId: 'cat_hu',
        currentCategory: sampleCategories[0],
        categories: sampleCategories,
      });
      expect(name).toBe('MAGYAR TV (filmek)');
    });

    it('falls back to category_name if category has no alias', () => {
      const name = resolveChannelCategoryName({
        channel: {
          category_ids: ['cat_doc'],
          source_id: 'src_iptv',
        },
        categoryId: 'cat_doc',
        currentCategory: sampleCategories[1],
        categories: sampleCategories,
      });
      expect(name).toBe('DOCUMENTARIES');
    });

    it('resolves channel category from category_ids when in Favorites mode', () => {
      const name = resolveChannelCategoryName({
        channel: {
          category_ids: ['cat_hu'],
          source_id: 'src_iptv',
        },
        categoryId: '__favorites__',
        categories: sampleCategories,
      });
      expect(name).toBe('MAGYAR TV (filmek)');
    });

    it('resolves channel category from category_ids when in per-source Favorites mode', () => {
      const name = resolveChannelCategoryName({
        channel: {
          category_ids: ['cat_hu'],
          source_id: 'src_iptv',
        },
        categoryId: '__favsrc_src_iptv',
        categories: sampleCategories,
      });
      expect(name).toBe('MAGYAR TV (filmek)');
    });

    it('resolves channel category when in Watchlist mode', () => {
      const name = resolveChannelCategoryName({
        channel: {
          category_ids: ['cat_hu'],
          source_id: 'src_iptv',
        },
        isWatchlistMode: true,
        categories: sampleCategories,
      });
      expect(name).toBe('MAGYAR TV (filmek)');
    });

    it('falls back to categoryNameMap when category is not in categories array', () => {
      const categoryNameMap = new Map([['cat_hidden', 'Hidden Custom Category']]);
      const name = resolveChannelCategoryName({
        channel: {
          category_ids: ['cat_hidden'],
          source_id: 'src_iptv',
        },
        categoryId: '__favorites__',
        categories: sampleCategories,
        categoryNameMap,
      });
      expect(name).toBe('Hidden Custom Category');
    });

    it('prioritizes playlist category link display name', () => {
      const name = resolveChannelCategoryName({
        channel: {
          category_ids: ['cat_hu'],
          source_id: 'src_iptv',
        },
        categoryId: '__plcat_1',
        linkedCategoryDisplayName: 'My Custom Playlist Category',
        categories: sampleCategories,
      });
      expect(name).toBe('My Custom Playlist Category');
    });
  });

  describe('resolveChannelSourceName', () => {
    it('resolves source name from sourceNames map', () => {
      const name = resolveChannelSourceName(
        { source_id: 'src_iptv', source_name: 'Raw Name' },
        sourceNames
      );
      expect(name).toBe('- IPTV -');
    });

    it('falls back to source_name when not in sourceNames map', () => {
      const name = resolveChannelSourceName(
        { source_id: 'unknown_src', source_name: 'Fallback Source' },
        sourceNames
      );
      expect(name).toBe('Fallback Source');
    });

    it('falls back to source_id when neither map nor source_name exists', () => {
      const name = resolveChannelSourceName(
        { source_id: 'unknown_src' },
        new Map()
      );
      expect(name).toBe('unknown_src');
    });
  });

  describe('resolveSpecialViewSuffix', () => {
    it('returns (Favorites) for global favorites', () => {
      expect(resolveSpecialViewSuffix('__favorites__')).toBe(' (Favorites)');
    });

    it('returns (Favorites) for per-source favorites', () => {
      expect(resolveSpecialViewSuffix('__favsrc_src_iptv')).toBe(' (Favorites)');
    });

    it('returns (Watchlist) for watchlist mode', () => {
      expect(resolveSpecialViewSuffix(null, true)).toBe(' (Watchlist)');
    });

    it('returns (Recently Viewed) for recent view', () => {
      expect(resolveSpecialViewSuffix('__recent__')).toBe(' (Recently Viewed)');
    });

    it('returns empty string for regular categories', () => {
      expect(resolveSpecialViewSuffix('cat_hu')).toBe('');
    });
  });

  describe('formatChannelFullPath', () => {
    it('formats Source / Category / Channel with aliases', () => {
      const path = formatChannelFullPath({
        channel: {
          name: 'FAMILY TIME HD (provider)',
          alias: 'FAMILY TIME HD',
          source_id: 'src_iptv',
          category_ids: ['cat_hu'],
        },
        categoryId: 'cat_hu',
        currentCategory: sampleCategories[0],
        categories: sampleCategories,
        sourceNames,
      });
      expect(path).toBe('- IPTV - / MAGYAR TV (filmek) / FAMILY TIME HD');
    });

    it('appends (Favorites) when viewing inside Favorites', () => {
      const path = formatChannelFullPath({
        channel: {
          name: 'FAMILY TIME HD',
          source_id: 'src_iptv',
          category_ids: ['cat_hu'],
        },
        categoryId: '__favorites__',
        categories: sampleCategories,
        sourceNames,
      });
      expect(path).toBe('- IPTV - / MAGYAR TV (filmek) / FAMILY TIME HD (Favorites)');
    });

    it('appends (Watchlist) when viewing inside Watchlist', () => {
      const path = formatChannelFullPath({
        channel: {
          name: 'FAMILY TIME HD',
          source_id: 'src_iptv',
          category_ids: ['cat_hu'],
        },
        isWatchlistMode: true,
        categories: sampleCategories,
        sourceNames,
      });
      expect(path).toBe('- IPTV - / MAGYAR TV (filmek) / FAMILY TIME HD (Watchlist)');
    });

    it('appends (Recently Viewed) when viewing inside Recently Viewed', () => {
      const path = formatChannelFullPath({
        channel: {
          name: 'FAMILY TIME HD',
          source_id: 'src_iptv',
          category_ids: ['cat_hu'],
        },
        categoryId: '__recent__',
        categories: sampleCategories,
        sourceNames,
      });
      expect(path).toBe('- IPTV - / MAGYAR TV (filmek) / FAMILY TIME HD (Recently Viewed)');
    });
  });

  describe('formatChannelDisplayPath', () => {
    it('returns only renamed category name when showFullPath is false', () => {
      const display = formatChannelDisplayPath({
        channel: {
          name: 'FAMILY TIME HD',
          source_id: 'src_iptv',
          category_ids: ['cat_hu'],
        },
        categoryId: 'cat_hu',
        currentCategory: sampleCategories[0],
        categories: sampleCategories,
        sourceNames,
        showFullPath: false,
      });
      expect(display).toBe('MAGYAR TV (filmek)');
    });

    it('returns full hierarchy path when showFullPath is true', () => {
      const display = formatChannelDisplayPath({
        channel: {
          name: 'FAMILY TIME HD',
          source_id: 'src_iptv',
          category_ids: ['cat_hu'],
        },
        categoryId: 'cat_hu',
        currentCategory: sampleCategories[0],
        categories: sampleCategories,
        sourceNames,
        showFullPath: true,
      });
      expect(display).toBe('- IPTV - / MAGYAR TV (filmek) / FAMILY TIME HD');
    });

    it('returns full hierarchy path with (Favorites) when showFullPath is true in Favorites', () => {
      const display = formatChannelDisplayPath({
        channel: {
          name: 'FAMILY TIME HD',
          source_id: 'src_iptv',
          category_ids: ['cat_hu'],
        },
        categoryId: '__favorites__',
        categories: sampleCategories,
        sourceNames,
        showFullPath: true,
      });
      expect(display).toBe('- IPTV - / MAGYAR TV (filmek) / FAMILY TIME HD (Favorites)');
    });
  });

  describe('parseCategoryIds', () => {
    it('returns empty array for undefined or empty string', () => {
      expect(parseCategoryIds(undefined)).toEqual([]);
      expect(parseCategoryIds('')).toEqual([]);
    });

    it('handles string array input directly', () => {
      expect(parseCategoryIds(['1', '2', '3'])).toEqual(['1', '2', '3']);
    });

    it('converts number array to string array', () => {
      expect(parseCategoryIds([1, 2, 3])).toEqual(['1', '2', '3']);
    });

    it('parses JSON string array', () => {
      expect(parseCategoryIds('["cat1", "cat2"]')).toEqual(['cat1', 'cat2']);
    });

    it('parses JSON numeric array into strings', () => {
      expect(parseCategoryIds('[10, 20]')).toEqual(['10', '20']);
    });

    it('returns empty array on malformed JSON', () => {
      expect(parseCategoryIds('not-json')).toEqual([]);
      expect(parseCategoryIds('{"not": "an-array"}')).toEqual([]);
    });
  });
});
