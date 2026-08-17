import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PlaylistItem {
  id: string;
  playlistId: string;
  itemType: 'movie' | 'episode';
  mediaId: string;
  seriesId?: string;
  seriesTitle?: string;
  seasonNum?: number;
  episodeNum?: number;
  episodeTitle?: string;
  title: string;
  poster?: string | null;
  backdropUrl?: string | null;
  directUrl?: string;
  sourceId?: string;
  sourceName?: string;
  duration?: number;
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  items: PlaylistItem[];
  removeAfterWatching?: boolean;
  autoplayNext?: boolean;
  showSourceName?: boolean;
}

interface VodPlaylistState {
  playlists: Playlist[];
  // Stack of pre-randomize item-id orders per playlist (newest last). Each
  // randomize pushes the order it replaced, so undo can step back through
  // multiple shuffles. Kept out of persistence (see partialize below).
  randomizeHistory: Record<string, string[][]>;
  createPlaylist: (name: string) => Playlist;
  deletePlaylist: (id: string) => void;
  renamePlaylist: (id: string, name: string) => void;
  addItemToPlaylist: (playlistId: string, item: Omit<PlaylistItem, 'id' | 'playlistId' | 'addedAt'>) => void;
  addItemsToPlaylist: (playlistId: string, items: Array<Omit<PlaylistItem, 'id' | 'playlistId' | 'addedAt'>>) => void;
  removeItemFromPlaylist: (playlistId: string, itemId: string) => void;
  removeItemsFromPlaylist: (playlistId: string, itemIds: string[]) => void;
  reorderPlaylistItems: (playlistId: string, fromIndex: number, toIndex: number) => void;
  randomizePlaylistItems: (playlistId: string) => void;
  undoRandomizePlaylistItems: (playlistId: string) => void;
  toggleRemoveAfterWatching: (playlistId: string) => void;
  toggleAutoplayNext: (playlistId: string) => void;
  toggleShowSourceName: (playlistId: string) => void;
}

