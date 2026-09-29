/**
 * What a deleted playlist leaves behind outside its own tables.
 *
 * `clearSourceData` / `clearVodData` wipe the rows the playlist owns, but a
 * playlist id is also written into places that are not keyed by it: the sidebar
 * ordering preferences, its own favourite order, the per-playlist logo
 * overrides, the Stalker short-EPG cache, and each Global EPG link that had it
 * attached. Those survive a delete, and a stale id in a list that renders names
 * shows up as an unresolvable entry (the raw id) — the same class of bug as a
 * Global EPG link that keeps naming a playlist that is gone.
 *
 * Everything here is best-effort: the playlist is already deleted by the time
 * this runs, so a preference that can't be read is logged and skipped rather
 * than allowed to fail the delete.
 *
 * Not covered on purpose: `watchlist`, `vod_history` and `episode_history`. Those
 * are the user's own viewing data, not a reference to the playlist, and the app
 * keeps them through "Clear All Cached Data" too.
 */
import { db } from '../db';
import { clearChannelSyncCache } from '../db/sync';
import { useSettingsStore } from '../stores/settingsStore';
import { dropDeletedGlobalEpgSourceRefs } from './globalEpgSourcePrune';

/** Preference keys holding a user-arranged list of sidebar playlists. */
export const ORDER_PREF_KEYS = ['sidebar_sources_order', 'vod_sidebar_sources_order'] as const;

/** Preference key for one playlist's channel favourite order. */
export function favoriteOrderPrefKey(sourceId: string): string {
  return `favorite_source_order:${sourceId}`;
}

/** localStorage lists whose entries are `<sourceId>:<rowId>` strings. */
export const PINNED_ROW_STORAGE_KEYS = ['ynotv:pinnedCategories', 'ynotv:pinnedFolders'] as const;

/**
 * Drop the `<sourceId>:`-prefixed entries of a JSON list in localStorage.
 *
 * The sidebar pins are stored as strings that lead with the source id, so a
 * deleted playlist's pins can be identified without knowing which categories or
 * folders they named. A missing, unparseable or non-list value is left alone.
 *
 * @returns whether anything was removed
 */
export function dropPinnedRowsForSource(storageKey: string, sourceId: string): boolean {
  let parsed: unknown;
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return false;
    parsed = JSON.parse(saved);
  } catch {
    return false; // Hand-edited or legacy value: leave it alone.
  }
  if (!Array.isArray(parsed)) return false;

  const prefix = `${sourceId}:`;
  const kept = parsed.filter(entry => typeof entry !== 'string' || !entry.startsWith(prefix));
  if (kept.length === parsed.length) return false;

  try {
    localStorage.setItem(storageKey, JSON.stringify(kept));
  } catch (e) {
    console.warn(`[Sources] Failed to clean the deleted playlist's pins from ${storageKey}:`, e);
    return false;
  }
  return true;
}

export interface DeletedSourceReferences {
  /** Global EPG links that lost the playlist as an attachment. */
  globalEpgLinks: number;
  /** Order preferences rewritten because they listed it. */
  orderPrefs: string[];
  /** Whether its own favourite-order preference existed and was removed. */
  favoriteOrderRemoved: boolean;
  /** Whether a per-playlist logo display/background override was removed. */
  logoOverrideRemoved: boolean;
  /** Per-channel audio delays that named one of its channels. */
  audioDelays: number;
  /** Stalker short-EPG cache entries that named it. */
  stalkerCacheEntries: number;
  /** localStorage lists whose pinned rows were removed. */
  pinnedLists: string[];
}

const EMPTY_REPORT: DeletedSourceReferences = {
  globalEpgLinks: 0,
  orderPrefs: [],
  favoriteOrderRemoved: false,
  logoOverrideRemoved: false,
  audioDelays: 0,
  stalkerCacheEntries: 0,
  pinnedLists: [],
};

/**
 * Drop `sourceId` from every array inside a parsed preference value, keeping the
 * value's shape.
 *
 * The order preferences come in two shapes — `sidebar_sources_order` is a plain
 * list, `vod_sidebar_sources_order` is a list per media type — and both hold
 * sidebar item ids, where a source id is just one kind of entry. So the id is
 * removed wherever it appears, and entries that merely look similar are left
 * alone.
 */
