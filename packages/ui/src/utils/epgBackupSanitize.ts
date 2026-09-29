/**
 * Repairs for EPG state that arrives from somewhere other than a live feed: a
 * backup being restored, or a channel pin naming a feed that no longer exists.
 * Both directions answer the same question — which feeds can actually serve a
 * pin (`ServableFeedIds` / `isServableFeedPin`) — so the rule lives here once.
 *
 * A backup restores *configuration*, and three pieces of the EPG state it
 * carries can't be handed over as-is:
 *
 *  - A feed pin (`epg_channel_overrides.epg_source_id`) names the one feed that
 *    may fill a channel: `global_epg_<linkId>` for an EPG source attached to a
 *    playlist, or a playlist id for a provider's own feed. A pinned channel is
 *    skipped by *every* other feed — including its own playlist's — so a pin
 *    whose feed isn't part of the imported data leaves that channel permanently
 *    blank with nothing in the UI to explain why. Restoring drops those pins and
 *    lets the channel fall back to the normal waterfall.
 *
 *  - `lastSynced` / `lastSyncResult` are run state, not configuration: they
 *    record when each feed last ran here and whether it filled anything.
 *    Programmes are not part of a backup (`programs` is cleared on import), so a
 *    stamp from the machine that produced the file would make the restored
 *    install skip a feed — leaving the imported channels with no guide at all
 *    until the freshness window passes.
 *
 *  - A link's attached playlists (`sourceIds`) name sources the file has to
 *    carry. The restore replaces the source list with the backup's own, so an
 *    attachment the file has no playlist for is dead on arrival — and the
 *    settings card renders an id it cannot resolve as the raw id, so it would
 *    show up as a pill of UUID text (see `globalEpgSourcePrune`).
 *
 * Every helper is pure so the rules can be tested without a database.
 */
import type { GlobalEpgLink } from '../types/app';
import { pruneGlobalEpgLinkSources } from './globalEpgSourcePrune';

/** Prefix of a pin that points at a global EPG link rather than a playlist. */
export const GLOBAL_EPG_PIN_PREFIX = 'global_epg_';

/** The feed ref channels are pinned to when the user picks a global EPG link. */
export function globalEpgPinRef(linkId: string): string {
  return `${GLOBAL_EPG_PIN_PREFIX}${linkId}`;
}

export function isGlobalEpgPin(pin: string): boolean {
  return pin.startsWith(GLOBAL_EPG_PIN_PREFIX);
}

/**
 * The feeds that can actually serve a pin: the playlists that exist, plus the
 * live global EPG links. A restore builds this from the backup, the sync passes
 * build it from the running app — the rule below is the same either way.
 */
export interface ServableFeedIds {
  /** Playlist ids (a provider's own feed passes its source id). */
  sourceIds: ReadonlySet<string>;
  /** Global EPG link ids (the bare id, without the `global_epg_` prefix). */
  linkIds: ReadonlySet<string>;
}

/**
 * Whether a feed pass could ever claim a channel carrying this pin. Mirrors what
 * the writer guarantees at pin time (see `servablePin` in the EPG editor): a
 * link pin needs that link to exist, a playlist pin needs that playlist.
 */
export function isServableFeedPin(pin: string, feeds: ServableFeedIds): boolean {
  const trimmed = pin.trim();
  if (!trimmed) return false;
  if (isGlobalEpgPin(trimmed)) {
    return feeds.linkIds.has(trimmed.slice(GLOBAL_EPG_PIN_PREFIX.length));
  }
  return feeds.sourceIds.has(trimmed);
}

/** The result of dropping the pins no feed can satisfy at match time. */
export interface ServableFeedPins {
  /** The pins that survive, unchanged. */
  pins: Map<string, string>;
  /** Distinct feed refs a dropped pin named — no feed can ever serve these. */
  unservableFeeds: string[];
  /** Stream ids whose pin was dropped, i.e. now treated as unpinned. */
  unpinnedStreamIds: string[];
}

