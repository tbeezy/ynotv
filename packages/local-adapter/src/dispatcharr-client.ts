/**
 * Dispatcharr Direct Connect API Client
 *
 * Auth via username/password (JWT → api_key) or pasted API key.
 * Catalog + proxy URLs for live / VOD. Prefer X-API-Key for requests.
 *
 * Endpoints (Dispatcharr 0.23+):
 * - POST /api/accounts/token/ | /token/refresh/
 * - GET  /api/accounts/users/me/
 * - GET  /api/channels/groups/ | channels/ | profiles/ | profiles/<id>/
 * - GET  /api/vod/categories/ | movies/ | series/ | episodes/
 * - GET  /api/epg/grid/
 * - Live: /proxy/ts/stream/{uuid}?output_format=mpegts
 * - VOD:  /proxy/vod/movie|episode/{uuid}/{session}
 */

import type { Channel, Category, Movie, Series, Season, Episode } from '@ynotv/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export interface DispatcharrConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  apiKey?: string;
  credentialType?: 'usernamePassword' | 'apiKey';
  userAgent?: string;
}

export interface DispatcharrChannelProfile {
  id: number;
  name: string;
  channels?: number[];
}

export interface DispatcharrUser {
  id: number;
  username: string;
  api_key?: string;
  channel_profiles?: number[];
  custom_properties?: {
    vod_movies_enabled?: boolean;
    vod_series_enabled?: boolean;
    [key: string]: unknown;
  };
}

interface Paginated<T> {
  results?: T[];
  next?: string | null;
  count?: number;
}

interface RawChannel {
  id: number;
  name: string;
  uuid?: string | null;
  /** Official Dispatcharr field; older builds used logo_id. */
  logo?: number | null;
  logo_id?: number | null;
  tvg_id?: string | null;
  /** Coalesced override + channel tvg_id (prefer over raw tvg_id). */
  effective_tvg_id?: string | null;
  epg_data_id?: number | null;
  effective_epg_data_id?: number | null;
  /** Official Dispatcharr field; older builds used channel_number. */
  number?: number | string | null;
  channel_number?: number | string | null;
  /** Official Dispatcharr field; older builds used channel_group / channel_group_id. */
  group?: number | null;
  channel_group_id?: number | null;
  channel_group?: number | null;
  is_catchup?: boolean;
  catchup_days?: number;
}

/** One programme from `GET /api/epg/grid/` (`{"data":[...]}`). */
export interface DispatcharrEpgGridProgram {
  id?: string | number;
  start_time?: string;
  end_time?: string;
  title?: string | null;
  sub_title?: string | null;
  description?: string | null;
  tvg_id?: string | null;
  season?: number | null;
  episode?: number | null;
}

export interface DispatcharrEpgGridOptions {
  /** Absolute window start (ISO 8601). Takes precedence over days/prevDays. */
  startIso?: string;
  /** Absolute window end (ISO 8601). */
  endIso?: string;
  /** Days forward from now (1–365). Ignored when start/end set. Default 3. */
  days?: number;
  /** Days of lookback from now (0–30). Ignored when start/end set. */
  prevDays?: number;
  /** Limit programmes to channels in this profile. */
  channelProfileId?: number | null;
}

/**
 * Map Dispatcharr grid rows onto local channel `stream_id`s.
 * Matches on channel `epg_channel_id` / tvg_id and on channel uuid/`stream_id`
 * (dummy grid rows use `str(channel.uuid)`). Shared tvg_ids fan out to every
 * matching channel.
 */
export function mapDispatcharrEpgGridToPrograms(
  channels: Array<Pick<Channel, 'stream_id' | 'epg_channel_id'>>,
  gridPrograms: DispatcharrEpgGridProgram[],
  sourceId: string
): Array<{
  id: string;
  stream_id: string;
  title: string;
  subtitle?: string;
  description: string;
  start: Date;
  end: Date;
  source_id: string;
}> {
  // Lookup key (lowercased) → all stream_ids that should receive that programme.
  const streamIdsByKey = new Map<string, string[]>();
  const addKey = (raw: string | undefined | null, streamId: string) => {
    const key = (raw || '').trim().toLowerCase();
    if (!key) return;
    const list = streamIdsByKey.get(key);
    if (list) {
      if (!list.includes(streamId)) list.push(streamId);
    } else {
      streamIdsByKey.set(key, [streamId]);
    }
  };

  for (const ch of channels) {
    addKey(ch.epg_channel_id, ch.stream_id);
    addKey(ch.stream_id, ch.stream_id);
  }

  const out: Array<{
    id: string;
    stream_id: string;
    title: string;
    subtitle?: string;
    description: string;
    start: Date;
    end: Date;
    source_id: string;
  }> = [];

  for (const prog of gridPrograms) {
    const tvgKey = (prog.tvg_id || '').trim().toLowerCase();
    if (!tvgKey) continue;
    const streamIds = streamIdsByKey.get(tvgKey);
    if (!streamIds?.length) continue;

    const start = prog.start_time ? new Date(prog.start_time) : null;
    const end = prog.end_time ? new Date(prog.end_time) : null;
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) continue;

    const title = (prog.title || '').trim() || 'Unknown';
    const subtitle = (prog.sub_title || '').trim() || undefined;
    const description = (prog.description || '').trim();
    const startTs = Math.floor(start.getTime() / 1000);
    const progKey = prog.id != null ? String(prog.id) : `${tvgKey}_${startTs}`;

    for (const streamId of streamIds) {
      out.push({
        id: `${streamId}_${progKey}`,
        stream_id: streamId,
        title,
        subtitle,
        description,
        start,
        end,
        source_id: sourceId,
      });
    }
  }

  return out;
}

interface RawGroup {
  id: number;
  name: string;
}

interface RawVodCategory {
  id: number;
  name: string;
  category_type?: string;
}

interface RawVodLogo {
  url?: string | null;
  cache_url?: string | null;
}

interface RawMovie {
  id?: number | string;
  uuid?: string;
  title?: string;
  name?: string;
  year?: number | string;
  genre?: string;
  genres?: string[];
  plot?: string;
  description?: string;
  overview?: string;
  rating?: number | string;
  duration_secs?: number;
  tmdb_id?: string | number;
  logo?: RawVodLogo | null;
  categories?: Array<number | { id: number; name?: string }>;
  category?: number | string;
  category_id?: number | string;
  custom_properties?: {
    cast?: string;
    actors?: string;
    director?: string;
    release_date?: string;
    /** Dispatcharr list responses often put the VOD category only here. */
    category_id?: number | string;
    [key: string]: unknown;
  };
}

