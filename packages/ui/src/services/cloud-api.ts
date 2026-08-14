// ─────────────────────────────────────────────────────────────────────────────
// Cloud Library API clients — Torbox & Premiumize.
// Mirrors NuvioDesktop's DebridApiClients + Torbox/Premiumize
// CloudLibraryProviderApi, adapted to the web runtime (fetch / fetchProxy).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CloudLibraryFile,
  CloudLibraryItem,
  CloudLibraryItemType,
} from '../types/cloud';
import {
  TORBOX_PROVIDER_ID,
  PREMIUMIZE_PROVIDER_ID,
  isPlayableCloudFileName,
} from '../types/cloud';

const TORBOX_BASE_URL = 'https://api.torbox.app';
const PREMIUMIZE_BASE_URL = 'https://www.premiumize.me';

export class CloudApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudApiError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP plumbing — prefers the app's fetchProxy (native networking via Tauri)
// and falls back to the browser fetch.
// ─────────────────────────────────────────────────────────────────────────────

interface RawResponse {
  ok: boolean;
  status: number;
  text: string;
  json: () => Promise<unknown>;
}

async function rawFetch(url: string, options: RequestInit): Promise<RawResponse> {
  const proxy = (window as any).fetchProxy as
    | { fetch: (url: string, options: any) => Promise<{ data?: RawResponse; error?: string }> }
    | undefined;
  if (proxy?.fetch) {
    const res = await proxy.fetch(url, options);
    if (res.error) throw new CloudApiError(res.error);
    if (!res.data) throw new CloudApiError(`No response from ${url}`);
    return res.data;
  }
  const response = await fetch(url, options);
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
    json: () => response.clone().json(),
  };
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await rawFetch(url, options);
  const text = res.text.trim();
  if (!text) {
    return undefined as unknown as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CloudApiError(`Invalid JSON response (HTTP ${res.status}).`);
  }
  return parsed as T;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    Accept: 'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Torbox
// ─────────────────────────────────────────────────────────────────────────────

interface TorboxEnvelope<T> {
  success?: boolean | null;
  data?: T | null;
  error?: string | null;
  detail?: string | null;
}

interface TorboxCloudItemDto {
  id?: unknown;
  hash?: string | null;
  name?: string | null;
  status?: string | null;
  state?: string | null;
  download_state?: string | null;
  progress?: number | null;
  download_progress?: number | null;
  size?: number | null;
  total_size?: number | null;
  files?: TorboxCloudFileDto[] | null;
}

interface TorboxCloudFileDto {
  id?: unknown;
  name?: string | null;
  short_name?: string | null;
  absolute_path?: string | null;
  mimetype?: string | null;
  mime_type?: string | null;
  size?: number | null;
}

async function torboxRequest<T>(
  path: string,
  apiKey: string,
  query: Record<string, string> = {},
): Promise<TorboxEnvelope<T>> {
  const params = new URLSearchParams(query).toString();
  const url = `${TORBOX_BASE_URL}${path}${params ? `?${params}` : ''}`;
  const envelope = await requestJson<TorboxEnvelope<T>>(url, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  if (!envelope) throw new CloudApiError(`Empty response from Torbox (${path}).`);
  if (envelope.success === false) {
    throw new CloudApiError(envelope.detail || envelope.error || `Torbox request failed (${path}).`);
  }
  return envelope;
}

export async function validateTorboxApiKey(apiKey: string): Promise<boolean> {
  try {
    const envelope = await torboxRequest<unknown>('/v1/api/user/me', apiKey);
    return envelope.success !== false;
  } catch {
    return false;
  }
}

function scalarString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number') return String(value);
  return null;
}

function toProgressFraction(value: number | null | undefined): number | null {
  if (value === null || value === undefined || isNaN(value)) return null;
  const normalized = value > 1.0 ? value / 100.0 : value;
  return Math.min(1, Math.max(0, normalized));
}

