import { create } from 'zustand';
import { db, type VodHiddenItem } from '../db';
import { overrideKey, type VodMediaType } from './vodMetadataOverridesStore';

/**
 * Titles the user hid from the Movies / Series browse and search views.
 * Rows live in `vod_hidden_items`, a table provider sync never writes, so a
 * hidden title stays hidden after a refresh. The key format matches
 * `overrideKey()` (`${type}:${id}`) so both user-data tables line up.
 */
interface VodHiddenItemsState {
  /** All hidden rows keyed by `${type}:${id}`. */
  hidden: Record<string, VodHiddenItem>;
  hydrated: boolean;
  /**
   * Bumped on every hide/unhide. Query hooks put this in their effect
   * dependencies so lists reload right after a change.
   */
  version: number;
  /** Load all hidden rows from the DB once. Safe to call repeatedly. */
  hydrate: () => Promise<void>;
  hide: (mediaId: string, type: VodMediaType, title?: string | null) => Promise<void>;
  unhide: (mediaId: string, type: VodMediaType) => Promise<void>;
  unhideAll: (type?: VodMediaType) => Promise<void>;
}

export const useVodHiddenItemsStore = create<VodHiddenItemsState>()((set, get) => ({
  hidden: {},
  hydrated: false,
  version: 0,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const rows = await db.vodHiddenItems.toArray();
      const map: Record<string, VodHiddenItem> = {};
      for (const row of rows) {
        map[row.hidden_key] = row;
      }
      // No version bump: hydrating only mirrors what the SQL queries already read.
      set({ hidden: map, hydrated: true });
    } catch (err) {
      // DB not ready yet — leave hydrated=false so the next call retries.
      console.error('[VodHiddenItems] Hydration failed:', err);
    }
  },

  hide: async (mediaId, type, title) => {
    const key = overrideKey(mediaId, type);
    const row: VodHiddenItem = {
      hidden_key: key,
      media_id: mediaId,
      media_type: type,
      title: title ?? null,
      hidden_at: Date.now(),
    };
    await db.vodHiddenItems.put(row);
    set((s) => ({ hidden: { ...s.hidden, [key]: row }, version: s.version + 1 }));
  },

  unhide: async (mediaId, type) => {
    const key = overrideKey(mediaId, type);
    await db.vodHiddenItems.delete(key);
    set((s) => {
      const next = { ...s.hidden };
      delete next[key];
      return { hidden: next, version: s.version + 1 };
    });
  },

  unhideAll: async (type) => {
    const rows = Object.values(get().hidden).filter((r) => !type || r.media_type === type);
    for (const row of rows) {
      await db.vodHiddenItems.delete(row.hidden_key);
    }
    set((s) => {
      const next = { ...s.hidden };
      for (const row of rows) delete next[row.hidden_key];
      return { hidden: next, version: s.version + 1 };
    });
  },
}));
