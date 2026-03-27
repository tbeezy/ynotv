/**
 * EPG Overrides Service
 * ---------------------
 * CRUD helpers for epg_channel_overrides and epg_program_overrides tables.
 * Also provides EPG channel search with normalized token-scoring for matching
 * a channel name to an XMLTV channel ID.
 */

import { db } from '../db';
import type { EpgChannelOverride, EpgProgramOverride, StoredEpgChannel } from '../db';

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
}

export async function deleteChannelOverride(streamId: string): Promise<void> {
  await db.epgChannelOverrides.delete(streamId);
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
  const synced = await dbInstance.select(`
    SELECT
      p.id,
      p.stream_id,
      COALESCE(o.title,       p.title)       AS title,
      COALESCE(o.description, p.description) AS description,
      COALESCE(o.start,       datetime(p.start, CAST(IFNULL(co.timeshift_hours, 0) * 60 AS INTEGER) || ' minutes')) AS start,
      COALESCE(o.end,         datetime(p.end,   CAST(IFNULL(co.timeshift_hours, 0) * 60 AS INTEGER) || ' minutes')) AS end,
      p.source_id,
      CASE WHEN o.id IS NOT NULL THEN 1 ELSE 0 END AS has_override,
      COALESCE(o.is_deleted, 0)              AS is_deleted,
      0 AS is_custom
    FROM programs p
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
  windowDays = 3
): Promise<EditorProgram[]> {
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
  epgChannelId: string
): Promise<number> {
  const dbInstance = await (db as any).dbPromise;

  // Find a source stream that has programs for this epg_channel_id (not the target itself)
  const rows = await dbInstance.select(
    `SELECT stream_id FROM channels
     WHERE epg_channel_id = $1 AND stream_id != $2
     LIMIT 1`,
    [epgChannelId, targetStreamId]
  ) as { stream_id: string }[];

  if (rows.length === 0) return 0;

  const sourceStreamId = rows[0].stream_id;

  // 1. Delete all existing *raw/synced* programs for the target stream so they don't merge
  await dbInstance.execute(
    `DELETE FROM programs WHERE stream_id = $1`,
    [targetStreamId]
  );

  // 2. Copy future/current programs to the target stream with new IDs matching the sync format.
  // INSERT OR REPLACE ensures the next sync can overwrite with official data seamlessly.
  await dbInstance.execute(
    `INSERT OR REPLACE INTO programs (id, stream_id, title, description, start, end, source_id)
     SELECT
       $1 || '_' || CAST(CAST(strftime('%s', start) AS INTEGER) * 1000 AS TEXT) AS id,
       $1 AS stream_id,
       title, description, start, end, source_id
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
        `INSERT OR REPLACE INTO programs (id, stream_id, title, description, start, end, source_id)
         SELECT
           $1 || '_' || CAST(CAST(strftime('%s', start) AS INTEGER) * 1000 AS TEXT) AS id,
           $1 AS stream_id,
           title, description, start, end, source_id
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
       (id, stream_id, title, description, start, end, is_deleted, is_custom)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      override.id,
      override.stream_id,
      override.title ?? null,
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
}

/** Hard-remove a single override row (use tombstone set to is_deleted=1 to soft-delete) */
export async function removeProgramOverride(id: string): Promise<void> {
  const dbInstance = await (db as any).dbPromise;
  await dbInstance.execute(`DELETE FROM epg_program_overrides WHERE id = $1`, [id]);
  const { dbEvents } = await import('../db/sqlite-adapter');
  dbEvents.notify('epg_program_overrides', 'delete');
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

/**
 * Search for channels by name to find the right TVG-ID to apply.
 * Queries the channels table (populated during M3U sync) and returns
 * distinct epg_channel_id entries with match scores.
 *
 * scope: 'source' = only channels from the given source_id
 *        'all'    = across all sources
 */
export async function searchEpgChannels(
  query: string,
  sourceId?: string,
  /** Max results to return */
  limit = 50
): Promise<ScoredEpgChannel[]> {
  const dbInstance = await (db as any).dbPromise;

  const likePattern = `%${query.replace(/[%_]/g, '\\$&')}%`;

  // Query channels table — it's always populated after M3U sync.
  // We want distinct epg_channel_id values (the TVG-ID to apply).
  // Falls back to channel name when epg_channel_id is empty.
  let rows: { id: string; display_name: string; icon_url: string | null; source_id: string }[];

  const sql = `
    SELECT
      COALESCE(epg_channel_id, name)   AS id,
      name                             AS display_name,
      stream_icon                      AS icon_url,
      source_id
    FROM channels
    WHERE (name LIKE $1 ESCAPE '\\' OR epg_channel_id LIKE $1 ESCAPE '\\')
      ${sourceId ? 'AND source_id = $2' : ''}
    GROUP BY COALESCE(epg_channel_id, name)
    ORDER BY name COLLATE NOCASE
    LIMIT 300
  `;

  rows = await dbInstance.select(sql, sourceId ? [likePattern, sourceId] : [likePattern]);

  const scored: ScoredEpgChannel[] = rows.map(r => ({
    id: r.id,
    display_name: r.display_name,
    icon_url: r.icon_url ?? undefined,
    source_id: r.source_id,
    score: scoreChannelMatch(query, r.display_name),
  }));

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
  limit = 10
): Promise<ScoredEpgChannel[]> {
  const dbInstance = await (db as any).dbPromise;

  const sql = `
    SELECT
      COALESCE(epg_channel_id, name)   AS id,
      name                             AS display_name,
      stream_icon                      AS icon_url,
      source_id
    FROM channels
    ${sourceId ? 'WHERE source_id = $1' : ''}
    GROUP BY COALESCE(epg_channel_id, name)
  `;

  const rows: { id: string; display_name: string; icon_url: string | null; source_id: string }[] =
    await dbInstance.select(sql, sourceId ? [sourceId] : []);

  const scored: ScoredEpgChannel[] = rows
    .map(r => ({
      id: r.id,
      display_name: r.display_name,
      icon_url: r.icon_url ?? undefined,
      source_id: r.source_id,
      score: scoreChannelMatch(channelName, r.display_name),
    }))
    .filter(r => r.score >= SCORE_THRESHOLD);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

