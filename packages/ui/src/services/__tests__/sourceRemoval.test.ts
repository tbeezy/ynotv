/**
 * What a deleted playlist leaves behind in preferences and settings.
 *
 * The database side is covered by `clearSourceStatements.test.ts`; this covers
 * the store side — ordering preferences, the playlist's own favourite order, its
 * logo overrides, the Stalker EPG cache, and the Global EPG links — plus the
 * contract that the delete flow hands the playlist over at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { GlobalEpgLink } from '../../types/app';

const { prefs, clearChannelSyncCache } = vi.hoisted(() => ({
  prefs: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  clearChannelSyncCache: vi.fn(async () => 0),
}));

vi.mock('../../db', () => ({ db: { prefs } }));
vi.mock('../../db/sync', () => ({ clearChannelSyncCache }));

const storageBackend: Record<string, unknown> = {};
const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
  Object.assign(storageBackend, patch);
});

Object.defineProperty(globalThis.window, 'storage', {
  value: {
    getSettings: async () => ({ success: true, data: { ...storageBackend } }),
    updateSettings,
  },
  configurable: true,
  writable: true,
});

type StoreModule = typeof import('../../stores/settingsStore');
type ServiceModule = typeof import('../sourceRemoval');

let useSettingsStore: StoreModule['useSettingsStore'];
let forgetDeletedSource: ServiceModule['forgetDeletedSource'];
let withoutSourceId: ServiceModule['withoutSourceId'];

/** What `db.prefs.get(key)` answers. */
let prefRows: Record<string, { key: string; value: string } | undefined> = {};

function prefValue(key: string): string | undefined {
  return prefRows[key]?.value;
}

function link(overrides: Partial<GlobalEpgLink> = {}): GlobalEpgLink {
  return {
    id: 'link-1',
    name: 'www.open-epg.com',
    url: 'https://www.open-epg.com/files/guide.xml',
    sourceIds: ['source-a'],
    ...overrides,
  };
}

beforeEach(async () => {
  localStorage.clear();
  prefRows = {};
  Object.keys(storageBackend).forEach((key) => delete storageBackend[key]);
  prefs.get.mockReset().mockImplementation(async (key: string) => prefRows[key] ?? null);
  prefs.put.mockReset().mockImplementation(async (row: { key: string; value: string }) => {
    prefRows[row.key] = row;
  });
  prefs.delete.mockReset().mockImplementation(async (key: string) => {
    delete prefRows[key];
  });
  updateSettings.mockClear();
  clearChannelSyncCache.mockReset().mockResolvedValue(0);
  vi.resetModules();
  ({ useSettingsStore } = await import('../../stores/settingsStore'));
  ({ forgetDeletedSource, withoutSourceId } = await import('../sourceRemoval'));
});

describe('withoutSourceId', () => {
  it('removes the id from a plain list', () => {
    expect(withoutSourceId(['source-a', 'source-b'], 'source-a')).toEqual({
      value: ['source-b'],
      changed: true,
    });
  });

  it('removes it from every list of a nested value, keeping the shape', () => {
    const value = { movies: ['source-a', 'source-b'], series: ['source-a'], picks: 'source-a' };

    expect(withoutSourceId(value, 'source-a')).toEqual({
      value: { movies: ['source-b'], series: [], picks: 'source-a' },
      changed: true,
    });
  });

  it('returns the same value when nothing matches', () => {
    const value = { movies: ['source-b'] };

    expect(withoutSourceId(value, 'source-a')).toEqual({ value, changed: false });
  });

  it('leaves scalars alone', () => {
    expect(withoutSourceId('source-a', 'source-a')).toEqual({ value: 'source-a', changed: false });
    expect(withoutSourceId(null, 'source-a')).toEqual({ value: null, changed: false });
  });
});

