import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get, put, notify, toArray } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  notify: vi.fn(),
  toArray: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    epgChannelOverrides: {
      get,
      put,
      toArray,
    },
  },
}));

vi.mock('../../db/sqlite-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/sqlite-adapter')>();
  return {
    ...actual,
    dbEvents: { notify },
  };
});

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ globalEpgLinks: [] }) },
}));

import { upsertChannelOverride } from '../epg-overrides';
import { priorOverrideSnapshot, buildRestoredOverride } from '../../utils/epgAutomatchUndo';
import { normalizeRow } from '../../db/sqlite-adapter';

describe('EPG Logo Lock Flow', () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
    notify.mockReset();
    toArray.mockReset();
    put.mockResolvedValue(undefined);
  });

  it('upsertChannelOverride preserves logo_locked when other fields are updated', async () => {
    get.mockResolvedValue({
      stream_id: 'ch-1',
      stream_icon: 'https://custom.test/my-logo.png',
      logo_locked: true,
      timeshift_hours: 0,
    });

    await upsertChannelOverride({
      stream_id: 'ch-1',
      timeshift_hours: 2,
    });

    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({
        stream_id: 'ch-1',
        stream_icon: 'https://custom.test/my-logo.png',
        logo_locked: true,
        timeshift_hours: 2,
      })
    );
  });

  it('priorOverrideSnapshot extracts logoLocked and buildRestoredOverride restores it', () => {
    const row = {
      override_stream_icon: 'https://custom.test/my-logo.png',
      override_timeshift_hours: null,
      override_logo_background: null,
      override_logo_padding: null,
      override_epg_source_id: null,
      match_by_alias: 0,
      override_logo_locked: 1,
    };

    const snapshot = priorOverrideSnapshot(row);
    expect(snapshot.logoLocked).toBe(true);

    const restored = buildRestoredOverride('ch-1', snapshot);
    expect(restored).toEqual({
      stream_id: 'ch-1',
      epg_channel_id: undefined,
      stream_icon: 'https://custom.test/my-logo.png',
      logo_background: undefined,
      logo_padding: undefined,
      timeshift_hours: undefined,
      epg_source_id: undefined,
      match_by_alias: undefined,
      logo_locked: true,
    });
  });

  it('hydrates logo_locked from SQLite integer/string to boolean in normalizeRow', () => {
    const rowWith1 = normalizeRow({ stream_id: 'ch-1', logo_locked: 1 }, 'epg_channel_overrides');
    expect(rowWith1.logo_locked).toBe(true);

    const rowWith0 = normalizeRow({ stream_id: 'ch-1', logo_locked: 0 }, 'epg_channel_overrides');
    expect(rowWith0.logo_locked).toBe(false);

    const rowWithStr1 = normalizeRow({ stream_id: 'ch-1', logo_locked: '1' }, 'epg_channel_overrides');
    expect(rowWithStr1.logo_locked).toBe(true);

    const rowWithStr0 = normalizeRow({ stream_id: 'ch-1', logo_locked: '0' }, 'epg_channel_overrides');
    expect(rowWithStr0.logo_locked).toBe(false);
  });
});
