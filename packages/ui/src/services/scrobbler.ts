import { AppSettings } from '../types/app';
import type { StremioMetaPreview } from '../types/stremio';
import i18n from '../i18n';
import { db, updateVodWatchProgress, recordEpisodeWatch } from '../db';
import { useSettingsStore, type TraktSettings, type SimklSettings } from '../stores/settingsStore';

// Unified logger helpers
const logInfo = (...args: any[]) => console.log('[Scrobbler]', ...args);
const logWarn = (...args: any[]) => console.warn('[Scrobbler]', ...args);
const logError = (...args: any[]) => console.error('[Scrobbler]', ...args);

// API Endpoints
const TRAKT_API_URL = 'https://api.trakt.tv';
export const SIMKL_API_URL = 'https://api.simkl.com';
export const DEFAULT_SIMKL_CLIENT_ID = 'cfab28c8449e6a5784705e4ff09d63e155598acb0491b074d246cca91bfe8408';

export interface SimklPinResponse {
  result: string;
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

// ---------------------------------------------------------------------------
// Trakt Catalog Definitions
// ---------------------------------------------------------------------------
export type TraktCatalogType =
  | 'playback'
  | 'watchlist'
  | 'history'
  | 'recommendations-movies'
  | 'recommendations-shows'
  | 'collection-movies'
  | 'collection-shows'
  | 'trending-movies'
  | 'trending-shows'
  | 'popular-movies'
  | 'popular-shows'
  | 'watched-movies'
  | 'watched-shows'
  | 'anticipated-movies'
  | 'anticipated-shows';

const TRAKT_PAGE_LIMIT = 30;
const TRAKT_CACHE_STALE_MS = 30 * 60 * 1000;

const TRAKT_CATALOG_URLS: Record<TraktCatalogType, string> = {
  'playback': `${TRAKT_API_URL}/sync/playback?limit=${TRAKT_PAGE_LIMIT}`,
  'watchlist': `${TRAKT_API_URL}/users/me/watchlist?limit=${TRAKT_PAGE_LIMIT}`,
  'history': `${TRAKT_API_URL}/users/me/history?limit=${TRAKT_PAGE_LIMIT}`,
  'recommendations-movies': `${TRAKT_API_URL}/recommendations/movies?limit=${TRAKT_PAGE_LIMIT}`,
  'recommendations-shows': `${TRAKT_API_URL}/recommendations/shows?limit=${TRAKT_PAGE_LIMIT}`,
  'collection-movies': `${TRAKT_API_URL}/users/me/collection/movies?limit=${TRAKT_PAGE_LIMIT}`,
  'collection-shows': `${TRAKT_API_URL}/users/me/collection/shows?limit=${TRAKT_PAGE_LIMIT}`,
  'trending-movies': `${TRAKT_API_URL}/movies/trending?limit=${TRAKT_PAGE_LIMIT}`,
  'trending-shows': `${TRAKT_API_URL}/shows/trending?limit=${TRAKT_PAGE_LIMIT}`,
  'popular-movies': `${TRAKT_API_URL}/movies/popular?limit=${TRAKT_PAGE_LIMIT}`,
  'popular-shows': `${TRAKT_API_URL}/shows/popular?limit=${TRAKT_PAGE_LIMIT}`,
  'watched-movies': `${TRAKT_API_URL}/movies/watched?limit=${TRAKT_PAGE_LIMIT}`,
  'watched-shows': `${TRAKT_API_URL}/shows/watched?limit=${TRAKT_PAGE_LIMIT}`,
  'anticipated-movies': `${TRAKT_API_URL}/movies/anticipated?limit=${TRAKT_PAGE_LIMIT}`,
  'anticipated-shows': `${TRAKT_API_URL}/shows/anticipated?limit=${TRAKT_PAGE_LIMIT}`,
};

// Which catalog types use a wrapped response (item.movie / item.show) vs flat
const WRAPPED_CATALOGS = new Set<TraktCatalogType>([
  'playback',
  'watchlist', 'history',
  'collection-movies', 'collection-shows',
  'trending-movies', 'trending-shows',
  'watched-movies', 'watched-shows',
  'anticipated-movies', 'anticipated-shows',
]);

export interface TraktCatalogDefinition {
  type: TraktCatalogType;
  label: string;
  description: string;
  group: string;
}

export const TRAKT_CATALOG_DEFINITIONS: TraktCatalogDefinition[] = [
  { type: 'playback', label: 'Resume Watching', description: 'In-progress movies and episodes from your Trakt playback history', group: 'Your Library' },
  { type: 'watchlist', label: 'Watchlist', description: 'Items you have saved to watch later', group: 'Your Library' },
  { type: 'history', label: 'History', description: 'Items you have watched', group: 'Your Library' },
  { type: 'collection-movies', label: 'Movie Collection', description: 'Movies in your collection', group: 'Your Library' },
  { type: 'collection-shows', label: 'Show Collection', description: 'Shows in your collection', group: 'Your Library' },
  { type: 'recommendations-movies', label: 'Movie Recommendations', description: 'Personalized movie recommendations from Trakt', group: 'Recommendations' },
  { type: 'recommendations-shows', label: 'Show Recommendations', description: 'Personalized show recommendations from Trakt', group: 'Recommendations' },
  { type: 'trending-movies', label: 'Trending Movies', description: 'Movies trending right now on Trakt', group: 'Trending & Popular' },
  { type: 'trending-shows', label: 'Trending Shows', description: 'Shows trending right now on Trakt', group: 'Trending & Popular' },
  { type: 'popular-movies', label: 'Popular Movies', description: 'All-time popular movies on Trakt', group: 'Trending & Popular' },
  { type: 'popular-shows', label: 'Popular Shows', description: 'All-time popular shows on Trakt', group: 'Trending & Popular' },
  { type: 'watched-movies', label: 'Most Watched Movies', description: 'Most watched movies this week on Trakt', group: 'Trending & Popular' },
  { type: 'watched-shows', label: 'Most Watched Shows', description: 'Most watched shows this week on Trakt', group: 'Trending & Popular' },
  { type: 'anticipated-movies', label: 'Most Anticipated Movies', description: 'Most anticipated upcoming movies on Trakt', group: 'Trending & Popular' },
  { type: 'anticipated-shows', label: 'Most Anticipated Shows', description: 'Most anticipated upcoming shows on Trakt', group: 'Trending & Popular' },
];

type ScrobblerProvider = 'Trakt';

const buildCredentials = {
  traktClientId: import.meta.env.VITE_TRAKT_CLIENT_ID?.trim() || '',
  traktClientSecret: import.meta.env.VITE_TRAKT_CLIENT_SECRET?.trim() || '',
  simklClientId: import.meta.env.VITE_SIMKL_CLIENT_ID?.trim() || DEFAULT_SIMKL_CLIENT_ID,
};

export function getScrobblerCredentialStatus() {
  return {
    traktConfigured: Boolean(buildCredentials.traktClientId && buildCredentials.traktClientSecret),
  };
}

function requireBuildCredential(value: string, provider: ScrobblerProvider, name: string): string {
  if (value) return value;
  throw new Error(`${provider} ${name} is not configured. Set the VITE_${provider.toUpperCase()}_${name.toUpperCase()} environment variable before building.`);
}

function getTraktCredentials() {
  return {
    clientId: requireBuildCredential(buildCredentials.traktClientId, 'Trakt', 'client_id'),
    clientSecret: requireBuildCredential(buildCredentials.traktClientSecret, 'Trakt', 'client_secret'),
  };
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface PlaybackMediaInfo {
  title: string;
  year?: string;
  imdbId?: string; // e.g. "tt1234567"
  tmdbId?: number; // TMDb id (preferred when available)
  type: 'movie' | 'series';
  season?: number;
  episode?: number;
  progressPercent: number; // 0 to 100
}

// Helper to handle cross-origin Tauri/Browser requests
async function makeRequest(url: string, options: any = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const bodyStr = options.body ? (typeof options.body === 'object' ? JSON.stringify(options.body) : options.body) : undefined;
  const fetchOptions = {
    ...options,
    headers,
    body: bodyStr,
  };

  if (window.fetchProxy) {
    const res = await window.fetchProxy.fetch(url, fetchOptions);
    if (res.error || !res.data) {
      throw new Error(res.error || `HTTP request failed to ${url}`);
    }
    const text = res.data.text;
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON
    }
      return {
        ok: res.data.ok,
        status: res.data.status,
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(json || {}),
      };
  } else {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: bodyStr,
    });
    return res;
  }
}

