/**
 * EPG Overrides Service
 * ---------------------
 * CRUD helpers for epg_channel_overrides and epg_program_overrides tables.
 * Also provides EPG channel search with normalized token-scoring for matching
 * a channel name to an XMLTV channel ID.
 */

import { db } from '../db';
import type { EpgChannelOverride, EpgProgramOverride, StoredEpgChannel } from '../db';
import { getSearchVariants } from '../utils/searchNormalization';
import { useSettingsStore } from '../stores/settingsStore';
import {
  matchByCleanName,
  scoreChannelMatch,
  type CleanNameIndex,
  type CleanMatchVia,
  type NameMatchCandidate,
} from '../utils/epgChannelMatch';
import { buildRestoredOverride, type PriorOverrideSnapshot } from '../utils/epgAutomatchUndo';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScoredEpgChannel extends StoredEpgChannel {
  score: number;
  sourceName?: string;
}

// ─── Channel Override CRUD ────────────────────────────────────────────────────

export async function getChannelOverride(streamId: string): Promise<EpgChannelOverride | null> {
  const row = await db.epgChannelOverrides.get(streamId);
  return row ?? null;
}

/**
 * Write a channel's override row, keeping every field the caller does not name.
 *
 * `put` is INSERT OR REPLACE, and the adapter builds its column list from the
 * object it is handed — a column left out of that object is written as NULL, not
 * left alone. Only the Channel tab's Save carries a whole row; every other caller
 * means to change *some* fields (the id a match picked, the feed's icon, the
 * timeshift), so a bare `put` erased the rest of the row. That is how applying a
 * match, running Automatch and resolving a refusal each silently dropped a
 * channel's logo background and tile padding — and with them the settings the
 * user had picked for that channel.
 *
 * So this is the one write path for channel overrides and it merges:
 *
 *  - a field the caller omits keeps its stored value;
 *  - a field the caller passes as `undefined` is cleared, because the key is
 *    present and therefore wins. That is what the Channel tab relies on to drop a
 *    feed lock when the TVG-ID is edited by hand, and what
 *    `releaseChannelFeedPin` relies on to release a pin.
 *
 * The read costs one primary-key lookup per write, which is deliberate: a caller
 * holding a row it captured earlier (an Automatch run preloads its channels) can
 * be minutes stale, and merging that back would revert a hand edit made while the
 * run was in progress.
 */
export async function upsertChannelOverride(override: EpgChannelOverride): Promise<void> {
  const existing = override.stream_id ? await getChannelOverride(override.stream_id) : null;
  await db.epgChannelOverrides.put({ ...(existing ?? {}), ...override });
  // Notify live queries immediately:
  // - 'programs': re-runs useCurrentProgram / usePrograms / useProgramsInRange / useAllPrograms
  //   (timeshift change affects all program time display)
  // - 'channels': re-runs useChannels so logo overrides appear instantly in the channel list
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('programs', 'update');
  dbEvents.notify('channels', 'update');
}


export async function batchUpsertLogoOverrides(
  updates: Array<{
    streamId: string;
    logoBackground?: 'auto' | 'light' | 'dark';
    /**
     * `'default'`/`'none'` records that choice on the channel; `null` clears it, so
     * the tile follows the global Tile Layout setting again; omitted leaves whatever
     * is stored. `null` and `undefined` differ on purpose — an editor has to be able
     * to say "back to the global setting" for a channel that carries a padding.
     */
    logoPadding?: 'default' | 'none' | null;
  }>
): Promise<void> {
  if (updates.length === 0) return;

  const streamIds = updates.map(u => u.streamId);
  const existingOverrides = await db.epgChannelOverrides.where('stream_id').anyOf(streamIds).toArray();
  const existingMap = new Map<string, EpgChannelOverride>(existingOverrides.map(o => [o.stream_id, o]));

  const toPut: EpgChannelOverride[] = [];
  const toDelete: string[] = [];

  for (const { streamId, logoBackground, logoPadding } of updates) {
    const existing = existingMap.get(streamId);

    const nextBg = logoBackground !== undefined
      ? (logoBackground === 'auto' ? undefined : logoBackground)
      : existing?.logo_background;

    // `null` is an explicit "no choice", so it clears rather than reading as a
    // field this update doesn't mention.
    const nextPad = logoPadding !== undefined
      ? (logoPadding ?? undefined)
      : existing?.logo_padding;

    const hasOtherOverrides = Boolean(
      existing?.epg_channel_id ||
      existing?.stream_icon ||
      existing?.epg_source_id ||
      existing?.match_by_alias ||
      existing?.logo_locked ||
      (existing?.timeshift_hours && existing.timeshift_hours !== 0)
    );

    if (!nextBg && !nextPad && !hasOtherOverrides) {
      if (existing) {
        toDelete.push(streamId);
      }
    } else {
      toPut.push({
        stream_id: streamId,
        epg_channel_id: existing?.epg_channel_id,
        stream_icon: existing?.stream_icon,
        timeshift_hours: existing?.timeshift_hours ?? 0,
        logo_background: nextBg,
        logo_padding: nextPad,
        // `put` is INSERT OR REPLACE, so the feed pin must be carried over
        // explicitly or a logo edit would erase it. Same for the
        // "match on my name" flag and the logo lock flag.
        epg_source_id: existing?.epg_source_id,
        match_by_alias: existing?.match_by_alias,
        logo_locked: existing?.logo_locked,
      });
    }
  }

  if (toDelete.length > 0) {
    await db.epgChannelOverrides.bulkDelete(toDelete);
  }
  if (toPut.length > 0) {
    await db.epgChannelOverrides.bulkPut(toPut);
  }

  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('channels', 'update');
}


// ─── Program Override CRUD ────────────────────────────────────────────────────


/**
 * Load raw synced programs + override metadata for the editor.
 * Returns both synced programs (with their override if present) AND custom-only programs.
 */
export interface EditorProgram {
  id: string;
  stream_id: string;
  /** Effective title (override wins if set) */
  title: string;
  /** Effective subtitle */
  subtitle: string;
  /** Effective description */
  description: string;
  /** Effective start ISO string */
  start: string;
  /** Effective end ISO string */
  end: string;
  source_id: string;
  /** Whether there is an override row for this program */
  has_override: boolean;
  /** Tombstoned — hidden in guide but visible in editor */
  is_deleted: boolean;
  /** User-created, not from sync */
  is_custom: boolean;
}

