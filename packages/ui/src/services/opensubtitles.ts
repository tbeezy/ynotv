/**
 * OpenSubtitles REST API v1 client for searching and downloading subtitles.
 * @see https://opensubtitles.stoplight.io/docs/opensubtitles-api/e3750fd63a100-getting-started
 *
 * Auth: Api-Key header + Authorization: Bearer <jwt_token>
 * Base: https://api.opensubtitles.com/api/v1
 */

const API_BASE = 'https://api.opensubtitles.com/api/v1';

/* ─── debug logging ─── */
function log(stage: string, ...args: any[]) {
  console.log(`[OpenSubtitles][${stage}]`, ...args);
}

/* ─── types ─── */
export interface OpenSubtitlesUser {
  username: string;
  user_id?: number;
  vip?: boolean;
  allowed_downloads?: number;
  level?: string;
  downloads_count?: number;
  remaining_downloads?: number;
}

export interface OpenSubtitlesSubtitle {
  id: string;
  fileId: number;
  subtitleId: string;
  language: string;
  release: string;
  fileName: string;
  downloads: number;
  rating: number;
  hearingImpaired: boolean;
  hd?: boolean;
  fps?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  movieName?: string;
  title?: string;
}

export interface OpenSubtitlesSearchResult {
  success: boolean;
  subtitles?: OpenSubtitlesSubtitle[];
  totalCount?: number;
  totalPages?: number;
  error?: string;
}

export interface OpenSubtitlesLoginResult {
  success: boolean;
  token?: string;
  user?: OpenSubtitlesUser;
  error?: string;
}

export interface OpenSubtitlesDownloadResult {
  success: boolean;
  content?: string;
  fileName?: string;
  remainingDownloads?: number;
  error?: string;
}

/** Get the configured app API consumer key from environment. */
export function getOpenSubtitlesApiKey(override?: string): string {
  if (override && override.trim()) return override.trim();
  return import.meta.env.VITE_OPENSUBTITLES_API_KEY?.trim() || '';
}

/* ─── low-level fetch ─── */
interface ApiFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<any>;
  text: string;
}

async function apiFetch(
  path: string,
  options: {
    method?: string;
    token?: string;
    apiKey?: string;
    params?: Record<string, string | number | undefined>;
    body?: any;
  } = {}
): Promise<ApiFetchResponse> {
  const apiKey = getOpenSubtitlesApiKey(options.apiKey);
  if (!apiKey) {
    throw new Error('OpenSubtitles API Consumer Key is missing. Build with VITE_OPENSUBTITLES_API_KEY.');
  }

  const url = new URL(`${API_BASE}${path}`);
  if (options.params) {
    Object.entries(options.params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    });
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Api-Key': apiKey,
    'User-Agent': 'YnoTV v1.0.0',
  };

  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  const method = options.method || (options.body ? 'POST' : 'GET');

  log('FETCH', `${method} ${url.toString()}`);

  const fetchOptions: any = {
    method,
    headers,
  };
  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  if (window.fetchProxy) {
    log('FETCH', 'using fetchProxy');
    const proxyResult = await window.fetchProxy.fetch(url.toString(), fetchOptions);
    if (proxyResult.error) {
      throw new Error(translateNativeError(proxyResult.error) || proxyResult.error);
    }
    if (!proxyResult.data) {
      throw new Error(i18n.t('subtitles:noResponseData'));
    }
    log('FETCH', `status=${proxyResult.data.status} ok=${proxyResult.data.ok}`);
    return {
      ok: proxyResult.data.ok,
      status: proxyResult.data.status,
      statusText: proxyResult.data.statusText,
      text: proxyResult.data.text,
      json: () => proxyResult.data!.json(),
    };
  } else {
    log('FETCH', 'using native fetch');
    const response = await fetch(url.toString(), fetchOptions);
    const text = await response.text();
    log('FETCH', `status=${response.status} ok=${response.ok} body=${text.slice(0, 200)}`);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      text,
      json: () => Promise.resolve(JSON.parse(text)),
    };
  }
}

/* ─── subtitle decoding ─── */
import { decodeSubtitleBytes } from '../utils/subtitleEncoding';
import i18n, { translateNativeError } from '../i18n';
import { useSettingsStore } from '../stores/settingsStore';

/**
 * Shared auto-retry wrapper used by search/download. Handles 401/403 by
 * triggering a background re-login and retrying once with the fresh token, then
 * retries once after 500ms on 5xx server errors.
 */
