import { describe, it, expect, vi } from 'vitest';
import type { Channel } from '@ynotv/core';

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

import { DispatcharrClient, mapDispatcharrEpgGridToPrograms } from '../dispatcharr-client';

function makeClient(baseUrl = 'http://dispatcharr.local:9191/') {
  return new DispatcharrClient(
    {
      baseUrl,
      apiKey: 'test-key',
      credentialType: 'apiKey',
    },
    'src1'
  );
}

function channel(partial: Partial<Channel> & Pick<Channel, 'stream_id' | 'name'>): Channel {
  return {
    stream_icon: '',
    epg_channel_id: '',
    category_ids: [],
    direct_url: '',
    source_id: 'src1',
    ...partial,
  };
}

describe('DispatcharrClient URL builders', () => {
  it('normalizes base URL trailing slash', () => {
    const client = makeClient('http://dispatcharr.local:9191///');
    expect(client.buildLiveUrl('abc-uuid')).toBe(
      'http://dispatcharr.local:9191/proxy/ts/stream/abc-uuid?output_format=mpegts'
    );
    expect(client.logoUrl(42)).toBe(
      'http://dispatcharr.local:9191/api/channels/logos/42/cache/'
    );
  });

  it('builds live MPEG-TS proxy URL', () => {
    const client = makeClient('http://host');
    expect(client.buildLiveUrl('chan-uuid')).toBe(
      'http://host/proxy/ts/stream/chan-uuid?output_format=mpegts'
    );
  });

  it('orders live URL attempts TS first then HLS fallbacks', () => {
    const client = makeClient('http://host');
    expect(client.buildLiveUrlAttempts('chan-uuid')).toEqual([
      'http://host/proxy/ts/stream/chan-uuid?output_format=mpegts',
      'http://host/proxy/hls/stream/chan-uuid.m3u8',
      'http://host/proxy/hls/stream/chan-uuid',
    ]);
  });

  it('extracts live stream uuid from proxy URLs', () => {
    expect(
      DispatcharrClient.extractLiveStreamUuid(
        'http://host/proxy/ts/stream/abc-uuid?output_format=mpegts'
      )
    ).toBe('abc-uuid');
    expect(
      DispatcharrClient.extractLiveStreamUuid('http://host/proxy/hls/stream/abc-uuid.m3u8')
    ).toBe('abc-uuid');
  });

  it('mints VOD session URL shapes for movies and episodes', () => {
    const session = DispatcharrClient.mintVodSession(1_700_000_000_000, 4321);
    expect(session).toBe('vod_1700000000000_4321');

    const client = makeClient('http://host');
    expect(client.buildMovieUrl('movie-uuid', session)).toBe(
      'http://host/proxy/vod/movie/movie-uuid/vod_1700000000000_4321'
    );
    expect(client.buildEpisodeUrl('ep-uuid', session)).toBe(
      'http://host/proxy/vod/episode/ep-uuid/vod_1700000000000_4321'
    );

    const autoMovie = client.buildMovieUrl('m1');
    expect(autoMovie).toMatch(/^http:\/\/host\/proxy\/vod\/movie\/m1\/vod_\d+_\d{4}$/);
  });

  it('remints catalog-time VOD session for playback', () => {
    const stale =
      'http://host/proxy/vod/movie/movie-uuid/vod_1700000000000_4321?x=1';
    const fresh = DispatcharrClient.remintVodSessionUrl(stale);
    expect(fresh).toMatch(
      /^http:\/\/host\/proxy\/vod\/movie\/movie-uuid\/vod_\d+_\d{4}\?x=1$/
    );
    expect(fresh).not.toContain('vod_1700000000000_4321');
    expect(
      DispatcharrClient.remintVodSessionUrl(
        'http://host/proxy/ts/stream/abc?output_format=mpegts'
      )
    ).toBe('http://host/proxy/ts/stream/abc?output_format=mpegts');
  });

  it('exposes X-API-Key auth headers', () => {
    const client = makeClient();
    const headers = client.getAuthHeaders();
    expect(headers['X-API-Key']).toBe('test-key');
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toBeTruthy();
    expect(client.getApiKey()).toBe('test-key');
  });

  it('exposes X-API-Key playback headers for MPV proxy URLs', () => {
    const client = makeClient('http://dispatcharr.local:9191');
    const headers = client.getPlaybackHttpHeaders();
    expect(headers['X-API-Key']).toBe('test-key');
    expect(headers.Authorization).toBeUndefined();
    expect(
      client.needsPlaybackAuthHeaders(
        'http://dispatcharr.local:9191/proxy/ts/stream/abc?output_format=mpegts'
      )
    ).toBe(true);
    expect(client.needsPlaybackAuthHeaders('https://cdn.example/stream.ts')).toBe(false);
  });
});

