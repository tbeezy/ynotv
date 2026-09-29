/**
 * Repair for a Global EPG link that still points at a playlist that is gone.
 *
 * A link stores the playlists it may fill as `sourceIds`, plus a per-source
 * record of its last run (`lastSyncResult.perSource` / `perSourceChannels` /
 * `perSourceSyncedAt`). Only the link editor ever rewrote those lists, so
 * deleting a playlist removed it from `sources` and from SQLite but left its id
 * inside every link that had it attached. The settings card renders an attached
 * id it cannot resolve as the raw id, which is what a stale entry shows up as:
 * a pill full of UUID next to the playlists that do still exist.
 *
 * Two directions of the same rule live here, because the callers know different
 * things:
 *
 *  - `pruneGlobalEpgLinkSources` is given the playlists that exist and drops
 *    everything else. Used where the authoritative list has just been read
 *    (the Settings source load, the EPG cache clear) so installs that lost a
 *    playlist before this cleanup existed are repaired too.
 *  - `dropGlobalEpgSourceReferences` is given the playlists that were deleted
 *    and drops exactly those. Used by the delete flow itself, where a
 *    long-lived `sources` snapshot could otherwise read as "every playlist is
 *    gone" and detach links the user never touched.
 *
 * Both are pure so the rules can be tested without a store or a database, and
 * both keep the untouched objects (and the input array) identical so callers
 * can skip persisting when nothing changed — the same contract as
 * `clearGlobalEpgSourceStamps` in `globalEpgFreshness`.
 */
import type { GlobalEpgLink } from '../types/app';

export interface GlobalEpgSourcePrune {
  /** The links with every reference to a playlist that is gone removed. */
  links: GlobalEpgLink[];
  /** Distinct playlist ids dropped from at least one link, in first-seen order. */
  removedSourceIds: string[];
  /** How many links this pass rewrote. */
  changedLinks: number;
  /** How many resulting links have no attached playlists at all. */
  emptyLinks: number;
}

const EMPTY_RESULT: GlobalEpgSourcePrune = {
  links: [],
  removedSourceIds: [],
  changedLinks: 0,
  emptyLinks: 0,
};

/** Keep only the entries whose key is still a playlist this link may use. */
function keepLiveEntries<T>(
  entries: Record<string, T> | undefined,
  isLive: (id: string) => boolean
): { map: Record<string, T> | undefined; changed: boolean } {
  if (!entries || typeof entries !== 'object') return { map: entries, changed: false };
  let changed = false;
  const map: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (isLive(key)) map[key] = value;
    else changed = true;
  }
  return changed ? { map, changed } : { map: entries, changed: false };
}

function pruneLinks(
  links: readonly GlobalEpgLink[] | null | undefined,
  isLive: (id: string) => boolean
): GlobalEpgSourcePrune {
  if (!Array.isArray(links)) return EMPTY_RESULT;
  if (links.length === 0) return { ...EMPTY_RESULT, links: links as GlobalEpgLink[] };

  const removedSourceIds: string[] = [];
  const seenRemoved = new Set<string>();
  let changedLinks = 0;
  let emptyLinks = 0;

  const next = links.map((link): GlobalEpgLink => {
    // A hand-edited or truncated settings file isn't a reason to drop the link.
    if (!link || typeof link !== 'object') return link;

    const attached = Array.isArray(link.sourceIds) ? link.sourceIds : [];
    const kept: string[] = [];
    for (const id of attached) {
      if (isLive(id)) {
        kept.push(id);
      } else if (!seenRemoved.has(id)) {
        // Undefined/blank ids can't name a playlist either, but they aren't
        // worth reporting as a deleted one.
        seenRemoved.add(id);
        if (id) removedSourceIds.push(id);
      }
    }

    const result = link.lastSyncResult;
    let nextResult = result;
    if (result) {
      const perSource = keepLiveEntries(result.perSource, isLive);
      const perSourceChannels = keepLiveEntries(result.perSourceChannels, isLive);
      const perSourceSyncedAt = keepLiveEntries(result.perSourceSyncedAt, isLive);

      if (perSource.changed || perSourceChannels.changed || perSourceSyncedAt.changed) {
        const noSourceLeft = Object.keys(perSource.map ?? {}).length === 0;
        if (perSource.changed && noSourceLeft) {
          // The recorded run only ever filled playlists that are gone, so the
          // whole result (its totals, its matched channels) describes nothing
          // that can still be filled. `lastSynced` stays: it is still when the
          // link last ran.
          nextResult = undefined;
        } else {
          nextResult = { ...result };
          if (perSource.changed) nextResult.perSource = perSource.map ?? {};
          if (perSourceChannels.changed) nextResult.perSourceChannels = perSourceChannels.map;
          if (perSourceSyncedAt.changed) nextResult.perSourceSyncedAt = perSourceSyncedAt.map;
        }
      }
    }

    const endsEmpty = kept.length === 0;
    if (endsEmpty) emptyLinks += 1;

    const attachedChanged = kept.length !== attached.length;
    // Nothing to say: hand the caller its own object back so it can skip a write.
    if (!attachedChanged && nextResult === result) return link;

    changedLinks += 1;
    return {
      ...link,
      sourceIds: kept,
      ...(nextResult === result ? {} : { lastSyncResult: nextResult }),
    };
  });

  return {
    links: changedLinks === 0 ? (links as GlobalEpgLink[]) : next,
    removedSourceIds,
    changedLinks,
    emptyLinks,
  };
}

/**
 * Drop every reference to a playlist that is not in `liveSourceIds`.
 *
 * `liveSourceIds` must be the complete, authoritative playlist list — the app
 * can't tell "this playlist was deleted" apart from "this caller only looked at
 * some playlists", so an empty or partial set detaches everything. Prefer
 * `dropGlobalEpgSourceReferences` when the deleted ids are the thing you know.
 */
export function pruneGlobalEpgLinkSources(
  links: readonly GlobalEpgLink[] | null | undefined,
  liveSourceIds: ReadonlySet<string>
): GlobalEpgSourcePrune {
  return pruneLinks(links, (id) => liveSourceIds.has(id));
}

/**
 * Drop every reference to the given deleted playlists, keeping all others —
 * even ids that are not in the caller's playlist snapshot.
 *
 * An empty set is a no-op, so a caller that has nothing to delete cannot detach
 * a link by accident.
 */
export function dropGlobalEpgSourceReferences(
  links: readonly GlobalEpgLink[] | null | undefined,
  deletedSourceIds: ReadonlySet<string>
): GlobalEpgSourcePrune {
  return pruneLinks(links, (id) => !deletedSourceIds.has(id));
}