interface RawSeries {
  id?: number | string;
  uuid?: string;
  name?: string;
  title?: string;
  year?: number | string;
  genre?: string;
  genres?: string[];
  plot?: string;
  description?: string;
  overview?: string;
  rating?: number | string;
  tmdb_id?: string | number;
  logo?: RawVodLogo | null;
  categories?: Array<number | { id: number; name?: string }>;
  category?: number | string;
  category_id?: number | string;
  custom_properties?: {
    cast?: string;
    actors?: string;
    release_date?: string;
    first_air_date?: string;
    /** Dispatcharr list responses often put the VOD category only here. */
    category_id?: number | string;
    [key: string]: unknown;
  };
}

interface RawEpisode {
  id?: number | string;
  uuid?: string;
  title?: string;
  name?: string;
  season_number?: number;
  episode_number?: number;
  plot?: string;
  description?: string;
  overview?: string;
  duration_secs?: number;
}

export class DispatcharrClient {
  private config: DispatcharrConfig;
  private sourceId: string;
  /** Maps catalog stream_id → Dispatcharr channel PK (for profile filters). */
  private channelPkByStreamId = new Map<string, number>();
  private onProgress?: (msg: string) => void;

  constructor(config: DispatcharrConfig, sourceId: string) {
    this.config = {
      ...config,
      baseUrl: DispatcharrClient.normalizeBaseUrl(config.baseUrl),
      userAgent: config.userAgent || 'VLC/3.0.18 LibVLC/3.0.18',
      credentialType: config.credentialType || (config.apiKey && !config.username ? 'apiKey' : 'usernamePassword'),
    };
    this.sourceId = sourceId;
    if (config.apiKey) {
      this.config.apiKey = config.apiKey;
    }
  }

  /** Optional progress messages for long catalog syncs (UI status line). */
  setProgressHandler(handler?: (msg: string) => void): void {
    this.onProgress = handler;
  }

