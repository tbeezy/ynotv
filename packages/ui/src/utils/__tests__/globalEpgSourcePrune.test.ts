/**
 * Prune rules for Global EPG links that still name a playlist which is gone.
 *
 * A stale attachment is user-visible: the settings card renders an id it cannot
 * resolve as the raw id, so a deleted playlist shows up as a pill of UUID text
 * that only deleting the whole EPG source used to clear. These tests pin down
 * what survives a prune — user configuration, live attachments, and the run
 * state of the playlists that are still attached.
 */
import { describe, it, expect } from 'vitest';
import type { GlobalEpgLink } from '../../types/app';
import {
  dropGlobalEpgSourceReferences,
  pruneGlobalEpgLinkSources,
} from '../globalEpgSourcePrune';

function link(overrides: Partial<GlobalEpgLink> = {}): GlobalEpgLink {
  return {
    id: 'link-1',
    name: 'www.open-epg.com',
    url: 'https://www.open-epg.com/files/guide.xml',
    sourceIds: ['live-a'],
    ...overrides,
  };
}

describe('pruneGlobalEpgLinkSources', () => {
  it('drops the ids of playlists that no longer exist', () => {
    const links = [link({ sourceIds: ['live-a', 'gone-1', 'gone-2'] })];

    const result = pruneGlobalEpgLinkSources(links, new Set(['live-a']));

    expect(result.links[0].sourceIds).toEqual(['live-a']);
    expect(result.removedSourceIds).toEqual(['gone-1', 'gone-2']);
    expect(result.changedLinks).toBe(1);
    expect(result.emptyLinks).toBe(0);
  });

  it('keeps the same objects when every attached playlist still exists', () => {
    const only = link();
    const links = [only, link({ id: 'link-2', sourceIds: ['live-b'] })];

    const result = pruneGlobalEpgLinkSources(links, new Set(['live-a', 'live-b']));

    // Same array and same objects: the callers skip persisting on changedLinks 0.
    expect(result.links).toBe(links);
    expect(result.links[0]).toBe(only);
    expect(result.changedLinks).toBe(0);
    expect(result.removedSourceIds).toEqual([]);
    expect(result.emptyLinks).toBe(0);
  });

  it('drops the dead keys from the per-source run state', () => {
    const links = [
      link({
        sourceIds: ['live-a', 'gone-1'],
        lastSynced: 1_700_000_000_000,
        lastSyncResult: {
          timestamp: 1_700_000_000_000,
          totalInserted: 3,
          perSource: { 'live-a': 1, 'gone-1': 2 },
          channelsMatched: 5,
          perSourceChannels: { 'live-a': 4, 'gone-1': 1 },
          perSourceSyncedAt: { 'live-a': 100, 'gone-1': 200 },
          matchedStreamIds: ['stream-1', 'stream-2'],
        },
      }),
    ];

    const result = pruneGlobalEpgLinkSources(links, new Set(['live-a']));
    const run = result.links[0].lastSyncResult;

    expect(result.links[0].sourceIds).toEqual(['live-a']);
    expect(run?.perSource).toEqual({ 'live-a': 1 });
    expect(run?.perSourceChannels).toEqual({ 'live-a': 4 });
    expect(run?.perSourceSyncedAt).toEqual({ 'live-a': 100 });
    // The parts that aren't keyed by playlist are left alone.
    expect(run?.totalInserted).toBe(3);
    expect(run?.channelsMatched).toBe(5);
    expect(run?.matchedStreamIds).toEqual(['stream-1', 'stream-2']);
    expect(result.links[0].lastSynced).toBe(1_700_000_000_000);
  });

  it('drops the whole run state when it only describes playlists that are gone', () => {
    const links = [
      link({
        sourceIds: ['gone-1'],
        lastSynced: 1_700_000_000_000,
        lastSyncResult: {
          timestamp: 1_700_000_000_000,
          totalInserted: 7,
          perSource: { 'gone-1': 7 },
        },
      }),
    ];

    const result = pruneGlobalEpgLinkSources(links, new Set(['live-a']));

    expect(result.links[0].sourceIds).toEqual([]);
    expect(result.links[0].lastSyncResult).toBeUndefined();
    // The link did run then — only the counts described a feed that is gone.
    expect(result.links[0].lastSynced).toBe(1_700_000_000_000);
    expect(result.emptyLinks).toBe(1);
  });

  it('keeps the per-source stamps of playlists that are still attached', () => {
    const links = [
      link({
        sourceIds: ['live-a', 'gone-1'],
        lastSyncResult: {
          timestamp: 1,
          totalInserted: 4,
          perSource: { 'live-a': 3, 'gone-1': 1 },
          perSourceSyncedAt: { 'live-a': 999, 'gone-1': 111 },
        },
      }),
    ];

    const result = pruneGlobalEpgLinkSources(links, new Set(['live-a']));

    expect(result.links[0].lastSyncResult?.perSourceSyncedAt).toEqual({ 'live-a': 999 });
    expect(result.links[0].lastSyncResult?.perSource).toEqual({ 'live-a': 3 });
  });

  it('preserves every setting the user chose', () => {
    const links = [
      link({
        id: 'link-9',
        name: 'My guide',
        url: 'https://example.test/a.xml',
        sourceIds: ['gone-1'],
        saveEntireEpg: true,
        display_order: 3,
      }),
    ];

    const pruned = pruneGlobalEpgLinkSources(links, new Set(['live-a'])).links[0];

    expect(pruned).toMatchObject({
      id: 'link-9',
      name: 'My guide',
      url: 'https://example.test/a.xml',
      saveEntireEpg: true,
      display_order: 3,
    });
  });

  it('counts the links it rewrote and the ones left with no playlists', () => {
    const links = [
      link({ id: 'link-1', sourceIds: ['live-a', 'gone-1'] }),
      link({ id: 'link-2', sourceIds: ['gone-1', 'gone-2'] }),
      link({ id: 'link-3', sourceIds: ['live-a'] }),
      link({ id: 'link-4', sourceIds: [] }),
    ];

    const result = pruneGlobalEpgLinkSources(links, new Set(['live-a']));

    expect(result.changedLinks).toBe(2);
    expect(result.emptyLinks).toBe(2); // link-2 (all dead) and link-4 (already empty)
    // Distinct, first-seen order — not once per link.
    expect(result.removedSourceIds).toEqual(['gone-1', 'gone-2']);
  });

  it('ignores blank ids instead of reporting them as deleted playlists', () => {
    const links = [link({ sourceIds: ['live-a', ''] })];

    const result = pruneGlobalEpgLinkSources(links, new Set(['live-a']));

    expect(result.links[0].sourceIds).toEqual(['live-a']);
    expect(result.removedSourceIds).toEqual([]);
    expect(result.changedLinks).toBe(1);
  });

  it('tolerates a hand-edited settings file', () => {
    expect(pruneGlobalEpgLinkSources(undefined, new Set(['live-a'])).links).toEqual([]);
    expect(pruneGlobalEpgLinkSources(null, new Set(['live-a'])).changedLinks).toBe(0);

    const broken = { id: 'link-1', name: 'x', url: 'y' } as unknown as GlobalEpgLink;
    const result = pruneGlobalEpgLinkSources([broken], new Set(['live-a']));
    expect(result.links[0]).toBe(broken);
    expect(result.changedLinks).toBe(0);
  });

  it('detaches everything when handed an empty playlist list', () => {
    // The sharp edge the callers have to respect: an empty set is
    // indistinguishable from "no playlist exists", so a failed or partial read
    // must never reach this function (see pruneStaleGlobalEpgSourcesFromStoredSources).
    const links = [link({ sourceIds: ['live-a'] }), link({ id: 'link-2', sourceIds: ['live-b'] })];

    const result = pruneGlobalEpgLinkSources(links, new Set());

    expect(result.links.every((entry) => entry.sourceIds.length === 0)).toBe(true);
    expect(result.removedSourceIds).toEqual(['live-a', 'live-b']);
    expect(result.emptyLinks).toBe(2);
  });
});

