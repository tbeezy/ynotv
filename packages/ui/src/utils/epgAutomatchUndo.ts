/**
 * Undo data for EPG Editor → Automatch Missing.
 *
 * A match writes an override (the id, the feed's icon) and copies the feed's
 * guide onto the stream. "Unmatch" has to take all of that back — and to do it
 * without destroying anything the user had set on a channel that merely had no
 * EPG assignment. So the run carries the channel's override row as it was
 * *before* the write, and the undo restores exactly that row.
 *
 * Kept pure and separate from the DB so the restore decision is testable.
 */

import type { EpgChannelOverride } from '../db';

/**
 * The fields of the pre-run override row that a match could have changed.
 * Everything is optional/undefined when the channel had no override row at all.
 */
export interface PriorOverrideSnapshot {
  streamIcon?: string | null;
  timeshiftHours?: number | null;
  logoBackground?: string | null;
  logoPadding?: string | null;
  feedSourceId?: string | null;
  matchByAlias?: boolean | null;
  logoLocked?: boolean | null;
}

/** The pre-run override aliases the Automatch query selects alongside each channel. */
interface SnapshotRow {
  override_stream_icon?: unknown;
  override_timeshift_hours?: unknown;
  override_logo_background?: unknown;
  override_logo_padding?: unknown;
  override_epg_source_id?: unknown;
  match_by_alias?: unknown;
  override_logo_locked?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function flag(value: unknown): boolean | null {
  return value === true || value === 1 || value === '1' || value === 'true' ? true : null;
}

/**
 * Read the snapshot from a row of `buildMissingEpgQuery`. Every field is null
 * when the channel had no override row, which is what `buildRestoredOverride`
 * uses to decide between restoring and deleting.
 */
export function priorOverrideSnapshot(row: SnapshotRow): PriorOverrideSnapshot {
  const timeshift = row.override_timeshift_hours;
  return {
    streamIcon: text(row.override_stream_icon),
    // 0 is the default, so it is not something to restore.
    timeshiftHours:
      typeof timeshift === 'number' && timeshift !== 0 ? timeshift : null,
    logoBackground: text(row.override_logo_background),
    logoPadding: text(row.override_logo_padding),
    feedSourceId: text(row.override_epg_source_id),
    matchByAlias: flag(row.match_by_alias),
    logoLocked: flag(row.override_logo_locked),
  };
}

/**
 * The override row to write back when a match is undone, or `null` when the
 * channel had no row before the run and the row should be deleted outright.
 *
 * The `epg_channel_id` is deliberately left unset: by construction the run only
 * touches channels whose effective id was empty, so an id in the restored row
 * could only be the one being undone.
 */
export function buildRestoredOverride(
  streamId: string,
  prior: PriorOverrideSnapshot | null | undefined
): EpgChannelOverride | null {
  if (!prior) return null;

  const kept = Boolean(
    prior.streamIcon ||
      prior.logoBackground ||
      prior.logoPadding ||
      prior.feedSourceId ||
      prior.matchByAlias ||
      prior.logoLocked ||
      (typeof prior.timeshiftHours === 'number' && prior.timeshiftHours !== 0)
  );
  if (!kept) return null;

  return {
    stream_id: streamId,
    epg_channel_id: undefined,
    stream_icon: prior.streamIcon ?? undefined,
    logo_background: prior.logoBackground ?? undefined,
    logo_padding: prior.logoPadding ?? undefined,
    timeshift_hours: prior.timeshiftHours ?? undefined,
    epg_source_id: prior.feedSourceId ?? undefined,
    match_by_alias: prior.matchByAlias ?? undefined,
    logo_locked: prior.logoLocked ?? undefined,
  };
}