function torboxFileDisplayName(file: TorboxCloudFileDto, parentName: string | null): string | null {
  const rawName = file.name?.trim() || null;
  const short = file.short_name?.trim() || null;
  const pathName = file.absolute_path?.trim() || null;
  const pathBasename = pathName ? substringAfterLast(substringAfterLast(pathName, '/'), '\\') : null;
  const parent = parentName?.trim() || null;

  const rawNameIsPath = !!rawName && (rawName.includes('/') || rawName.includes('\\'));
  const rawNameBasename = rawName && rawNameIsPath ? substringAfterLast(substringAfterLast(rawName, '/'), '\\') : null;

  const candidates = [
    short,
    rawNameBasename,
    rawName && !rawNameIsPath ? rawName : null,
    pathName,
    rawName,
    pathName,
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate.trim().length === 0) continue;
    const normalized = normalizeDisplayName(candidate);
    if (normalized === normalizeDisplayName(parent) && normalized.length > 0) continue;
    if (!candidate.includes('.') && normalized === normalizeDisplayName(pathName ? substringBeforeLast(pathName, '.') : null)) continue;
    return candidate;
  }
  return candidates.find((c) => c && c.trim().length > 0) || null;
}

function normalizeDisplayName(value: string | null): string {
  if (!value) return '';
  return substringAfterLast(substringAfterLast(value.trim(), '/'), '\\')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function substringBeforeLast(value: string, delimiter: string): string {
  const idx = value.lastIndexOf(delimiter);
  return idx === -1 ? value : value.slice(0, idx);
}

function substringAfterLast(value: string, delimiter: string): string {
  const idx = value.lastIndexOf(delimiter);
  return idx === -1 ? value : value.slice(idx + delimiter.length);
}

function torboxCloudItemToLibraryItem(
  dto: TorboxCloudItemDto,
  providerId: string,
  providerName: string,
  type: CloudLibraryItemType,
): CloudLibraryItem | null {
  const itemId = scalarString(dto.id) || dto.hash?.trim() || null;
  if (!itemId) return null;
  const itemName = dto.name?.trim() || itemId;
  const mappedFiles: CloudLibraryFile[] = (dto.files || [])
    .map((file) => {
      const name = torboxFileDisplayName(file, itemName);
      if (!name) return null;
      const fileId = scalarString(file.id);
      const mime = file.mimetype?.trim() || file.mime_type?.trim() || null;
      return {
        id: fileId,
        name,
        sizeBytes: file.size ?? null,
        mimeType: mime,
        playable: fileId !== null && isPlayableCloudFileName(name, mime),
        playbackUrl: null,
      } as CloudLibraryFile;
    })
    .filter((f): f is CloudLibraryFile => f !== null);

  const filesSize = mappedFiles
    .map((f) => f.sizeBytes)
    .filter((s): s is number => typeof s === 'number' && s > 0)
    .reduce((sum, s) => sum + s, 0);

  const status = [dto.status, dto.download_state, dto.state].find((s) => s && s.trim().length > 0) || null;

  return {
    providerId,
    providerName,
    id: itemId,
    type,
    name: itemName,
    status,
    sizeBytes: dto.size ?? dto.total_size ?? (filesSize > 0 ? filesSize : null),
    progressFraction: toProgressFraction(dto.progress ?? dto.download_progress),
    files: mappedFiles,
  };
}

export async function torboxListCloudItems(apiKey: string): Promise<CloudLibraryItem[]> {
  const [torrents, usenet, web] = await Promise.all([
    torboxRequest<TorboxCloudItemDto[]>('/v1/api/torrents/mylist', apiKey),
    torboxRequest<TorboxCloudItemDto[]>('/v1/api/usenet/mylist', apiKey),
    torboxRequest<TorboxCloudItemDto[]>('/v1/api/webdl/mylist', apiKey),
  ]);

  const toItems = (envelope: TorboxEnvelope<TorboxCloudItemDto[]>, type: CloudLibraryItemType) =>
    (envelope.data || []).map((dto) => torboxCloudItemToLibraryItem(dto, TORBOX_PROVIDER_ID, 'Torbox', type)).filter((i): i is CloudLibraryItem => i !== null);

  return [
    ...toItems(torrents, 'Torrent'),
    ...toItems(usenet, 'Usenet'),
    ...toItems(web, 'WebDownload'),
  ];
}

function torboxRequestIdParamName(type: CloudLibraryItemType): string {
  switch (type) {
    case 'Torrent':
      return 'torrent_id';
    case 'Usenet':
      return 'usenet_id';
    case 'WebDownload':
      return 'web_id';
    default:
      return 'file_id';
  }
}

function torboxRequestDlPath(type: CloudLibraryItemType): string {
  switch (type) {
    case 'Torrent':
      return '/v1/api/torrents/requestdl';
    case 'Usenet':
      return '/v1/api/usenet/requestdl';
    case 'WebDownload':
      return '/v1/api/webdl/requestdl';
    default:
      return '';
  }
}

export async function torboxResolvePlaybackUrl(
  apiKey: string,
  item: CloudLibraryItem,
  file: CloudLibraryFile,
): Promise<string> {
  const path = torboxRequestDlPath(item.type);
  if (!path || !file.id) {
    throw new CloudApiError('This file cannot be resolved for playback.');
  }
  const query: Record<string, string> = {
    [torboxRequestIdParamName(item.type)]: item.id,
    file_id: file.id,
    token: apiKey.trim(),
    zip_link: 'false',
    redirect: 'false',
    append_name: 'false',
  };
  const envelope = await torboxRequest<string>(path, apiKey, query);
  const url = typeof envelope.data === 'string' ? envelope.data.trim() : null;
  if (!url) {
    throw new CloudApiError(envelope.detail || envelope.error || 'Torbox returned no download link.');
  }
  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// Premiumize
// ─────────────────────────────────────────────────────────────────────────────

interface PremiumizeBaseDto {
  status?: string | null;
  message?: string | null;
  code?: string | null;
}

interface PremiumizeItemListAllDto extends PremiumizeBaseDto {
  files?: PremiumizeCloudFileDto[] | null;
}

interface PremiumizeCloudFileDto {
  id?: string | null;
  name?: string | null;
  path?: string | null;
  type?: string | null;
  size?: number | null;
  mime_type?: string | null;
  link?: string | null;
}

interface PremiumizeItemDetailsDto extends PremiumizeBaseDto {
  id?: string | null;
  name?: string | null;
  size?: number | null;
  mime_type?: string | null;
  link?: string | null;
}

async function premiumizeRequest<T extends PremiumizeBaseDto>(
  path: string,
  apiKey: string,
  query: Record<string, string> = {},
): Promise<T> {
  const params = new URLSearchParams(query).toString();
  const url = `${PREMIUMIZE_BASE_URL}${path}${params ? `?${params}` : ''}`;
  const body = await requestJson<T>(url, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
  if (!body) throw new CloudApiError(`Empty response from Premiumize (${path}).`);
  if ((body.status || '').toLowerCase() === 'error') {
    throw new CloudApiError(body.message || body.code || `Premiumize request failed (${path}).`);
  }
  return body;
}

export async function validatePremiumizeApiKey(apiKey: string): Promise<boolean> {
  try {
    const body = await premiumizeRequest<PremiumizeBaseDto>('/api/account/info', apiKey);
    return (body.status || '').toLowerCase() === 'success';
  } catch {
    return false;
  }
}

/**
 * Premiumize exposes a flat file list where `path` looks like
 * `Folder/Sub/file.mkv`. Mirror NuvioDesktop: group files by their top-level
 * folder (or standalone file) into a single cloud item, keeping each file's
 * basename for the row label.
 */
export async function premiumizeListCloudItems(apiKey: string): Promise<CloudLibraryItem[]> {
  const body = await premiumizeRequest<PremiumizeItemListAllDto>('/api/item/listall', apiKey);
  const rawFiles = (body.files || []).filter((f) => f.name?.trim() || f.path?.trim());

  const groups = new Map<string, { itemId: string; itemName: string; files: CloudLibraryFile[] }>();
  for (const dto of rawFiles) {
    const normalizedPath = (dto.path || '').trim().replace(/^\/+|\/+$/g, '');
    const fileName = dto.name?.trim()
      || (normalizedPath ? substringAfterLast(substringAfterLast(normalizedPath, '/'), '\\') : null)
      || 'Unknown';
    const segments = normalizedPath.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
    const topLevel = segments[0];
    const isRootFile = segments.length <= 1;
    const groupKey = isRootFile ? `file:${dto.id || normalizedPath || fileName}` : `folder:${topLevel}`;
    const itemId = isRootFile ? `file:${dto.id || normalizedPath || fileName}` : `folder:${topLevel}`;
    const itemName = isRootFile ? fileName : topLevel || fileName;

    let group = groups.get(groupKey);
    if (!group) {
      group = { itemId, itemName, files: [] };
      groups.set(groupKey, group);
    }
    group.files.push({
      id: dto.id?.trim() || null,
      name: fileName,
      sizeBytes: dto.size ?? null,
      mimeType: dto.mime_type?.trim() || null,
      playable: isPlayableCloudFileName(fileName, dto.mime_type),
      playbackUrl: dto.link?.trim() || null,
    });
  }

  const items: CloudLibraryItem[] = [];
  for (const group of groups.values()) {
    const playableFirst = [...group.files].sort((a, b) => {
      if (a.playable !== b.playable) return a.playable ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    const sizeBytes = playableFirst
      .map((f) => f.sizeBytes)
      .filter((s): s is number => typeof s === 'number' && s > 0)
      .reduce((sum, s) => sum + s, 0);
    items.push({
      providerId: PREMIUMIZE_PROVIDER_ID,
      providerName: 'Premiumize',
      id: group.itemId,
      type: 'File',
      name: group.itemName,
      status: 'Ready',
      sizeBytes: sizeBytes > 0 ? sizeBytes : null,
      progressFraction: null,
      files: playableFirst,
    });
  }
  items.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return items;
}

export async function premiumizeResolvePlaybackUrl(
  apiKey: string,
  item: CloudLibraryItem,
  file: CloudLibraryFile,
): Promise<string> {
  if (file.playbackUrl && file.playbackUrl.trim().length > 0) {
    return file.playbackUrl.trim();
  }
  if (!file.id) {
    throw new CloudApiError('This file cannot be resolved for playback.');
  }
  const body = await premiumizeRequest<PremiumizeItemDetailsDto>('/api/item/details', apiKey, {
    id: file.id,
  });
  const url = body.link?.trim();
  if (!url) {
    throw new CloudApiError(body.message || body.code || 'Premiumize returned no download link.');
  }
  return url;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider registry
// ─────────────────────────────────────────────────────────────────────────────

export interface CloudProviderApi {
  providerId: string;
  providerName: string;
  validateApiKey: (apiKey: string) => Promise<boolean>;
  listItems: (apiKey: string) => Promise<CloudLibraryItem[]>;
  resolvePlayback: (apiKey: string, item: CloudLibraryItem, file: CloudLibraryFile) => Promise<string>;
}

export const CLOUD_PROVIDER_APIS: Record<string, CloudProviderApi> = {
  [TORBOX_PROVIDER_ID]: {
    providerId: TORBOX_PROVIDER_ID,
    providerName: 'Torbox',
    validateApiKey: validateTorboxApiKey,
    listItems: torboxListCloudItems,
    resolvePlayback: torboxResolvePlaybackUrl,
  },
  [PREMIUMIZE_PROVIDER_ID]: {
    providerId: PREMIUMIZE_PROVIDER_ID,
    providerName: 'Premiumize',
    validateApiKey: validatePremiumizeApiKey,
    listItems: premiumizeListCloudItems,
    resolvePlayback: premiumizeResolvePlaybackUrl,
  },
};

export function cloudProviderApiFor(providerId: string | null | undefined): CloudProviderApi | null {
  const normalized = (providerId || '').trim().toLowerCase();
  return CLOUD_PROVIDER_APIS[normalized] || null;
}

export function cloudProviderApiKeysFromSettings(settings: any): Record<string, string> {
  const debrid = settings?.features?.debrid_settings || {};
  const keys = debrid.providerApiKeys || {};
  const result: Record<string, string> = {};
  for (const [providerId, key] of Object.entries(keys)) {
    if (typeof key === 'string' && key.trim().length > 0) {
      result[providerId.toLowerCase()] = key.trim();
    }
  }
  return result;
}

export function cloudLibraryEnabledFromSettings(settings: any): boolean {
  const debrid = settings?.features?.debrid_settings || {};
  return debrid.enabled === true && debrid.cloudLibraryEnabled !== false;
}