async function apiFetchWithRetry(
  initialToken: string,
  logStage: string,
  doFetch: (token: string) => Promise<ApiFetchResponse>,
  customApiKey?: string
): Promise<{ res: ApiFetchResponse }> {
  let activeToken = initialToken;
  let res = await doFetch(activeToken);

  // Auto-retry once on 401/403 (unauthorized/expired token) via background re-login
  if (res.status === 401 || res.status === 403) {
    log(logStage, `HTTP ${res.status} returned. Triggering background re-login...`);
    const ss = useSettingsStore.getState().subtitleSettings;
    const refreshed = await ensureValidOpenSubtitlesToken(ss, true);
    if (refreshed.token) {
      activeToken = refreshed.token;
      log(logStage, 'Retrying with fresh token...');
      res = await doFetch(activeToken);
    } else {
      log(logStage, 'Auto re-login failed. Aborting; user must re-login.');
      throw new Error(i18n.t('subtitles:sessionExpired'));
    }
  }

  // Auto-retry once on 5xx server error after 500ms delay
  if (res.status >= 500) {
    log(logStage, `Server error HTTP ${res.status}. Retrying in 500ms...`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    res = await doFetch(activeToken);
  }

  return { res };
}

/* ─── Login ─── */
export async function loginOpenSubtitles(
  username: string,
  password: string,
  customApiKey?: string
): Promise<OpenSubtitlesLoginResult> {
  if (!username.trim() || !password) {
    return { success: false, error: 'Username and password are required' };
  }

  try {
    log('LOGIN', `Attempting login for user: ${username}`);
    const res = await apiFetch('/login', {
      method: 'POST',
      apiKey: customApiKey,
      body: { username: username.trim(), password },
    });

    const data = await res.json();
    log('LOGIN', 'Response data:', { status: res.status, ok: res.ok, data });

    if (!res.ok || !data.token) {
      const errorMsg = data.message || data.error || `Login failed (HTTP ${res.status})`;
      return { success: false, error: errorMsg };
    }

    return {
      success: true,
      token: data.token,
      user: {
        username: username.trim(),
        user_id: data.user?.user_id,
        vip: data.user?.vip,
        allowed_downloads: data.user?.allowed_downloads,
        level: data.user?.level,
      },
    };
  } catch (e: any) {
    log('LOGIN', 'Error:', e?.message);
    return { success: false, error: translateNativeError(e?.message) || i18n.t('subtitles:loginRequestFailed') };
  }
}

/* ─── Logout ─── */
export async function logoutOpenSubtitles(
  token: string,
  customApiKey?: string
): Promise<{ success: boolean; error?: string }> {
  if (!token) return { success: true };

  try {
    log('LOGOUT', 'Logging out token');
    const res = await apiFetch('/logout', {
      method: 'DELETE',
      token,
      apiKey: customApiKey,
    });
    return { success: res.ok };
  } catch (e: any) {
    log('LOGOUT', 'Error:', e?.message);
    return { success: false, error: e?.message };
  }
}

/* ─── Get User Info ─── */
export async function getUserInfo(
  token: string,
  customApiKey?: string
): Promise<{ success: boolean; user?: OpenSubtitlesUser; error?: string }> {
  if (!token) return { success: false, error: 'No authentication token provided' };

  try {
    log('USER_INFO', 'Fetching user info');
    const res = await apiFetch('/infos/user', {
      token,
      apiKey: customApiKey,
    });
    const data = await res.json();
    if (!res.ok || !data.data) {
      return { success: false, error: data.message || 'Failed to fetch user info' };
    }
    const u = data.data;
    return {
      success: true,
      user: {
        username: u.username || '',
        user_id: u.user_id,
        vip: u.vip,
        allowed_downloads: u.allowed_downloads,
        level: u.level,
        downloads_count: u.downloads_count,
        remaining_downloads: u.remaining_downloads,
      },
    };
  } catch (e: any) {
    log('USER_INFO', 'Error:', e?.message);
    return { success: false, error: e?.message };
  }
}

/**
 * Returns the cached JWT token for OpenSubtitles.
 * Does NOT call /login or /infos/user or OS keyring when forceRefresh is false.
 * Re-authenticates using the OS keyring (Windows Credential Manager) ONLY when forceRefresh is true (e.g. on 401).
 */
export async function ensureValidOpenSubtitlesToken(
  subtitleSettings?: any,
  forceRefresh = false
): Promise<{
  token: string;
  user: OpenSubtitlesUser | null;
}> {
  if (!subtitleSettings) {
    return { token: '', user: null };
  }

  const existingToken = subtitleSettings.openSubtitlesToken || '';

  // 1. If forceRefresh is false, return cached token/user immediately without any network calls or keyring lookups
  if (!forceRefresh) {
    return { token: existingToken, user: subtitleSettings.openSubtitlesUser || null };
  }

  // 2. Only if forceRefresh is true (e.g. on 401 Unauthorized response), fetch credentials from OS keyring and log in
  try {
    log('ENSURE_TOKEN', 'Force refresh requested (401 error). Fetching credentials from OS vault...');
    const { invoke } = await import('@tauri-apps/api/core');
    const creds = await invoke<[string, string] | null>('get_opensubtitles_credentials');

    if (creds && creds[0] && creds[1]) {
      const [credUser, credPass] = creds;
      log('ENSURE_TOKEN', `Re-authenticating via /login for user: ${credUser}`);
      const loginRes = await loginOpenSubtitles(credUser, credPass);
      if (loginRes.success && loginRes.token && loginRes.user) {
        log('ENSURE_TOKEN', 'Re-authentication successful! Updating cached token.');
        useSettingsStore.getState().setSubtitleSettings({
          openSubtitlesToken: loginRes.token,
          openSubtitlesUser: loginRes.user,
          openSubtitlesUsername: credUser,
        });
        return { token: loginRes.token, user: loginRes.user };
      }
    }
  } catch (err) {
    log('ENSURE_TOKEN', 'Failed to retrieve credentials from OS vault:', err);
  }

  // No credentials stored, or re-login failed. Do NOT silently return the stale token
  // we already know is unauthorized (401/403) — signal failure so callers don't retry
  // the same bad token and cause an infinite 401 loop.
  log('ENSURE_TOKEN', 'Re-authentication failed. No fresh token available.');
  return { token: '', user: subtitleSettings.openSubtitlesUser || null };
}

/* ─── Search Subtitles ─── */
export interface OpenSubtitlesSearchParams {
  query?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  type?: 'movie' | 'episode' | 'all';
  languages?: string; // 2-letter ISO codes (e.g. "en" or "en,es")
  tmdbId?: number;
  imdbId?: number | string;
  year?: number;
}

export async function searchOpenSubtitles(
  token: string,
  params: OpenSubtitlesSearchParams,
  customApiKey?: string
): Promise<OpenSubtitlesSearchResult> {
  if (!token) {
    return { success: false, error: 'Login required to search OpenSubtitles' };
  }
  if (!params.query?.trim() && !params.imdbId && !params.tmdbId) {
    return { success: false, error: 'Search query or ID is required' };
  }

  try {
    const queryParams: Record<string, string | number | undefined> = {};

    if (params.query && params.query.trim()) {
      queryParams.query = params.query.trim();
    }

    if (params.languages) queryParams.languages = params.languages;
    if (params.type) queryParams.type = params.type;
    if (params.seasonNumber && params.seasonNumber > 0) queryParams.season_number = params.seasonNumber;
    if (params.episodeNumber && params.episodeNumber > 0) queryParams.episode_number = params.episodeNumber;

    // ID searches are mutually exclusive per the OS API. Prefer TMDb ID, fall back to IMDb ID.
    // For TV episodes our IDs are show-level, so use the parent_* params (docs: "Use imdb_id for movie
    // or episode. Use parent_imdb_id for TV Shows").
    const isEpisode = params.type === 'episode';
    const useTmdb = !!(params.tmdbId && params.tmdbId > 0);
    const useImdb = !useTmdb && !!params.imdbId;
    if (useTmdb) {
      queryParams[isEpisode ? 'parent_tmdb_id' : 'tmdb_id'] = params.tmdbId as number;
    } else if (useImdb) {
      // Strip 'tt' prefix and any leading zeroes (per OS API guidelines).
      const imdb = String(params.imdbId).replace(/^tt/, '').replace(/^0+/, '');
      queryParams[isEpisode ? 'parent_imdb_id' : 'imdb_id'] = imdb;
    }
    if (params.year && params.year > 0) queryParams.year = params.year;

    log('SEARCH', 'Query params:', queryParams);

    const { res } = await apiFetchWithRetry(
      token,
      'SEARCH',
      (activeToken) =>
        apiFetch('/subtitles', {
          token: activeToken,
          apiKey: customApiKey,
          params: queryParams,
        }),
      customApiKey
    );

    const body = await res.json();
    if (!res.ok || !body.data) {
      return { success: false, error: body.message || `Search failed (HTTP ${res.status})` };
    }

    const rawList: any[] = body.data || [];
    const subtitles: OpenSubtitlesSubtitle[] = rawList
      .map((item): OpenSubtitlesSubtitle | null => {
        const attr = item.attributes || {};
        const files = attr.files || [];
        const primaryFile = files[0] || {};

        if (!primaryFile.file_id) return null;

        const release = attr.release || primaryFile.file_name || attr.url || 'Subtitle';
        const feat = attr.feature_details || {};

        const sub: OpenSubtitlesSubtitle = {
          id: String(item.id),
          fileId: Number(primaryFile.file_id),
          subtitleId: String(attr.subtitle_id || item.id),
          language: String(attr.language || 'en'),
          release: String(release),
          fileName: String(primaryFile.file_name || `${release}.srt`),
          downloads: Number(attr.download_count || 0),
          rating: Number(attr.ratings || 0),
          hearingImpaired: Boolean(attr.hearing_impaired),
          hd: attr.hd !== undefined ? Boolean(attr.hd) : undefined,
          fps: attr.fps !== undefined ? Number(attr.fps) : undefined,
          seasonNumber: feat.season_number !== undefined ? Number(feat.season_number) : undefined,
          episodeNumber: feat.episode_number !== undefined ? Number(feat.episode_number) : undefined,
          movieName: feat.movie_name || feat.title ? String(feat.movie_name || feat.title) : undefined,
          title: feat.title ? String(feat.title) : undefined,
        };
        return sub;
      })
      .filter((s): s is OpenSubtitlesSubtitle => s !== null);

    return {
      success: true,
      subtitles,
      totalCount: body.total_count || subtitles.length,
      totalPages: body.total_pages || 1,
    };
  } catch (e: any) {
    log('SEARCH', 'Error:', e?.message);
    return { success: false, error: translateNativeError(e?.message) || i18n.t('subtitles:openSubtitlesSearchFailed') };
  }
}

/* ─── Download Subtitle ─── */
export async function downloadOpenSubtitlesSubtitle(
  token: string,
  fileId: number,
  customApiKey?: string
): Promise<OpenSubtitlesDownloadResult> {
  if (!token) {
    return { success: false, error: 'Login required to download subtitles' };
  }
  if (!fileId) {
    return { success: false, error: 'Invalid subtitle file ID' };
  }

  try {
    log('DOWNLOAD', `Requesting download link for fileId: ${fileId}`);
    const { res } = await apiFetchWithRetry(
      token,
      'DOWNLOAD',
      (activeToken) =>
        apiFetch('/download', {
          method: 'POST',
          token: activeToken,
          apiKey: customApiKey,
          body: { file_id: fileId },
        }),
      customApiKey
    );

    const body = await res.json();
    if (!res.ok || !body.link) {
      return { success: false, error: body.message || `Download request failed (HTTP ${res.status})` };
    }

    const downloadLink = body.link;
    const fileName = body.file_name || `subtitle_${fileId}.srt`;
    const remaining = body.remaining;

    log('DOWNLOAD', `Fetching subtitle content from: ${downloadLink}`);

    let content = '';
    if (window.fetchProxy && typeof (window.fetchProxy as any).fetchBinary === 'function') {
      // Fetch raw bytes so we can charset-detect (OpenSubtitles files aren't always UTF-8)
      const binRes = await (window.fetchProxy as any).fetchBinary(downloadLink);
      if (binRes.error || !binRes.data) {
        throw new Error(binRes.error || i18n.t('subtitles:downloadFailed'));
      }
      content = decodeSubtitleBytes(binRes.data as Uint8Array);
    } else if (window.fetchProxy) {
      const proxyRes = await window.fetchProxy.fetch(downloadLink);
      if (proxyRes.error || !proxyRes.data) {
        throw new Error(proxyRes.error || i18n.t('subtitles:downloadFailed'));
      }
      content = decodeSubtitleBytes(new TextEncoder().encode(proxyRes.data.text));
    } else {
      const fetchRes = await fetch(downloadLink);
      if (!fetchRes.ok) {
        throw new Error(i18n.t('subtitles:downloadFailed') + ` (HTTP ${fetchRes.status})`);
      }
      content = decodeSubtitleBytes(new Uint8Array(await fetchRes.arrayBuffer()));
    }

    if (!content || !content.trim()) {
      return { success: false, error: 'Downloaded subtitle file was empty' };
    }

    return {
      success: true,
      content,
      fileName,
      remainingDownloads: remaining,
    };
  } catch (e: any) {
    log('DOWNLOAD', 'Error:', e?.message);
    return { success: false, error: e?.message || i18n.t('subtitles:downloadFailed') };
  }
}
