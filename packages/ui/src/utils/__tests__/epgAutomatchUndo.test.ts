import { describe, it, expect } from 'vitest';
import { priorOverrideSnapshot, buildRestoredOverride } from '../epgAutomatchUndo';

/** A query row for a channel that had no override row at all. */
const noRow = {
  stream_id: 'ch-1',
  name: 'Some Channel',
  override_stream_icon: null,
  override_timeshift_hours: null,
  override_logo_background: null,
  override_logo_padding: null,
  override_epg_source_id: null,
  match_by_alias: 0,
  override_logo_locked: 0,
};

describe('priorOverrideSnapshot', () => {
  it('reads every field the run could overwrite', () => {
    const snapshot = priorOverrideSnapshot({
      override_stream_icon: 'https://example.test/logo.png',
      override_timeshift_hours: 2,
      override_logo_background: 'dark',
      override_logo_padding: 'none',
      override_epg_source_id: 'global_epg_link-1',
      match_by_alias: 1,
      override_logo_locked: 1,
    });

    expect(snapshot).toEqual({
      streamIcon: 'https://example.test/logo.png',
      timeshiftHours: 2,
      logoBackground: 'dark',
      logoPadding: 'none',
      feedSourceId: 'global_epg_link-1',
      matchByAlias: true,
      logoLocked: true,
    });
  });

  it('treats a channel with no override row as empty', () => {
    const snapshot = priorOverrideSnapshot(noRow);
    expect(snapshot).toEqual({
      streamIcon: null,
      timeshiftHours: null,
      logoBackground: null,
      logoPadding: null,
      feedSourceId: null,
      matchByAlias: null,
      logoLocked: null,
    });
  });

  it('ignores a zero timeshift and blank strings, which are the defaults', () => {
    const snapshot = priorOverrideSnapshot({
      override_stream_icon: '   ',
      override_timeshift_hours: 0,
      override_epg_source_id: '',
      match_by_alias: '0',
    });
    expect(snapshot.streamIcon).toBeNull();
    expect(snapshot.timeshiftHours).toBeNull();
    expect(snapshot.feedSourceId).toBeNull();
    expect(snapshot.matchByAlias).toBeNull();
  });
});

describe('buildRestoredOverride', () => {
  it('restores logo/padding/timeshift the user had set on an unmatched channel', () => {
    const restored = buildRestoredOverride('ch-1', {
      streamIcon: 'https://example.test/logo.png',
      logoBackground: 'light',
      logoPadding: 'none',
      timeshiftHours: 1,
      matchByAlias: true,
      feedSourceId: null,
    });

    expect(restored).toEqual({
      stream_id: 'ch-1',
      epg_channel_id: undefined,
      stream_icon: 'https://example.test/logo.png',
      logo_background: 'light',
      logo_padding: 'none',
      timeshift_hours: 1,
      epg_source_id: undefined,
      match_by_alias: true,
    });
  });

  it('never restores an epg id — the run only touches channels without one', () => {
    const restored = buildRestoredOverride('ch-1', { streamIcon: 'icon' });
    expect(restored?.epg_channel_id).toBeUndefined();
  });

  it('returns null when there was nothing to keep, so the row is deleted', () => {
    expect(buildRestoredOverride('ch-1', priorOverrideSnapshot(noRow))).toBeNull();
    expect(buildRestoredOverride('ch-1', null)).toBeNull();
    expect(buildRestoredOverride('ch-1', undefined)).toBeNull();
    // A zero timeshift is the default, not something to write back.
    expect(buildRestoredOverride('ch-1', { timeshiftHours: 0 })).toBeNull();
  });

  it('keeps a stale feed lock so an undo cannot drop it', () => {
    const restored = buildRestoredOverride('ch-1', { feedSourceId: 'src-9' });
    expect(restored?.epg_source_id).toBe('src-9');
  });

  it('keeps locked logo flag so an undo restores the lock', () => {
    const restored = buildRestoredOverride('ch-1', { logoLocked: true });
    expect(restored?.logo_locked).toBe(true);
  });
});