export async function getEditorProgramsForStream(
  streamId: string,
  /** Window in days around now to fetch — defaults to ±3 days */
  windowDays = 3
): Promise<EditorProgram[]> {
  const dbInstance = await (db as any).dbPromise;

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const from = new Date(Date.now() - windowMs).toISOString();
  const to = new Date(Date.now() + windowMs).toISOString();

  // Synced programs (joined with overrides including tombstones)
  // Both source-level (sm.epg_timeshift_hours) and per-channel (co.timeshift_hours)
  // shifts are applied combined in one strftime() so they compose correctly.
  // When the combined shift is 0 we return p.start RAW to preserve the UTC 'Z'
  // suffix so JavaScript parses it correctly as UTC.
  const synced = await dbInstance.select(`
    SELECT
      p.id,
      p.stream_id,
      COALESCE(o.title,       p.title)       AS title,
      COALESCE(o.subtitle,    p.subtitle)    AS subtitle,
      COALESCE(o.description, p.description) AS description,
      COALESCE(o.start,
        CASE WHEN IFNULL(sm.epg_timeshift_hours, 0) + IFNULL(co.timeshift_hours, 0) = 0
          THEN p.start
          ELSE strftime('%Y-%m-%dT%H:%M:%SZ', p.start,
                 CAST((IFNULL(sm.epg_timeshift_hours, 0) + IFNULL(co.timeshift_hours, 0)) * 60 AS INTEGER) || ' minutes')
          END
      ) AS start,
      COALESCE(o.end,
        CASE WHEN IFNULL(sm.epg_timeshift_hours, 0) + IFNULL(co.timeshift_hours, 0) = 0
          THEN p.end
          ELSE strftime('%Y-%m-%dT%H:%M:%SZ', p.end,
                 CAST((IFNULL(sm.epg_timeshift_hours, 0) + IFNULL(co.timeshift_hours, 0)) * 60 AS INTEGER) || ' minutes')
          END
      ) AS end,
      p.source_id,
      CASE WHEN o.id IS NOT NULL THEN 1 ELSE 0 END AS has_override,
      COALESCE(o.is_deleted, 0)              AS is_deleted,
      0 AS is_custom
    FROM programs p
    LEFT JOIN sourcesMeta sm ON sm.source_id = p.source_id
    LEFT JOIN epg_channel_overrides co ON co.stream_id = p.stream_id
    LEFT JOIN epg_program_overrides o ON o.id = p.id AND o.is_custom = 0
    WHERE p.stream_id = $1
      AND p.start >= $2
      AND p.start <= $3
    ORDER BY p.start ASC
  `, [streamId, from, to]) as any[];

  // Custom-only programs
  const custom = await dbInstance.select(`
    SELECT
      id,
      stream_id,
      title,
      subtitle,
      description,
      start,
      end,
      '' AS source_id,
      1  AS has_override,
      is_deleted,
      1  AS is_custom
    FROM epg_program_overrides
    WHERE stream_id = $1
      AND is_custom = 1
      AND start >= $2 AND start <= $3
    ORDER BY start ASC
  `, [streamId, from, to]) as any[];

  const all: EditorProgram[] = [...synced, ...custom].map(r => ({
    id: r.id,
    stream_id: r.stream_id,
    title: r.title ?? '',
    subtitle: r.subtitle ?? '',
    description: r.description ?? '',
    start: r.start ?? '',
    end: r.end ?? '',
    source_id: r.source_id ?? '',
    has_override: Boolean(r.has_override),
    is_deleted: Boolean(r.is_deleted),
    is_custom: Boolean(r.is_custom),
  }));

  // Sort merged list by start time
  all.sort((a, b) => a.start.localeCompare(b.start));
  return all;
}

// ─── Feed guide resolution ────────────────────────────────────────────────────

/** The minimal adapter surface these helpers touch (`db.dbPromise`). */
type SqlDb = {
  select: (sql: string, params?: unknown[]) => Promise<any[]>;
  execute: (sql: string, params?: unknown[]) => Promise<unknown>;
};

/** Where one feed's guide for a tvg-id lives: a link cache, or a channel holding it. */
export type FeedGuideSource =
  | { kind: 'cache'; linkId: string }
  | { kind: 'channel'; streamId: string };

/**
 * The single place that decides where a feed's guide for `epgChannelId` comes from.
 *
 * A tvg-id is not unique: `aandenetwork.us` is carried by the US A&E East channel
 * of several playlists at once, and a global EPG feed keeps its own copy. Picking
 * "any channel with that id" (the old `LIMIT 1`, with no source filter and no
 * ordering) therefore handed back whichever row the planner found first — the
 * preview showed a guide the feed does not carry, and Apply copied it onto the
 * channel under the *other* playlist's source stamp. Every caller now names the
 * feed it is asking about and gets that feed's own channel, or nothing.
 *
 * `feedRef` is the `source_id` a search result carries: a playlist id, or
 * `global_epg_<linkId>` for a link (resolved straight to its cache DB). Omitting it
 * keeps the old library-wide lookup for callers that have no feed to name.
 * `excludeStreamId` drops the channel being written, so a copy can never read the
 * rows it just deleted. Ordering is explicit: the answer must not depend on the
 * query planner.
 */
export async function findFeedGuideSource(
  epgChannelId: string | null | undefined,
  feedRef?: string | null,
  excludeStreamId?: string
): Promise<FeedGuideSource | null> {
  const id = epgChannelId?.trim();
  if (!id) return null;

  if (feedRef && feedRef.startsWith('global_epg_')) {
    return { kind: 'cache', linkId: feedRef.slice('global_epg_'.length) };
  }

  const dbInstance = (await (db as any).dbPromise) as SqlDb;
  const params: unknown[] = [id];
  let where = 'COALESCE(o.epg_channel_id, c.epg_channel_id) = $1';
  if (feedRef) {
    params.push(feedRef);
    where += ` AND c.source_id = $${params.length}`;
  }
  if (excludeStreamId) {
    params.push(excludeStreamId);
    where += ` AND c.stream_id != $${params.length}`;
  }

  // A feed can hold more than one channel for an id, and an overridden sibling must
  // not shadow a native one: an override naming this very id is exactly what
  // Automatch produces, and such a sibling may hold nothing, which would resolve a
  // copy to 0 rows while a native channel with a full guide sat right beside it.
  // Native first, then a stable order so the answer never depends on the planner.
  // Deliberately softer than the alignment's `sc.stream_id NOT IN (…overrides)`:
  // there an overridden carrier must be excluded outright, because the guide it
  // holds belongs to *its* pin; here a fallback to an overridden sibling that does
  // hold rows still beats resolving to nothing.
  const rows = (await dbInstance.select(
    `SELECT c.stream_id
       FROM channels c
       LEFT JOIN epg_channel_overrides o ON o.stream_id = c.stream_id
      WHERE ${where}
      ORDER BY (o.epg_channel_id IS NOT NULL) ASC, c.stream_id ASC
      LIMIT 1`,
    params
  )) as { stream_id: string }[];

  return rows[0] ? { kind: 'channel', streamId: rows[0].stream_id } : null;
}

/** The playlist a channel belongs to, which owns the guide rows written onto it. */
async function getChannelSourceId(dbInstance: SqlDb, streamId: string): Promise<string> {
  const rows = (await dbInstance.select(
    'SELECT source_id FROM channels WHERE stream_id = $1 LIMIT 1',
    [streamId]
  )) as { source_id: string | null }[];
  return rows[0]?.source_id || 'unknown';
}

