import i18n, { translateNativeError } from '../i18n';

export const NUVIO_SUPABASE_URL = 'https://api.nuvio.tv';
export const NUVIO_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';

export function getEffectiveNuvioUrl(): string {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('ynotv_nuvio_url') || NUVIO_SUPABASE_URL;
  }
  return NUVIO_SUPABASE_URL;
}

export function getEffectiveNuvioKey(): string {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('ynotv_nuvio_key') || NUVIO_ANON_KEY;
  }
  return NUVIO_ANON_KEY;
}

export function setNuvioCustomConfig(url: string | null, key: string | null) {
  if (typeof window !== 'undefined') {
    if (url) {
      localStorage.setItem('ynotv_nuvio_url', url);
    } else {
      localStorage.removeItem('ynotv_nuvio_url');
    }
    if (key) {
      localStorage.setItem('ynotv_nuvio_key', key);
    } else {
      localStorage.removeItem('ynotv_nuvio_key');
    }
  }
}

export interface NuvioProfile {
  id: string;
  user_id: string;
  profile_index: number;
  name: string;
  avatar_color_hex: string;
  avatar_id: string | null;
  avatar_url: string | null;
  uses_primary_addons: boolean;
  uses_primary_plugins: boolean;
  pin_enabled: boolean;
  pin_locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface NuvioProfilePushPayload {
  profile_index: number;
  name: string;
  avatar_color_hex: string;
  uses_primary_addons: boolean;
  uses_primary_plugins: boolean;
  avatar_id: string | null;
  avatar_url: string | null;
}

export interface NuvioCollectionSource {
  provider: string; // 'addon' | 'tmdb' | 'trakt'
  addonId?: string | null;
  type?: string | null;
  catalogId?: string | null;
  genre?: string | null;
  tmdbSourceType?: string | null;
  title?: string | null;
  tmdbId?: number | null;
  traktListId?: number | null;
  mediaType?: string | null;
  sortBy?: string | null;
  sortHow?: string | null;
  filters?: any | null;
}

export interface NuvioCollectionFolder {
  id: string;
  title: string;
  coverImageUrl?: string | null;
  coverEmoji?: string | null;
  focusGifUrl?: string | null;
  focusGifEnabled: boolean;
  tileShape: string; // 'poster' | 'landscape' | 'square'
  hideTitle: boolean;
  sources: NuvioCollectionSource[];
  heroBackdropUrl?: string | null;
  heroVideoUrl?: string | null;
  titleLogoUrl?: string | null;
}

export interface NuvioCollection {
  id: string;
  title: string;
  backdropImageUrl?: string | null;
  pinToTop: boolean;
  viewMode: string; // 'TABBED_GRID' | 'ROWS' | 'FOLLOW_LAYOUT'
  showAllTab: boolean;
  folders: NuvioCollectionFolder[];
}

export interface NuvioAddonRow {
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
}

export interface NuvioPluginRow {
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
}

export interface NuvioLibrarySyncItem {
  content_id: string;
  content_type: string;
  name: string;
  poster: string | null;
  poster_shape: string; // 'POSTER' | 'LANDSCAPE' | 'SQUARE'
  background: string | null;
  description: string | null;
  release_info: string | null;
  imdb_rating: number | null;
  genres: string[];
  addon_base_url: string | null;
  added_at: number;
}

export interface NuvioWatchProgressSyncEntry {
  content_id: string;
  content_type: string;
  video_id: string;
  season: number | null;
  episode: number | null;
  position: number; // in milliseconds
  duration: number; // in milliseconds
  last_watched: number; // epoch ms
  progress_key: string;
}

export interface NuvioWatchedSyncItem {
  content_id: string;
  content_type: string;
  title: string;
  season: number | null;
  episode: number | null;
  watched_at: number; // epoch ms
}

export interface PinVerifyResult {
  unlocked: boolean;
  retry_after_seconds: number;
  message: string | null;
}

export interface AvatarCatalogItem {
  id: string;
  display_name: string;
  storage_path: string;
  category: string;
  sort_order: number;
  is_active: boolean;
  bg_color: string | null;
}

export interface NuvioSession {
  access_token: string;
  refresh_token: string;
  user: {
    id: string;
    email: string;
  };
}

// Internal – exchange a refresh_token for a new session
export async function refreshNuvioSession(refreshToken: string): Promise<NuvioSession> {
  return callNuvioApiRaw<NuvioSession>('POST', 'auth/v1/token?grant_type=refresh_token', {
    refresh_token: refreshToken,
  });
}

// Core request implementation
async function executeNuvioRequestOnce<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
  token?: string | null
): Promise<T> {
  const url = `${getEffectiveNuvioUrl()}/${path}`;

  const headers: Record<string, string> = {
    'apikey': getEffectiveNuvioKey(),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'NuvioDesktop/0.1.26-alpha',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options: RequestInit = { method, headers };
  if (body) options.body = JSON.stringify(body);

  // Tauri proxy
  const proxy = (window as any).fetchProxy;
  if (proxy?.fetch) {
    const res = await proxy.fetch(url, options);
    if (res.error) throw new Error(translateNativeError(res.error) || res.error);
    if (!res.data) throw new Error(`No response data from Nuvio API: ${path}`);
    if (!res.data.ok) {
      const errorJson = await res.data.json().catch(() => ({}));
      const status = res.data.status;
      const msg = errorJson.msg || errorJson.error_description || errorJson.error?.message || `API HTTP ${status} for ${path}`;
      const err = new Error(msg) as any;
      err.status = status;
      throw err;
    }
    const text = res.data.text || '';
    if (!text.trim()) {
      return {} as T;
    }
    return JSON.parse(text) as T;
  }

  const res = await fetch(url, options);
  if (!res.ok) {
    const errorJson = await res.json().catch(() => ({}));
    const msg = errorJson.msg || errorJson.error_description || errorJson.error?.message || `API HTTP ${res.status} for ${path}`;
    const err = new Error(msg) as any;
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  if (!text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

let lastRpcTimestamp = 0;
const MIN_RPC_INTERVAL_MS = 500; // Minimum 500ms spacing between RPC calls to prevent 429 rate limit bursts
let rpcQueueChain: Promise<any> = Promise.resolve();

function enqueueRpcRequest<T>(fn: () => Promise<T>): Promise<T> {
  const nextCall = rpcQueueChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastRpcTimestamp;
    if (elapsed < MIN_RPC_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_RPC_INTERVAL_MS - elapsed));
    }
    lastRpcTimestamp = Date.now();
    return fn();
  });
  rpcQueueChain = nextCall.catch(() => {});
  return nextCall;
}