/**
 * Drop the pins no feed can satisfy — the match-time direction of the same rule
 * the import repair applies at restore time.
 *
 * A pinned channel is skipped by every feed that isn't the one named, so a pin
 * to a feed that no longer exists reserves that channel for nobody and leaves it
 * blank for good. Cleaning up as a feed disappears (`releasePinsForFeed`) covers
 * the paths in the app; this is the backstop for a pin the app never got to
 * clean — a database written by an older build, a hand-edited row, a restore
 * that predates the repair. Those pins are treated as absent, so the channel
 * falls back to the normal waterfall instead of waiting for a feed that is gone.
 *
 * The dropped feed refs are returned as well: the alignment queries have to
 * ignore the same pins, and they decide in SQL.
 */
export function dropUnservableFeedPins(
  pinMap: ReadonlyMap<string, string>,
  feeds: ServableFeedIds
): ServableFeedPins {
  const pins = new Map<string, string>();
  const unservableFeeds = new Set<string>();
  const unpinnedStreamIds: string[] = [];

  for (const [streamId, pin] of pinMap) {
    if (isServableFeedPin(pin, feeds)) {
      pins.set(streamId, pin);
      continue;
    }
    unservableFeeds.add(pin.trim());
    unpinnedStreamIds.push(streamId);
  }

  return { pins, unservableFeeds: [...unservableFeeds], unpinnedStreamIds };
}

/** An override row as it appears in a backup (current or legacy spelling). */
export interface ImportedFeedPinRow {
  streamId?: string;
  stream_id?: string;
  epgSourceId?: string | null;
  epg_source_id?: string | null;
}

export interface DroppedFeedPin {
  streamId: string;
  pin: string;
}

/**
 * The pin a restore would actually apply, using the same precedence the restore
 * uses (`epgSourceId` wins when present, even when it is null/undefined, with
 * the snake_case field as the legacy fallback).
 */
