import { create } from 'zustand';
import { db, type VodMetadataOverride } from '../db';

export type VodMediaType = 'movie' | 'series';

/** Stable map key for an override row — `${media_type}:${media_id}`. */
export function overrideKey(mediaId: string, type: VodMediaType): string {
  return `${type}:${mediaId}`;
}

/**
 * Merge a metadata override onto a movie/series row for display. The override
 * table is never written by sync, so edits survive provider syncs. Only fields
 * the user explicitly corrected are applied; everything else stays provider
 * data. Movies and series use different poster fields, so both are set.
 */
export function applyVodMetadataOverride<T extends object>(
  item: T,
  override: VodMetadataOverride | undefined
): T {
  if (!override) return item;
  const merged: any = { ...item };
  if (override.title) {
    merged.title = override.title;
    merged.name = override.title;
  }
  if (override.year) merged.year = override.year;
  if (override.poster) {
    merged.stream_icon = override.poster;
    merged.cover = override.poster;
  }
  if (override.plot) merged.plot = override.plot;
  if (override.tmdb_id) merged.tmdb_id = override.tmdb_id;
  return merged;
}

export interface VodMetadataOverrideFields {
  title?: string | null;
  year?: string | null;
  poster?: string | null;
  plot?: string | null;
  tmdb_id?: number | null;
}

interface VodMetadataOverridesState {
  /** All overrides keyed by overrideKey(mediaId, type). */
  overrides: Record<string, VodMetadataOverride>;
  hydrated: boolean;
  /** Load all overrides from the DB once. Safe to call repeatedly. */
  hydrate: () => Promise<void>;
  setOverride: (
    mediaId: string,
    type: VodMediaType,
    fields: VodMetadataOverrideFields
  ) => Promise<void>;
  clearOverride: (mediaId: string, type: VodMediaType) => Promise<void>;
}

export const useVodMetadataOverridesStore = create<VodMetadataOverridesState>()((set, get) => ({
  overrides: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const rows = await db.vodMetadataOverrides.toArray();
      const map: Record<string, VodMetadataOverride> = {};
      for (const row of rows) {
        map[row.override_key] = row;
      }
      set({ overrides: map, hydrated: true });
    } catch (err) {
      // DB not ready yet — leave hydrated=false so the next call retries.
      console.error('[VodMetadataOverrides] Hydration failed:', err);
    }
  },

  setOverride: async (mediaId, type, fields) => {
    const key = overrideKey(mediaId, type);
    const existing = get().overrides[key];
    const row: VodMetadataOverride = {
      override_key: key,
      media_id: mediaId,
      media_type: type,
      title: fields.title !== undefined ? fields.title : (existing?.title ?? null),
      year: fields.year !== undefined ? fields.year : (existing?.year ?? null),
      poster: fields.poster !== undefined ? fields.poster : (existing?.poster ?? null),
      plot: fields.plot !== undefined ? fields.plot : (existing?.plot ?? null),
      tmdb_id: fields.tmdb_id !== undefined ? fields.tmdb_id : (existing?.tmdb_id ?? null),
      updated_at: Date.now(),
    };
    await db.vodMetadataOverrides.put(row);
    set((s) => ({ overrides: { ...s.overrides, [key]: row } }));
  },

  clearOverride: async (mediaId, type) => {
    const key = overrideKey(mediaId, type);
    await db.vodMetadataOverrides.delete(key);
    set((s) => {
      const next = { ...s.overrides };
      delete next[key];
      return { overrides: next };
    });
  },
}));
