import { describe, it, expect } from 'vitest';
import { formatChannelFullPath } from '../../utils/channelPath';

describe('ChannelInfoOverlay channelDisplayTitle formatting', () => {
  const sourceNames = new Map<string, string>([
    ['src_iptv', 'IPTV 1'],
    ['src_cable', 'Cable Provider'],
  ]);

  it('renders standard Source / Category / Channel hierarchy path', () => {
    const title = formatChannelFullPath({
      channel: {
        name: 'CNN',
        source_id: 'src_iptv',
      },
      fallbackCategoryName: 'News',
      sourceNames,
    });
    expect(title).toBe('IPTV 1 / News / CNN');
  });

  it('uses channel alias over raw name when available', () => {
    const title = formatChannelFullPath({
      channel: {
        name: 'CNN (1080p) [RAW]',
        alias: 'CNN HD',
        source_id: 'src_iptv',
      },
      fallbackCategoryName: 'News',
      sourceNames,
    });
    expect(title).toBe('IPTV 1 / News / CNN HD');
  });

  it('appends (Favorites) only when viewing in Favorites mode (__favorites__)', () => {
    const title = formatChannelFullPath({
      channel: {
        name: 'HBO',
        source_id: 'src_iptv',
      },
      categoryId: '__favorites__',
      fallbackCategoryName: 'Movies',
      sourceNames,
      translations: { favorites: 'Favorites' },
    });
    expect(title).toBe('IPTV 1 / Movies / HBO (Favorites)');
  });

  it('does NOT append (Favorites) when viewing in standard category even if channel is favorited', () => {
    // When playing in normal category, categoryId is the normal category ID
    const title = formatChannelFullPath({
      channel: {
        name: 'HBO',
        source_id: 'src_iptv',
      },
      categoryId: 'cat_movies',
      fallbackCategoryName: 'Movies',
      sourceNames,
      translations: { favorites: 'Favorites' },
    });
    expect(title).toBe('IPTV 1 / Movies / HBO');
  });

  it('appends (Watchlist) when viewing in Watchlist mode', () => {
    const title = formatChannelFullPath({
      channel: {
        name: 'Discovery',
        source_id: 'src_iptv',
      },
      categoryId: '__watchlist__',
      fallbackCategoryName: 'Documentaries',
      sourceNames,
      translations: { watchlist: 'Watchlist' },
    });
    expect(title).toBe('IPTV 1 / Documentaries / Discovery (Watchlist)');
  });

  it('appends (Recently Viewed) when viewing in Recently Viewed mode', () => {
    const title = formatChannelFullPath({
      channel: {
        name: 'ESPN',
        source_id: 'src_iptv',
      },
      categoryId: '__recent__',
      fallbackCategoryName: 'Sports',
      sourceNames,
      translations: { recentlyViewed: 'Recently Viewed' },
    });
    expect(title).toBe('IPTV 1 / Sports / ESPN (Recently Viewed)');
  });

  it('uses localized suffix when translations are provided', () => {
    const title = formatChannelFullPath({
      channel: {
        name: 'HBO',
        source_id: 'src_iptv',
      },
      categoryId: '__favorites__',
      fallbackCategoryName: 'Filmek',
      sourceNames,
      translations: { favorites: 'Kedvencek' },
    });
    expect(title).toBe('IPTV 1 / Filmek / HBO (Kedvencek)');
  });

  it('gracefully handles missing source and missing category', () => {
    const title = formatChannelFullPath({
      channel: {
        name: 'Standalone Channel',
      },
      sourceNames: new Map(),
    });
    expect(title).toBe('Standalone Channel');
  });
});