/**
 * Programmes `streamId` holds right now.
 *
 * Every copy path reports this, so `0` means "the channel has no guide", never "the
 * copy found nothing to move" — those are different states and only one of them is
 * worth acting on.
 */
async function countChannelPrograms(dbInstance: SqlDb, streamId: string): Promise<number> {
  const rows = (await dbInstance.select(
    'SELECT COUNT(*) AS rows FROM programs WHERE stream_id = $1',
    [streamId]
  )) as { rows: number }[];
  return rows[0]?.rows ?? 0;
}

/**
 * Whether the guide a channel currently holds can only have come from another feed,
 * so a reset must drop it rather than leave it showing.
 *
 * Three ways that happens, all read from what the override actually did rather than
 * inferred from the rows (which carry the channel's own source whichever feed wrote
 * them): the channel has no provider id of its own, the override locked it to a
 * different feed, or the override remapped it to an id the provider never gave.
 *
 * A plain override naming the channel's own id is deliberately *not* one of them:
 * that is the Automatch self-match, and its rows are the provider's own.
 *
 * Also deliberately *not* used is "the feed's parsed keys don't include this id": the
 * matcher fills channels by name, by display-name and by the advanced token tier, so
 * a feed with no `epg_channels` row for an id can still be the one that wrote the
 * guide — deciding on that would delete guides the provider really did supply.
 */
function rowsCameFromAnotherFeed(
  hadOverride: boolean,
  ownSourceId: string | null | undefined,
  originalEpgId: string | null | undefined,
  overrideEpgId: string | null,
  overridePin: string | null
): boolean {
  // No override at all means nothing was borrowed: the rows are the channel's own,
  // or a global EPG link's that legitimately matches it, and a reset has nothing to
  // undo.
  if (!hadOverride) return false;
  if (!originalEpgId) return true;
  if (overridePin && overridePin !== ownSourceId) return true;
  if (overrideEpgId && overrideEpgId !== originalEpgId) return true;
  return false;
}

/**
 * Make `targetStreamId`'s guide exactly the guide source's rows, stamped with the
 * target channel's own source — the same stamp the sync writer and the post-sync
 * alignment use, so the channel's own wipe owns the rows and no other playlist's
 * programme count grows from a copy it never made.
 *
 * A guide source that holds no programmes is not a reason to delete the channel's
 * current ones: that is the ordinary state of a feed whose download came back
 * empty, and emptying the channel for it is what turned a pinned channel blank in
 * the first place. Returns the rows the channel holds afterwards.
 */
async function replaceGuideFromChannel(
  dbInstance: SqlDb,
  targetStreamId: string,
  sourceStreamId: string
): Promise<number> {
  const counts = (await dbInstance.select(
    `SELECT
       (SELECT COUNT(*) FROM programs WHERE stream_id = $1) AS source_rows,
       (SELECT COUNT(*) FROM programs WHERE stream_id = $2) AS target_rows`,
    [sourceStreamId, targetStreamId]
  )) as { source_rows: number; target_rows: number }[];

  const sourceRows = counts[0]?.source_rows ?? 0;
  if (sourceRows === 0) {
    console.warn(
      `[EPG Override] Guide source ${sourceStreamId} holds no programs; kept the ` +
        `${counts[0]?.target_rows ?? 0} row(s) already on ${targetStreamId}`
    );
    return counts[0]?.target_rows ?? 0;
  }

  const targetSourceId = await getChannelSourceId(dbInstance, targetStreamId);

  await dbInstance.execute(`DELETE FROM programs WHERE stream_id = $1`, [targetStreamId]);

  // IDs are built from the raw start string ({stream_id}_{start}) exactly like the
  // sync writer, so INSERT OR REPLACE lets the next sync overwrite copies seamlessly.
  await dbInstance.execute(
    `INSERT OR REPLACE INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
     SELECT
       $1 || '_' || start AS id,
       $1 AS stream_id,
       title, subtitle, description, start, end,
       $3 AS source_id
     FROM programs
     WHERE stream_id = $2`,
    [targetStreamId, sourceStreamId, targetSourceId]
  );

  // Ids are derived from `start`, exactly as the source's own ids are, so the
  // channel now holds the guide source's row count.
  return sourceRows;
}

/**
 * Load programs for preview when the user clicks a search result.
 * Finds the channel the *feed that result belongs to* holds for this tvg-id and
 * returns its programs, so a feed with no data previews empty instead of showing
 * another feed's guide. Note for playlist feeds this is a view of what is stored
 * locally for that feed's channel: an unsynced feed previews empty too.
 */
export async function getPreviewProgramsForEpgId(
  epgChannelId: string,
  windowDays = 3,
  sourceId?: string
): Promise<EditorProgram[]> {
  if (sourceId && sourceId.startsWith('global_epg_')) {
    const epgLinkId = sourceId.replace('global_epg_', '');
    try {
      const cacheDbName = `epg_cache_${epgLinkId}`;
      const Database = (await import('@tauri-apps/plugin-sql')).default;
      const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
      
      const progs = await cacheDb.select(
        'SELECT * FROM programs WHERE stream_id = $1 ORDER BY start ASC',
        [epgChannelId]
      ) as any[];
      
      return progs.map(p => ({
        id: p.id,
        stream_id: epgChannelId,
        title: p.title,
        subtitle: p.subtitle,
        description: p.description,
        start: p.start,
        end: p.end,
        source_id: `global_epg_${epgLinkId}`,
        has_override: false,
        is_deleted: false,
        is_custom: false,
      }));
    } catch (e) {
      console.warn(`[EPG Preview] Failed to load programs from cache DB ${epgLinkId}:`, e);
      return [];
    }
  }

  const guide = await findFeedGuideSource(epgChannelId, sourceId);
  if (!guide || guide.kind !== 'channel') return [];
  return getEditorProgramsForStream(guide.streamId, windowDays);
}

/**
 * Immediately copy programs from the feed's channel for epgChannelId into
 * targetStreamId. Called after "Apply" so the channel shows programs right away
 * without waiting for a sync. Only the feed the user picked is read, so an id that
 * several feeds share can never hand back another feed's rows.
 *
 * Returns the number of programs the channel now holds — on every path. A feed with
 * nothing for the id copies nothing and leaves the current guide in place rather
 * than deleting it for a copy that will never land, so the count it reports is the
 * guide that survived, never the zero rows it moved.
 */
