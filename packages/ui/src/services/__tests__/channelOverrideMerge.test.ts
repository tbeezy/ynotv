/**
 * Channel-override writes must not erase the fields they don't name.
 *
 * `db.epgChannelOverrides.put` is INSERT OR REPLACE, and the SQLite adapter builds
 * its column list from the object it is handed: a column left out of that object is
 * written as NULL rather than left alone. Three callers — Apply in the EPG editor's
 * search tab, the bulk Automatch write, and resolving a refusal — pass only the
 * fields a match changes, so each of them used to reset the channel's logo
 * background and tile padding along with its pin. Nothing surfaced that; the user
 * just found the channel back on the global logo settings.
 *
 * `upsertChannelOverride` is therefore the one write path and it merges. These tests
 * pin both halves of that contract: an omitted field survives, and a field passed as
 * `undefined` is still cleared (the Channel tab relies on that to drop a feed lock,
 * and `releaseChannelFeedPin` to release a pin).
 *
 * `batchUpsertLogoOverrides` — the logo editor's writer — needs the same two
 * meanings, plus a third: a tile padding the user has put back on the global
 * setting. `undefined` there already means "this update doesn't mention padding", so
 * the editor says "no choice" with `null` and the stored value has to go.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { get, put, notify, bulkPut, bulkDelete, storedRows } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  notify: vi.fn(),
  bulkPut: vi.fn(),
  bulkDelete: vi.fn(),
  storedRows: { current: [] as Array<Record<string, unknown>> },
}));

vi.mock('../../db', () => ({
  db: {
    epgChannelOverrides: {
      get,
      put,
      bulkPut,
      bulkDelete,
      where: () => ({ anyOf: () => ({ toArray: async () => storedRows.current }) }),
    },
  },
}));
vi.mock('../../db/sqlite-adapter', () => ({
  dbEvents: { notify },
}));
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ globalEpgLinks: [] }) },
}));

import { upsertChannelOverride, batchUpsertLogoOverrides } from '../epg-overrides';

/** A channel the user had personalised: logo tile, offset and feed all set by hand. */
const storedRow = {
  stream_id: 'playlist-a_100',
  epg_channel_id: 'old.id',
  stream_icon: 'http://logo/old.png',
  logo_background: 'light',
  logo_padding: 'none',
  timeshift_hours: 2,
  epg_source_id: 'global_epg_link-1',
  match_by_alias: 1,
};

/** The shape a match writes: the id it picked, the feed's icon, its feed. */
const matchWrite = {
  stream_id: 'playlist-a_100',
  epg_channel_id: 'aandenetwork.us',
  stream_icon: 'http://logo/new.png',
  timeshift_hours: 0,
  epg_source_id: 'playlist-b',
  match_by_alias: true,
};

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  notify.mockReset();
  bulkPut.mockReset();
  bulkDelete.mockReset();
  put.mockResolvedValue(undefined);
  bulkPut.mockResolvedValue(undefined);
  bulkDelete.mockResolvedValue(undefined);
  storedRows.current = [];
});

