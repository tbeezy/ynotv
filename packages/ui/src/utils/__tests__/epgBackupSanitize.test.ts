import { describe, it, expect } from 'vitest';
import {
  dropUnservableFeedPins,
  GLOBAL_EPG_PIN_PREFIX,
  globalEpgPinRef,
  importedFeedPin,
  isServableFeedPin,
  repairImportedEpgState,
  sanitizeImportedFeedPins,
  stripEpgLinkRunState,
  stripImportedEpgLinkRunState,
  type ImportedFeedPinRow,
} from '../epgBackupSanitize';
import type { GlobalEpgLink } from '../../types/app';

const FEEDS = {
  sourceIds: new Set(['playlist-a', 'playlist-b']),
  linkIds: new Set(['link-1']),
};

function row(overrides: Partial<ImportedFeedPinRow> = {}): ImportedFeedPinRow {
  return { streamId: 'ch-1', epgSourceId: globalEpgPinRef('link-1'), ...overrides };
}

function link(overrides: Partial<GlobalEpgLink> = {}): GlobalEpgLink {
  return {
    id: 'link-1',
    name: 'DE1',
    url: 'http://example.test/epg.xml',
    sourceIds: ['playlist-a'],
    ...overrides,
  };
}

describe('imported feed pins', () => {
  it('keeps a pin whose EPG link is in the backup', () => {
    const input = [row()];
    const result = sanitizeImportedFeedPins(input, FEEDS);
    expect(result.dropped).toEqual([]);
    expect(result.overrides[0].epgSourceId).toBe(globalEpgPinRef('link-1'));
  });

  it('keeps a pin whose playlist is in the backup', () => {
    const result = sanitizeImportedFeedPins([row({ epgSourceId: 'playlist-b' })], FEEDS);
    expect(result.dropped).toEqual([]);
  });

  it('drops a pin to an EPG link the backup does not carry', () => {
    const result = sanitizeImportedFeedPins([row({ epgSourceId: globalEpgPinRef('gone') })], FEEDS);
    expect(result.dropped).toEqual([{ streamId: 'ch-1', pin: 'global_epg_gone' }]);
    expect(result.overrides).toHaveLength(1);
    expect(result.overrides[0].epgSourceId).toBeUndefined();
  });

  it('drops a pin to a playlist the backup does not carry', () => {
    const result = sanitizeImportedFeedPins([row({ epgSourceId: 'ghost-playlist' })], FEEDS);
    expect(result.dropped).toEqual([{ streamId: 'ch-1', pin: 'ghost-playlist' }]);
  });

  it('clears both spellings so a legacy snake_case pin cannot come back', () => {
    const result = sanitizeImportedFeedPins(
      [{ streamId: 'ch-9', epgSourceId: globalEpgPinRef('gone'), epg_source_id: globalEpgPinRef('gone') }],
      FEEDS
    );
    const kept = result.overrides[0] as Record<string, unknown>;
    expect(kept.epgSourceId).toBeUndefined();
    expect('epg_source_id' in kept).toBe(false);
  });

  it('drops a legacy snake_case pin that names a missing feed', () => {
    const result = sanitizeImportedFeedPins(
      [{ stream_id: 'ch-9', epg_source_id: globalEpgPinRef('gone') }],
      FEEDS
    );
    expect(result.dropped).toEqual([{ streamId: 'ch-9', pin: 'global_epg_gone' }]);
  });

  it('leaves every other field of the override alone', () => {
    const result = sanitizeImportedFeedPins(
      [{
        streamId: 'ch-1',
        epgChannelId: 'ard.de',
        timeshiftHours: 2,
        matchByAlias: true,
        epgSourceId: globalEpgPinRef('gone'),
      }],
      FEEDS
    );
    expect(result.overrides[0]).toMatchObject({
      streamId: 'ch-1',
      epgChannelId: 'ard.de',
      timeshiftHours: 2,
      matchByAlias: true,
    });
  });

  it('keeps unpinned rows and tolerates a missing list', () => {
    expect(sanitizeImportedFeedPins([{ streamId: 'ch-1' }], FEEDS).overrides).toHaveLength(1);
    expect(sanitizeImportedFeedPins(undefined, FEEDS).overrides).toEqual([]);
    expect(sanitizeImportedFeedPins(null, FEEDS).dropped).toEqual([]);
  });

  it('reads the pin with the precedence the restore uses', () => {
    // camelCase wins when present, even as null — the restore reads it first.
    expect(importedFeedPin({ streamId: 'a', epgSourceId: null, epg_source_id: 'playlist-a' })).toBe('');
    expect(importedFeedPin({ streamId: 'a', epg_source_id: ' playlist-a ' })).toBe('playlist-a');
    expect(importedFeedPin({ streamId: 'a' })).toBe('');
  });

  it('treats blank pins as no pin', () => {
    expect(isServableFeedPin('   ', FEEDS)).toBe(false);
    expect(sanitizeImportedFeedPins([row({ epgSourceId: '  ' })], FEEDS).dropped).toEqual([]);
  });

  it('recognises the global-link prefix', () => {
    expect(GLOBAL_EPG_PIN_PREFIX).toBe('global_epg_');
    expect(globalEpgPinRef('abc')).toBe('global_epg_abc');
  });

  it('survives a hand-edited backup without aborting the restore', () => {
    // Junk entries and a non-array field must not throw: the restore is the one
    // path that can't be retried after a partial write.
    const result = sanitizeImportedFeedPins(
      [null, 'nonsense', row({ epgSourceId: globalEpgPinRef('gone') })] as never,
      FEEDS
    );
    expect(result.overrides).toHaveLength(3);
    expect(result.dropped).toHaveLength(1);
    expect(sanitizeImportedFeedPins({} as never, FEEDS)).toEqual({ overrides: [], dropped: [] });
  });
});