export async function copyProgramsFromEpgChannel(
  targetStreamId: string,
  epgChannelId: string,
  sourceId?: string
): Promise<number> {
  const dbInstance = (await (db as any).dbPromise) as SqlDb;

  const guide = await findFeedGuideSource(epgChannelId, sourceId, targetStreamId);
  if (!guide) {
    console.warn(
      `[EPG Override] Feed ${sourceId ?? '(unspecified)'} carries no guide for "${epgChannelId}"; ` +
        `leaving the current guide on ${targetStreamId} as it is`
    );
    // Nothing was copied, so the channel keeps whatever it held.
    return countChannelPrograms(dbInstance, targetStreamId);
  }

  if (guide.kind === 'cache') {
    const epgLinkId = guide.linkId;
    try {
      const cacheDbName = `epg_cache_${epgLinkId}`;
      const Database = (await import('@tauri-apps/plugin-sql')).default;
      const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
      
      const progs = await cacheDb.select(
        'SELECT * FROM programs WHERE stream_id = $1',
        [epgChannelId]
      ) as any[];

      if (progs.length > 0) {
        // The guide belongs to the target channel, so its rows carry the target's
        // source — never the feed's.
        const targetSourceId = await getChannelSourceId(dbInstance, targetStreamId);

        const programsToInsert = progs.map(p => ({
          id: `${targetStreamId}_${p.start}`,
          stream_id: targetStreamId,
          title: p.title,
          subtitle: p.subtitle,
          description: p.description,
          start: new Date(p.start),
          end: new Date(p.end),
          source_id: targetSourceId
        }));

        // Replace, don't merge: the guide is exactly this feed's window.
        await dbInstance.execute(`DELETE FROM programs WHERE stream_id = $1`, [targetStreamId]);
        await db.programs.bulkPut(programsToInsert);
        const { dbEvents } = await import('../db/sqlite-adapter');
        dbEvents.notify('programs', 'clear');
        dbEvents.notify('programs', 'add');
        return programsToInsert.length;
      }
    } catch (e) {
      console.warn(`[EPG Override] Failed to copy programs from cache DB ${epgLinkId}:`, e);
    }
    // Nothing came out of the link's cache, so the channel keeps what it had.
    return countChannelPrograms(dbInstance, targetStreamId);
  }

  // The feed's own channel supplies the guide (no time cutoff — the whole guide is
  // what the user expects when they apply a match).
  const count = await replaceGuideFromChannel(dbInstance, targetStreamId, guide.streamId);

  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('programs', 'clear');
  dbEvents.notify('programs', 'add');
  return count;
}

/**
 * Resets a channel back to its default state: the override, the feed lock and any
 * custom programs go, and the channel's *own* feed's guide for its original tvg-id
 * is put back so a sync isn't needed. A feed that carries nothing for that id leaves
 * the current guide untouched instead of blanking the channel.
 */
/**
 * Release a channel's feed lock without touching the rest of its override
 * (tvg-id, logo, timeshift all stay). `put` is INSERT OR REPLACE, so the row is
 * rewritten from the existing values with only `epg_source_id` cleared.
 */
export async function releaseChannelFeedPin(streamId: string): Promise<boolean> {
  const existing = await getChannelOverride(streamId);
  if (!existing?.epg_source_id) return false;
  await upsertChannelOverride({ ...existing, epg_source_id: undefined });
  return true;
}

/** How many channels of a playlist are locked to an EPG source. */
export async function countFeedPinsInSource(sourceId: string): Promise<number> {
  try {
    const dbInstance = await (db as any).dbPromise;
    const rows = await dbInstance.select(
      `SELECT COUNT(*) AS count FROM epg_channel_overrides eco
       JOIN channels c ON c.stream_id = eco.stream_id
       WHERE c.source_id = $1
         AND eco.epg_source_id IS NOT NULL AND TRIM(eco.epg_source_id) != ''`,
      [sourceId]
    ) as { count: number }[];
    return rows?.[0]?.count ?? 0;
  } catch {
    // Column may be missing on an old DB — treat as no pins.
    return 0;
  }
}

/**
 * Release every feed lock in a playlist. Only `epg_source_id` is cleared — the
 * TVG-IDs, logos and timeshifts the user set stay, so this is safe to undo by
 * re-applying a match.
 * @returns how many channels were released
 */
export async function releaseFeedPinsInSource(sourceId: string): Promise<number> {
  const count = await countFeedPinsInSource(sourceId);
  if (count === 0) return 0;
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(
    `UPDATE epg_channel_overrides SET epg_source_id = NULL
     WHERE epg_source_id IS NOT NULL
       AND stream_id IN (SELECT stream_id FROM channels WHERE source_id = $1)`,
    [sourceId]
  );
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('epg_channel_overrides', 'update');
  dbEvents.notify('channels', 'update');
  return count;
}

/**
 * Release every feed lock pointing at one feed.
 *
 * A pinned channel is served by the pinned feed alone — every other feed skips
 * it, including its own playlist's. So a pin has to be released the moment its
 * feed stops being able to serve it, which happens in exactly two ways: the EPG
 * source is deleted, or it is detached from the channel's playlist. Leaving the
 * pin behind would keep those channels blank for good.
 *
 * @param sourceIds Restrict the release to channels of these playlists (used
 *   when a link loses an attached source: only the channels that just lost their
 *   feed are released, and pins in still-attached playlists are untouched).
 * @returns how many channels were released
 */
export async function releasePinsForFeed(feedRef: string, sourceIds?: string[]): Promise<number> {
  const feed = feedRef.trim();
  if (!feed) return 0;

  const scoped = (sourceIds ?? []).filter(id => !!id && id.trim().length > 0);

  try {
    const dbInstance = await (db as any).dbPromise;

    const where = scoped.length > 0
      ? `epg_source_id = $1
         AND stream_id IN (
           SELECT stream_id FROM channels
           WHERE source_id IN (${scoped.map((_, i) => `$${i + 2}`).join(', ')})
         )`
      : 'epg_source_id = $1';
    const args = [feed, ...scoped];

    const countRows = await dbInstance.select(
      `SELECT COUNT(*) AS count FROM epg_channel_overrides WHERE ${where}`,
      args
    ) as { count: number }[];
    const count = countRows?.[0]?.count ?? 0;
    if (count === 0) return 0;

    await dbInstance.execute(
      `UPDATE epg_channel_overrides SET epg_source_id = NULL WHERE ${where}`,
      args
    );

    const { dbEvents } = await import('../db/sqlite-adapter');
    dbEvents.notify('epg_channel_overrides', 'update');
    dbEvents.notify('channels', 'update');
    return count;
  } catch (e) {
    // Column may be missing on an old DB — nothing to release in that case.
    console.warn(`[EPG] Failed to release feed locks for ${feed}:`, e);
    return 0;
  }
}

// ─── Audit: every channel that carries an EPG match ──────────────────────────

/**
 * One channel's EPG match, as the audit report lists it.
 *
 * `feedRef` is the lock: `global_epg_<linkId>` when the channel is pinned to a
 * global EPG link, a bare source id when pinned to a playlist's own feed, and
 * null when nothing is pinned and the sync's waterfall decides which feed fills
 * the channel — the state every match made before locks were stored is in.
 */