describe('upsertChannelOverride', () => {
  it('keeps the logo settings a match write does not name', async () => {
    get.mockResolvedValue({ ...storedRow });

    await upsertChannelOverride({ ...matchWrite });

    const written = put.mock.calls[0][0];
    expect(written.epg_channel_id).toBe('aandenetwork.us');
    expect(written.stream_icon).toBe('http://logo/new.png');
    expect(written.epg_source_id).toBe('playlist-b');
    // The fields the match never mentioned are the user's, and must survive.
    expect(written.logo_background).toBe('light');
    expect(written.logo_padding).toBe('none');
  });

  it('writes every column, so no unmentioned field is left to default to NULL', async () => {
    get.mockResolvedValue({ ...storedRow });

    await upsertChannelOverride({ ...matchWrite });

    const written = put.mock.calls[0][0];
    expect(Object.keys(written).sort()).toEqual([
      'epg_channel_id',
      'epg_source_id',
      'logo_background',
      'logo_padding',
      'match_by_alias',
      'stream_icon',
      'stream_id',
      'timeshift_hours',
    ]);
  });

  it('still clears a field the caller passes as undefined', async () => {
    get.mockResolvedValue({ ...storedRow });

    // Dropping the pin when the TVG-ID is edited by hand, and releasing it.
    await upsertChannelOverride({ stream_id: 'playlist-a_100', epg_source_id: undefined });

    const written = put.mock.calls[0][0];
    // Present, so it overrides the stored pin and binds as NULL…
    expect('epg_source_id' in written).toBe(true);
    expect(written.epg_source_id).toBeUndefined();
    // …while everything the caller did not mention is untouched.
    expect(written.epg_channel_id).toBe('old.id');
    expect(written.logo_background).toBe('light');
    expect(written.timeshift_hours).toBe(2);
  });

  it('lets a named field overwrite its stored value', async () => {
    get.mockResolvedValue({ ...storedRow });

    await upsertChannelOverride({ stream_id: 'playlist-a_100', logo_padding: 'default' });

    expect(put.mock.calls[0][0].logo_padding).toBe('default');
    expect(put.mock.calls[0][0].logo_background).toBe('light');
  });

  it('writes a first override exactly as given', async () => {
    get.mockResolvedValue(null);

    await upsertChannelOverride({ ...matchWrite });

    const written = put.mock.calls[0][0];
    expect(written).toEqual(matchWrite);
    // No stored row to lose, so no logo keys are invented for it.
    expect('logo_padding' in written).toBe(false);
  });

  it('announces the change to the live queries', async () => {
    get.mockResolvedValue(null);

    await upsertChannelOverride({ stream_id: 'playlist-a_100' });

    expect(notify).toHaveBeenCalledWith('programs', 'update');
    expect(notify).toHaveBeenCalledWith('channels', 'update');
  });
});

describe('batchUpsertLogoOverrides', () => {
  it('records an explicit Normal or No Pad on the row it is given', async () => {
    storedRows.current = [{ ...storedRow }];

    await batchUpsertLogoOverrides([{ streamId: 'playlist-a_100', logoPadding: 'default' }]);

    const written = bulkPut.mock.calls[0][0][0];
    expect(written.logo_padding).toBe('default');
    // The rest of the row is carried over explicitly, as before.
    expect(written.epg_channel_id).toBe('old.id');
    expect(written.epg_source_id).toBe('global_epg_link-1');
  });

  it('clears the padding for an explicit "no choice"', async () => {
    storedRows.current = [{ ...storedRow }];

    await batchUpsertLogoOverrides([{ streamId: 'playlist-a_100', logoPadding: null }]);

    const written = bulkPut.mock.calls[0][0][0];
    // Present-and-undefined is what the adapter writes as NULL, which is how a tile
    // goes back to following the global Tile Layout setting.
    expect('logo_padding' in written).toBe(true);
    expect(written.logo_padding).toBeUndefined();
    expect(written.logo_background).toBe('light');
  });

  it('leaves the stored padding alone when the update does not mention it', async () => {
    storedRows.current = [{ ...storedRow }];

    await batchUpsertLogoOverrides([{ streamId: 'playlist-a_100', logoBackground: 'dark' }]);

    const written = bulkPut.mock.calls[0][0][0];
    expect(written.logo_padding).toBe('none');
    expect(written.logo_background).toBe('dark');
  });

  it('deletes the row when clearing the padding leaves nothing else set', async () => {
    storedRows.current = [{ stream_id: 'playlist-a_100', logo_padding: 'none' }];

    await batchUpsertLogoOverrides([{ streamId: 'playlist-a_100', logoPadding: null }]);

    expect(bulkDelete).toHaveBeenCalledWith(['playlist-a_100']);
    expect(bulkPut).not.toHaveBeenCalled();
  });

  it('preserves logo_locked and does not delete row when clearing padding if logo is locked', async () => {
    storedRows.current = [{ stream_id: 'playlist-a_100', logo_padding: 'none', logo_locked: 1 }];

    await batchUpsertLogoOverrides([{ streamId: 'playlist-a_100', logoPadding: null }]);

    expect(bulkDelete).not.toHaveBeenCalled();
    const written = bulkPut.mock.calls[0][0][0];
    expect(written.logo_locked).toBe(1);
  });
});
