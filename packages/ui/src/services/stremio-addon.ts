import { invoke } from '@tauri-apps/api/core';
import type { InstalledAddon, StremioManifest, StremioCatalogResponse, StremioMeta, StremioStream, StremioSubtitle } from '../types/stremio';
import i18n, { translateNativeError } from '../i18n';
import { addonSubError, addonSubLangSummary, addonSubLog, addonSubPreview } from './addonSubtitleLog';

function encodeAddonPathSegment(val: string): string {
  return encodeURIComponent(val).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const MANIFEST_CACHE = new Map<string, { manifest: StremioManifest; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

const CATALOG_CACHE = new Map<string, Promise<StremioCatalogResponse>>();
const CATALOG_RESPONSE_CACHE = new Map<string, StremioCatalogResponse>();
const META_CACHE = new Map<string, Promise<StremioMeta | null>>();
const META_RESPONSE_CACHE = new Map<string, StremioMeta>();

export function clearCatalogCache() {
  CATALOG_CACHE.clear();
  CATALOG_RESPONSE_CACHE.clear();
  META_CACHE.clear();
  META_RESPONSE_CACHE.clear();
}

async function fetchJson(url: string): Promise<any> {
  const proxy = window.fetchProxy;
  if (proxy?.fetch) {
    const res = await proxy.fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (res.error) throw new Error(translateNativeError(res.error) || res.error);
    if (!res.data) throw new Error(`Failed to fetch ${url}`);
    if (!res.data.ok) throw new Error(`HTTP ${res.data.status} for ${url}`);
    return await res.data.json();
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

export function parseAddonUrl(url: string): { baseUrl: string; query: string } {
  const parts = url.split('?');
  let cleanUrl = parts[0];
  const query = parts[1] ? `?${parts[1]}` : '';
  cleanUrl = cleanUrl.replace(/\/manifest\.json$/i, '');
  cleanUrl = cleanUrl.replace(/\/+$/, '');
  return { baseUrl: cleanUrl, query };
}

export function cleanAddonUrl(url: string): string {
  const parsed = parseAddonUrl(url);
  return parsed.baseUrl + parsed.query;
}

export function getManifestUrl(baseUrl: string): string {
  const parsed = parseAddonUrl(baseUrl);
  return `${parsed.baseUrl}/manifest.json${parsed.query}`;
}

/**
 * Open an addon's configuration page ({baseUrl}/configure) so users can
 * customise it, mirroring the Stremio addon manager's configure button. Falls
 * back to a new browser tab if the native opener is unavailable.
 */
export async function openAddonConfigureUrl(baseUrl: string): Promise<void> {
  const parsed = parseAddonUrl(baseUrl);
  const url = `${parsed.baseUrl}/configure${parsed.query}`;
  try {
    await invoke('open_external_url', { url });
  } catch (e) {
    console.error('[Addon] Failed to open configure URL:', e);
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function normalizeBaseUrl(url: string): string {
  return parseAddonUrl(url).baseUrl;
}

function addonHasResource(addon: InstalledAddon, resource: string): boolean {
  return addon.manifest.resources.some(r => {
    if (typeof r === 'string') return r === resource;
    return r.name === resource;
  });
}

export async function fetchManifest(url: string): Promise<StremioManifest> {
  const manifestUrl = getManifestUrl(url);
  const cached = MANIFEST_CACHE.get(manifestUrl);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.manifest;
  }
  const manifest = await fetchJson(manifestUrl) as StremioManifest;
  MANIFEST_CACHE.set(manifestUrl, { manifest, ts: Date.now() });
  return manifest;
}

export function getCachedCatalog(
  baseUrl: string,
  type: string,
  id: string,
  extra?: Record<string, string>
): StremioCatalogResponse | undefined {
  const parsed = parseAddonUrl(baseUrl);
  let url = `${parsed.baseUrl}/catalog/${encodeAddonPathSegment(type)}/${encodeAddonPathSegment(id)}`;
  const extraArgs = extra
    ? Object.entries(extra)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    : '';
  if (extraArgs) {
    url += `/${extraArgs}`;
  }
  url += `.json${parsed.query}`;
  return CATALOG_RESPONSE_CACHE.get(url);
}

export async function fetchCatalog(
  baseUrl: string,
  type: string,
  id: string,
  extra?: Record<string, string>
): Promise<StremioCatalogResponse> {
  const parsed = parseAddonUrl(baseUrl);
  let url = `${parsed.baseUrl}/catalog/${encodeAddonPathSegment(type)}/${encodeAddonPathSegment(id)}`;
  const extraArgs = extra
    ? Object.entries(extra)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')
    : '';
  if (extraArgs) {
    url += `/${extraArgs}`;
  }
  url += `.json${parsed.query}`;

  const cachedResponse = CATALOG_RESPONSE_CACHE.get(url);
  if (cachedResponse) {
    return cachedResponse;
  }

  const cachedPromise = CATALOG_CACHE.get(url);
  if (cachedPromise) {
    return cachedPromise;
  }

  const promise = fetchJson(url) as Promise<StremioCatalogResponse>;
  CATALOG_CACHE.set(url, promise);

  promise
    .then((resp) => {
      CATALOG_RESPONSE_CACHE.set(url, resp);
    })
    .catch(() => {
      CATALOG_CACHE.delete(url);
    });

  return promise;
}

/**
 * Detect error-placeholder names some addons (e.g. AIOStreams) emit as if they
 * were valid meta when they fail to resolve an id — for example
 * "[❌] AIOStreams - Error - Trailer" or "AIO Streams - Error". Trusting such
 * meta would render the error string as the poster/title (e.g. in Nuvio
 * Continue Watching). Only exact AIOStreams failure naming is treated as an
 * error, so real titles containing the word "Error" are unaffected.
 */
export function isErrorMetaName(name: string | null | undefined): boolean {
  if (!name) return true;
  if (name.includes('❌')) return true;
  return /aio\s*streams?\s*[-–—]\s*error/i.test(name);
}

export async function fetchMeta(
  addons: InstalledAddon[],
  type: string,
  id: string
): Promise<StremioMeta | null> {
  const cacheKey = `${type}:${id}`;
  const cachedResponse = META_RESPONSE_CACHE.get(cacheKey);
  if (cachedResponse) {
    return cachedResponse;
  }
  const cachedPromise = META_CACHE.get(cacheKey);
  if (cachedPromise) {
    return cachedPromise;
  }

  const promise = (async () => {
    for (const addon of addons) {
      if (!addonHasResource(addon, 'meta')) continue;
      try {
        const parsed = parseAddonUrl(addon.baseUrl);
        const url = `${parsed.baseUrl}/meta/${encodeAddonPathSegment(type)}/${encodeAddonPathSegment(id)}.json${parsed.query}`;
        const data = await fetchJson(url) as { meta: StremioMeta };
        if (data?.meta && !isErrorMetaName(data.meta.name)) {
          META_RESPONSE_CACHE.set(cacheKey, data.meta);
          return data.meta;
        }
      } catch {
        // Try next addon
      }
    }
    META_CACHE.delete(cacheKey);
    return null;
  })();

  META_CACHE.set(cacheKey, promise);

  promise.catch(() => {
    META_CACHE.delete(cacheKey);
  });

  return promise;
}

export async function fetchStreams(
  addons: InstalledAddon[],
  type: string,
  id: string,
  onStreams?: (streams: StremioStream[]) => void
): Promise<StremioStream[]> {
  const results: StremioStream[] = [];
  
  const promises = addons.map(async (addon) => {
    if (!addonHasResource(addon, 'stream')) return;
    try {
      const parsed = parseAddonUrl(addon.baseUrl);
      const url = `${parsed.baseUrl}/stream/${encodeAddonPathSegment(type)}/${encodeAddonPathSegment(id)}.json${parsed.query}`;
      const data = await fetchJson(url) as { streams: StremioStream[] };
      if (data?.streams) {
        const addonStreams = data.streams.map(s => ({
          ...s,
          addonName: addon.manifest.name
        }));
        results.push(...addonStreams);
        if (onStreams) {
          onStreams(addonStreams);
        }
      }
    } catch {
      // Ignore errors for individual addon
    }
  });

  await Promise.all(promises);
  return results;
}

export async function fetchSubtitles(
  addons: InstalledAddon[],
  type: string,
  id: string,
  extra?: Record<string, string>
): Promise<StremioSubtitle[]> {
  const results: StremioSubtitle[] = [];
  
  const promises = addons.map(async (addon) => {
    if (!addonHasResource(addon, 'subtitles')) return;
    try {
      const parsed = parseAddonUrl(addon.baseUrl);
      let url = `${parsed.baseUrl}/subtitles/${encodeAddonPathSegment(type)}/${encodeAddonPathSegment(id)}`;
      const extraArgs = extra
        ? Object.entries(extra)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join('&')
        : '';
      if (extraArgs) {
        url += `/${extraArgs}`;
      }
      url += `.json${parsed.query}`;
      addonSubLog('fetch', `${addon.manifest.name} → ${url}`);
      const data = await fetchJson(url) as { subtitles: StremioSubtitle[] };
      if (data?.subtitles) {
        const addonSubtitles = data.subtitles.map(sub => ({
          ...sub,
          addonName: addon.manifest.name
        }));
        addonSubLog(
          'fetch',
          `${addon.manifest.name}: ${addonSubtitles.length} entry(ies) — ${addonSubLangSummary(addonSubtitles)}`
        );
        results.push(...addonSubtitles);
      } else {
        addonSubLog(
          'fetch',
          `${addon.manifest.name}: response has no subtitles[] — ${addonSubPreview(JSON.stringify(data))}`
        );
      }
    } catch (err) {
      // Add-ons fail independently, and a subtitle add-on that errors looks
      // exactly like one that simply offers nothing — the trace is the only
      // place the reason surfaces.
      addonSubError('fetch', `${addon.manifest.name} subtitles request failed`, err);
    }
  });

  await Promise.all(promises);
  return results;
}