export interface EpgMatchRow {
  streamId: string;
  channelName: string;
  sourceId: string | null;
  epgChannelId: string | null;
  feedRef: string | null;
  /** Matching uses the channel's own (renamed) name, not the provider's. */
  matchByAlias: boolean;
}

/**
 * Every channel that has an EPG match, for the editor's Matches report.
 *
 * A read-only snapshot: the report is a browse/audit surface, so it is loaded
 * whole (a few columns per override, ~15k rows in a heavily-matched library) and
 * grouped in memory, which keeps the group-by switch immediate and lets the list
 * be filtered without a query per keystroke.
 */
export async function listEpgMatches(): Promise<EpgMatchRow[]> {
  const dbInstance = await (db as any).dbPromise;
  const select = (extra: string) => `SELECT o.stream_id AS stream_id,
            c.name AS channel_name,
            c.source_id AS source_id,
            o.epg_channel_id AS epg_channel_id,
            o.epg_source_id AS feed_ref
            ${extra}
       FROM epg_channel_overrides o
       JOIN channels c ON c.stream_id = o.stream_id`;

  const toRows = (rows: any[]): EpgMatchRow[] => (rows || []).map(r => ({
    streamId: r.stream_id as string,
    channelName: (r.channel_name as string) ?? '',
    sourceId: (r.source_id as string) ?? null,
    epgChannelId: (r.epg_channel_id as string) ?? null,
    feedRef: (r.feed_ref as string) ?? null,
    matchByAlias: r.match_by_alias === 1 || r.match_by_alias === true,
  }));

  try {
    return toRows(await dbInstance.select(select(', o.match_by_alias AS match_by_alias'), []));
  } catch {
    // match_by_alias is DB v29 — an older DB simply has no channel using it.
    return toRows(await dbInstance.select(select(', 0 AS match_by_alias'), []));
  }
}

/**
 * Category names per matched channel, for the report's Category grouping.
 *
 * Loaded on demand: a channel can sit in several categories, so this is one row
 * per membership, and it is only read when that grouping is picked. The
 * category's own rename wins over its provider name, matching everywhere else
 * the app shows one.
 */
export async function listEpgMatchCategories(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const dbInstance = await (db as any).dbPromise;
    const rows = await dbInstance.select(
      `SELECT cc.stream_id AS stream_id,
              cat.category_name AS category_name,
              cat.alias AS category_alias
         FROM channel_categories cc
         JOIN epg_channel_overrides o ON o.stream_id = cc.stream_id
         LEFT JOIN categories cat
                ON cat.category_id = cc.category_id AND cat.source_id = cc.source_id`,
      []
    ) as { stream_id: string; category_name: string | null; category_alias: string | null }[];

    for (const row of rows || []) {
      const name = (row.category_alias || row.category_name || '').trim();
      if (!name) continue;
      const list = out.get(row.stream_id);
      if (list) {
        if (!list.includes(name)) list.push(name);
      } else {
        out.set(row.stream_id, [name]);
      }
    }
    for (const list of out.values()) list.sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.warn('[EPG] Failed to list categories for the matches report:', e);
  }
  return out;
}

/**
 * Release the feed lock on a set of channels, leaving the rest of each override
 * (tvg-id, logo, timeshift) alone.
 *
 * The report's groups are heterogeneous — a feed group, a playlist group and a
 * category group are all just sets of channels — so they share this one path
 * instead of three feed/source-shaped ones. Chunked because a SQLite statement
 * takes a bounded number of bound parameters and a group can hold thousands of
 * channels.
 *
 * @returns how many channels were released
 */
export async function releaseFeedPinsForStreamIds(streamIds: string[]): Promise<number> {
  const ids = [...new Set(streamIds.filter(id => !!id && id.trim().length > 0))];
  if (ids.length === 0) return 0;

  const CHUNK = 400;
  let released = 0;
  try {
    const dbInstance = await (db as any).dbPromise;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, n) => `$${n + 1}`).join(', ');
      const where = `epg_source_id IS NOT NULL AND TRIM(epg_source_id) != ''
                       AND stream_id IN (${placeholders})`;
      const countRows = await dbInstance.select(
        `SELECT COUNT(*) AS count FROM epg_channel_overrides WHERE ${where}`,
        chunk
      ) as { count: number }[];
      const count = countRows?.[0]?.count ?? 0;
      if (count === 0) continue;
      await dbInstance.execute(
        `UPDATE epg_channel_overrides SET epg_source_id = NULL WHERE ${where}`,
        chunk
      );
      released += count;
    }
    if (released > 0) {
      const { dbEvents } = await import('../db/sqlite-adapter');
      dbEvents.notify('epg_channel_overrides', 'update');
      dbEvents.notify('channels', 'update');
    }
    return released;
  } catch (e) {
    // Column may be missing on an old DB — nothing to release in that case.
    console.warn('[EPG] Failed to release feed locks:', e);
    return released;
  }
}

/**
 * Undo one Automatch Missing result: drop the id it wrote, the guide it copied,
 * and restore the channel's override row from the snapshot taken before the run.
 *
 * Restoring rather than deleting matters — a channel with no EPG assignment can
 * still carry a logo background, padding or timeshift the user set, and those
 * must survive an unmatch.
 *
 * `modified` means the channel was matched by hand after the run, so the row on
 * disk is no longer the one being undone and the user's newer choice wins.
 */
export type UnmatchOutcome = 'unmatched' | 'modified' | 'missing';

/**
 * The override-row half of an unmatch: decide whether the row on disk is still the
 * one being undone, and write the pre-run row back (or delete it).
 *
 * The guide the match copied is deliberately not touched here — the single and the
 * bulk undo delete those rows their own way, since the bulk one batches them.
 */
async function applyUnmatch(
  streamId: string,
  expectedEpgChannelId: string,
  prior?: PriorOverrideSnapshot | null
): Promise<{ outcome: UnmatchOutcome; restored: boolean }> {
  const existing = await getChannelOverride(streamId);

  // Already unmatch-ed (or the row was reset) — nothing left to undo.
  if (!existing?.epg_channel_id) return { outcome: 'missing', restored: false };
  if (existing.epg_channel_id !== expectedEpgChannelId) return { outcome: 'modified', restored: false };

  const restored = buildRestoredOverride(streamId, prior);
  if (restored) {
    // Deliberately a bare `put`, not `upsertChannelOverride`: an undo writes the
    // pre-run row *whole*, so the fields the match introduced (the id, the pin)
    // have to go. Merging would keep exactly the ones being taken back.
    await db.epgChannelOverrides.put(restored);
  } else {
    await db.epgChannelOverrides.delete(streamId);
  }
  return { outcome: 'unmatched', restored: Boolean(restored) };
}

