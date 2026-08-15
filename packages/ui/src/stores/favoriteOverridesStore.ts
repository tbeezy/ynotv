/**
 * Optimistic favorite overrides store.
 *
 * The LiveTV favorite star reads from this store first, so toggling a favorite
 * updates the icon immediately instead of waiting for the database round-trip
 * and the debounced live-query refresh. The authoritative value still lives in
 * the channels table; overrides are reconciled (cleared) whenever a structural
 * channels-table event occurs, since the next live query re-fetches the real
 * is_favorite value.
 */

import { create } from 'zustand';
import { dbEvents } from '../db/sqlite-adapter';

interface FavoriteOverridesState {
  overrides: Record<string, boolean>;
  setOverride: (streamId: string, value: boolean) => void;
  clearOverride: (streamId: string) => void;
  clearAll: () => void;
}

export const useFavoriteOverridesStore = create<FavoriteOverridesState>((set) => ({
  overrides: {},
  setOverride: (streamId, value) => set((state) => ({
    overrides: { ...state.overrides, [streamId]: value },
  })),
  clearOverride: (streamId) => set((state) => {
    if (!(streamId in state.overrides)) return state;
    const next = { ...state.overrides };
    delete next[streamId];
    return { overrides: next };
  }),
  clearAll: () => set({ overrides: {} }),
}));

// Favorite toggles emit the dedicated 'favorites' event (not 'channels'), so
// this only fires for structural writes — syncs, cache clears, bulk ops, the
// channel manager, etc. Clear optimistic state so the next query wins.
dbEvents.subscribe('channels', () => {
  useFavoriteOverridesStore.getState().clearAll();
});

/** Subscribe to the optimistic override (if any) for a single channel. */
export const useFavoriteOverride = (streamId: string) =>
  useFavoriteOverridesStore((state) => state.overrides[streamId]);