describe('dropping unservable pins at match time', () => {
  it('keeps pins a live feed can serve', () => {
    const result = dropUnservableFeedPins(
      new Map([
        ['ch-1', globalEpgPinRef('link-1')],
        ['ch-2', 'playlist-a'],
        ['ch-3', ' playlist-b '],
      ]),
      FEEDS
    );
    expect([...result.pins]).toEqual([
      ['ch-1', globalEpgPinRef('link-1')],
      ['ch-2', 'playlist-a'],
      ['ch-3', ' playlist-b '],
    ]);
    expect(result.unservableFeeds).toEqual([]);
    expect(result.unpinnedStreamIds).toEqual([]);
  });

  it('drops a pin to a feed that no longer exists', () => {
    const result = dropUnservableFeedPins(
      new Map([
        ['ch-1', 'playlist-gone'],
        ['ch-2', globalEpgPinRef('link-gone')],
        ['ch-3', 'playlist-a'],
      ]),
      FEEDS
    );
    expect([...result.pins]).toEqual([['ch-3', 'playlist-a']]);
    expect(result.unservableFeeds.sort()).toEqual(['global_epg_link-gone', 'playlist-gone']);
    expect(result.unpinnedStreamIds).toEqual(['ch-1', 'ch-2']);
  });

  it('reports each dead feed once, however many channels point at it', () => {
    const result = dropUnservableFeedPins(
      new Map([
        ['ch-1', 'playlist-gone'],
        ['ch-2', 'playlist-gone'],
        ['ch-3', 'playlist-gone'],
      ]),
      FEEDS
    );
    expect(result.unservableFeeds).toEqual(['playlist-gone']);
    expect(result.unpinnedStreamIds).toHaveLength(3);
  });

  it('leaves a pin that merely names a blank feed unpinned rather than reserved', () => {
    // A blank pin satisfies no feed, so keeping it would reserve the channel for
    // nobody — the failure this whole rule exists to prevent.
    const result = dropUnservableFeedPins(new Map([['ch-1', '   ']]), FEEDS);
    expect(result.pins.size).toBe(0);
    expect(result.unpinnedStreamIds).toEqual(['ch-1']);
  });

  it('passes an empty pin map through untouched', () => {
    const result = dropUnservableFeedPins(new Map(), FEEDS);
    expect(result.pins.size).toBe(0);
    expect(result.unservableFeeds).toEqual([]);
    expect(result.unpinnedStreamIds).toEqual([]);
  });
});

describe('imported EPG link run state', () => {
  it('drops the stamps and keeps the configuration', () => {
    const { links, reset } = stripEpgLinkRunState([
      link({
        lastSynced: 1_700_000_000_000,
        lastSyncResult: {
          timestamp: 1_700_000_000_000,
          totalInserted: 12,
          perSource: { 'playlist-a': 12 },
          perSourceSyncedAt: { 'playlist-a': 1 },
        },
        saveEntireEpg: true,
      }),
    ]);
    expect(reset).toBe(1);
    expect(links[0]).toEqual({
      id: 'link-1',
      name: 'DE1',
      url: 'http://example.test/epg.xml',
      sourceIds: ['playlist-a'],
      saveEntireEpg: true,
    });
  });

  it('does not count a link that never ran', () => {
    const { links, reset } = stripEpgLinkRunState([link()]);
    expect(reset).toBe(0);
    expect(links[0]).toHaveProperty('url', 'http://example.test/epg.xml');
  });

  it('returns the settings untouched when there is nothing to reset', () => {
    const settings = { theme: 'dark', globalEpgLinks: [link()] };
    const result = stripImportedEpgLinkRunState(settings);
    expect(result.reset).toBe(0);
    expect(result.settings).toBe(settings);
  });

  it('returns a settings object with cleaned links when stamps exist', () => {
    const settings = { theme: 'dark', globalEpgLinks: [link({ lastSynced: 5 })] };
    const result = stripImportedEpgLinkRunState(settings);
    expect(result.reset).toBe(1);
    expect(result.settings.theme).toBe('dark');
    expect(result.settings.globalEpgLinks?.[0]).not.toHaveProperty('lastSynced');
  });

  it('tolerates settings with no links key', () => {
    const settings: { theme: string; globalEpgLinks?: GlobalEpgLink[] } = { theme: 'dark' };
    expect(stripImportedEpgLinkRunState(settings)).toEqual({ settings, reset: 0 });
  });

  it('tolerates a links value that is not an array', () => {
    const settings = { globalEpgLinks: { nope: true } } as unknown as { globalEpgLinks?: GlobalEpgLink[] };
    expect(stripImportedEpgLinkRunState(settings)).toEqual({ settings, reset: 0 });
  });

  it('keeps junk entries in the links array instead of throwing', () => {
    const { links } = stripEpgLinkRunState([null, link({ lastSynced: 5 })] as never);
    expect(links[0]).toBeNull();
    expect(links[1]).not.toHaveProperty('lastSynced');
  });
});