async function executeNuvioRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
  token?: string | null
): Promise<T> {
  const isRpc = path.includes('rpc/');
  const runCall = async () => {
    const maxRetries = 3;
    let attempt = 0;
    while (true) {
      try {
        return await executeNuvioRequestOnce<T>(method, path, body, token);
      } catch (err: any) {
        if (err?.status === 429 && attempt < maxRetries) {
          attempt++;
          const backoffMs = Math.min(1500 * Math.pow(2, attempt - 1) + Math.random() * 300, 6000);
          console.warn(`[NuvioAPI] HTTP 429 Rate Limit for ${path}. Retrying in ${Math.round(backoffMs)}ms (attempt ${attempt}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
        throw err;
      }
    }
  };

  if (isRpc) {
    return enqueueRpcRequest(runCall);
  }
  return runCall();
}

interface CacheEntry {
  timestamp: number;
  promise: Promise<any>;
}

const apiCache = new Map<string, CacheEntry>();
const CACHE_TTL = 120000; // 2 minutes cache TTL

export function clearNuvioApiCache() {
  apiCache.clear();
}

// Low-level fetch that never auto-refreshes (avoids infinite loops)
async function callNuvioApiRaw<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
  token?: string | null
): Promise<T> {
  const isGetOrPull =
    method === 'GET' ||
    path.includes('rpc/sync_pull_') ||
    path.includes('rpc/sync_get_') ||
    path.includes('rpc/get_');

  if (!isGetOrPull) {
    clearNuvioApiCache();
    return executeNuvioRequest<T>(method, path, body, token);
  }

  const cacheKey = `${getEffectiveNuvioUrl()}/${path}::${body ? JSON.stringify(body) : ''}::${token || ''}`;
  const cached = apiCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.promise as Promise<T>;
  }

  const promise = executeNuvioRequest<T>(method, path, body, token);

  apiCache.set(cacheKey, {
    timestamp: Date.now(),
    promise,
  });

  promise.catch(() => {
    apiCache.delete(cacheKey);
  });

  return promise;
}

// Request Helper – calls raw, auto-refreshes token on 401 and retries once
async function callNuvioApi<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: any,
  token?: string | null
): Promise<T> {
  try {
    return await callNuvioApiRaw<T>(method, path, body, token);
  } catch (err: any) {
    // On 401 with a refresh token, attempt a session refresh and retry once
    if (err?.status === 401 && token) {
      try {
        const { useNuvioAuthStore } = await import('../stores/nuvioAuthStore');
        const store = useNuvioAuthStore.getState();
        const rt = store.refreshToken;
        if (rt) {
          console.log('[NuvioAPI] Access token expired – refreshing session...');
          const newSession = await callNuvioApiRaw<NuvioSession>(
            'POST', 'auth/v1/token?grant_type=refresh_token', { refresh_token: rt }
          );
          // Persist the new tokens in the store
          useNuvioAuthStore.setState({
            token: newSession.access_token,
            refreshToken: newSession.refresh_token,
          });
          // Retry with the new access token
          return await callNuvioApiRaw<T>(method, path, body, newSession.access_token);
        }
      } catch (refreshErr) {
        console.error('[NuvioAPI] Token refresh failed:', refreshErr);
        // Clear auth so the user sees the login screen
        const { useNuvioAuthStore } = await import('../stores/nuvioAuthStore');
        useNuvioAuthStore.setState({ token: null, refreshToken: null, user: null, activeProfile: null, profiles: [] });
      }
    }
    throw err;
  }
}

// ==========================================
// AUTHENTICATION
// ==========================================

export async function loginNuvio(email: string, password: string): Promise<NuvioSession> {
  return callNuvioApi<NuvioSession>('POST', 'auth/v1/token?grant_type=password', {
    email,
    password,
  });
}

export async function signUpNuvio(email: string, password: string): Promise<NuvioSession> {
  return callNuvioApi<NuvioSession>('POST', 'auth/v1/signup', {
    email,
    password,
  });
}

export async function logoutNuvio(token: string): Promise<void> {
  await callNuvioApi<void>('POST', 'auth/v1/logout', null, token);
}

export async function deleteNuvioAccount(token: string): Promise<void> {
  await callNuvioApi<void>('POST', 'functions/v1/delete-account', null, token);
}

// ==========================================
// PROFILES
// ==========================================

export async function fetchNuvioProfiles(token: string): Promise<NuvioProfile[]> {
  return callNuvioApi<NuvioProfile[]>('POST', 'rest/v1/rpc/sync_pull_profiles', {}, token);
}

export async function pushNuvioProfiles(token: string, profiles: NuvioProfilePushPayload[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_profiles', { p_profiles: profiles }, token);
}

export async function deleteNuvioProfileData(token: string, profileId: number): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_delete_profile_data', { p_profile_id: profileId }, token);
}

export async function verifyNuvioProfilePin(token: string, profileId: number, pin: string): Promise<PinVerifyResult> {
  const res = await callNuvioApi<PinVerifyResult | PinVerifyResult[]>('POST', 'rest/v1/rpc/verify_profile_pin', {
    p_profile_id: profileId,
    p_pin: pin,
  }, token);

  if (Array.isArray(res)) {
    return res[0] || { unlocked: false, retry_after_seconds: 0, message: null };
  }
  return res;
}

export async function setNuvioProfilePin(token: string, profileId: number, pin: string, currentPin?: string | null): Promise<void> {
  const body: any = {
    p_profile_id: profileId,
    p_pin: pin,
  };
  if (currentPin) {
    body.p_current_pin = currentPin;
  }
  await callNuvioApi<void>('POST', 'rest/v1/rpc/set_profile_pin', body, token);
}

export async function clearNuvioProfilePin(token: string, profileId: number, currentPin?: string | null): Promise<void> {
  const body: any = {
    p_profile_id: profileId,
  };
  if (currentPin) {
    body.p_current_pin = currentPin;
  }
  await callNuvioApi<void>('POST', 'rest/v1/rpc/clear_profile_pin', body, token);
}

export async function clearNuvioProfilePinWithPassword(token: string, profileId: number): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/clear_profile_pin_with_account_password', {
    p_profile_id: profileId,
  }, token);
}

export async function fetchNuvioProfileLocks(token: string): Promise<any> {
  return callNuvioApi<any>('POST', 'rest/v1/rpc/sync_pull_profile_locks', {}, token);
}

// ==========================================
// COLLECTIONS
// ==========================================

export interface NuvioCollectionBlob {
  profile_id: number;
  collections_json: NuvioCollection[];
  updated_at: string | null;
}

export async function fetchNuvioCollections(token: string, profileId: number): Promise<NuvioCollection[]> {
  const res = await callNuvioApi<NuvioCollectionBlob[]>('POST', 'rest/v1/rpc/sync_pull_collections', {
    p_profile_id: profileId,
  }, token);
  return res[0]?.collections_json || [];
}

export async function pushNuvioCollections(token: string, profileId: number, collections: NuvioCollection[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_collections', {
    p_profile_id: profileId,
    p_collections_json: collections,
  }, token);
}

// ==========================================
// ADDONS
// Nuvio reads addons via direct table REST query (GET /rest/v1/addons)
// matching AddonRepository.pullFromServer(): .from("addons").select { filter { eq("profile_id", id) } order("sort_order", ASCENDING) }
// Push uses the sync_push_addons RPC, same as Nuvio.
// ==========================================

export async function fetchNuvioAddons(token: string, profileId: number): Promise<NuvioAddonRow[]> {
  return callNuvioApi<NuvioAddonRow[]>('GET', `rest/v1/addons?profile_id=eq.${profileId}&order=sort_order.asc`, undefined, token);
}

export async function pushNuvioAddons(token: string, profileId: number, addons: NuvioAddonRow[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_addons', {
    p_profile_id: profileId,
    p_addons: addons,
  }, token);
}

// ==========================================
// PLUGINS
// Nuvio reads plugins via direct table REST query (GET /rest/v1/plugins)
// matching PluginRepository.pullFromServer(): .from("plugins").select { filter { eq("profile_id", id) } order("sort_order", ASCENDING) }
// Push uses the sync_push_plugins RPC, same as Nuvio.
// ==========================================

export async function fetchNuvioPlugins(token: string, profileId: number): Promise<NuvioPluginRow[]> {
  return callNuvioApi<NuvioPluginRow[]>('GET', `rest/v1/plugins?profile_id=eq.${profileId}&order=sort_order.asc`, undefined, token);
}

export async function pushNuvioPlugins(token: string, profileId: number, plugins: NuvioPluginRow[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_plugins', {
    p_profile_id: profileId,
    p_plugins: plugins,
  }, token);
}

// ==========================================
// LIBRARY
// ==========================================

export async function fetchNuvioLibrary(token: string, profileId: number, limit = 500, offset = 0): Promise<NuvioLibrarySyncItem[]> {
  return callNuvioApi<NuvioLibrarySyncItem[]>('POST', 'rest/v1/rpc/sync_pull_library', {
    p_profile_id: profileId,
    p_limit: limit,
    p_offset: offset,
  }, token);
}

export async function pushNuvioLibrary(token: string, profileId: number, items: NuvioLibrarySyncItem[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_library', {
    p_profile_id: profileId,
    p_items: items,
  }, token);
}

// ==========================================
// WATCH PROGRESS DELTA SYNC
// ==========================================

export async function fetchNuvioWatchProgressDeltaCursor(token: string, profileId: number): Promise<number> {
  const res = await callNuvioApi<any>('POST', 'rest/v1/rpc/sync_get_watch_progress_delta_cursor', {
    p_profile_id: profileId,
  }, token);
  if (typeof res === 'number') return res;
  if (Array.isArray(res)) return typeof res[0] === 'number' ? res[0] : 0;
  if (res && typeof res === 'object' && typeof res.cursor === 'number') return res.cursor;
  return Number(res) || 0;
}

export interface NuvioWatchProgressDeltaEvent {
  event_id: number;
  operation: string; // 'upsert' | 'delete'
  progress_key: string;
  content_id: string;
  content_type: string;
  video_id: string;
  season: number | null;
  episode: number | null;
  position: number;
  duration: number;
  last_watched: number;
}

export async function fetchNuvioWatchProgressDelta(
  token: string,
  profileId: number,
  sinceEventId: number,
  limit = 900,
): Promise<NuvioWatchProgressDeltaEvent[]> {
  return callNuvioApi<NuvioWatchProgressDeltaEvent[]>('POST', 'rest/v1/rpc/sync_pull_watch_progress_delta', {
    p_profile_id: profileId,
    p_since_event_id: sinceEventId,
    p_limit: limit,
  }, token);
}

// ==========================================
// WATCH PROGRESS
// ==========================================

export async function fetchNuvioWatchProgress(token: string, profileId: number, sinceLastWatched?: number | null, limit = 500): Promise<NuvioWatchProgressSyncEntry[]> {
  const body: any = {
    p_profile_id: profileId,
    p_limit: limit,
  };
  if (sinceLastWatched) {
    body.p_since_last_watched = sinceLastWatched;
  }
  return callNuvioApi<NuvioWatchProgressSyncEntry[]>('POST', 'rest/v1/rpc/sync_pull_watch_progress', body, token);
}

export async function pushNuvioWatchProgress(token: string, profileId: number, entries: NuvioWatchProgressSyncEntry[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_watch_progress', {
    p_profile_id: profileId,
    p_entries: entries,
  }, token);
}

export async function deleteNuvioWatchProgress(token: string, profileId: number, keys: string[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_delete_watch_progress', {
    p_profile_id: profileId,
    p_keys: keys,
  }, token);
}

// ==========================================
// WATCHED HISTORY DELTA SYNC
// ==========================================

export async function fetchNuvioWatchedItemsDeltaCursor(token: string, profileId: number): Promise<number> {
  const res = await callNuvioApi<any>('POST', 'rest/v1/rpc/sync_get_watched_items_delta_cursor', {
    p_profile_id: profileId,
  }, token);
  if (typeof res === 'number') return res;
  if (Array.isArray(res)) return typeof res[0] === 'number' ? res[0] : 0;
  if (res && typeof res === 'object' && typeof res.cursor === 'number') return res.cursor;
  return Number(res) || 0;
}

export interface NuvioWatchedDeltaEvent {
  event_id: number;
  operation: string; // 'upsert' | 'delete'
  content_id: string;
  content_type: string;
  title: string;
  season: number | null;
  episode: number | null;
  watched_at: number;
}

export async function fetchNuvioWatchedItemsDelta(
  token: string,
  profileId: number,
  sinceEventId: number,
  limit = 900,
): Promise<NuvioWatchedDeltaEvent[]> {
  return callNuvioApi<NuvioWatchedDeltaEvent[]>('POST', 'rest/v1/rpc/sync_pull_watched_items_delta', {
    p_profile_id: profileId,
    p_since_event_id: sinceEventId,
    p_limit: limit,
  }, token);
}

// ==========================================
// WATCHED HISTORY
// ==========================================

export async function fetchNuvioWatchedItems(token: string, profileId: number, page = 1, pageSize = 250): Promise<NuvioWatchedSyncItem[]> {
  return callNuvioApi<NuvioWatchedSyncItem[]>('POST', 'rest/v1/rpc/sync_pull_watched_items', {
    p_profile_id: profileId,
    p_page: page,
    p_page_size: pageSize,
  }, token);
}

export async function pushNuvioWatchedItems(token: string, profileId: number, items: NuvioWatchedSyncItem[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_watched_items', {
    p_profile_id: profileId,
    p_items: items,
  }, token);
}

export async function deleteNuvioWatchedItems(token: string, profileId: number, keys: { content_id: string; season?: number | null; episode?: number | null }[]): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_delete_watched_items', {
    p_profile_id: profileId,
    p_keys: keys,
  }, token);
}

// ==========================================
// SETTINGS BLOB
// ==========================================

export interface NuvioSettingsBlobResponse {
  profile_id: number;
  settings_json: any;
  updated_at: string | null;
}

export async function fetchNuvioProfileSettings(token: string, profileId: number, platform = 'desktop'): Promise<any | null> {
  const res = await callNuvioApi<NuvioSettingsBlobResponse[]>('POST', 'rest/v1/rpc/sync_pull_profile_settings_blob', {
    p_profile_id: profileId,
    p_platform: platform,
  }, token);
  return res[0]?.settings_json || null;
}

export async function pushNuvioProfileSettings(token: string, profileId: number, settings: any, platform = 'desktop'): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_profile_settings_blob', {
    p_profile_id: profileId,
    p_platform: platform,
    p_settings_json: settings,
  }, token);
}

// ==========================================
// HOME CATALOG SETTINGS
// ==========================================

export async function fetchNuvioHomeCatalogSettings(token: string, profileId: number): Promise<any | null> {
  const res = await callNuvioApi<any>('POST', 'rest/v1/rpc/sync_pull_home_catalog_settings', {
    p_profile_id: profileId,
    p_platform: 'home_catalog_shared',
  }, token);
  return res[0]?.settings_json || null;
}

export async function pushNuvioHomeCatalogSettings(token: string, profileId: number, settings: any): Promise<void> {
  await callNuvioApi<void>('POST', 'rest/v1/rpc/sync_push_home_catalog_settings', {
    p_profile_id: profileId,
    p_platform: 'home_catalog_shared',
    p_settings_json: settings,
  }, token);
}

// ==========================================
// AVATARS
// ==========================================

export async function fetchNuvioAvatarCatalog(token: string): Promise<AvatarCatalogItem[]> {
  return callNuvioApi<AvatarCatalogItem[]>('POST', 'rest/v1/rpc/get_avatar_catalog', {}, token);
}