  static normalizeBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
  }

  /** Client-minted VOD session id (vod_<millis>_<rand>), matches Dispatcharr server format. */
  static mintVodSession(nowMs: number = Date.now(), rand: number = Math.floor(Math.random() * 9000) + 1000): string {
    return `vod_${nowMs}_${rand}`;
  }

  /**
   * Replace a catalog-time VOD session segment with a fresh one for playback.
   * Catalog sync embeds `vod_<ms>_<rand>` in direct_url; remint on play so
   * sessions stay unique / current.
   */
  static remintVodSessionUrl(url: string): string {
    const trimmed = (url || '').trim();
    if (!trimmed) return trimmed;
    try {
      const parsed = new URL(trimmed);
      const m = parsed.pathname.match(
        /^(\/proxy\/vod\/(?:movie|episode)\/[^/]+)\/[^/]+\/?$/i
      );
      if (!m) return trimmed;
      parsed.pathname = `${m[1]}/${DispatcharrClient.mintVodSession()}`;
      return parsed.toString();
    } catch {
      return trimmed;
    }
  }

  getApiKey(): string | undefined {
    return this.config.apiKey || undefined;
  }

  getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.config.userAgent || 'VLC/3.0.18 LibVLC/3.0.18',
    };
    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }
    return headers;
  }

  /**
   * HTTP headers for MPV when playing a Dispatcharr proxy URL that did not
   * redirect to a CDN. Aerio sends both shapes — some builds reject X-API-Key alone.
   */
  getPlaybackHttpHeaders(): Record<string, string> {
    // Prefer X-API-Key alone for proxy playback — dual Authorization: ApiKey
    // breaks some Dispatcharr builds (AerioTV changelog: v1.6.16+).
    if (!this.config.apiKey) return {};
    return {
      'X-API-Key': this.config.apiKey,
    };
  }

  /** True when the final play URL still needs Dispatcharr auth on the request. */
  needsPlaybackAuthHeaders(url: string): boolean {
    if (!this.config.apiKey || !url) return false;
    try {
      const parsed = new URL(url);
      if (!this.isOwnHost(url)) return false;
      return parsed.pathname.includes('/proxy/');
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // URL builders
  // ===========================================================================

  buildLiveUrl(channelUuid: string): string {
    return `${this.config.baseUrl}/proxy/ts/stream/${channelUuid}?output_format=mpegts`;
  }

  /**
   * Live URL attempts for libmpv. MPEG-TS first — HLS-first broke playback on
   * several Dispatcharr hosts (resolver treated non-playable HLS as success).
   * HLS remains a fallback only.
   */
  buildLiveUrlAttempts(channelUuid: string): string[] {
    const base = this.config.baseUrl;
    const uuid = channelUuid.trim();
    if (!uuid) return [];
    return [
      this.buildLiveUrl(uuid),
      `${base}/proxy/hls/stream/${uuid}.m3u8`,
      `${base}/proxy/hls/stream/${uuid}`,
    ];
  }

  /** Extract channel/stream uuid from a Dispatcharr live proxy URL. */
  static extractLiveStreamUuid(url: string): string | null {
    const trimmed = (url || '').trim();
    if (!trimmed) return null;
    try {
      const path = new URL(trimmed).pathname;
      // /proxy/ts/stream/{uuid} or /proxy/hls/stream/{uuid}.m3u8
      const m =
        /\/proxy\/(?:ts|hls)\/stream\/([^/?#]+)/i.exec(path) ||
        /\/proxy\/ts\/channel\/([^/?#]+)/i.exec(path);
      if (!m?.[1]) return null;
      return m[1].replace(/\.m3u8$/i, '');
    } catch {
      return null;
    }
  }

  /**
   * Resolve a live channel for playback: MPEG-TS first, then HLS fallbacks.
   * Requires a successful HTTP response (see resolvePlaybackUrl).
   */
  async resolveLivePlaybackUrl(rawUrl: string): Promise<string> {
    const uuid = DispatcharrClient.extractLiveStreamUuid(rawUrl);
    const attempts = uuid
      ? this.buildLiveUrlAttempts(uuid)
      : [(rawUrl || '').trim()].filter(Boolean);

    if (attempts.length === 0) {
      throw new Error('Dispatcharr playback URL is empty (missing stream uuid)');
    }

    let lastError: Error | null = null;
    for (const attempt of attempts) {
      try {
        const resolved = await this.resolvePlaybackUrl(attempt);
        if (resolved) return resolved;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[Dispatcharr] Live attempt failed: ${attempt}`, lastError.message);
      }
    }
    throw lastError || new Error('Dispatcharr live playback resolution failed');
  }

  buildMovieUrl(uuid: string, session?: string): string {
    const sid = session ?? DispatcharrClient.mintVodSession();
    return `${this.config.baseUrl}/proxy/vod/movie/${uuid}/${sid}`;
  }

  buildEpisodeUrl(uuid: string, session?: string): string {
    const sid = session ?? DispatcharrClient.mintVodSession();
    return `${this.config.baseUrl}/proxy/vod/episode/${uuid}/${sid}`;
  }

  logoUrl(logoId: number | string): string {
    return `${this.config.baseUrl}/api/channels/logos/${logoId}/cache/`;
  }

  // ===========================================================================
  // Auth
  // ===========================================================================

  async login(): Promise<{ access: string; refresh: string }> {
    const { username, password } = this.config;
    if (!username || !password) {
      throw new Error('Dispatcharr login requires username and password');
    }
    const data = await this.requestJson<{ access: string; refresh: string }>(
      '/api/accounts/token/',
      {
        method: 'POST',
        body: { username, password },
        auth: 'none',
      }
    );
    if (!data?.access || !data?.refresh) {
      throw new Error('Unexpected login response from Dispatcharr');
    }
    return { access: data.access, refresh: data.refresh };
  }

  async refreshAccessToken(refresh: string): Promise<string> {
    const data = await this.requestJson<{ access: string }>(
      '/api/accounts/token/refresh/',
      {
        method: 'POST',
        body: { refresh },
        auth: 'none',
      }
    );
    if (!data?.access) {
      throw new Error('Unexpected refresh response from Dispatcharr');
    }
    return data.access;
  }

  async fetchCurrentUser(accessTokenOrApiKey?: string): Promise<DispatcharrUser> {
    const headers = this.buildRequestHeaders(accessTokenOrApiKey);
    const raw = await this.requestJson<any>('/api/accounts/users/me/', { headers });
    return this.normalizeUser(raw);
  }

  /**
   * Ensure apiKey is set: login + users/me if usernamePassword, or use pasted apiKey.
   * Returns the user profile.
   */
  async bootstrapAuth(): Promise<DispatcharrUser> {
    const mode = this.config.credentialType || 'usernamePassword';

    if (mode === 'apiKey') {
      if (!this.config.apiKey) {
        throw new Error('Dispatcharr API key is required');
      }
      const user = await this.fetchCurrentUser(this.config.apiKey);
      if (user.api_key) {
        this.config.apiKey = user.api_key;
      }
      return user;
    }

    const { access } = await this.login();
    const user = await this.fetchCurrentUser(access);
    if (!user.api_key) {
      throw new Error(
        `Dispatcharr account '${user.username}' has no API key. Generate one in System → Users.`
      );
    }
    this.config.apiKey = user.api_key;
    return user;
  }

  async testConnection(): Promise<{ success: boolean; error?: string; user?: DispatcharrUser }> {
    try {
      const user = await this.bootstrapAuth();
      return { success: true, user };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ===========================================================================
  // Profiles
  // ===========================================================================

  async listChannelProfiles(): Promise<DispatcharrChannelProfile[]> {
    const data = await this.fetchCatalog<any>('/api/channels/profiles/', 'profiles');
    return data.map((p: any) => ({
      id: Number(p.id),
      name: String(p.name ?? ''),
      channels: Array.isArray(p.channels) ? p.channels.map((c: any) => Number(c)) : undefined,
    }));
  }

  /**
   * Channel PKs enabled in a Channel Profile.
   * Legacy Dispatcharr: `{ channels: number[] }` on profile detail.
   * Newer builds: membership via `/api/channels/profiles/{id}/channels/` (+ channel_count on detail).
   */
  async getProfileChannelIds(profileId: number): Promise<number[]> {
    const detail = await this.requestJson<{
      channels?: unknown;
      channel_count?: number;
    }>(`/api/channels/profiles/${profileId}/`);

    const fromDetail = this.normalizeProfileChannelIds(detail?.channels);
    if (fromDetail.length > 0) {
      return fromDetail;
    }

    // Nested membership list (current Dispatcharr API)
    try {
      const nested = await this.fetchCatalog<unknown>(
        `/api/channels/profiles/${profileId}/channels/`,
        `profile ${profileId} channels`
      );
      const fromNested = this.normalizeProfileChannelIds(nested);
      if (fromNested.length > 0) {
        return fromNested;
      }
    } catch (err) {
      // Fall through to channel_count check / empty return
      console.warn(
        `[Dispatcharr] Nested profile channels fetch failed for ${profileId}:`,
        err
      );
    }

    const channelCount =
      typeof detail?.channel_count === 'number' ? detail.channel_count : undefined;
    if (channelCount != null && channelCount > 0) {
      throw new Error(
        `Dispatcharr profile ${profileId} reports ${channelCount} channel(s) but membership list was empty. ` +
          `Cannot filter safely — sync aborted to avoid wiping local channels.`
      );
    }

    return [];
  }

  /**
   * Apply account-assigned profiles (fail-closed if assigned non-empty) +
   * optional selected profile id(s) as a UNION (fail-open only on network/throw
   * for a given selected profile; empty membership with channel_count > 0 aborts).
   *
   * Prefer `selectedProfileIds`. Legacy `selectedProfileId` is still accepted
   * and treated as a single-element selection.
   */
  async filterChannelsByProfiles(
    channels: Channel[],
    opts: {
      accountProfileIds?: number[];
      selectedProfileId?: number | null;
      selectedProfileIds?: number[];
    }
  ): Promise<Channel[]> {
    let filtered = channels;

    const accountIds = (opts.accountProfileIds || []).filter((id) => Number.isFinite(id));
    if (accountIds.length > 0) {
      const allowed = new Set<number>();
      for (const profileId of accountIds) {
        const ids = await this.getProfileChannelIds(profileId);
        for (const id of ids) allowed.add(id);
      }
      filtered = filtered.filter((ch) => {
        const pk = this.resolveChannelPk(ch);
        return pk != null && allowed.has(pk);
      });
    }

    const selectedIds = this.resolveSelectedProfileIds(opts);
    if (selectedIds.length > 0) {
      const union = new Set<number>();
      let anySuccess = false;

      for (const selected of selectedIds) {
        try {
          const ids = await this.getProfileChannelIds(selected);
          for (const id of ids) union.add(id);
          anySuccess = true;
        } catch (err) {
          // Fail-open only for transport errors — empty membership with channel_count > 0
          // throws from getProfileChannelIds and must abort sync (rethrow).
          const msg = err instanceof Error ? err.message : String(err);
          if (/reports \d+ channel\(s\) but membership list was empty/i.test(msg)) {
            throw err;
          }
          // Keep going; other selected profiles may still succeed on network errors.
        }
      }

      if (anySuccess) {
        filtered = filtered.filter((ch) => {
          const pk = this.resolveChannelPk(ch);
          return pk != null && union.has(pk);
        });
      }
      // If every selected-profile fetch failed with transport errors, fail-open
      // (keep account-filtered list) — same as single-id behavior.
    }

    return filtered;
  }

  /**
   * Fetch channel PK membership sets for each selected profile.
   * Used by sync to stamp per-profile composite category ids.
   */
  async getProfileMembershipMaps(
    profileIds: number[]
  ): Promise<Map<number, Set<number>>> {
    const maps = new Map<number, Set<number>>();
    for (const profileId of profileIds.filter((id) => Number.isFinite(id))) {
      const ids = await this.getProfileChannelIds(profileId);
      maps.set(profileId, new Set(ids));
    }
    return maps;
  }

  /**
   * Rewrite channel category_ids to `dp:{profileId}:{groupId}` for every
   * selected profile that contains the channel, and rebuild categories to match.
   * Channels that land in multiple profiles get multiple composite ids (appear under both).
   */
  applyProfileScopedCategories(
    channels: Channel[],
    groups: Category[],
    membershipByProfile: Map<number, Set<number>>
  ): { channels: Channel[]; categories: Category[] } {
    const groupNameById = new Map(
      groups.map((g) => [g.category_id, g.category_name] as const)
    );
    const categoryById = new Map<string, Category>();
    let displayOrder = 0;

    const stamped = channels.map((ch) => {
      const pk = this.resolveChannelPk(ch);
      const groupIds = (ch.category_ids || []).map(String).filter(Boolean);
      const nextIds: string[] = [];

      if (pk != null) {
        for (const [profileId, members] of membershipByProfile) {
          if (!members.has(pk)) continue;
          for (const groupId of groupIds) {
            const compositeId = `dp:${profileId}:${groupId}`;
            if (!nextIds.includes(compositeId)) nextIds.push(compositeId);
            if (!categoryById.has(compositeId)) {
              categoryById.set(compositeId, {
                category_id: compositeId,
                category_name: groupNameById.get(groupId) || groupId,
                source_id: this.sourceId,
                display_order: displayOrder++,
              });
            }
          }
        }
      }

      return { ...ch, category_ids: nextIds };
    });

    return {
      channels: stamped,
      categories: Array.from(categoryById.values()),
    };
  }

  private resolveSelectedProfileIds(opts: {
    selectedProfileId?: number | null;
    selectedProfileIds?: number[];
  }): number[] {
    if (Array.isArray(opts.selectedProfileIds) && opts.selectedProfileIds.length > 0) {
      return opts.selectedProfileIds.filter((id) => Number.isFinite(id));
    }
    const single = opts.selectedProfileId;
    if (single != null && Number.isFinite(single)) return [single];
    return [];
  }

  // ===========================================================================
  // Live catalog
  // ===========================================================================

  async getChannelGroups(): Promise<Category[]> {
    // Prefer unpaginated (omit page) — Dispatcharr returns the full list when no page is set.
    const groups = await this.fetchCatalog<RawGroup>('/api/channels/groups/', 'groups');
    return groups.map((g, index) => ({
      category_id: String(g.id),
      category_name: g.name,
      source_id: this.sourceId,
      display_order: index,
    }));
  }

  async getLiveChannels(): Promise<Channel[]> {
    const raw = await this.fetchCatalog<RawChannel>('/api/channels/channels/', 'channels');
    this.channelPkByStreamId.clear();

    // Many Dispatcharr channels have epg_data assigned but an empty tvg_id.
    // Grid programmes key by EPGData.tvg_id — bridge via /api/epg/epgdata/.
    const needsBridge = raw.some((ch) => {
      const tvg = (ch.effective_tvg_id || ch.tvg_id || '').trim();
      const epgId = ch.effective_epg_data_id ?? ch.epg_data_id;
      return !tvg && epgId != null;
    });
    const epgTvgById = needsBridge ? await this.getEpgDataTvgMap() : new Map<number, string>();

    return raw.map((ch, index) => {
      const uuid = (ch.uuid || '').trim();
      const streamId = uuid || `disp-${ch.id}`;
      this.channelPkByStreamId.set(streamId, ch.id);

      const groupId = ch.group ?? ch.channel_group_id ?? ch.channel_group ?? null;
      const channelNum = this.parseChannelNumber(ch.number ?? ch.channel_number);
      const logoId = ch.logo ?? ch.logo_id ?? null;

      let tvgId = (ch.effective_tvg_id || ch.tvg_id || '').trim();
      if (!tvgId) {
        const epgId = ch.effective_epg_data_id ?? ch.epg_data_id;
        if (epgId != null) {
          tvgId = (epgTvgById.get(Number(epgId)) || '').trim();
        }
      }

      return {
        stream_id: streamId,
        name: ch.name || `Channel ${ch.id}`,
        stream_icon: logoId != null ? this.logoUrl(logoId) : '',
        epg_channel_id: tvgId,
        category_ids: groupId != null ? [String(groupId)] : [],
        direct_url: uuid ? this.buildLiveUrl(uuid) : '',
        source_id: this.sourceId,
        tv_archive: ch.is_catchup ? 1 : 0,
        tv_archive_duration: ch.catchup_days,
        channel_num: channelNum,
        provider_order: index,
      } satisfies Channel;
    });
  }

  /**
   * Map EPGData PK → tvg_id (Dispatcharr guide match key).
   * Used when channel.tvg_id is empty but epg_data_id is set.
   */
  async getEpgDataTvgMap(): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      const rows = await this.fetchCatalog<{
        id?: number;
        tvg_id?: string | null;
      }>('/api/epg/epgdata/', 'epgdata');
      for (const row of rows) {
        if (row.id == null) continue;
        const tvg = (row.tvg_id || '').trim();
        if (tvg) map.set(Number(row.id), tvg);
      }
    } catch (err) {
      console.warn('[Dispatcharr] Failed to fetch epgdata bridge map:', err);
    }
    return map;
  }

  // ===========================================================================
  // VOD
  // ===========================================================================

  async getVodCategories(): Promise<{ movies: Category[]; series: Category[] }> {
    try {
      const cats = await this.fetchCatalog<RawVodCategory>('/api/vod/categories/', 'VOD categories');
      const movies: Category[] = [];
      const series: Category[] = [];
      cats.forEach((cat, index) => {
        const mapped: Category = {
          category_id: String(cat.id),
          category_name: cat.name,
          source_id: this.sourceId,
          display_order: index,
        };
        const type = (cat.category_type || '').toLowerCase();
        if (type === 'series' || type === 'tv' || type === 'show') {
          series.push(mapped);
        } else {
          movies.push(mapped);
        }
      });
      return { movies, series };
    } catch {
      return { movies: [], series: [] };
    }
  }

  private mapRawMovie(
    m: RawMovie,
    categoryNameToId: Map<string, string>,
    /** When listing via ?category=name|movie, force this membership. */
    forcedCategoryIds?: string[]
  ): Movie | null {
    const id = m.id != null ? String(m.id) : m.uuid || '';
    if (!id) return null;
    const uuid = (m.uuid || '').trim();
    const categoryIds =
      forcedCategoryIds && forcedCategoryIds.length > 0
        ? [...forcedCategoryIds]
        : this.resolveVodCategoryIds(m, categoryNameToId);
    const props = m.custom_properties || {};
    const year = m.year != null ? String(m.year) : undefined;

    return {
      stream_id: id,
      name: m.title || m.name || `Movie ${id}`,
      title: m.title || m.name,
      year,
      stream_icon: m.logo?.url || m.logo?.cache_url || '',
      category_ids: categoryIds,
      direct_url: uuid ? this.buildMovieUrl(uuid) : '',
      source_id: this.sourceId,
      plot: m.plot || m.overview || m.description,
      cast: (props.cast as string) || (props.actors as string) || undefined,
      director: (props.director as string) || undefined,
      genre: m.genre || (Array.isArray(m.genres) ? m.genres.join(', ') : undefined),
      release_date: (props.release_date as string) || undefined,
      duration: m.duration_secs,
      rating: m.rating != null ? String(m.rating) : undefined,
      tmdb_id: m.tmdb_id != null && !Number.isNaN(Number(m.tmdb_id)) ? Number(m.tmdb_id) : undefined,
    };
  }

  private mapRawSeries(
    s: RawSeries,
    categoryNameToId: Map<string, string>,
    forcedCategoryIds?: string[]
  ): Series | null {
    const id = s.id != null ? String(s.id) : s.uuid || '';
    if (!id) return null;
    const categoryIds =
      forcedCategoryIds && forcedCategoryIds.length > 0
        ? [...forcedCategoryIds]
        : this.resolveVodCategoryIds(s, categoryNameToId);
    const props = s.custom_properties || {};
    const year = s.year != null ? String(s.year) : undefined;

    return {
      series_id: id,
      name: s.name || s.title || `Series ${id}`,
      title: s.title || s.name,
      year,
      cover: s.logo?.url || s.logo?.cache_url || '',
      category_ids: categoryIds,
      source_id: this.sourceId,
      plot: s.plot || s.overview || s.description,
      cast: (props.cast as string) || (props.actors as string) || undefined,
      genre: s.genre || (Array.isArray(s.genres) ? s.genres.join(', ') : undefined),
      release_date:
        (props.release_date as string) || (props.first_air_date as string) || undefined,
      rating: s.rating != null ? String(s.rating) : undefined,
      tmdb_id: s.tmdb_id != null && !Number.isNaN(Number(s.tmdb_id)) ? Number(s.tmdb_id) : undefined,
    };
  }

  /** Build lowercase category-name → id map for genre/name fallback matching. */
  private async buildVodCategoryNameMap(
    kind: 'movie' | 'series'
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const cats = await this.getVodCategories();
      const list = kind === 'movie' ? cats.movies : cats.series;
      for (const cat of list) {
        const key = (cat.category_name || '').trim().toLowerCase();
        if (key) map.set(key, cat.category_id);
      }
    } catch (err) {
      console.warn('[Dispatcharr] Failed to seed VOD category name map:', err);
    }
    return map;
  }

  async getMovies(): Promise<Movie[]> {
    const categoryNameToId = await this.buildVodCategoryNameMap('movie');
    const raw = await this.fetchCatalog<RawMovie>('/api/vod/movies/', 'movies');
    const movies: Movie[] = [];
    for (const m of raw) {
      const mapped = this.mapRawMovie(m, categoryNameToId);
      if (mapped) movies.push(mapped);
    }
    return movies;
  }

  async getSeries(): Promise<Series[]> {
    const categoryNameToId = await this.buildVodCategoryNameMap('series');
    const raw = await this.fetchCatalog<RawSeries>('/api/vod/series/', 'series');
    const series: Series[] = [];
    for (const s of raw) {
      const mapped = this.mapRawSeries(s, categoryNameToId);
      if (mapped) series.push(mapped);
    }
    return series;
  }

  /**
   * Stream movies page-by-page (large libraries). Caller upserts each page
   * so the UI can show titles before the full catalog finishes.
   *
   * Dispatcharr list payloads omit category membership — it lives on
   * M3UMovieRelation. When `categories` is provided we walk each category via
   * `?category=name|movie` and stamp `category_ids` accordingly (unioning when
   * a title appears in more than one category).
   */
  async forEachMoviesPage(
    onPage: (
      movies: Movie[],
      meta: { page: number; totalHint?: number; accumulated: number }
    ) => Promise<void>,
    /** Optional pre-seeded name→id map (avoids a second categories fetch). */
    categoryNameToId?: Map<string, string>,
    categories?: Category[]
  ): Promise<number> {
    const nameMap = categoryNameToId ?? (await this.buildVodCategoryNameMap('movie'));
    if (categories && categories.length > 0) {
      return this.forEachVodByCategories<RawMovie, Movie>(
        'movie',
        categories,
        nameMap,
        onPage,
        (raw, forced) => this.mapRawMovie(raw, nameMap, forced)
      );
    }
    return this.forEachCatalogPage<RawMovie>(
      '/api/vod/movies/',
      'movies',
      async (raw, meta) => {
        const movies: Movie[] = [];
        for (const m of raw) {
          const mapped = this.mapRawMovie(m, nameMap);
          if (mapped) movies.push(mapped);
        }
        if (movies.length > 0) {
          await onPage(movies, meta);
        }
      },
      1000
    );
  }

  async forEachSeriesPage(
    onPage: (
      series: Series[],
      meta: { page: number; totalHint?: number; accumulated: number }
    ) => Promise<void>,
    categoryNameToId?: Map<string, string>,
    categories?: Category[]
  ): Promise<number> {
    const nameMap = categoryNameToId ?? (await this.buildVodCategoryNameMap('series'));
    if (categories && categories.length > 0) {
      return this.forEachVodByCategories<RawSeries, Series>(
        'series',
        categories,
        nameMap,
        onPage,
        (raw, forced) => this.mapRawSeries(raw, nameMap, forced)
      );
    }
    return this.forEachCatalogPage<RawSeries>(
      '/api/vod/series/',
      'series',
      async (raw, meta) => {
        const series: Series[] = [];
        for (const s of raw) {
          const mapped = this.mapRawSeries(s, nameMap);
          if (mapped) series.push(mapped);
        }
        if (series.length > 0) {
          await onPage(series, meta);
        }
      },
      1000
    );
  }

  /**
   * Walk each VOD category with Dispatcharr's `category=name|type` filter.
   * Movie/series list rows do not include category FKs — only the relation does.
   */
  private async forEachVodByCategories<TRaw, TMapped extends { category_ids?: string[] }>(
    kind: 'movie' | 'series',
    categories: Category[],
    _nameMap: Map<string, string>,
    onPage: (
      items: TMapped[],
      meta: { page: number; totalHint?: number; accumulated: number }
    ) => Promise<void>,
    mapOne: (raw: TRaw, forcedCategoryIds: string[]) => TMapped | null
  ): Promise<number> {
    const basePath = kind === 'movie' ? '/api/vod/movies/' : '/api/vod/series/';
    const label = kind === 'movie' ? 'movies' : 'series';
    // stream/series id → accumulated category ids across categories
    const catsById = new Map<string, string[]>();
    let accumulated = 0;
    let pageNum = 0;

    for (const cat of categories) {
      const catName = (cat.category_name || '').trim();
      if (!catName) continue;
      const filter = `${catName}|${kind}`;
      const path = `${basePath}?category=${encodeURIComponent(filter)}`;
      await this.forEachCatalogPage<TRaw>(
        path,
        `${label} (${catName})`,
        async (raw) => {
          const batch: TMapped[] = [];
          for (const row of raw) {
            const mapped = mapOne(row, [cat.category_id]);
            if (!mapped) continue;
            const id =
              kind === 'movie'
                ? (mapped as unknown as Movie).stream_id
                : (mapped as unknown as Series).series_id;
            if (!id) continue;
            const prev = catsById.get(id) || [];
            if (!prev.includes(cat.category_id)) prev.push(cat.category_id);
            catsById.set(id, prev);
            mapped.category_ids = [...prev];
            batch.push(mapped);
          }
          if (batch.length === 0) return;
          pageNum += 1;
          accumulated += batch.length;
          // totalHint stays undefined — per-category counts don't sum cleanly
          // when titles belong to multiple categories.
          await onPage(batch, { page: pageNum, accumulated });
        },
        1000
      );
    }

    return catsById.size;
  }

  async getSeriesInfo(seriesId: string): Promise<Season[]> {
    const rawId = seriesId.replace(/^disp-/, '');
    const path =
      `/api/vod/episodes/?series=${encodeURIComponent(rawId)}` +
      `&ordering=season_number,episode_number`;
    const episodes = await this.fetchCatalog<RawEpisode>(path, 'episodes');

    const bySeason = new Map<number, Episode[]>();
    for (const ep of episodes) {
      const seasonNum = ep.season_number ?? 0;
      const episodeNum = ep.episode_number ?? 0;
      const uuid = (ep.uuid || '').trim();
      const id = ep.id != null ? String(ep.id) : uuid || `${seasonNum}-${episodeNum}`;
      const list = bySeason.get(seasonNum) || [];
      list.push({
        id,
        title: ep.title || ep.name || `Episode ${episodeNum}`,
        episode_num: episodeNum,
        season_num: seasonNum,
        direct_url: uuid ? this.buildEpisodeUrl(uuid) : '',
        plot: ep.plot || ep.description || ep.overview,
        duration: ep.duration_secs,
      });
      bySeason.set(seasonNum, list);
    }

    return [...bySeason.entries()]
      .sort(([a], [b]) => a - b)
      .map(([season_number, eps]) => ({
        season_number,
        episodes: eps.sort((a, b) => a.episode_num - b.episode_num),
      }));
  }

  // ===========================================================================
  // EPG
  // ===========================================================================

  /**
   * Fetch programmes from Dispatcharr's grid API.
   * Prefer `days`/`prevDays` (or absolute start/end). Optional profile filter.
   *
   * Without a channel profile the full-library grid can be 100MB+; in that case
   * we automatically fetch absolute time chunks and merge.
   */
  async getEpgGrid(
    options: DispatcharrEpgGridOptions | string = {},
    endIsoLegacy?: string
  ): Promise<DispatcharrEpgGridProgram[]> {
    // Back-compat: getEpgGrid(startIso, endIso)
    const opts: DispatcharrEpgGridOptions =
      typeof options === 'string'
        ? { startIso: options, endIso: endIsoLegacy }
        : options || {};

    const hasProfile = opts.channelProfileId != null && opts.channelProfileId > 0;
    const hasAbsolute = Boolean(opts.startIso || opts.endIso);

    // Unscoped grids are huge — pull in 6h windows instead of one giant JSON body.
    if (!hasProfile && !hasAbsolute) {
      const days = Math.max(1, Math.min(365, opts.days ?? 2));
      const prevDays = Math.max(0, Math.min(30, opts.prevDays ?? 1));
      const now = Date.now();
      const startMs = now - prevDays * 86_400_000;
      const endMs = now + days * 86_400_000;
      return this.getEpgGridChunked(startMs, endMs, null);
    }

    return this.fetchEpgGridOnce(opts);
  }

  /** Fetch grid in 6-hour absolute windows and dedupe. */
  async getEpgGridChunked(
    startMs: number,
    endMs: number,
    channelProfileId: number | null
  ): Promise<DispatcharrEpgGridProgram[]> {
    const CHUNK_MS = 6 * 60 * 60 * 1000;
    const byKey = new Map<string, DispatcharrEpgGridProgram>();
    let cursor = startMs;
    while (cursor < endMs) {
      const chunkEnd = Math.min(cursor + CHUNK_MS, endMs);
      const rows = await this.fetchEpgGridOnce({
        startIso: new Date(cursor).toISOString(),
        endIso: new Date(chunkEnd).toISOString(),
        channelProfileId,
      });
      for (const row of rows) {
        const key = `${row.tvg_id ?? ''}|${row.start_time ?? ''}|${row.id ?? ''}`;
        if (!byKey.has(key)) byKey.set(key, row);
      }
      cursor = chunkEnd;
    }
    return [...byKey.values()];
  }

  private async fetchEpgGridOnce(
    opts: DispatcharrEpgGridOptions
  ): Promise<DispatcharrEpgGridProgram[]> {
    const params = new URLSearchParams();
    if (opts.startIso || opts.endIso) {
      if (opts.startIso) params.set('start', opts.startIso);
      if (opts.endIso) params.set('end', opts.endIso);
    } else {
      const days = Math.max(1, Math.min(365, opts.days ?? 2));
      const prevDays = Math.max(0, Math.min(30, opts.prevDays ?? 1));
      params.set('days', String(days));
      params.set('prev_days', String(prevDays));
    }
    if (opts.channelProfileId != null && opts.channelProfileId > 0) {
      params.set('channel_profile_id', String(opts.channelProfileId));
    }

    const path = `/api/epg/grid/?${params.toString()}`;
    const data = await this.requestJson<
      DispatcharrEpgGridProgram[] | { data?: DispatcharrEpgGridProgram[]; results?: DispatcharrEpgGridProgram[] }
    >(path);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray((data as { results?: DispatcharrEpgGridProgram[] })?.results)) {
      return (data as { results: DispatcharrEpgGridProgram[] }).results;
    }
    return [];
  }

  // ===========================================================================
  // Playback URL resolution
  // ===========================================================================

  /**
   * Follow redirects with auth only on own host; return final URL for mpv.
   */
  async resolvePlaybackUrl(url: string): Promise<string> {
    const trimmed = (url || '').trim();
    if (!trimmed) {
      throw new Error('Dispatcharr playback URL is empty (missing stream uuid)');
    }

    let current = trimmed;
    for (let i = 0; i < 5; i++) {
      const headers: Record<string, string> = {
        Accept: '*/*',
        Range: 'bytes=0-0',
        'User-Agent': this.config.userAgent || 'VLC/3.0.18 LibVLC/3.0.18',
      };
      // Auth only on our Dispatcharr host — never forward X-API-Key to redirect targets.
      if (this.isOwnHost(current) && this.config.apiKey) {
        headers['X-API-Key'] = this.config.apiKey;
      }

      const response = await this.rawFetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
      });

      const status = response.status;
      if (status >= 300 && status < 400) {
        const loc = response.headers.get('Location') || response.headers.get('location');
        if (!loc) return current;
        current = new URL(loc, current).href;
        continue;
      }

      if (status === 401 || status === 403) {
        throw new Error(`Dispatcharr playback auth failed: HTTP ${status}`);
      }

      // Non-success (404/5xx/etc.) must fail so live URL fallbacks can try the next form.
      // Previously we returned the URL anyway, which pinned broken HLS and never reached TS.
      if (status < 200 || status >= 300) {
        throw new Error(`Dispatcharr playback probe failed: HTTP ${status}`);
      }

      // Prefer final URL from response when available
      try {
        if (response.url) return response.url;
      } catch {
        // ignore
      }
      return current;
    }
    return current;
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private resolveChannelPk(ch: Channel): number | null {
    const cached = this.channelPkByStreamId.get(ch.stream_id);
    if (cached != null) return cached;

    const disp = /^disp-(\d+)$/.exec(ch.stream_id);
    if (disp) return Number(disp[1]);

    if (/^\d+$/.test(ch.stream_id)) return Number(ch.stream_id);
    return null;
  }

  /** Normalize profile membership payloads (number[], or objects with channel_id/channel/id). */
  private normalizeProfileChannelIds(raw: unknown): number[] {
    if (raw == null) return [];
    const list = Array.isArray(raw) ? raw : [];
    const ids: number[] = [];
    for (const entry of list) {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        ids.push(entry);
        continue;
      }
      if (typeof entry === 'string' && /^\d+$/.test(entry.trim())) {
        ids.push(Number(entry.trim()));
        continue;
      }
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>;
        const candidate = obj.channel_id ?? obj.channel ?? obj.id;
        const n = typeof candidate === 'number' ? candidate : Number(candidate);
        if (Number.isFinite(n)) ids.push(n);
      }
    }
    return ids;
  }

  private parseChannelNumber(value: number | string | null | undefined): number | undefined {
    if (value == null || value === '') return undefined;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    const n = parseFloat(String(value).trim());
    return Number.isFinite(n) ? n : undefined;
  }

  private coerceCategoryId(value: unknown): string | null {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    return null;
  }

  /**
   * Resolve Dispatcharr VOD category membership for sidebar browse.
   * Order matches AerioTV / Dispatcharr list payloads:
   * 1. categories[]  2. category / category_id  3. custom_properties.category_id
   * 4. genre / genres names matched to /api/vod/categories/ names (real IDs).
   */
  private resolveVodCategoryIds(
    item: {
      categories?: Array<number | { id: number }>;
      category?: number | string;
      category_id?: number | string;
      genre?: string;
      genres?: string[];
      custom_properties?: { category_id?: number | string; [key: string]: unknown };
    },
    categoryNameToId: Map<string, string>
  ): string[] {
    const ids: string[] = [];
    const add = (raw: unknown) => {
      const id = this.coerceCategoryId(raw);
      if (id && !ids.includes(id)) ids.push(id);
    };

    if (Array.isArray(item.categories) && item.categories.length > 0) {
      for (const c of item.categories) {
        add(typeof c === 'object' ? c.id : c);
      }
    }

    add(item.category);
    add(item.category_id);
    add(item.custom_properties?.category_id);

    if (ids.length > 0) return ids;

    // Fallback: map genre labels onto real category IDs by name.
    const genreParts: string[] = [];
    if (Array.isArray(item.genres)) {
      for (const g of item.genres) {
        if (typeof g === 'string' && g.trim()) genreParts.push(g.trim());
      }
    }
    if (item.genre) {
      for (const part of item.genre.split(/[,/|]/)) {
        const t = part.trim();
        if (t) genreParts.push(t);
      }
    }
    for (const name of genreParts) {
      const mapped = categoryNameToId.get(name.toLowerCase());
      if (mapped && !ids.includes(mapped)) ids.push(mapped);
    }

    return ids;
  }

  private normalizeUser(raw: any): DispatcharrUser {
    const props = raw?.custom_properties;
    return {
      id: Number(raw?.id) || 0,
      username: String(raw?.username ?? ''),
      api_key: raw?.api_key || undefined,
      channel_profiles: Array.isArray(raw?.channel_profiles)
        ? raw.channel_profiles.map(Number)
        : [],
      custom_properties:
        props && typeof props === 'object'
          ? {
              vod_movies_enabled: props.vod_movies_enabled !== false,
              vod_series_enabled: props.vod_series_enabled !== false,
              ...props,
            }
          : undefined,
    };
  }

  private isOwnHost(url: string): boolean {
    try {
      const host = new URL(url).host.toLowerCase();
      const own = new URL(this.config.baseUrl).host.toLowerCase();
      return host === own;
    } catch {
      return false;
    }
  }

  private buildRequestHeaders(accessTokenOrApiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.config.userAgent || 'VLC/3.0.18 LibVLC/3.0.18',
    };
    if (accessTokenOrApiKey) {
      // JWT access tokens are long; API keys are typically shorter hex.
      // Prefer Bearer when the caller passed an access token from login;
      // otherwise X-API-Key. Heuristic: JWT has three dot-separated parts.
      if (accessTokenOrApiKey.split('.').length === 3) {
        headers['Authorization'] = `Bearer ${accessTokenOrApiKey}`;
      } else {
        headers['X-API-Key'] = accessTokenOrApiKey;
      }
    } else if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }
    return headers;
  }

  /**
   * Prefer a single unpaginated response (Dispatcharr returns the full list when
   * no `page` query is set). Fall back to paginated pages with a larger page size.
   * Rewrites absolute `next` URLs onto our configured base origin so a TLS-terminating
   * proxy does not flip every page between http:// and https://.
   */
  private async fetchCatalog<T>(basePath: string, label: string, pageSize = 1000): Promise<T[]> {
    const all: T[] = [];
    await this.forEachCatalogPage<T>(
      basePath,
      label,
      async (items) => {
        all.push(...items);
      },
      pageSize
    );
    return all;
  }

  /**
   * Walk a catalog endpoint page-by-page. Invokes `onPage` after each page so
   * callers can upsert progressively (60k+ VOD libraries).
   * @returns total items yielded across all pages
   */
  async forEachCatalogPage<T>(
    basePath: string,
    label: string,
    onPage: (
      items: T[],
      meta: { page: number; totalHint?: number; accumulated: number }
    ) => Promise<void>,
    pageSize = 1000
  ): Promise<number> {
    const path = basePath.includes('?') ? basePath : `${basePath}${basePath.endsWith('/') ? '' : '/'}`;
    this.onProgress?.(`Fetching ${label}…`);

    // Try unpaginated first (omit page) — small catalogs come back as a plain array.
    const probe = await this.requestJson<T[] | Paginated<T>>(path);
    if (Array.isArray(probe)) {
      let accumulated = 0;
      let pageNum = 0;
      for (let i = 0; i < probe.length; i += pageSize) {
        pageNum += 1;
        const chunk = probe.slice(i, i + pageSize);
        accumulated += chunk.length;
        this.onProgress?.(`Importing ${label}: ${accumulated}/${probe.length}`);
        await onPage(chunk, { page: pageNum, totalHint: probe.length, accumulated });
      }
      this.onProgress?.(`Fetched ${probe.length} ${label}`);
      return probe.length;
    }

    // Paginated — request large pages from the start (ignore tiny default first page).
    const sep = path.includes('?') ? '&' : '?';
    let pathOrUrl: string | null = `${path}${sep}page_size=${pageSize}`;
    let guard = 0;
    let pageNum = 0;
    let totalHint: number | undefined =
      typeof probe.count === 'number' ? probe.count : undefined;
    let accumulated = 0;

    while (pathOrUrl && guard < 500) {
      guard += 1;
      const prev: string = pathOrUrl;
      const data = await this.requestJson<T[] | Paginated<T>>(pathOrUrl);

      if (Array.isArray(data)) {
        pageNum += 1;
        accumulated += data.length;
        await onPage(data, { page: pageNum, totalHint, accumulated });
        break;
      }

      const page = data as Paginated<T>;
      if (typeof page.count === 'number') totalHint = page.count;
      const pageLen = Array.isArray(page.results) ? page.results.length : 0;
      if (pageLen > 0) {
        pageNum += 1;
        accumulated += pageLen;
        const totalPages =
          totalHint != null ? Math.max(1, Math.ceil(totalHint / Math.max(pageLen, 1))) : undefined;
        this.onProgress?.(
          totalPages
            ? `Fetching ${label}: page ${pageNum}/${totalPages} (${accumulated}${totalHint != null ? `/${totalHint}` : ''})`
            : `Fetching ${label}: page ${pageNum} (${accumulated} so far)`
        );
        await onPage(page.results as T[], { page: pageNum, totalHint, accumulated });
      }

      const nextRaw = page.next || null;
      if (!nextRaw || nextRaw === prev) break;
      const rewritten = this.rewritePaginationUrl(nextRaw);
      if (rewritten === prev) break;
      pathOrUrl = rewritten;
    }

    this.onProgress?.(`Fetched ${accumulated} ${label}`);
    return accumulated;
  }

  /** Keep pagination on the same scheme/host as the configured source URL. */
  private rewritePaginationUrl(next: string): string {
    if (!next.startsWith('http://') && !next.startsWith('https://')) {
      return next;
    }
    try {
      const base = new URL(this.config.baseUrl);
      const n = new URL(next);
      n.protocol = base.protocol;
      n.host = base.host;
      return n.toString();
    } catch {
      return next;
    }
  }

  private async requestJson<T>(
    pathOrUrl: string,
    opts?: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      auth?: 'apiKey' | 'none';
    }
  ): Promise<T> {
    const method = opts?.method || 'GET';
    const url = pathOrUrl.startsWith('http')
      ? pathOrUrl
      : `${this.config.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

    const headers: Record<string, string> = {
      ...(opts?.headers || (opts?.auth === 'none' ? {
        Accept: 'application/json',
        'User-Agent': this.config.userAgent || 'VLC/3.0.18 LibVLC/3.0.18',
      } : this.getAuthHeaders())),
    };

    if (opts?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await this.rawFetch(url, {
      method,
      headers,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Dispatcharr API error: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 160)}` : ''}`
      );
    }

    return (await response.json()) as T;
  }

  private async rawFetch(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      redirect?: RequestRedirect;
    }
  ): Promise<Response> {
    const method = init.method || 'GET';
    const headers = init.headers || {};

    if (typeof window !== 'undefined' && (window as any).__TAURI__) {
      return tauriFetch(url, {
        method,
        headers,
        body: init.body,
        redirect: init.redirect,
      } as any);
    }

    if (typeof window !== 'undefined' && (window as any).fetchProxy) {
      const result = await (window as any).fetchProxy.fetch(url, {
        method,
        headers,
        body: init.body,
        // Preserve redirect mode so resolvePlaybackUrl can keep auth host-scoped.
        ...(init.redirect ? { redirect: init.redirect } : {}),
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Fetch failed');
      }
      // Minimal Response-like adapter for Electron proxy path
      const status = result.data.status;
      const text = result.data.text ?? '';
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: result.data.statusText || '',
        url: result.data.url || url,
        headers: {
          get: (name: string) => {
            const h = result.data.headers || {};
            return h[name] || h[name.toLowerCase()] || null;
          },
        },
        json: async () => JSON.parse(text),
        text: async () => text,
      } as unknown as Response;
    }

    return fetch(url, {
      method,
      headers,
      body: init.body,
      redirect: init.redirect ?? 'follow',
    });
  }
}
