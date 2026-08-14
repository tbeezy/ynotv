// ─────────────────────────────────────────────────────────────────────────────
// Cloud Library types (Torbox / Premiumize) — mirrors NuvioDesktop's
// CloudLibraryModels so the Cloud tab behaves the same way.
// ─────────────────────────────────────────────────────────────────────────────

export type CloudLibraryItemType = 'Torrent' | 'Usenet' | 'WebDownload' | 'File';

export const CLOUD_LIBRARY_CONTENT_TYPE = 'cloud';

export const TORBOX_PROVIDER_ID = 'torbox';
export const PREMIUMIZE_PROVIDER_ID = 'premiumize';
export const REAL_DEBRID_PROVIDER_ID = 'realdebrid';

export const TORBOX_CLOUD_LIBRARY_POSTER_URL = 'https://torbox.app/assets/logo-bb7a9579.svg';
export const PREMIUMIZE_CLOUD_LIBRARY_POSTER_URL = 'https://www.premiumize.me/icon_normal.svg';

export interface CloudLibraryFile {
  id: string | null;
  name: string;
  sizeBytes?: number | null;
  mimeType?: string | null;
  playable: boolean;
  playbackUrl?: string | null;
}

export interface CloudLibraryItem {
  providerId: string;
  providerName: string;
  id: string;
  type: CloudLibraryItemType;
  name: string;
  status?: string | null;
  sizeBytes?: number | null;
  progressFraction?: number | null;
  files: CloudLibraryFile[];
}

export interface CloudLibraryProviderState {
  providerId: string;
  providerName: string;
  isLoading: boolean;
  errorMessage: string | null;
  items: CloudLibraryItem[];
}

export interface CloudLibraryUiState {
  isLoaded: boolean;
  isEnabled: boolean;
  isRefreshing: boolean;
  providers: CloudLibraryProviderState[];
}

export function cloudLibraryStableKey(item: CloudLibraryItem): string {
  return `${item.providerId}:${item.type}:${item.id}`;
}

export function cloudLibraryFileStableKey(file: CloudLibraryFile): string {
  return file.id || file.name;
}

export function cloudLibraryItemPlayableFiles(item: CloudLibraryItem): CloudLibraryFile[] {
  return item.files.filter((f) => f.playable);
}

export function cloudLibraryPlaybackVideoId(item: CloudLibraryItem, file: CloudLibraryFile): string {
  return `${cloudLibraryStableKey(item)}:${cloudLibraryFileStableKey(file)}`;
}

export function cloudLibraryProviderId(providerIdOrContentId: string | null | undefined): string {
  return (providerIdOrContentId || '')
    .trim()
    .replace(new RegExp(`^${CLOUD_LIBRARY_CONTENT_TYPE}:`), '')
    .split(':')[0]
    .toLowerCase();
}

export function cloudLibraryProviderPosterUrl(providerIdOrContentId: string | null | undefined): string | null {
  switch (cloudLibraryProviderId(providerIdOrContentId)) {
    case TORBOX_PROVIDER_ID:
      return TORBOX_CLOUD_LIBRARY_POSTER_URL;
    case PREMIUMIZE_PROVIDER_ID:
      return PREMIUMIZE_CLOUD_LIBRARY_POSTER_URL;
    default:
      return null;
  }
}

const PLAYABLE_VIDEO_EXTENSIONS = new Set([
  '3g2',
  '3gp',
  'avi',
  'divx',
  'flv',
  'm2ts',
  'm4v',
  'mkv',
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'mts',
  'ogm',
  'ogv',
  'ts',
  'webm',
  'wmv',
]);

export function isPlayableCloudFileName(name: string, mimeType?: string | null): boolean {
  const normalizedMime = (mimeType || '').toLowerCase();
  if (normalizedMime.startsWith('video/')) return true;
  const extension = substringAfterLast(name, '.');
  return PLAYABLE_VIDEO_EXTENSIONS.has(extension.toLowerCase());
}

export function formatCloudBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function substringAfterLast(value: string, delimiter: string): string {
  const idx = value.lastIndexOf(delimiter);
  return idx === -1 ? value : value.slice(idx + delimiter.length);
}