export const useVodPlaylistStore = create<VodPlaylistState>()(
  persist(
    (set, get) => ({
      playlists: [],
      randomizeHistory: {},

      createPlaylist: (name) => {
        const trimmed = name.trim() || 'My Playlist';
        const newPlaylist: Playlist = {
          id: `pl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          name: trimmed,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          items: [],
          removeAfterWatching: false,
          autoplayNext: true,
          showSourceName: true,
        };
        set((state) => ({
          playlists: [newPlaylist, ...state.playlists],
        }));
        return newPlaylist;
      },

      deletePlaylist: (id) => set((state) => {
        const nextHistory = { ...state.randomizeHistory };
        delete nextHistory[id];
        return {
          playlists: state.playlists.filter((p) => p.id !== id),
          randomizeHistory: nextHistory,
        };
      }),

      renamePlaylist: (id, name) => set((state) => ({
        playlists: state.playlists.map((p) =>
          p.id === id ? { ...p, name: name.trim() || p.name, updatedAt: Date.now() } : p
        ),
      })),

      addItemToPlaylist: (playlistId, item) => set((state) => {
        return {
          playlists: state.playlists.map((p) => {
            if (p.id !== playlistId) return p;
            const newItem: PlaylistItem = {
              ...item,
              id: `${playlistId}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              playlistId,
              addedAt: Date.now(),
            };
            return {
              ...p,
              items: [...p.items, newItem],
              updatedAt: Date.now(),
            };
          }),
        };
      }),

      addItemsToPlaylist: (playlistId, itemsToAdd) => set((state) => {
        return {
          playlists: state.playlists.map((p) => {
            if (p.id !== playlistId) return p;
            const newItems: PlaylistItem[] = itemsToAdd.map((item, idx) => ({
              ...item,
              id: `${playlistId}_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 7)}`,
              playlistId,
              addedAt: Date.now() + idx,
            }));
            return {
              ...p,
              items: [...p.items, ...newItems],
              updatedAt: Date.now(),
            };
          }),
        };
      }),

      removeItemFromPlaylist: (playlistId, itemId) => set((state) => ({
        playlists: state.playlists.map((p) =>
          p.id === playlistId
            ? { ...p, items: p.items.filter((item) => item.id !== itemId), updatedAt: Date.now() }
            : p
        ),
      })),

      removeItemsFromPlaylist: (playlistId, itemIds) => set((state) => ({
        playlists: state.playlists.map((p) => {
          if (p.id !== playlistId || itemIds.length === 0) return p;
          const removeIds = new Set(itemIds);
          return { ...p, items: p.items.filter((item) => !removeIds.has(item.id)), updatedAt: Date.now() };
        }),
      })),

      reorderPlaylistItems: (playlistId, fromIndex, toIndex) => set((state) => ({
        playlists: state.playlists.map((p) => {
          if (p.id !== playlistId) return p;
          if (fromIndex < 0 || fromIndex >= p.items.length || toIndex < 0 || toIndex >= p.items.length) {
            return p;
          }
          const updatedItems = [...p.items];
          const [moved] = updatedItems.splice(fromIndex, 1);
          updatedItems.splice(toIndex, 0, moved);
          return {
            ...p,
            items: updatedItems,
            updatedAt: Date.now(),
          };
        }),
      })),

      randomizePlaylistItems: (playlistId) => set((state) => {
        const target = state.playlists.find((p) => p.id === playlistId);
        if (!target || target.items.length === 0) return state;
        const shuffled = [...target.items];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return {
          playlists: state.playlists.map((p) =>
            p.id === playlistId ? { ...p, items: shuffled, updatedAt: Date.now() } : p
          ),
          randomizeHistory: {
            ...state.randomizeHistory,
            [playlistId]: [...(state.randomizeHistory[playlistId] || []), target.items.map((item) => item.id)],
          },
        };
      }),

      undoRandomizePlaylistItems: (playlistId) => set((state) => {
        const history = state.randomizeHistory[playlistId];
        if (!history || history.length === 0) return state;
        const originalIds = history[history.length - 1];
        const nextHistory = { ...state.randomizeHistory };
        const remaining = history.slice(0, -1);
        if (remaining.length === 0) {
          delete nextHistory[playlistId];
        } else {
          nextHistory[playlistId] = remaining;
        }
        return {
          playlists: state.playlists.map((p) => {
            if (p.id !== playlistId) return p;
            const byId = new Map(p.items.map((item) => [item.id, item]));
            const restored = originalIds
              .map((id) => byId.get(id))
              .filter((item): item is PlaylistItem => Boolean(item));
            // Append items that were added after the randomize
            const addedAfter = p.items.filter((item) => !originalIds.includes(item.id));
            return {
              ...p,
              items: [...restored, ...addedAfter],
              updatedAt: Date.now(),
            };
          }),
          randomizeHistory: nextHistory,
        };
      }),

      toggleRemoveAfterWatching: (playlistId) => set((state) => ({
        playlists: state.playlists.map((p) =>
          p.id === playlistId
            ? { ...p, removeAfterWatching: !p.removeAfterWatching, updatedAt: Date.now() }
            : p
        ),
      })),

      toggleAutoplayNext: (playlistId) => set((state) => ({
        playlists: state.playlists.map((p) =>
          p.id === playlistId
            ? { ...p, autoplayNext: !(p.autoplayNext ?? true), updatedAt: Date.now() }
            : p
        ),
      })),

      toggleShowSourceName: (playlistId) => set((state) => ({
        playlists: state.playlists.map((p) =>
          p.id === playlistId
            ? { ...p, showSourceName: !(p.showSourceName ?? true), updatedAt: Date.now() }
            : p
        ),
      })),
    }),
    {
      name: 'vod-playlists-store',
      // Keep the persisted shape unchanged (playlists only) — the randomize
      // undo snapshot is session-only state.
      partialize: (state) => ({ playlists: state.playlists }),
    }
  )
);