export async function unmatchAutomatchChannel(
  streamId: string,
  expectedEpgChannelId: string,
  prior?: PriorOverrideSnapshot | null
): Promise<UnmatchOutcome> {
  const { outcome, restored } = await applyUnmatch(streamId, expectedEpgChannelId, prior);
  if (outcome !== 'unmatched') return outcome;

  // The match copied the feed's guide onto this stream. Leaving those rows would
  // keep showing the very guide the user just rejected.
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(`DELETE FROM programs WHERE stream_id = $1`, [streamId]);

  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('epg_channel_overrides', restored ? 'update' : 'delete');
  dbEvents.notify('channels', 'update');
  dbEvents.notify('programs', 'clear');
  dbEvents.notify('programs', 'add');
  return 'unmatched';
}

/** One match to take back, straight from an Automatch run's results. */
export interface UnmatchTarget {
  streamId: string;
  epgChannelId: string;
  prior?: PriorOverrideSnapshot | null;
}

/**
 * What a bulk undo did with each target, so the caller can retire exactly the rows
 * that were taken back and flag the ones a later hand-match protected.
 */
export interface BulkUnmatchResult {
  /** Channels whose match — and copied guide — was undone. */
  undoneStreamIds: string[];
  /** Channels left alone because they were matched by hand after the run. */
  modifiedStreamIds: string[];
}

/**
 * Undo every match of one Automatch run.
 *
 * Same decision per channel as `unmatchAutomatchChannel`, but the copied guides
 * are dropped a chunk of 200 at a time instead of one statement per channel, and
 * the tables are announced once at the end.
 *
 * The override rows themselves are still written one at a time, exactly as the
 * single undo writes them: a bulk row write takes its column list from the first
 * row of the batch, which would silently drop the settings a restored row happens
 * not to carry. Each of those writes announces its own table, but live queries
 * debounce at 50ms, so they fold into one refresh per window.
 *
 * Rows that were already gone are reported as undone (that is the outcome the
 * caller shows), while rows matched by hand since the run are left untouched.
 */
export async function unmatchAutomatchChannels(targets: UnmatchTarget[]): Promise<BulkUnmatchResult> {
  const result: BulkUnmatchResult = { undoneStreamIds: [], modifiedStreamIds: [] };
  if (targets.length === 0) return result;

  let anyRestoredRow = false;
  let anyDeletedRow = false;
  // Only rows this pass actually matched back out still carry the feed's copied
  // guide; a 'missing' row was unmatch-ed earlier, which dropped its guide then.
  const guideStreamIds: string[] = [];

  for (const target of targets) {
    const { outcome, restored } = await applyUnmatch(target.streamId, target.epgChannelId, target.prior);
    if (outcome === 'modified') {
      result.modifiedStreamIds.push(target.streamId);
      continue;
    }
    // 'missing' means the row was already gone: for the user that is the same
    // outcome as a successful unmatch, so the row is retired either way.
    result.undoneStreamIds.push(target.streamId);
    if (outcome !== 'unmatched') continue;
    guideStreamIds.push(target.streamId);
    if (restored) anyRestoredRow = true;
    else anyDeletedRow = true;
  }

  if (guideStreamIds.length > 0) {
    const dbInstance = await (db as any).dbPromise;
    for (let i = 0; i < guideStreamIds.length; i += 200) {
      const chunk = guideStreamIds.slice(i, i + 200);
      const placeholders = chunk.map((_, n) => `$${n + 1}`).join(',');
      await dbInstance.execute(
        `DELETE FROM programs WHERE stream_id IN (${placeholders})`,
        chunk
      );
    }
  }

  // Nothing on disk changed when every target was already gone or hand-matched.
  if (anyRestoredRow || anyDeletedRow) {
    const { dbEvents } = await import('../db/sqlite-adapter');
    if (anyRestoredRow) dbEvents.notify('epg_channel_overrides', 'update');
    else dbEvents.notify('epg_channel_overrides', 'delete');
    dbEvents.notify('channels', 'update');
    dbEvents.notify('programs', 'clear');
    dbEvents.notify('programs', 'add');
  }

  return result;
}

export async function resetChannelToDefault(streamId: string): Promise<void> {
  const dbInstance = await (db as any).dbPromise;

  // 1. The channel's own provider id and playlist, and what the override changed,
  // all read before the override is deleted.
  const rows = await dbInstance.select(
    `SELECT epg_channel_id, source_id FROM channels WHERE stream_id = $1`,
    [streamId]
  ) as { epg_channel_id: string | null; source_id: string | null }[];
  const originalEpgId = rows[0]?.epg_channel_id;
  const ownSourceId = rows[0]?.source_id;
  const overrideRows = await dbInstance.select(
    `SELECT epg_channel_id, epg_source_id FROM epg_channel_overrides WHERE stream_id = $1`,
    [streamId]
  ) as { epg_channel_id: string | null; epg_source_id: string | null }[];
  const hadOverride = overrideRows.length > 0;
  const overrideEpgId = overrideRows[0]?.epg_channel_id ?? null;
  const overridePin = (overrideRows[0]?.epg_source_id ?? '').trim() || null;

  // 2. Delete overrides
  await dbInstance.execute(`DELETE FROM epg_channel_overrides WHERE stream_id = $1`, [streamId]);
  await dbInstance.execute(`DELETE FROM epg_program_overrides WHERE stream_id = $1`, [streamId]);

  // 3. Put the channel's own feed's guide back for its original tvg-id. Scoped to
  // the channel's own playlist, so a reset can never restore a different
  // playlist's channel under this source's name.
  //
  // When that feed has nothing for the id there is no guide to restore, and what the
  // channel is holding is then either its own provider's rows (an override that just
  // names this channel's own id — the Automatch self-match) or the guide the
  // override borrowed from another feed. The borrowed ones go: the user asked to be
  // back on their provider, those rows now count as "has a guide" and so would also
  // block a global EPG link from filling the channel, and the confirmation dialog
  // promises the original data is restored. The provider's own rows stay, because
  // deleting a guide we cannot prove is foreign just blanks the channel until the
  // next sync.
  const guide = originalEpgId
    ? await findFeedGuideSource(originalEpgId, ownSourceId, streamId)
    : null;
  if (guide?.kind === 'channel') {
    await replaceGuideFromChannel(dbInstance, streamId, guide.streamId);
  } else if (rowsCameFromAnotherFeed(hadOverride, ownSourceId, originalEpgId, overrideEpgId, overridePin)) {
    const dropped = await countChannelPrograms(dbInstance, streamId);
    await dbInstance.execute(`DELETE FROM programs WHERE stream_id = $1`, [streamId]);
    console.log(
      `[EPG Override] Reset: dropped ${dropped} borrowed row(s) from ${streamId} ` +
        `(override ${overridePin ? `pinned to ${overridePin}` : `named "${overrideEpgId}"`}, ` +
        `own feed ${ownSourceId ?? '(unknown)'} has no guide for ` +
        `"${originalEpgId ?? overrideEpgId ?? '(none)'}")`
    );
  } else if (originalEpgId) {
    console.warn(
      `[EPG Override] Reset: feed ${ownSourceId ?? '(unknown)'} carries no guide for ` +
        `"${originalEpgId}"; kept the current guide on ${streamId}`
    );
  }

  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('epg_channel_overrides', 'delete');
  dbEvents.notify('epg_program_overrides', 'delete');
  dbEvents.notify('programs', 'clear');
  dbEvents.notify('programs', 'add');
}