describe('repairImportedEpgState', () => {
  const settings = {
    theme: 'dark',
    globalEpgLinks: [link({ lastSynced: 99, lastSyncResult: { timestamp: 1, totalInserted: 3, perSource: {} } })],
  };

  it('takes the servable feeds from the backup itself', () => {
    const result = repairImportedEpgState({
      sources: [{ id: 'playlist-a' }],
      settings,
      epgChannelOverrides: [
        row({ streamId: 'kept-link', epgSourceId: globalEpgPinRef('link-1') }),
        row({ streamId: 'kept-playlist', epgSourceId: 'playlist-a' }),
        row({ streamId: 'dropped-link', epgSourceId: globalEpgPinRef('link-9') }),
        row({ streamId: 'dropped-playlist', epgSourceId: 'playlist-z' }),
      ],
    });

    expect(result.epgChannelOverrides.map(o => o.streamId)).toEqual([
      'kept-link',
      'kept-playlist',
      'dropped-link',
      'dropped-playlist',
    ]);
    expect(result.droppedPins.map(p => p.streamId)).toEqual(['dropped-link', 'dropped-playlist']);
    expect(result.epgChannelOverrides[2].epgSourceId).toBeUndefined();
    expect(result.resetLinks).toBe(1);
    expect(result.settings.theme).toBe('dark');
    expect(result.settings.globalEpgLinks?.[0]).not.toHaveProperty('lastSyncResult');
  });

  it('ignores source entries with no usable id', () => {
    const result = repairImportedEpgState({
      sources: [{}, { id: '' }, null as never],
      settings: { globalEpgLinks: [] },
      epgChannelOverrides: [row({ epgSourceId: 'playlist-a' })],
    });
    expect(result.droppedPins).toEqual([{ streamId: 'ch-1', pin: 'playlist-a' }]);
  });

  it('handles a backup with no overrides and no links', () => {
    const result = repairImportedEpgState({ settings: {}, sources: [] });
    expect(result).toEqual({
      epgChannelOverrides: [],
      settings: {},
      droppedPins: [],
      resetLinks: 0,
      prunedSourceIds: [],
    });
  });

  it('detaches a link from a playlist the backup does not carry', () => {
    const result = repairImportedEpgState({
      sources: [{ id: 'playlist-a' }],
      settings: { globalEpgLinks: [link({ sourceIds: ['playlist-a', 'gone-playlist'] })] },
      epgChannelOverrides: [],
    });

    // The restore replaces the source list with the backup's, so the id can
    // never resolve again — the card would render it as raw UUID text.
    expect(result.settings.globalEpgLinks?.[0].sourceIds).toEqual(['playlist-a']);
    expect(result.prunedSourceIds).toEqual(['gone-playlist']);
  });

  it('leaves the settings object alone when every attachment is carried', () => {
    const settings = { globalEpgLinks: [link({ sourceIds: ['playlist-a', 'playlist-b'] })] };
    const result = repairImportedEpgState({
      sources: [{ id: 'playlist-a' }, { id: 'playlist-b' }],
      settings,
      epgChannelOverrides: [],
    });

    expect(result.prunedSourceIds).toEqual([]);
    // Same object back: there is nothing to persist differently.
    expect(result.settings).toBe(settings);
  });

  it('keeps counting a link that only ever filled a playlist the backup lacks', () => {
    const result = repairImportedEpgState({
      sources: [],
      settings: {
        globalEpgLinks: [
          link({
            sourceIds: ['gone-playlist'],
            lastSynced: 5,
            lastSyncResult: { timestamp: 1, totalInserted: 2, perSource: { 'gone-playlist': 2 } },
          }),
        ],
      },
      epgChannelOverrides: [],
    });

    // `resetLinks` keeps meaning "links that carried run state", whatever the
    // prune does to their attachments.
    expect(result.resetLinks).toBe(1);
    expect(result.prunedSourceIds).toEqual(['gone-playlist']);
    expect(result.settings.globalEpgLinks?.[0].sourceIds).toEqual([]);
    expect(result.settings.globalEpgLinks?.[0]).not.toHaveProperty('lastSynced');
  });

  it('detaches everything when the backup carries no playlists at all', () => {
    const result = repairImportedEpgState({
      sources: [],
      settings: { globalEpgLinks: [link({ sourceIds: ['playlist-a'] })] },
      epgChannelOverrides: [],
    });

    expect(result.settings.globalEpgLinks?.[0].sourceIds).toEqual([]);
    expect(result.prunedSourceIds).toEqual(['playlist-a']);
  });
});