class ScrobblerService {
  private lastActiveMedia: PlaybackMediaInfo | null = null;
  private isScrobblingActive = false;
  private scrobbleSessionId = 0;

  // Cache for Trakt catalogs (stale after 30 minutes, playback type not cached)
  private catalogCache = new Map<string, { data: { items: StremioMetaPreview[]; hasMore: boolean }; timestamp: number }>();
  private listCatalogCache = new Map<string, { data: { items: StremioMetaPreview[]; hasMore: boolean }; timestamp: number }>();

  // Retrieve app settings — the settings store is the single source of truth
  // (hydrated at boot, written by the setters below), so no IPC round-trip.
  private async getSettings(): Promise<AppSettings> {
    return useSettingsStore.getState() as unknown as AppSettings;
  }

  // Update app settings — route through the store setters so the store stays
  // current and the write-queue persistence is used. The scrobbler only ever
  // writes trakt/simkl fields, so only those keys are forwarded.
  private async updateSettings(settings: Partial<AppSettings>): Promise<void> {
    const store = useSettingsStore.getState();
    const traktPartial: Partial<TraktSettings> = {};
    const simklPartial: Partial<SimklSettings> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith('trakt')) (traktPartial as Record<string, any>)[k] = v;
      if (k.startsWith('simkl')) (simklPartial as Record<string, any>)[k] = v;
    }
    if (Object.keys(traktPartial).length > 0) store.setTraktSettings(traktPartial);
    if (Object.keys(simklPartial).length > 0) store.setSimklSettings(simklPartial);
  }

  // --------------------------------------------------------------------------
  // Trakt Authentication / OAuth Flow
  // --------------------------------------------------------------------------
  async generateTraktDeviceCode(): Promise<DeviceCodeResponse> {
    const { clientId } = getTraktCredentials();

    logInfo('Generating Trakt Device Code...');
    const response = await makeRequest(`${TRAKT_API_URL}/oauth/device/code`, {
      method: 'POST',
      headers: {
        'trakt-api-version': '2',
        'trakt-api-key': clientId,
        'User-Agent': 'ynotv/1.0',
      },
      body: { client_id: clientId },
    });

    if (!response.ok) {
      throw new Error(i18n.t('settings:scrobbling.failedGenerateTraktCode'));
    }

    return await response.json();
  }

  async pollTraktToken(deviceCode: string): Promise<{ success: boolean; error?: string }> {
    const { clientId, clientSecret } = getTraktCredentials();

    logInfo('Polling Trakt access token...');
    const response = await makeRequest(`${TRAKT_API_URL}/oauth/device/token`, {
      method: 'POST',
      headers: {
        'trakt-api-version': '2',
        'trakt-api-key': clientId,
        'User-Agent': 'ynotv/1.0',
      },
      body: {
        code: deviceCode,
        client_id: clientId,
        client_secret: clientSecret,
      },
    });

    if (response.status === 400) {
      // Still pending user approval
      return { success: false };
    }

    if (response.status === 404 || response.status === 410) {
      return { success: false, error: 'Device code expired' };
    }

    if (response.ok) {
      const data = await response.json();
      await this.updateSettings({
        traktEnabled: true,
        traktAccessToken: data.access_token,
        traktRefreshToken: data.refresh_token,
        traktTokenExpiresAt: Date.now() + (data.expires_in * 1000),
        traktScrobbleEnabled: true,
        traktSyncEnabled: false,
        traktCatalogsEnabled: {},
        traktNuvioCatalogsEnabled: {},
      });
      logInfo('Trakt linked successfully.');
      return { success: true };
    }

    return { success: false, error: 'Authorization failed' };
  }

  private refreshingTraktPromise: Promise<boolean> | null = null;

  async refreshTraktToken(force: boolean = false): Promise<boolean> {
    if (this.refreshingTraktPromise) {
      return await this.refreshingTraktPromise;
    }

    this.refreshingTraktPromise = this.doRefreshTraktToken(force).finally(() => {
      this.refreshingTraktPromise = null;
    });

    return await this.refreshingTraktPromise;
  }

  private async doRefreshTraktToken(force: boolean): Promise<boolean> {
    const settings = await this.getSettings();
    const refreshToken = settings.traktRefreshToken;
    const expiresAt = settings.traktTokenExpiresAt;

    if (!refreshToken) return false;

    // Refresh if forced OR if expiring within 48 hours
    if (!force && expiresAt && (expiresAt - Date.now() > 2 * 24 * 60 * 60 * 1000)) {
      return true;
    }

    const { clientId, clientSecret } = getTraktCredentials();

    logInfo('Refreshing Trakt Access Token...');
    try {
      const response = await makeRequest(`${TRAKT_API_URL}/oauth/token`, {
        method: 'POST',
        headers: {
          'trakt-api-version': '2',
          'trakt-api-key': clientId,
          'User-Agent': 'ynotv/1.0',
        },
        body: {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        },
      });

      if (response.ok) {
        const data = await response.json();
        await this.updateSettings({
          traktAccessToken: data.access_token,
          traktRefreshToken: data.refresh_token,
          traktTokenExpiresAt: Date.now() + (data.expires_in * 1000),
        });
        logInfo('Trakt token refreshed successfully.');
        return true;
      } else {
        logWarn('Trakt refresh request failed with status:', response.status);
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          logWarn('Trakt refresh token is invalid or revoked. Logging out Trakt session.');
          await this.logoutTrakt();
        }
        return false;
      }
    } catch (e) {
      logError('Failed to refresh Trakt token:', e);
      return false;
    }
  }

  private async makeTraktAuthorizedRequest(url: string, options: any = {}): Promise<any> {
    const settings = await this.getSettings();
    if (!settings.traktEnabled || !settings.traktAccessToken) return null;

    const { clientId } = getTraktCredentials();
    const headers = {
      'Authorization': `Bearer ${settings.traktAccessToken}`,
      'trakt-api-version': '2',
      'trakt-api-key': clientId,
      'User-Agent': 'ynotv/1.0',
      ...options.headers,
    };

    let response = await makeRequest(url, { ...options, headers });

    // Handle 401 Unauthorized by attempting a forced token refresh and retrying once
    if (response.status === 401) {
      logWarn('Trakt API returned 401 Unauthorized. Attempting automatic token refresh...');
      const refreshed = await this.refreshTraktToken(true);
      if (refreshed) {
        const newSettings = await this.getSettings();
        if (newSettings.traktAccessToken) {
          headers['Authorization'] = `Bearer ${newSettings.traktAccessToken}`;
          logInfo('Retrying Trakt API request with refreshed token...');
          response = await makeRequest(url, { ...options, headers });
        }
      }
    }

    return response;
  }

  async logoutTrakt(): Promise<void> {
    await this.updateSettings({
      traktEnabled: false,
      traktAccessToken: null,
      traktRefreshToken: null,
      traktTokenExpiresAt: null,
      traktScrobbleEnabled: false,
      traktSyncEnabled: false,
      traktCatalogsEnabled: undefined,
      traktCatalogOrder: undefined,
      traktCatalogsBeforeAddon: undefined,
      traktEnabledLists: undefined,
      traktNuvioCatalogsEnabled: undefined,
      traktNuvioCatalogOrder: undefined,
      traktNuvioCatalogsBeforeAddon: undefined,
      traktNuvioEnabledLists: undefined,
    });
    logInfo('Trakt unlinked successfully.');
  }

  // --------------------------------------------------------------------------
  // Simkl Authentication / PIN Flow (device auth, no redirect URI required)
  // --------------------------------------------------------------------------
  async generateSimklPinCode(): Promise<SimklPinResponse> {
    const clientId = buildCredentials.simklClientId || DEFAULT_SIMKL_CLIENT_ID;
    logInfo('Requesting Simkl PIN code...');
    const url = `${SIMKL_API_URL}/oauth/pin?client_id=${encodeURIComponent(clientId)}&app-name=ynotv&app-version=1.0`;
    const response = await makeRequest(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'ynotv/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(i18n.t('settings:simkl.failedRequestPin', { status: response.status }));
    }

    const data = await response.json();
    if (!data.user_code) {
      throw new Error(i18n.t('settings:simkl.missingUserCode'));
    }
    return data as SimklPinResponse;
  }

  async pollSimklPin(userCode: string): Promise<{ success: boolean; accessToken?: string; error?: string }> {
    const clientId = buildCredentials.simklClientId || DEFAULT_SIMKL_CLIENT_ID;
    try {
      const url = `${SIMKL_API_URL}/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(clientId)}&app-name=ynotv&app-version=1.0`;
      const response = await makeRequest(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'ynotv/1.0',
        },
      });

      if (!response.ok) {
        return { success: false, error: i18n.t('settings:simkl.pollFailed', { status: response.status }) };
      }

      const data = await response.json();

      // A response containing device_code means the original code is gone
      // (already authorized, expired, or garbage-collected) — stop polling.
      if (data.device_code) {
        return { success: false, error: 'The code has expired. Please try again.' };
      }

      if (data.result === 'OK' && data.access_token) {
        await this.updateSettings({
          simklEnabled: true,
          simklAccessToken: data.access_token,
          simklScrobbleEnabled: true,
        });
        logInfo('Simkl linked successfully via PIN flow.');
        return { success: true, accessToken: data.access_token };
      }

      // result === 'KO' → user has not authorized yet; keep polling.
      return { success: false };
    } catch (e) {
      logError('Simkl PIN poll error:', e);
      return { success: false, error: 'Simkl PIN poll request failed' };
    }
  }

  async logoutSimkl(): Promise<void> {
    await this.updateSettings({
      simklEnabled: false,
      simklAccessToken: null,
      simklScrobbleEnabled: false,
    });
    logInfo('Simkl unlinked successfully.');
  }

  // --------------------------------------------------------------------------
  // Unified Real-Time Scrobbling APIs (Trakt & Simkl)
  // --------------------------------------------------------------------------
  async startScrobble(media: PlaybackMediaInfo): Promise<void> {
    this.scrobbleSessionId += 1;
    this.lastActiveMedia = media;
    this.isScrobblingActive = true;
    logInfo('Start scrobbling media:', media.title, media.type === 'series' ? `S${media.season}E${media.episode}` : '', `(${Math.round(media.progressPercent)}%)`);

    await Promise.allSettled([
      this.sendTraktScrobble('start', media),
      this.sendSimklScrobble('start', media),
    ]);
  }

  async updateScrobble(progressPercent: number): Promise<void> {
    if (!this.isScrobblingActive || !this.lastActiveMedia) return;
    
    this.lastActiveMedia.progressPercent = progressPercent;
    logInfo('Updating scrobble progress:', this.lastActiveMedia.title, `(${Math.round(progressPercent)}%)`);

    // Simkl is excluded here: it expects scrobble events only on real play/pause/stop
    // actions and extrapolates progress server-side. Periodic re-posting is discouraged.
    await this.sendTraktScrobble('start', this.lastActiveMedia);
  }

  async pauseScrobble(): Promise<void> {
    if (!this.isScrobblingActive || !this.lastActiveMedia) return;
    logInfo('Pausing scrobble:', this.lastActiveMedia.title);

    await Promise.allSettled([
      this.sendTraktScrobble('pause', this.lastActiveMedia),
      this.sendSimklScrobble('pause', this.lastActiveMedia),
    ]);
  }

  async stopScrobble(progressPercent: number): Promise<void> {
    if (!this.isScrobblingActive || !this.lastActiveMedia) return;
    
    const stoppedMedia = this.lastActiveMedia;
    const sessionId = this.scrobbleSessionId;
    stoppedMedia.progressPercent = progressPercent;
    this.isScrobblingActive = false;
    
    logInfo('Stopping scrobble:', stoppedMedia.title, `(${Math.round(progressPercent)}%)`);

    if (progressPercent >= 90) {
      logInfo('Media completed (>=90%)! Marking as fully watched.');
    }

    await Promise.allSettled([
      this.sendTraktScrobble('stop', stoppedMedia),
      this.sendSimklScrobble('stop', stoppedMedia),
    ]);

    // Don't clear the active media if a new playback session started while the
    // stop request was in flight (e.g. autoplay advancing to the next episode).
    if (this.scrobbleSessionId === sessionId && this.lastActiveMedia === stoppedMedia) {
      this.lastActiveMedia = null;
    }
  }

  // --------------------------------------------------------------------------
  // Trakt Internal Scrobbler Request
  // --------------------------------------------------------------------------
  private async sendTraktScrobble(action: 'start' | 'pause' | 'stop', media: PlaybackMediaInfo): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.traktEnabled || !settings.traktScrobbleEnabled || !settings.traktAccessToken) return;

    try {
      const payload: any = {
        progress: Math.min(100, Math.max(0, media.progressPercent)),
      };

      const imdbClean = media.imdbId && media.imdbId.startsWith('tt') ? media.imdbId : undefined;
      const tmdbClean = media.tmdbId && Number.isFinite(media.tmdbId) && media.tmdbId > 0 ? media.tmdbId : undefined;
      const ids = imdbClean || tmdbClean ? { imdb: imdbClean, tmdb: tmdbClean } : undefined;

      if (media.type === 'movie') {
        payload.movie = {
          title: media.title,
          year: media.year ? parseInt(media.year) : undefined,
          ids,
        };
      } else {
        payload.show = {
          title: media.title,
          ids,
        };
        payload.episode = {
          season: media.season ?? 1,
          number: media.episode ?? 1,
        };
      }

      const url = `${TRAKT_API_URL}/scrobble/${action}`;
      logInfo(`Sending Trakt Scrobble (${action}) request...`);
      const response = await this.makeTraktAuthorizedRequest(url, {
        method: 'POST',
        body: payload,
      });

      if (!response) return;

      const responseText = await response.text().catch(() => '');
      let responseBody: any = null;
      if (responseText) {
        try {
          responseBody = JSON.parse(responseText);
        } catch {
          responseBody = responseText;
        }
      }

      if (!response.ok) {
        logWarn('Trakt scrobble failed with status:', response.status, responseBody);
      } else {
        logInfo(`Trakt Scrobble (${action}) accepted:`, responseBody);
        if (action === 'stop') {
          await this.logTraktPlaybackProgress(media);
        }
      }
    } catch (e) {
      logError('Trakt scrobble connection error:', e);
    }
  }

  // --------------------------------------------------------------------------
  // Simkl Internal Scrobbler Request
  // --------------------------------------------------------------------------
  private async sendSimklScrobble(action: 'start' | 'pause' | 'stop', media: PlaybackMediaInfo): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.simklEnabled || !settings.simklScrobbleEnabled || !settings.simklAccessToken) return;

    const clientId = buildCredentials.simklClientId || DEFAULT_SIMKL_CLIENT_ID;
    const imdbClean = media.imdbId && media.imdbId.startsWith('tt') ? media.imdbId : undefined;
    const tmdbClean = media.tmdbId && Number.isFinite(media.tmdbId) && media.tmdbId > 0 ? media.tmdbId : undefined;

    // Metadata guard: Ensure at least a valid IMDb/TMDb ID or valid title metadata exists
    if (!imdbClean && !tmdbClean && (!media.title || media.title === 'Unknown Video')) {
      logWarn('[Simkl] Skipping scrobble: missing valid IMDb/TMDb ID or title metadata.');
      return;
    }

    // Simkl accepts progress with up to 2 decimal places
    const progress = Math.round(Math.min(100, Math.max(0, media.progressPercent)) * 100) / 100;

    const ids = imdbClean || tmdbClean ? { imdb: imdbClean, tmdb: tmdbClean } : undefined;

    let payload: any = {};
    if (media.type === 'movie') {
      payload = {
        progress,
        movie: {
          title: media.title,
          year: media.year ? parseInt(String(media.year), 10) : undefined,
          ids,
        },
      };
    } else {
      payload = {
        progress,
        show: {
          title: media.title,
          year: media.year ? parseInt(String(media.year), 10) : undefined,
          ids,
        },
        episode: {
          season: media.season ?? 1,
          number: media.episode ?? 1,
        },
      };
    }

    const headers = {
      'Authorization': `Bearer ${settings.simklAccessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ynotv/1.0',
    };

    const url = `${SIMKL_API_URL}/scrobble/${action}?client_id=${encodeURIComponent(clientId)}&app-name=ynotv&app-version=1.0`;
    logInfo(`Sending Simkl Scrobble (${action}) request...`, media.title);

    let response: any = null;
    let responseText = '';
    let attempts = 0;
    while (attempts < 3) {
      try {
        const res = await makeRequest(url, {
          method: 'POST',
          headers,
          body: payload,
        });

        if (res.status === 401) {
          logWarn('[Simkl] 401 Unauthorized during scrobble. Invalidating access token.');
          await this.updateSettings({
            simklEnabled: false,
            simklAccessToken: null,
          });
          return;
        }

        responseText = await res.text().catch(() => '');

        // Simkl throttles scrobbles with a 20s per-user lock that returns HTTP 400
        // with a RATE_LIMIT error (not 429). Handle both forms.
        const isRateLimited = res.status === 429
          || (res.status === 400 && responseText.toUpperCase().includes('RATE_LIMIT'));

        if (isRateLimited) {
          attempts++;
          const backoffMs = Math.pow(2, attempts) * 1000;
          logWarn(`[Simkl] Scrobble rate limited (${res.status}). Retrying in ${backoffMs}ms...`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        response = res;
        break;
      } catch (e) {
        logError('Simkl scrobble request error:', e);
        return;
      }
    }

    if (!response) return;

    let responseBody: any = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }

    if (!response.ok) {
      logWarn('[Simkl] Scrobble failed with status:', response.status, responseBody);
    } else {
      logInfo(`[Simkl] Scrobble (${action}) accepted:`, responseBody);
    }
  }

  private async logTraktPlaybackProgress(media: PlaybackMediaInfo): Promise<void> {
    try {
      const response = await this.makeTraktAuthorizedRequest(`${TRAKT_API_URL}/sync/playback`, {
        method: 'GET',
      });

      if (!response || !response.ok) {
        logWarn('Trakt playback verification failed with status:', response?.status);
        return;
      }

      const items = await response.json();
      if (!Array.isArray(items)) return;

      const matching = items.find((item: any) => {
        if (media.type === 'movie') {
          if (item.type !== 'movie') return false;
          const itemImdb = item.movie?.ids?.imdb;
          const itemTmdb = item.movie?.ids?.tmdb;
          if (media.imdbId && itemImdb && itemImdb === media.imdbId) return true;
          if (media.tmdbId && itemTmdb != null && Number(itemTmdb) === media.tmdbId) return true;
          if (!media.imdbId && !media.tmdbId) return item.movie?.title === media.title;
          return false;
        }
        if (item.type !== 'episode') return false;
        if (item.episode?.season !== media.season || item.episode?.number !== media.episode) return false;
        const itemImdb = item.show?.ids?.imdb;
        const itemTmdb = item.show?.ids?.tmdb;
        if (media.imdbId && itemImdb && itemImdb === media.imdbId) return true;
        if (media.tmdbId && itemTmdb != null && Number(itemTmdb) === media.tmdbId) return true;
        if (!media.imdbId && !media.tmdbId) return item.show?.title === media.title;
        return false;
      });

      if (matching) {
        logInfo('Trakt playback progress verified:', {
          progress: matching.progress,
          pausedAt: matching.paused_at,
          type: matching.type,
          title: matching.movie?.title || matching.show?.title,
          season: matching.episode?.season,
          episode: matching.episode?.number,
        });
      } else {
        logWarn('Trakt playback progress was not found after stop for:', {
          imdbId: media.imdbId,
          type: media.type,
          season: media.season,
          episode: media.episode,
        });
      }
    } catch (e) {
      logWarn('Trakt playback verification error:', e);
    }
  }

  // --------------------------------------------------------------------------
  // Progress Sync Engine (Trakt continue watches)
  // --------------------------------------------------------------------------
  async syncPlaybackProgress(): Promise<void> {
    logInfo('Running watch progress sync...');
    const settings = await this.getSettings();

    if (settings.traktEnabled && settings.traktSyncEnabled && settings.traktAccessToken) {
      await this.syncTraktPlaybackProgress();
    }
  }

  private async syncTraktPlaybackProgress(): Promise<void> {
    try {
      logInfo('Syncing active continue-watching sessions from Trakt...');
      const response = await this.makeTraktAuthorizedRequest(`${TRAKT_API_URL}/sync/playback`, {
        method: 'GET',
      });

      if (response && response.ok) {
        const items = await response.json();
        if (Array.isArray(items)) {
          for (const item of items) {
            const fraction = item.progress ? item.progress / 100 : 0;
            if (fraction <= 0.02 || fraction >= 0.95) continue;

            const imdbId = item.movie?.ids?.imdb || item.show?.ids?.imdb;
            if (!imdbId) continue;

            if (item.type === 'movie' && item.movie) {
              const title = item.movie.title;
              
              // Sync to local sqlite DB
              await updateVodWatchProgress(imdbId, 'movie', Math.floor(fraction * 7200), 7200).catch(() => {});
              
              logInfo(`Synced Trakt Movie resume progress: ${title} (${Math.round(item.progress)}%)`);
            } else if (item.type === 'episode' && item.show && item.episode) {
              const showTitle = item.show.title;
              const season = item.episode.season;
              const epNum = item.episode.number;
              const videoId = `imdbId:${imdbId}:${season}:${epNum}`; // standard stremio video ID string format
              
              // Sync to local sqlite DB
              await updateVodWatchProgress(imdbId, 'series', Math.floor(fraction * 2700), 2700).catch(() => {});
              await recordEpisodeWatch(videoId, imdbId, 'stremio', season, epNum, `Episode ${epNum}`, Math.floor(fraction * 2700), 2700).catch(() => {});

              logInfo(`Synced Trakt Series resume progress: ${showTitle} S${season}E${epNum} (${Math.round(item.progress)}%)`);
            }
          }
        }
      }
    } catch (e) {
      logWarn('Trakt playback progress sync error:', e);
    }
  }

  // --------------------------------------------------------------------------
  // Catalog Fetching (Transforms Trakt APIs into Stremio-friendly items)
  // --------------------------------------------------------------------------
  async fetchTraktCatalog(type: TraktCatalogType, page: number = 1): Promise<{ items: StremioMetaPreview[]; hasMore: boolean }> {
    if (type !== 'playback') {
      const cacheKey = `${type}:${page}`;
      const cached = this.catalogCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < TRAKT_CACHE_STALE_MS) {
        return cached.data;
      }
    }
    const settings = await this.getSettings();
    if (!settings.traktEnabled || !settings.traktAccessToken) return { items: [], hasMore: false };

    try {
      const baseUrl = TRAKT_CATALOG_URLS[type];
      if (!baseUrl) return { items: [], hasMore: false };
      const url = `${baseUrl}&page=${page}`;

      logInfo(`Fetching Trakt ${type} catalog page ${page}...`);
      const response = await this.makeTraktAuthorizedRequest(url, { method: 'GET' });

      if (response && response.ok) {
        let rawItems = await response.json();
        if (Array.isArray(rawItems)) {
          // For history, deduplicate shows keeping only the latest watched episode
          if (type === 'history') {
            const seen = new Map<string, { item: any; epoch: number }>();
            for (const item of rawItems) {
              const media = item.movie || item.show || item;
              const imdbId = media?.ids?.imdb;
              if (!imdbId) continue;
              if (item.type === 'episode' || item.show) {
                const epoch = new Date(item.watched_at || 0).getTime();
                const existing = seen.get(imdbId);
                if (!existing || epoch > existing.epoch) {
                  seen.set(imdbId, { item, epoch });
                }
              } else {
                if (!seen.has(imdbId)) {
                  seen.set(imdbId, { item, epoch: 0 });
                }
              }
            }
            rawItems = Array.from(seen.values()).map(e => e.item);
          }

          const isWrapped = WRAPPED_CATALOGS.has(type);
          const items = rawItems.map((item: any) => {
            let media: any;
            let itemType: 'movie' | 'series';

            if (isWrapped) {
              media = item.movie || item.show || item;
              if (item.type === 'movie') itemType = 'movie';
              else if (item.type === 'show' || item.type === 'episode') itemType = 'series';
              else if (item.movie) itemType = 'movie';
              else if (item.show) itemType = 'series';
              else itemType = type.includes('movie') ? 'movie' : 'series';
            } else {
              media = item;
              if (item.type === 'movie') itemType = 'movie';
              else if (item.type === 'show' || item.type === 'series') itemType = 'series';
              else itemType = type.includes('movie') ? 'movie' : 'series';
            }

            const imdbId = media?.ids?.imdb;
            if (!imdbId) return null;

            let name = media.title;
            let releaseInfo: string | undefined;

            // Tag history items with the latest season/episode
            if (type === 'history' && !item.movie && item.episode) {
              const ep = item.episode;
              name = `${media.title} \u2014 S${ep.season}:E${ep.number}`;
              releaseInfo = `S${ep.season}:E${ep.number}`;
            }

            // Tag playback items with season/episode and progress
            if (type === 'playback' && !item.movie && item.episode) {
              const ep = item.episode;
              name = `${media.title} \u2014 S${ep.season}:E${ep.number}`;
              releaseInfo = `S${ep.season}:E${ep.number}`;
            }

            const result: Record<string, any> = {
              id: imdbId,
              type: itemType,
              name,
              poster: `https://images.metahub.space/poster/medium/${imdbId}/img`,
              imdbRating: media.rating ? String(typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating) : undefined,
              year: media.year,
              releaseInfo,
            };

            // Carry progress for resume-playback support
            if (type === 'playback' && typeof item.progress === 'number') {
              result.progress = item.progress;
            }

            // Carry season/episode for deep-link navigation
            if (type === 'history' && !item.movie && item.episode) {
              result.traktSeason = item.episode.season;
              result.traktEpisode = item.episode.number;
            }

            // Carry season/episode for playback deep-links
            if (type === 'playback' && !item.movie && item.episode) {
              result.traktSeason = item.episode.season;
              result.traktEpisode = item.episode.number;
            }

            return result;
          }).filter(Boolean) as StremioMetaPreview[];

          const hasMore = items.length >= TRAKT_PAGE_LIMIT;
          const result = { items, hasMore };
          if (type !== 'playback') {
            this.catalogCache.set(`${type}:${page}`, { data: result, timestamp: Date.now() });
          }
          return result;
        }
      }
    } catch (e) {
      logError(`Failed to fetch Trakt catalog ${type}:`, e);
    }
    return { items: [], hasMore: false };
  }

  // --------------------------------------------------------------------------
  // Trakt Custom Lists
  // --------------------------------------------------------------------------
  async fetchTraktLists(): Promise<{ id: { trakt: number; slug: string }; name: string }[]> {
    const settings = await this.getSettings();
    if (!settings.traktEnabled || !settings.traktAccessToken) return [];

    try {
      const url = `${TRAKT_API_URL}/users/me/lists`;
      logInfo('Fetching Trakt user lists...');
      const response = await this.makeTraktAuthorizedRequest(url, { method: 'GET' });

      if (response && response.ok) {
        const lists = await response.json();
        if (Array.isArray(lists)) {
          return lists.map((list: any) => ({
            id: { trakt: list.ids?.trakt, slug: list.ids?.slug },
            name: list.name,
          }));
        }
      }
    } catch (e) {
      logError('Failed to fetch Trakt lists:', e);
    }
    return [];
  }

  async fetchTraktListCatalog(listId: string, page: number = 1): Promise<{ items: StremioMetaPreview[]; hasMore: boolean }> {
    const cacheKey = `${listId}:${page}`;
    const cached = this.listCatalogCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < TRAKT_CACHE_STALE_MS) {
      return cached.data;
    }
    const settings = await this.getSettings();
    if (!settings.traktEnabled || !settings.traktAccessToken) return { items: [], hasMore: false };

    try {
      const url = `${TRAKT_API_URL}/users/me/lists/${listId}/items?limit=${TRAKT_PAGE_LIMIT}&page=${page}`;
      logInfo(`Fetching Trakt list catalog ${listId} page ${page}...`);
      const response = await this.makeTraktAuthorizedRequest(url, { method: 'GET' });

      if (response && response.ok) {
        const rawItems = await response.json();
        if (Array.isArray(rawItems)) {
          const items = rawItems.map((item: any) => {
            const media = item.movie || item.show || item;
            let itemType: 'movie' | 'series' = 'series';
            if (item.type === 'movie' || item.movie) {
              itemType = 'movie';
            } else if (item.type === 'show' || item.type === 'series' || item.type === 'episode' || item.show) {
              itemType = 'series';
            } else {
              itemType = item.type === 'movie' ? 'movie' : 'series';
            }
            const imdbId = media?.ids?.imdb;
            if (!imdbId) return null;

            return {
              id: imdbId,
              type: itemType,
              name: media.title,
              poster: `https://images.metahub.space/poster/medium/${imdbId}/img`,
              imdbRating: media.rating ? String(typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating) : undefined,
              year: media.year,
            };
          }).filter(Boolean) as StremioMetaPreview[];

          const hasMore = items.length >= TRAKT_PAGE_LIMIT;
          const result = { items, hasMore };
          this.listCatalogCache.set(`${listId}:${page}`, { data: result, timestamp: Date.now() });
          return result;
        }
      }
    } catch (e) {
      logError(`Failed to fetch Trakt list catalog ${listId}:`, e);
    }
    return { items: [], hasMore: false };
  }
}

export const scrobbler = new ScrobblerService();