describe('DispatcharrClient.getProfileChannelIds', () => {
  it('uses legacy channels array on profile detail when present', async () => {
    const client = makeClient();
    vi.spyOn(client as any, 'requestJson').mockResolvedValue({
      id: 5,
      name: 'TELUS',
      channels: [10, 20, 30],
      channel_count: 3,
    });
    const fetchCatalog = vi.spyOn(client as any, 'fetchCatalog');

    const ids = await client.getProfileChannelIds(5);
    expect(ids).toEqual([10, 20, 30]);
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it('falls back to nested /profiles/{id}/channels/ when detail omits channels', async () => {
    const client = makeClient();
    vi.spyOn(client as any, 'requestJson').mockResolvedValue({
      id: 5,
      name: 'TELUS',
      channel_count: 2,
    });
    vi.spyOn(client as any, 'fetchCatalog').mockResolvedValue([
      { channel_id: 101 },
      { channel: 102 },
    ]);

    const ids = await client.getProfileChannelIds(5);
    expect(ids).toEqual([101, 102]);
  });

  it('throws when channel_count > 0 but membership is empty', async () => {
    const client = makeClient();
    vi.spyOn(client as any, 'requestJson').mockResolvedValue({
      id: 5,
      name: 'TELUS',
      channel_count: 42,
    });
    vi.spyOn(client as any, 'fetchCatalog').mockResolvedValue([]);

    await expect(client.getProfileChannelIds(5)).rejects.toThrow(/membership list was empty/i);
  });

  it('returns empty when channel_count is 0 and no membership', async () => {
    const client = makeClient();
    vi.spyOn(client as any, 'requestJson').mockResolvedValue({
      id: 5,
      name: 'Empty',
      channel_count: 0,
    });
    vi.spyOn(client as any, 'fetchCatalog').mockResolvedValue([]);

    await expect(client.getProfileChannelIds(5)).resolves.toEqual([]);
  });
});

describe('DispatcharrClient.filterChannelsByProfiles', () => {
  it('fail-closed: account profiles restrict to union of memberships', async () => {
    const client = makeClient();
    vi.spyOn(client, 'getProfileChannelIds').mockImplementation(async (profileId: number) => {
      if (profileId === 10) return [1, 2];
      if (profileId === 11) return [2, 3];
      return [];
    });

    // Seed PK map the same way getLiveChannels does
    const channels = [
      channel({ stream_id: 'uuid-a', name: 'A' }),
      channel({ stream_id: 'uuid-b', name: 'B' }),
      channel({ stream_id: 'uuid-c', name: 'C' }),
      channel({ stream_id: 'uuid-d', name: 'D' }),
    ];
    (client as any).channelPkByStreamId.set('uuid-a', 1);
    (client as any).channelPkByStreamId.set('uuid-b', 2);
    (client as any).channelPkByStreamId.set('uuid-c', 3);
    (client as any).channelPkByStreamId.set('uuid-d', 4);

    const result = await client.filterChannelsByProfiles(channels, {
      accountProfileIds: [10, 11],
    });

    expect(result.map((c) => c.stream_id)).toEqual(['uuid-a', 'uuid-b', 'uuid-c']);
  });

  it('intersects with selectedProfileId after account filter', async () => {
    const client = makeClient();
    vi.spyOn(client, 'getProfileChannelIds').mockImplementation(async (profileId: number) => {
      if (profileId === 1) return [1, 2, 3];
      if (profileId === 99) return [2];
      return [];
    });

    const channels = [
      channel({ stream_id: 'disp-1', name: 'One' }),
      channel({ stream_id: 'disp-2', name: 'Two' }),
      channel({ stream_id: 'disp-3', name: 'Three' }),
    ];

    const result = await client.filterChannelsByProfiles(channels, {
      accountProfileIds: [1],
      selectedProfileId: 99,
    });

    expect(result.map((c) => c.stream_id)).toEqual(['disp-2']);
  });

  it('unions multiple selectedProfileIds after account filter', async () => {
    const client = makeClient();
    vi.spyOn(client, 'getProfileChannelIds').mockImplementation(async (profileId: number) => {
      if (profileId === 1) return [1, 2, 3, 4];
      if (profileId === 10) return [1, 2];
      if (profileId === 20) return [3];
      return [];
    });

    const channels = [
      channel({ stream_id: 'disp-1', name: 'One' }),
      channel({ stream_id: 'disp-2', name: 'Two' }),
      channel({ stream_id: 'disp-3', name: 'Three' }),
      channel({ stream_id: 'disp-4', name: 'Four' }),
    ];

    const result = await client.filterChannelsByProfiles(channels, {
      accountProfileIds: [1],
      selectedProfileIds: [10, 20],
    });

    expect(result.map((c) => c.stream_id)).toEqual(['disp-1', 'disp-2', 'disp-3']);
  });

  it('fail-open: selected profile fetch error keeps account-filtered list', async () => {
    const client = makeClient();
    vi.spyOn(client, 'getProfileChannelIds').mockImplementation(async (profileId: number) => {
      if (profileId === 1) return [1, 2];
      throw new Error('network');
    });

    const channels = [
      channel({ stream_id: 'disp-1', name: 'One' }),
      channel({ stream_id: 'disp-2', name: 'Two' }),
      channel({ stream_id: 'disp-9', name: 'Nine' }),
    ];

    const result = await client.filterChannelsByProfiles(channels, {
      accountProfileIds: [1],
      selectedProfileId: 50,
    });

    expect(result.map((c) => c.stream_id)).toEqual(['disp-1', 'disp-2']);
  });

  it('rethrows membership-empty errors for selected profile (abort sync)', async () => {
    const client = makeClient();
    vi.spyOn(client, 'getProfileChannelIds').mockImplementation(async (profileId: number) => {
      if (profileId === 1) return [1, 2];
      throw new Error(
        'Dispatcharr profile 50 reports 42 channel(s) but membership list was empty. Cannot filter safely — sync aborted to avoid wiping local channels.'
      );
    });

    const channels = [
      channel({ stream_id: 'disp-1', name: 'One' }),
      channel({ stream_id: 'disp-2', name: 'Two' }),
    ];

    await expect(
      client.filterChannelsByProfiles(channels, {
        accountProfileIds: [1],
        selectedProfileId: 50,
      })
    ).rejects.toThrow(/membership list was empty/i);
  });

  it('skips filtering when account profiles are empty and no selection', async () => {
    const client = makeClient();
    const spy = vi.spyOn(client, 'getProfileChannelIds');
    const channels = [channel({ stream_id: 'disp-1', name: 'One' })];

    const result = await client.filterChannelsByProfiles(channels, {
      accountProfileIds: [],
      selectedProfileId: null,
    });

    expect(result).toEqual(channels);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('DispatcharrClient.applyProfileScopedCategories', () => {
  it('stamps dp:{profile}:{group} ids so overlapping channels appear under both profiles', () => {
    const client = makeClient();
    (client as any).channelPkByStreamId.set('uuid-a', 1);
    (client as any).channelPkByStreamId.set('uuid-b', 2);

    const groups = [
      { category_id: '5', category_name: 'Sports', source_id: 'src1' },
      { category_id: '6', category_name: 'News', source_id: 'src1' },
    ];
    const channels = [
      channel({ stream_id: 'uuid-a', name: 'A', category_ids: ['5'] }),
      channel({ stream_id: 'uuid-b', name: 'B', category_ids: ['5', '6'] }),
    ];
    const membership = new Map<number, Set<number>>([
      [10, new Set([1, 2])],
      [20, new Set([2])],
    ]);

    const { channels: stamped, categories } = client.applyProfileScopedCategories(
      channels,
      groups,
      membership
    );

    expect(stamped[0].category_ids).toEqual(['dp:10:5']);
    expect(stamped[1].category_ids).toEqual(['dp:10:5', 'dp:10:6', 'dp:20:5', 'dp:20:6']);
    expect(categories.map((c) => c.category_id).sort()).toEqual([
      'dp:10:5',
      'dp:10:6',
      'dp:20:5',
      'dp:20:6',
    ]);
    expect(categories.find((c) => c.category_id === 'dp:10:5')?.category_name).toBe('Sports');
  });
});

describe('DispatcharrClient.resolvePlaybackUrl', () => {
  it('rejects empty playback URLs (missing uuid)', async () => {
    const client = makeClient('http://dispatcharr.local:9191');
    await expect(client.resolvePlaybackUrl('')).rejects.toThrow(/empty/i);
    await expect(client.resolvePlaybackUrl('   ')).rejects.toThrow(/empty/i);
  });

  it('sends X-API-Key only on own host, not after off-host redirect', async () => {
    const client = makeClient('http://dispatcharr.local:9191');
    const calls: Array<{ url: string; apiKey?: string }> = [];

    vi.spyOn(client as any, 'rawFetch').mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0] ?? '');
      const init = args[1] as { headers?: Record<string, string> } | undefined;
      calls.push({ url, apiKey: init?.headers?.['X-API-Key'] });
      if (url.startsWith('http://dispatcharr.local:9191')) {
        return {
          status: 302,
          ok: false,
          url,
          headers: { get: (n: string) => (n.toLowerCase() === 'location' ? 'https://cdn.example/stream.ts' : null) },
        };
      }
      return {
        status: 200,
        ok: true,
        url,
        headers: { get: () => null },
      };
    });

    const finalUrl = await client.resolvePlaybackUrl(
      'http://dispatcharr.local:9191/proxy/ts/stream/abc-uuid?output_format=mpegts'
    );

    expect(finalUrl).toBe('https://cdn.example/stream.ts');
    expect(calls).toHaveLength(2);
    expect(calls[0].apiKey).toBe('test-key');
    expect(calls[1].apiKey).toBeUndefined();
  });

  it('rejects non-2xx probe responses so live fallbacks can run', async () => {
    const client = makeClient('http://dispatcharr.local:9191');
    vi.spyOn(client as any, 'rawFetch').mockResolvedValue({
      status: 404,
      ok: false,
      url: 'http://dispatcharr.local:9191/proxy/hls/stream/abc.m3u8',
      headers: { get: () => null },
    });

    await expect(
      client.resolvePlaybackUrl('http://dispatcharr.local:9191/proxy/hls/stream/abc.m3u8')
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('DispatcharrClient.getEpgGrid', () => {
  it('builds days/prev_days and channel_profile_id query params', async () => {
    const client = makeClient('http://dispatcharr.local:9191');
    let requestedUrl = '';
    vi.spyOn(client as any, 'rawFetch').mockImplementation(async (...args: unknown[]) => {
      requestedUrl = String(args[0] ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
        text: async () => '',
      };
    });

    await client.getEpgGrid({ days: 3, prevDays: 7, channelProfileId: 42 });

    expect(requestedUrl).toContain('/api/epg/grid/?');
    expect(requestedUrl).toContain('days=3');
    expect(requestedUrl).toContain('prev_days=7');
    expect(requestedUrl).toContain('channel_profile_id=42');
  });

  it('uses start/end when provided (legacy positional args)', async () => {
    const client = makeClient('http://dispatcharr.local:9191');
    let requestedUrl = '';
    vi.spyOn(client as any, 'rawFetch').mockImplementation(async (...args: unknown[]) => {
      requestedUrl = String(args[0] ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 1,
              tvg_id: 'espn.us',
              title: 'Game',
              start_time: '2026-01-15T12:00:00Z',
              end_time: '2026-01-15T14:00:00Z',
            },
          ],
        }),
        text: async () => '',
      };
    });

    const rows = await client.getEpgGrid('2026-01-15T00:00:00Z', '2026-01-16T00:00:00Z');

    expect(requestedUrl).toContain('start=2026-01-15T00%3A00%3A00Z');
    expect(requestedUrl).toContain('end=2026-01-16T00%3A00%3A00Z');
    expect(requestedUrl).not.toContain('days=');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Game');
  });
});

describe('mapDispatcharrEpgGridToPrograms', () => {
  it('matches programmes by epg_channel_id (tvg_id)', () => {
    const channels = [
      channel({ stream_id: 'uuid-espn', name: 'ESPN', epg_channel_id: 'espn.us' }),
    ];
    const mapped = mapDispatcharrEpgGridToPrograms(
      channels,
      [
        {
          id: 10,
          tvg_id: 'espn.us',
          title: 'SportsCenter',
          description: 'News',
          start_time: '2026-01-15T12:00:00.000Z',
          end_time: '2026-01-15T13:00:00.000Z',
        },
      ],
      'src1'
    );

    expect(mapped).toHaveLength(1);
    expect(mapped[0].stream_id).toBe('uuid-espn');
    expect(mapped[0].title).toBe('SportsCenter');
    expect(mapped[0].source_id).toBe('src1');
  });

  it('matches dummy programmes by channel uuid / stream_id', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const channels = [channel({ stream_id: uuid, name: 'No EPG', epg_channel_id: '' })];
    const mapped = mapDispatcharrEpgGridToPrograms(
      channels,
      [
        {
          id: 'dummy-standard-1-20260115T120000',
          tvg_id: uuid,
          title: 'No EPG',
          start_time: '2026-01-15T12:00:00.000Z',
          end_time: '2026-01-15T16:00:00.000Z',
        },
      ],
      'src1'
    );

    expect(mapped).toHaveLength(1);
    expect(mapped[0].stream_id).toBe(uuid);
  });

  it('fans out shared tvg_id to every matching channel', () => {
    const channels = [
      channel({ stream_id: 'uuid-a', name: 'A', epg_channel_id: 'shared.tvg' }),
      channel({ stream_id: 'uuid-b', name: 'B', epg_channel_id: 'shared.tvg' }),
    ];
    const mapped = mapDispatcharrEpgGridToPrograms(
      channels,
      [
        {
          id: 99,
          tvg_id: 'shared.tvg',
          title: 'Shared Show',
          start_time: '2026-01-15T12:00:00.000Z',
          end_time: '2026-01-15T13:00:00.000Z',
        },
      ],
      'src1'
    );

    expect(mapped).toHaveLength(2);
    expect(mapped.map((p) => p.stream_id).sort()).toEqual(['uuid-a', 'uuid-b']);
  });

  it('is case-insensitive on tvg_id matching', () => {
    const channels = [
      channel({ stream_id: 'uuid-1', name: 'Ch', epg_channel_id: 'ESPN.US' }),
    ];
    const mapped = mapDispatcharrEpgGridToPrograms(
      channels,
      [
        {
          id: 1,
          tvg_id: 'espn.us',
          title: 'X',
          start_time: '2026-01-15T12:00:00.000Z',
          end_time: '2026-01-15T13:00:00.000Z',
        },
      ],
      'src1'
    );
    expect(mapped).toHaveLength(1);
  });
});

describe('DispatcharrClient.getLiveChannels epg_channel_id', () => {
  it('prefers effective_tvg_id over tvg_id', async () => {
    const client = makeClient('http://dispatcharr.local:9191');
    vi.spyOn(client as any, 'requestJson').mockResolvedValue([
      {
        id: 1,
        name: 'ESPN',
        uuid: 'chan-uuid-1',
        tvg_id: 'raw.tvg',
        effective_tvg_id: 'effective.tvg',
        group: 5,
      },
    ]);

    const channels = await client.getLiveChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].epg_channel_id).toBe('effective.tvg');
    expect(channels[0].stream_id).toBe('chan-uuid-1');
  });

  it('bridges empty tvg_id via epg_data_id → /api/epg/epgdata/', async () => {
    const client = makeClient('http://dispatcharr.local:9191');
    vi.spyOn(client as any, 'requestJson').mockImplementation(async (...args: unknown[]) => {
      const path = String(args[0] ?? '');
      if (path.includes('/api/epg/epgdata/')) {
        return [{ id: 11929, tvg_id: 'Canal.Futbol.Replay.es', name: 'Canal Futbol' }];
      }
      // channels list
      return [
        {
          id: 28699,
          name: 'Canal Fútbol Replay',
          uuid: 'd04d7dd1-e763-424a-94cf-7f6c12a0db6d',
          tvg_id: '',
          effective_tvg_id: '',
          epg_data_id: null,
          effective_epg_data_id: 11929,
          group: 1,
        },
      ];
    });

    const channels = await client.getLiveChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].epg_channel_id).toBe('Canal.Futbol.Replay.es');
  });
});