export function importedFeedPin(row: ImportedFeedPinRow): string {
  const value = row.epgSourceId !== undefined ? row.epgSourceId : row.epg_source_id;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Drop the feed pins a restore cannot serve, keeping the rest of each override
 * (tvg-id, logo, timeshift, match-by-name all stay). The rows themselves are
 * kept — only the pin is cleared.
 */
export function sanitizeImportedFeedPins<T extends ImportedFeedPinRow>(
  overrides: readonly T[] | null | undefined,
  feeds: ServableFeedIds
): { overrides: T[]; dropped: DroppedFeedPin[] } {
  const kept: T[] = [];
  const dropped: DroppedFeedPin[] = [];

  // A hand-edited or truncated backup isn't a reason to abort a restore, so
  // anything that isn't a row passes through untouched.
  if (!Array.isArray(overrides)) return { overrides: [], dropped: [] };

  for (const override of overrides) {
    if (!override || typeof override !== 'object') {
      kept.push(override);
      continue;
    }
    const pin = importedFeedPin(override);
    if (!pin || isServableFeedPin(pin, feeds)) {
      kept.push(override);
      continue;
    }
    dropped.push({
      streamId: String(override.streamId ?? override.stream_id ?? ''),
      pin,
    });
    const cleaned = { ...override } as T & Record<string, unknown>;
    // Clear both spellings: the restore reads camelCase first, so leaving the
    // snake_case copy behind would resurrect the pin on a legacy backup.
    cleaned.epgSourceId = undefined;
    delete cleaned.epg_source_id;
    kept.push(cleaned);
  }

  return { overrides: kept, dropped };
}

/**
 * Strip the per-render state from an EPG link, keeping every setting the user
 * chose (name, URL, attached playlists, save-entire-feed, order).
 */
export function stripEpgLinkRunState<T extends { lastSynced?: unknown; lastSyncResult?: unknown }>(
  links: readonly T[] | null | undefined
): { links: Array<Omit<T, 'lastSynced' | 'lastSyncResult'>>; reset: number } {
  if (!Array.isArray(links)) return { links: [], reset: 0 };
  let reset = 0;
  const cleaned = links.map((link) => {
    if (!link || typeof link !== 'object') {
      return link as Omit<T, 'lastSynced' | 'lastSyncResult'>;
    }
    const { lastSynced: _lastSynced, lastSyncResult: _lastSyncResult, ...config } = link;
    if (_lastSynced !== undefined || _lastSyncResult !== undefined) reset += 1;
    return config;
  });
  return { links: cleaned, reset };
}

/** Settings as a backup carries them, for the link-run-state pass. */
export function stripImportedEpgLinkRunState<T extends { globalEpgLinks?: GlobalEpgLink[] }>(
  settings: T
): { settings: T; reset: number } {
  if (!settings || typeof settings !== 'object') return { settings, reset: 0 };
  const links = settings.globalEpgLinks;
  if (!Array.isArray(links) || links.length === 0) return { settings, reset: 0 };
  const { links: cleaned, reset } = stripEpgLinkRunState(links);
  if (reset === 0) return { settings, reset: 0 };
  return { settings: { ...settings, globalEpgLinks: cleaned as GlobalEpgLink[] }, reset };
}

/** A backup, as far as this repair cares about it. */
export interface ImportedBackupSlice<T, S> {
  epgChannelOverrides?: readonly T[] | null;
  sources?: ReadonlyArray<{ id?: string }> | null;
  settings: S;
}

export interface ImportedEpgRepair<T, S> {
  epgChannelOverrides: T[];
  settings: S;
  droppedPins: DroppedFeedPin[];
  resetLinks: number;
  /** Playlist ids dropped from the links because the backup has no such source. */
  prunedSourceIds: string[];
}

/**
 * The two repairs together, with the feeds taken from the backup itself: a pin
 * is only kept when the playlist or EPG source it names is part of the same
 * file, so what is servable after the restore is what was servable before it.
 */
export function repairImportedEpgState<
  T extends ImportedFeedPinRow,
  S extends { globalEpgLinks?: GlobalEpgLink[] }
>(backup: ImportedBackupSlice<T, S>): ImportedEpgRepair<T, S> {
  const settings = backup.settings && typeof backup.settings === 'object'
    ? backup.settings
    : ({} as S);

  const ids = (values: ReadonlyArray<{ id?: string }> | null | undefined): Set<string> => {
    const out = new Set<string>();
    for (const value of values ?? []) {
      const id = value && typeof value === 'object' ? value.id : undefined;
      if (typeof id === 'string' && id.length > 0) out.add(id);
    }
    return out;
  };

  const sourceIds = ids(backup.sources);
  const pins = sanitizeImportedFeedPins(backup.epgChannelOverrides, {
    sourceIds,
    linkIds: ids(settings.globalEpgLinks),
  });
  const linkRunState = stripImportedEpgLinkRunState(settings);

  // A link's attachment list is configuration, but it names playlists the file
  // has to carry: the restore replaces the source list with the backup's own, so
  // an id without a matching source is stale the moment it lands — and a link
  // renders an id it cannot resolve as the raw id, the same orphan the app now
  // clears when a playlist is deleted here. Runs after the run-state strip so
  // `resetLinks` still counts the links that carried one.
  const pruned = pruneGlobalEpgLinkSources(linkRunState.settings.globalEpgLinks, sourceIds);

  return {
    epgChannelOverrides: pins.overrides,
    settings: pruned.changedLinks > 0
      ? { ...linkRunState.settings, globalEpgLinks: pruned.links }
      : linkRunState.settings,
    droppedPins: pins.dropped,
    resetLinks: linkRunState.reset,
    prunedSourceIds: pruned.removedSourceIds,
  };
}