describe('dropGlobalEpgSourceReferences', () => {
  it('removes exactly the deleted playlists and keeps every other id', () => {
    // The deletion flow knows what it deleted, not what still exists: an id
    // missing from the caller's playlist snapshot must survive.
    const links = [link({ sourceIds: ['gone-1', 'live-b', 'not-in-the-snapshot'] })];

    const result = dropGlobalEpgSourceReferences(links, new Set(['gone-1']));

    expect(result.links[0].sourceIds).toEqual(['live-b', 'not-in-the-snapshot']);
    expect(result.removedSourceIds).toEqual(['gone-1']);
    expect(result.changedLinks).toBe(1);
  });

  it('is a no-op for an empty set', () => {
    const links = [link({ sourceIds: ['live-a', 'live-b'] })];

    const result = dropGlobalEpgSourceReferences(links, new Set());

    expect(result.links).toBe(links);
    expect(result.changedLinks).toBe(0);
  });

  it('clears the run state of the deleted playlist only', () => {
    const links = [
      link({
        sourceIds: ['live-a', 'gone-1'],
        lastSyncResult: {
          timestamp: 1,
          totalInserted: 3,
          perSource: { 'live-a': 1, 'gone-1': 2 },
          perSourceSyncedAt: { 'live-a': 100, 'gone-1': 200 },
        },
      }),
    ];

    const result = dropGlobalEpgSourceReferences(links, new Set(['gone-1']));

    expect(result.links[0].sourceIds).toEqual(['live-a']);
    expect(result.links[0].lastSyncResult?.perSource).toEqual({ 'live-a': 1 });
    expect(result.links[0].lastSyncResult?.perSourceSyncedAt).toEqual({ 'live-a': 100 });
  });
});