export function withoutSourceId(value: unknown, sourceId: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    const kept = value.filter(entry => entry !== sourceId);
    return kept.length === value.length ? { value, changed: false } : { value: kept, changed: true };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const result = withoutSourceId(entry, sourceId);
      if (result.changed) changed = true;
      next[key] = result.value;
    }
    // Same object back when nothing matched, so callers can skip a write.
    return changed ? { value: next, changed: true } : { value, changed: false };
  }
  return { value, changed: false };
}

/**
 * Remove a deleted playlist from every preference and setting that named it.
 * Never throws: each step is isolated so one failing store can't stop the rest.
 */
export async function forgetDeletedSource(sourceId: string): Promise<DeletedSourceReferences> {
  const id = typeof sourceId === 'string' ? sourceId.trim() : '';
  if (!id) return { ...EMPTY_REPORT };

  const report: DeletedSourceReferences = { ...EMPTY_REPORT };

  // 1. Global EPG links — the same rule the link editor applies on save.
  try {
    report.globalEpgLinks = dropDeletedGlobalEpgSourceRefs(new Set([id]));
  } catch (e) {
    console.warn('[Sources] Failed to detach the deleted playlist from Global EPG sources:', e);
  }

  // 2. Sidebar ordering preferences.
  for (const key of ORDER_PREF_KEYS) {
    try {
      const pref = await db.prefs.get(key);
      if (!pref?.value) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(pref.value);
      } catch {
        continue; // Hand-edited or legacy value: leave it alone.
      }
      const cleaned = withoutSourceId(parsed, id);
      if (!cleaned.changed) continue;
      await db.prefs.put({ key, value: JSON.stringify(cleaned.value) });
      report.orderPrefs.push(key);
    } catch (e) {
      console.warn(`[Sources] Failed to drop the deleted playlist from ${key}:`, e);
    }
  }

  // 3. The playlist's own channel favourite order.
  try {
    const key = favoriteOrderPrefKey(id);
    const pref = await db.prefs.get(key);
    if (pref) {
      await db.prefs.delete(key);
      report.favoriteOrderRemoved = true;
    }
  } catch (e) {
    console.warn('[Sources] Failed to remove the deleted playlist favourite order:', e);
  }

  // 4. Per-playlist logo overrides ('default' is the setters' "no override").
  try {
    const settings = useSettingsStore.getState();
    const hasDisplay = id in settings.sourceLogoDisplayOverrides;
    const hasBackground = id in settings.sourceLogoBackgroundOverrides;
    if (hasDisplay) settings.setSourceLogoDisplayOverride(id, 'default');
    if (hasBackground) settings.setSourceLogoBackgroundOverride(id, 'default');
    report.logoOverrideRemoved = hasDisplay || hasBackground;
  } catch (e) {
    console.warn('[Sources] Failed to remove the deleted playlist logo overrides:', e);
  }

  // 5. Per-channel audio delays, keyed `<sourceId>_<streamId>` — a custom delay
  //    for a channel that no longer exists can never be reached again (a
  //    re-added playlist gets new ids), so the entries are dead weight.
  try {
    const delays = useSettingsStore.getState().channelAudioDelays ?? {};
    const stale = Object.keys(delays).filter(key => key.startsWith(`${id}_`));
    if (stale.length > 0) {
      const next = { ...delays };
      for (const key of stale) delete next[key];
      useSettingsStore.getState().setChannelAudioDelays(next);
      report.audioDelays = stale.length;
    }
  } catch (e) {
    console.warn('[Sources] Failed to remove the deleted playlist audio delays:', e);
  }

  // 6. Stalker short-EPG cache, keyed `<sourceId>_<channelId>` (clears both the
  //    in-memory map and the copy persisted in prefs).
  try {
    report.stalkerCacheEntries = await clearChannelSyncCache(id);
  } catch (e) {
    console.warn('[Sources] Failed to clear the deleted playlist Stalker EPG cache:', e);
  }

  // 7. Sidebar pins, stored as `<sourceId>:<categoryId>` / `<sourceId>:<folderId>`
  //    in localStorage. `dropPinnedRowsForSource` never throws.
  report.pinnedLists = PINNED_ROW_STORAGE_KEYS.filter(key => dropPinnedRowsForSource(key, id));

  return report;
}
