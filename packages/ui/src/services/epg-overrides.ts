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

export async function upsertChannelOverride(override: EpgChannelOverride): Promise<void> {
  await db.epgChannelOverrides.put(override);
  // Notify live queries immediately:
  // - 'programs': re-runs useCurrentProgram / usePrograms / useProgramsInRange / useAllPrograms
  //   (timeshift change affects all program time display)
  // - 'channels': re-runs useChannels so logo overrides appear instantly in the channel list
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('programs', 'update');
  dbEvents.notify('channels', 'update');
}

export async function deleteChannelOverride(streamId: string): Promise<void> {
  await db.epgChannelOverrides.delete(streamId);
}

export async function batchUpsertLogoOverrides(
  updates: Array<{
    streamId: string;
    logoBackground?: 'auto' | 'light' | 'dark';
    logoPadding?: 'default' | 'none';
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

    const nextPad = logoPadding !== undefined
      ? (logoPadding === 'default' ? undefined : logoPadding)
      : existing?.logo_padding;

    const hasOtherOverrides = Boolean(
      existing?.epg_channel_id ||
      existing?.stream_icon ||
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

export async function batchUpsertLogoBackground(
  updates: Array<{ streamId: string; logoBackground: 'auto' | 'light' | 'dark' }>
): Promise<void> {
  return batchUpsertLogoOverrides(updates);
}

// ─── Program Override CRUD ────────────────────────────────────────────────────

/**
 * Load all override rows (including tombstones) for a given stream.
 * Used by the editor to show deleted programs as strikethrough.
 */
export async function getProgramOverridesForStream(streamId: string): Promise<EpgProgramOverride[]> {
  return db.epgProgramOverrides.where('stream_id').equals(streamId).toArray();
}

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

/**
 * Load programs for preview when the user clicks a search result.
 * Finds an existing channel that uses the given epg_channel_id and returns its programs.
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

  const dbInstance = await (db as any).dbPromise;

  // Find a stream_id that already has programs for this epg_channel_id
  // (checking both the raw channel value and any user-applied overrides)
  const rows = await dbInstance.select(
    `SELECT c.stream_id
     FROM channels c
     LEFT JOIN epg_channel_overrides o ON o.stream_id = c.stream_id
     WHERE COALESCE(o.epg_channel_id, c.epg_channel_id) = $1
     LIMIT 1`,
    [epgChannelId]
  ) as { stream_id: string }[];

  if (rows.length === 0) return [];
  return getEditorProgramsForStream(rows[0].stream_id, windowDays);
}

/**
 * Immediately copy programs from the channel matched to epgChannelId into targetStreamId.
 * Called after "Apply" so the channel shows programs right away without waiting for a sync.
 * Returns the number of programs copied (0 if no source found).
 */
export async function copyProgramsFromEpgChannel(
  targetStreamId: string,
  epgChannelId: string,
  sourceId?: string
): Promise<number> {
  const dbInstance = await (db as any).dbPromise;

  // 1. Delete all existing *raw/synced* programs for the target stream so they don't merge
  await dbInstance.execute(
    `DELETE FROM programs WHERE stream_id = $1`,
    [targetStreamId]
  );

  if (sourceId && sourceId.startsWith('global_epg_')) {
    const epgLinkId = sourceId.replace('global_epg_', '');
    try {
      const cacheDbName = `epg_cache_${epgLinkId}`;
      const Database = (await import('@tauri-apps/plugin-sql')).default;
      const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
      
      const progs = await cacheDb.select(
        'SELECT * FROM programs WHERE stream_id = $1',
        [epgChannelId]
      ) as any[];

      if (progs.length > 0) {
        // Query the channel's source_id to associate with programs
        const channelRow = await dbInstance.select(
          'SELECT source_id FROM channels WHERE stream_id = $1 LIMIT 1',
          [targetStreamId]
        ) as { source_id: string }[];
        const targetSourceId = channelRow[0]?.source_id || 'unknown';

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

        await db.programs.bulkPut(programsToInsert);
        const { dbEvents } = await import('../db/sqlite-adapter');
        dbEvents.notify('programs', 'clear');
        dbEvents.notify('programs', 'add');
        return programsToInsert.length;
      }
    } catch (e) {
      console.warn(`[EPG Override] Failed to copy programs from cache DB ${epgLinkId}:`, e);
    }
    return 0;
  }

  // Find a source stream that has programs for this epg_channel_id (not the target itself)
  const rows = await dbInstance.select(
    `SELECT stream_id FROM channels
     WHERE epg_channel_id = $1 AND stream_id != $2
     LIMIT 1`,
    [epgChannelId, targetStreamId]
  ) as { stream_id: string }[];

  if (rows.length === 0) return 0;

  const sourceStreamId = rows[0].stream_id;

  // 2. Copy future/current programs to the target stream with new IDs matching the sync format.
  // INSERT OR REPLACE ensures the next sync can overwrite with official data seamlessly.
  await dbInstance.execute(
    `INSERT OR REPLACE INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
     SELECT
       $1 || '_' || CAST(CAST(strftime('%s', start) AS INTEGER) * 1000 AS TEXT) AS id,
       $1 AS stream_id,
       title, subtitle, description, start, end, source_id
     FROM programs
     WHERE stream_id = $2
       AND end >= datetime('now', '-1 hour')`,
    [targetStreamId, sourceStreamId]
  );

  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('programs', 'clear');
  dbEvents.notify('programs', 'add');
  return 1;
}

/**
 * Resets a channel back to its default state.
 * Deletes the channel override, custom programs, and restores tombstoned programs.
 * Also copies the original programs back so a sync isn't needed.
 */
export async function resetChannelToDefault(streamId: string): Promise<void> {
  const dbInstance = await (db as any).dbPromise;

  // 1. Get original epg_channel_id before we delete the override
  const rows = await dbInstance.select(
    `SELECT epg_channel_id FROM channels WHERE stream_id = $1`,
    [streamId]
  ) as { epg_channel_id: string | null }[];
  const originalEpgId = rows[0]?.epg_channel_id;

  // 2. Delete overrides
  await dbInstance.execute(`DELETE FROM epg_channel_overrides WHERE stream_id = $1`, [streamId]);
  await dbInstance.execute(`DELETE FROM epg_program_overrides WHERE stream_id = $1`, [streamId]);

  // 3. Restore original programs if we have an original epg_channel_id
  if (originalEpgId) {
    // Clear programs that belonged to the previous override
    await dbInstance.execute(`DELETE FROM programs WHERE stream_id = $1`, [streamId]);

    // Find a stream that has the original epg_channel_id (to copy its programs)
    const srcRows = await dbInstance.select(
      `SELECT stream_id FROM channels WHERE epg_channel_id = $1 AND stream_id != $2 LIMIT 1`,
      [originalEpgId, streamId]
    ) as { stream_id: string }[];

    if (srcRows.length > 0) {
      const sourceStreamId = srcRows[0].stream_id;
      await dbInstance.execute(
        `INSERT OR REPLACE INTO programs (id, stream_id, title, subtitle, description, start, end, source_id)
         SELECT
           $1 || '_' || CAST(CAST(strftime('%s', start) AS INTEGER) * 1000 AS TEXT) AS id,
           $1 AS stream_id,
           title, subtitle, description, start, end, source_id
         FROM programs
         WHERE stream_id = $2
           AND end >= datetime('now', '-1 hour')`,
        [streamId, sourceStreamId]
      );
    }
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

// Noise tokens stripped before comparison
const NOISE_TOKENS = new Set([
  'hd', 'fhd', 'uhd', '4k', 'sd', '1080p', '720p', '480p',
  'us', 'uk', 'ca', 'au', 'east', 'west', 'channel', 'tv', 'the',
]);

function normalizeTokens(str: string): string[] {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')  // strip punctuation / special chars
    .split(/\s+/)
    .filter(t => t.length > 0 && !NOISE_TOKENS.has(t));
}

/**
 * Sørensen-Dice-style token overlap score.
 * Returns 0–1 based on shared tokens; +0.2 bonus for substring containment.
 */
export function scoreChannelMatch(channelName: string, epgDisplayName: string): number {
  if (!channelName || !epgDisplayName) return 0;
  const a = normalizeTokens(channelName);
  const b = normalizeTokens(epgDisplayName);
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const t of setA) {
    if (setB.has(t)) shared++;
  }

  const score = (2 * shared) / (setA.size + setB.size);

  // Substring bonus
  const normA = a.join(' ');
  const normB = b.join(' ');
  const bonus = (normA.includes(normB) || normB.includes(normA)) ? 0.2 : 0;

  return Math.min(1.2, score + bonus);
}

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
 * Auto-match: runs scoring of channelName against ALL channels in scope.
 * Returns top matches above SCORE_THRESHOLD.
 */
const SCORE_THRESHOLD = 0.4;

export async function autoMatchChannelName(
  channelName: string,
  sourceId?: string,
  limit = 10,
  searchMode: EpgSearchMode = 'm3u'
): Promise<ScoredEpgChannel[]> {
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
        source_id
      FROM channels
      ${sourceId ? 'WHERE source_id = $1' : ''}
      GROUP BY COALESCE(epg_channel_id, name), source_id
    `;
    rows = await dbInstance.select(sql, sourceId ? [sourceId] : []);
  }

  const extraResults: ScoredEpgChannel[] = [];
  if (searchMode === 'epg' && window.storage) {
    try {
      const globalEpgLinks = useSettingsStore.getState().globalEpgLinks;
      const cacheLinks = globalEpgLinks.filter(link => link.saveEntireEpg);
      
      const Database = (await import('@tauri-apps/plugin-sql')).default;
      for (const link of cacheLinks) {
        if (sourceId && !link.sourceIds.includes(sourceId)) {
          continue;
        }
        
        try {
          const cacheDbName = `epg_cache_${link.id}`;
          const cacheDb = await Database.load(`sqlite:${cacheDbName}.db`);
          
          const sql = `SELECT id, display_name, icon_url FROM epg_channels`;
          const cacheRows = await cacheDb.select(sql) as any[];
          for (const r of cacheRows) {
            extraResults.push({
              id: r.id,
              display_name: r.display_name,
              icon_url: r.icon_url || undefined,
              source_id: `global_epg_${link.id}`,
              score: scoreChannelMatch(channelName, r.display_name),
            });
          }
        } catch (dbErr) {
          // Ignore
        }
      }
    } catch (e) {
      // Ignore
    }
  }

  const scored: ScoredEpgChannel[] = (rows
    .map(r => ({
      id: r.id,
      display_name: r.display_name,
      icon_url: r.icon_url ?? undefined,
      source_id: r.source_id,
      score: scoreChannelMatch(channelName, r.display_name),
    })) as ScoredEpgChannel[])
    .concat(extraResults)
    .filter(r => r.score >= SCORE_THRESHOLD);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