export async function upsertProgramOverride(override: EpgProgramOverride): Promise<void> {
  const dbInstance = await (db as any).dbPromise;
  // Use explicit INSERT OR REPLACE so every column is guaranteed to be set,
  // regardless of which fields are present in the override object.
  await dbInstance.execute(
    `INSERT OR REPLACE INTO epg_program_overrides
       (id, stream_id, title, subtitle, description, start, end, is_deleted, is_custom)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      override.id,
      override.stream_id,
      override.title ?? null,
      override.subtitle ?? null,
      override.description ?? null,
      override.start ?? null,
      override.end ?? null,
      override.is_deleted ?? 0,
      override.is_custom ?? 0,
    ]
  );
  // Notify live queries so the EPG guide / now-playing bar updates immediately
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('epg_program_overrides', 'update');
  // Also notify 'programs' so hooks subscribed to that table (useCurrentProgram,
  // usePrograms, useProgramsInRange, useAllPrograms) re-run immediately
  dbEvents.notify('programs', 'update');
}

/** Hard-remove a single override row (use tombstone set to is_deleted=1 to soft-delete) */
export async function removeProgramOverride(id: string): Promise<void> {
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(`DELETE FROM epg_program_overrides WHERE id = $1`, [id]);
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('epg_program_overrides', 'delete');
  dbEvents.notify('programs', 'update');
}

/** Restore a tombstoned program by removing the is_deleted flag */
export async function restoreProgramOverride(id: string): Promise<void> {
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(
    `UPDATE epg_program_overrides SET is_deleted = 0 WHERE id = $1`,
    [id]
  );
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('epg_program_overrides', 'update');
  dbEvents.notify('programs', 'update');
}

// ─── EPG Channel Search & Scoring ────────────────────────────────────────────

/**
 * Sørensen-Dice-style token overlap score — re-exported from the shared util so
 * the sync, the editor and the opt-in cleaned tier all score identically.
 */
export { scoreChannelMatch } from '../utils/epgChannelMatch';

export type EpgSearchMode = 'm3u' | 'epg';

/**
 * Search for channels by name to find the right TVG-ID to apply.
 * Queries either the channels table (M3U) or the epg_channels table (raw XMLTV).
 *
 * searchMode: 'm3u' = channels table (populated during M3U sync)
 *             'epg' = epg_channels table (raw EPG display names from XMLTV)
 * scope: 'source' = only channels from the given source_id
 *        'all'    = across all sources
 */
export async function searchEpgChannels(
  query: string,
  sourceId?: string,
  /** Max results to return */
  limit = 50,
  searchMode: EpgSearchMode = 'm3u'
): Promise<ScoredEpgChannel[]> {
  const dbInstance = await (db as any).dbPromise;

  const queryWords = query.trim().split(/\s+/).filter(Boolean);
  const wordSqlPartsEpg: string[] = [];
  const wordSqlPartsCh: string[] = [];
  const epgParams: string[] = [];
  const chParams: string[] = [];

  for (const word of queryWords) {
    const variants = getSearchVariants(word);
    const epgClauses: string[] = [];
    const chClauses: string[] = [];
    for (const v of variants) {
      const escaped = v.replace(/[%_]/g, '\\$&');
      epgClauses.push(`display_name LIKE ? ESCAPE '\\'`, `id LIKE ? ESCAPE '\\'`);
      epgParams.push(`%${escaped}%`, `%${escaped}%`);
      chClauses.push(`name LIKE ? ESCAPE '\\'`, `epg_channel_id LIKE ? ESCAPE '\\'`);
      chParams.push(`%${escaped}%`, `%${escaped}%`);
    }
    wordSqlPartsEpg.push(`(${epgClauses.join(' OR ')})`);
    wordSqlPartsCh.push(`(${chClauses.join(' OR ')})`);
  }

  const epgWhere = wordSqlPartsEpg.join(' AND ');
  const chWhere = wordSqlPartsCh.join(' AND ');

  let rows: { id: string; display_name: string; icon_url: string | null; source_id: string }[];

  if (searchMode === 'epg') {
    const sql = `
      SELECT
        id,
        display_name,
        icon_url,
        source_id
      FROM epg_channels
      WHERE (${epgWhere})
        ${sourceId ? 'AND source_id = ?' : ''}
      ORDER BY display_name COLLATE NOCASE
      LIMIT 300
    `;
    const finalParams = sourceId ? [...epgParams, sourceId] : epgParams;
    rows = await dbInstance.select(sql, finalParams);
  } else {
    const sql = `
      SELECT
        COALESCE(epg_channel_id, name)   AS id,
        name                             AS display_name,
        stream_icon                      AS icon_url,
        source_id
      FROM channels
      WHERE (${chWhere})
        ${sourceId ? 'AND source_id = ?' : ''}
      GROUP BY COALESCE(epg_channel_id, name), source_id
      ORDER BY name COLLATE NOCASE
      LIMIT 300
    `;
    const finalParams = sourceId ? [...chParams, sourceId] : chParams;
    rows = await dbInstance.select(sql, finalParams);
  }

  // Load additional results from local cache databases if searchMode === 'epg'
  const extraResults: ScoredEpgChannel[] = [];
  if (searchMode === 'epg' && window.storage) {
    try {
      const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
      const cacheLinks = globalEpgLinks.filter(link => link.saveEntireEpg);
      
      const Database = (await import('@tauri-apps/plugin-sql')).default;
      for (const link of cacheLinks) {
        // If a specific sourceId filter is provided, only search this global EPG if it is linked to that source
        if (sourceId && !link.sourceIds.includes(sourceId)) {
          continue;
        }
        
        try {
          const cacheDbName = `epg_cache_${link.id}`;
          const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
          
          const sql = `
            SELECT id, display_name, icon_url
            FROM epg_channels
            WHERE (${epgWhere})
            LIMIT 100
          `;
          const cacheRows = await cacheDb.select(sql, epgParams) as any[];
          for (const r of cacheRows) {
            extraResults.push({
              id: r.id,
              display_name: r.display_name,
              icon_url: r.icon_url || undefined,
              source_id: `global_epg_${link.id}`, // Virtual source id
              score: scoreChannelMatch(query, r.display_name),
            });
          }
        } catch (dbErr) {
          // Cache DB not initialized yet
        }
      }
    } catch (settingsErr) {
      console.warn('[EPG Search] Failed to read settings:', settingsErr);
    }
  }

  const scored: ScoredEpgChannel[] = (rows.map(r => ({
    id: r.id,
    display_name: r.display_name,
    icon_url: r.icon_url ?? undefined,
    source_id: r.source_id,
    score: scoreChannelMatch(query, r.display_name),
  })) as ScoredEpgChannel[]).concat(extraResults);

  scored.sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name));
  return scored.slice(0, limit);
}

/**
 * Every EPG channel name a match can be made against, without any scoring.
 * Loaded once per run so a 5,000-channel automatch doesn't re-query per channel.
 */
export type EpgMatchCandidate = NameMatchCandidate & { source_id: string };

export async function loadEpgMatchCandidates(
  sourceId?: string,
  searchMode: EpgSearchMode = 'm3u'
): Promise<EpgMatchCandidate[]> {
  const dbInstance = await (db as any).dbPromise;

  let rows: { id: string; display_name: string; icon_url: string | null; source_id: string }[];

  if (searchMode === 'epg') {
    const sql = `
      SELECT
        id,
        display_name,
        icon_url,
        source_id
      FROM epg_channels
      ${sourceId ? 'WHERE source_id = $1' : ''}
    `;
    rows = await dbInstance.select(sql, sourceId ? [sourceId] : []);
  } else {
    const sql = `
      SELECT
        COALESCE(epg_channel_id, name)   AS id,
        name                             AS display_name,
        stream_icon                      AS icon_url,
        source_id,
        MIN(stream_id)                   AS stream_id
      FROM channels
      ${sourceId ? 'WHERE source_id = $1' : ''}
      GROUP BY COALESCE(epg_channel_id, name), source_id
    `;
    rows = await dbInstance.select(sql, sourceId ? [sourceId] : []);
  }

  const candidates: EpgMatchCandidate[] = rows.map(r => ({
    id: r.id,
    display_name: r.display_name,
    icon_url: r.icon_url ?? undefined,
    source_id: r.source_id,
    stream_id: (r as any).stream_id ?? undefined,
  }));

  // Cached global EPG links aren't in the DB — their channels live in their own
  // cache database, so they have to be appended here.
  if (searchMode === 'epg' && window.storage) {
    try {
      const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
      const cacheLinks = globalEpgLinks.filter(link => link.saveEntireEpg);
      const Database = (await import('@tauri-apps/plugin-sql')).default;
      for (const link of cacheLinks) {
        if (sourceId && !link.sourceIds.includes(sourceId)) continue;
        try {
          const cacheDb = await Database.load(`sqlite:epg_cache_${link.id}.db`);
          const cacheRows = await cacheDb.select(
            `SELECT id, display_name, icon_url FROM epg_channels`
          ) as any[];
          for (const r of cacheRows) {
            candidates.push({
              id: r.id,
              display_name: r.display_name,
              icon_url: r.icon_url || undefined,
              source_id: `global_epg_${link.id}`,
            });
          }
        } catch {
          // Cache DB not initialized yet
        }
      }
    } catch {
      // Ignore
    }
  }

  return candidates;
}

/**
 * Auto-match: runs scoring of channelName against ALL channels in scope.
 * Returns top matches above SCORE_THRESHOLD.
 *
 * Loads the candidates itself, so it suits a single channel (the editor's
 * Auto-match button). A caller matching many channels back to back must load
 * the list once and use {@link rankEpgMatchCandidates} /
 * {@link bestEpgMatchCandidate} instead — see their doc comments.
 */
const SCORE_THRESHOLD = 0.4;

export async function autoMatchChannelName(
  channelName: string,
  sourceId?: string,
  limit = 10,
  searchMode: EpgSearchMode = 'm3u'
): Promise<ScoredEpgChannel[]> {
  const candidates = await loadEpgMatchCandidates(sourceId, searchMode);
  return rankEpgMatchCandidates(channelName, candidates, limit);
}

/**
 * Score a name against an already-loaded candidate list.
 *
 * The candidates do not depend on the name being matched, so a bulk run (the
 * Automatch Missing pass) loads them once and calls this per channel. Re-loading
 * them per channel re-ran the same query and re-read every global-EPG cache for
 * every channel, which is what made a run over a large scope take hours.
 *
 * Filtering (`>= SCORE_THRESHOLD`) and the score-descending order are exactly
 * what `autoMatchChannelName` has always applied, so a preloaded list produces
 * the same results as a fresh query would.
 */
export function rankEpgMatchCandidates(
  channelName: string,
  candidates: EpgMatchCandidate[],
  limit = 10
): ScoredEpgChannel[] {
  const scored: ScoredEpgChannel[] = candidates
    .map(c => ({ ...c, score: scoreChannelMatch(channelName, c.display_name) }))
    .filter(r => r.score >= SCORE_THRESHOLD);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * The winner for a name, in the shape a bulk run needs: one result, no scored
 * array built and no sort.
 *
 * Allocating a scored copy of every candidate and sorting it (millions of
 * objects across a run) is pure overhead when only the best match is used, and
 * `null` is reported both when nothing clears the floor and when the candidate
 * list is empty — the same "no match" the ranked list reports via `.length === 0`.
 * Ties keep the first candidate, matching the stable sort in
 * {@link rankEpgMatchCandidates}, so `bestEpgMatchCandidate(name, list)` is
 * always `rankEpgMatchCandidates(name, list, 1)[0] ?? null`.
 */
export function bestEpgMatchCandidate(
  channelName: string,
  candidates: EpgMatchCandidate[]
): ScoredEpgChannel | null {
  let best: ScoredEpgChannel | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = scoreChannelMatch(channelName, c.display_name);
    if (score < SCORE_THRESHOLD) continue;
    if (best === null || score > bestScore) {
      best = { ...c, score };
      bestScore = score;
    }
  }
  return best;
}

/**
 * Opt-in matching tier: clean the decorations off both sides (`|DE| ARD-ALPHA
 * HD` → `ARD-ALPHA`) and match on what is left, refusing whenever the cleaned
 * name fits more than one EPG channel and the region markers can't split them.
 *
 * `threshold` is the same slider the plain scorer uses. Nothing here is ever
 * assigned silently: the caller reports `ambiguous` channels in its results.
 */
export function matchChannelWithCleanNames(
  channelName: string,
  candidates: CleanNameIndex<EpgMatchCandidate> | EpgMatchCandidate[],
  threshold: number,
  extraTags?: string | string[],
  /** Excluded from the candidates — a channel can't supply its own guide. */
  selfStreamId?: string
): {
  match: ScoredEpgChannel | null;
  ambiguous: boolean;
  cleanedName: string;
  /** The refusing candidates, so the caller can offer them as a choice. */
  choices: EpgMatchCandidate[];
  totalChoices: number;
  via: CleanMatchVia;
} {
  const outcome = matchByCleanName(channelName, candidates, threshold, extraTags, selfStreamId);
  return {
    match: outcome.match
      ? ({ ...outcome.match, score: outcome.match.score } as ScoredEpgChannel)
      : null,
    ambiguous: outcome.ambiguous,
    cleanedName: outcome.cleanedName,
    choices: outcome.choices,
    totalChoices: outcome.totalChoices,
    via: outcome.match?.via ?? 'none',
  };
}