describe('forgetDeletedSource', () => {
  it('drops the playlist from the sidebar order preferences', async () => {
    prefRows['sidebar_sources_order'] = {
      key: 'sidebar_sources_order',
      value: JSON.stringify(['source-b', 'source-a']),
    };
    prefRows['vod_sidebar_sources_order'] = {
      key: 'vod_sidebar_sources_order',
      value: JSON.stringify({ movies: ['source-a', 'source-b'], series: ['source-a'] }),
    };

    const report = await forgetDeletedSource('source-a');

    expect(report.orderPrefs).toEqual(['sidebar_sources_order', 'vod_sidebar_sources_order']);
    expect(prefValue('sidebar_sources_order')).toBe(JSON.stringify(['source-b']));
    // Other media types are untouched, and an emptied list stays a list.
    expect(prefValue('vod_sidebar_sources_order')).toBe(
      JSON.stringify({ movies: ['source-b'], series: [] })
    );
  });

  it('leaves an order preference it is not in alone', async () => {
    prefRows['sidebar_sources_order'] = {
      key: 'sidebar_sources_order',
      value: JSON.stringify(['source-b']),
    };

    const report = await forgetDeletedSource('source-a');

    expect(report.orderPrefs).toEqual([]);
    expect(prefs.put).not.toHaveBeenCalled();
  });

  it('survives a preference it cannot parse', async () => {
    prefRows['sidebar_sources_order'] = { key: 'sidebar_sources_order', value: 'not json' };

    await expect(forgetDeletedSource('source-a')).resolves.toBeDefined();
    expect(prefs.put).not.toHaveBeenCalled();
  });

  it("removes the playlist's own favourite order, only if it has one", async () => {
    prefRows['favorite_source_order:source-a'] = {
      key: 'favorite_source_order:source-a',
      value: JSON.stringify(['a-1']),
    };

    const report = await forgetDeletedSource('source-a');

    expect(report.favoriteOrderRemoved).toBe(true);
    expect(prefs.delete).toHaveBeenCalledWith('favorite_source_order:source-a');
    expect(prefRows['favorite_source_order:source-a']).toBeUndefined();
  });

  it('does not create a favourite-order delete that has nothing to remove', async () => {
    const report = await forgetDeletedSource('source-a');

    expect(report.favoriteOrderRemoved).toBe(false);
    expect(prefs.delete).not.toHaveBeenCalled();
  });

  it('removes the per-playlist logo overrides through the store', async () => {
    useSettingsStore.setState({
      sourceLogoDisplayOverrides: { 'source-a': 'square' as const, 'source-b': 'rectangle' as const },
      sourceLogoBackgroundOverrides: { 'source-a': 'dark' as const },
    });

    const report = await forgetDeletedSource('source-a');
    const state = useSettingsStore.getState();

    expect(report.logoOverrideRemoved).toBe(true);
    expect(state.sourceLogoDisplayOverrides).toEqual({ 'source-b': 'rectangle' });
    expect(state.sourceLogoBackgroundOverrides).toEqual({});
    // Persisted through the bridge, not just dropped from memory.
    expect(updateSettings).toHaveBeenCalledWith({
      sourceLogoDisplayOverrides: { 'source-b': 'rectangle' },
    });
  });

  it('drops the per-channel audio delays that belong to its channels', async () => {
    useSettingsStore.setState({
      channelAudioDelays: { 'source-a_a-1': 0.4, 'source-a_a-2': -0.2, 'source-b_b-1': 0.9 },
    });

    const report = await forgetDeletedSource('source-a');

    expect(report.audioDelays).toBe(2);
    expect(useSettingsStore.getState().channelAudioDelays).toEqual({ 'source-b_b-1': 0.9 });
    expect(updateSettings).toHaveBeenCalledWith({ channelAudioDelays: { 'source-b_b-1': 0.9 } });
  });

  it('leaves the delay map alone when none of it names its channels', async () => {
    useSettingsStore.setState({ channelAudioDelays: { 'source-b_b-1': 0.9 } });

    const report = await forgetDeletedSource('source-a');

    expect(report.audioDelays).toBe(0);
    expect(useSettingsStore.getState().channelAudioDelays).toEqual({ 'source-b_b-1': 0.9 });
  });

  it('removes the sidebar pins that lead with the deleted playlist id', async () => {
    localStorage.setItem(
      'ynotv:pinnedCategories',
      JSON.stringify(['source-a:cat-1', 'source-b:cat-2', 'source-a:cat-3'])
    );
    localStorage.setItem('ynotv:pinnedFolders', JSON.stringify(['source-a:folder-1']));

    const report = await forgetDeletedSource('source-a');

    expect(report.pinnedLists).toEqual(['ynotv:pinnedCategories', 'ynotv:pinnedFolders']);
    expect(JSON.parse(localStorage.getItem('ynotv:pinnedCategories')!)).toEqual(['source-b:cat-2']);
    expect(JSON.parse(localStorage.getItem('ynotv:pinnedFolders')!)).toEqual([]);
  });

  it('leaves pins of other playlists and unparseable values alone', async () => {
    localStorage.setItem('ynotv:pinnedCategories', JSON.stringify(['source-b:cat-2']));
    localStorage.setItem('ynotv:pinnedFolders', 'not json');

    const report = await forgetDeletedSource('source-a');

    expect(report.pinnedLists).toEqual([]);
    expect(JSON.parse(localStorage.getItem('ynotv:pinnedCategories')!)).toEqual(['source-b:cat-2']);
    expect(localStorage.getItem('ynotv:pinnedFolders')).toBe('not json');
  });

  it('clears the Stalker short-EPG cache and reports how many entries it held', async () => {
    clearChannelSyncCache.mockResolvedValue(4);
    clearChannelSyncCache.mockResolvedValue(4);

    const report = await forgetDeletedSource('source-a');

    expect(clearChannelSyncCache).toHaveBeenCalledWith('source-a');
    expect(report.stalkerCacheEntries).toBe(4);
  });

  it('detaches the playlist from every Global EPG link', async () => {
    useSettingsStore.setState({
      globalEpgLinks: [
        link({ sourceIds: ['source-a', 'source-b'] }),
        link({ id: 'link-2', sourceIds: ['source-b'] }),
      ],
    });

    const report = await forgetDeletedSource('source-a');

    expect(report.globalEpgLinks).toBe(1);
    expect(useSettingsStore.getState().globalEpgLinks[0].sourceIds).toEqual(['source-b']);
  });

  it('does nothing at all for a blank id', async () => {
    const report = await forgetDeletedSource('   ');

    expect(report).toEqual({
      globalEpgLinks: 0,
      orderPrefs: [],
      favoriteOrderRemoved: false,
      logoOverrideRemoved: false,
      audioDelays: 0,
      stalkerCacheEntries: 0,
      pinnedLists: [],
    });
    expect(prefs.get).not.toHaveBeenCalled();
    expect(clearChannelSyncCache).not.toHaveBeenCalled();
  });

  it('keeps going when one store fails', async () => {
    prefs.get.mockImplementation(async (key: string) => {
      if (key === 'sidebar_sources_order') throw new Error('prefs unavailable');
      return prefRows[key] ?? null;
    });
    clearChannelSyncCache.mockResolvedValue(2);

    const report = await forgetDeletedSource('source-a');

    expect(report.orderPrefs).toEqual([]);
    expect(report.stalkerCacheEntries).toBe(2);
  });
});

describe('delete-flow wiring', () => {
  it('hands the deleted playlist to the reference cleanup', () => {
    const src = readFileSync(
      new URL('../../components/settings/SourcesTab.tsx', import.meta.url),
      'utf8'
    );
    const at = src.indexOf('async function confirmDelete()');
    expect(at).toBeGreaterThanOrEqual(0);
    const confirmDelete = src.slice(at);

    const cleanup = confirmDelete.indexOf('await forgetDeletedSource(id)');
    const removed = confirmDelete.indexOf('await window.storage.deleteSource(id)');

    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThanOrEqual(0);
    // The references go first: an interruption here leaves a playlist the user
    // can delete again, where the reverse order could strand references to a
    // playlist that no longer exists.
    expect(cleanup).toBeLessThan(removed);
  });
});
