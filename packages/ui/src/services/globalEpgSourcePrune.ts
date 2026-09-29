/**
 * Applying the `globalEpgSourcePrune` rules to the live app: the settings store
 * plus the persisted settings file.
 *
 * The pure rules live in `utils/globalEpgSourcePrune`; this module is the only
 * place that knows where the playlists and the links are read from, so every
 * caller (playlist deletion, the Settings source load, the EPG cache clear)
 * goes through one path and the safety guards are in one place.
 */
import { useSettingsStore } from '../stores/settingsStore';
import {
  dropGlobalEpgSourceReferences,
  pruneGlobalEpgLinkSources,
  type GlobalEpgSourcePrune,
} from '../utils/globalEpgSourcePrune';

/** Log a prune that actually rewrote something, and where it ran. */
function report(kind: string, result: GlobalEpgSourcePrune): void {
  if (result.changedLinks === 0) return;
  console.log(
    `[Global EPG] ${kind}: removed ${result.removedSourceIds.length} deleted playlist reference(s) ` +
      `from ${result.changedLinks} EPG source(s)` +
      (result.emptyLinks > 0 ? `; ${result.emptyLinks} now have no playlists attached` : '')
  );
}

/** The links the prune should read and write through the settings store. */
function currentLinks(): ReturnType<typeof useSettingsStore.getState>['globalEpgLinks'] {
  return useSettingsStore.getState().globalEpgLinks;
}

/**
 * Remove references to the given deleted playlists from every Global EPG link
 * (attachment list and per-source run state) and persist the result.
 *
 * Returns how many links changed; 0 means nothing was written.
 */
export function dropDeletedGlobalEpgSourceRefs(deletedSourceIds: ReadonlySet<string>): number {
  if (deletedSourceIds.size === 0) return 0;
  const result = dropGlobalEpgSourceReferences(currentLinks(), deletedSourceIds);
  if (result.changedLinks === 0) return 0;
  useSettingsStore.getState().setGlobalEpgLinks(result.links);
  report('Dropped deleted playlist references', result);
  return result.changedLinks;
}

/**
 * Remove references to every playlist that is not in `liveSourceIds` from every
 * Global EPG link and persist the result.
 *
 * `liveSourceIds` must be the complete playlist list. Callers that read it from
 * disk should use `pruneStaleGlobalEpgSourcesFromStoredSources` instead: a
 * failed read looks exactly like "no playlists exist" and would detach every
 * link, which is the one outcome this repair must never cause.
 */
export function pruneStaleGlobalEpgSources(liveSourceIds: ReadonlySet<string>): number {
  const result = pruneGlobalEpgLinkSources(currentLinks(), liveSourceIds);
  if (result.changedLinks === 0) return 0;
  useSettingsStore.getState().setGlobalEpgLinks(result.links);
  report('Pruned deleted playlists', result);
  return result.changedLinks;
}

/**
 * Read the stored playlist list and prune against it.
 *
 * Only a successful read is trusted — anything else returns 0 without touching
 * the links, so a mid-startup or failing storage bridge can't wipe them.
 */
export async function pruneStaleGlobalEpgSourcesFromStoredSources(): Promise<number> {
  if (typeof window === 'undefined' || !window.storage) return 0;
  try {
    const result = await window.storage.getSources();
    if (!result?.success || !Array.isArray(result.data)) {
      console.warn('[Global EPG] Skipped pruning deleted playlists: could not read the playlist list');
      return 0;
    }
    const live = new Set<string>();
    for (const source of result.data) {
      const id = source && typeof source === 'object' ? (source as { id?: unknown }).id : undefined;
      if (typeof id === 'string' && id.length > 0) live.add(id);
    }
    return pruneStaleGlobalEpgSources(live);
  } catch (e) {
    console.warn('[Global EPG] Failed to prune deleted playlists:', e);
    return 0;
  }
}
