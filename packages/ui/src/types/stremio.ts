export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  logo?: string;
  background?: string;
  resources: (string | { name: string; types: string[]; idPrefixes?: string[] })[];
  types: string[];
  catalogs: StremioManifestCatalog[];
  behaviorHints?: { adult?: boolean; p2p?: boolean; configurable?: boolean; configurationRequired?: boolean };
}

export interface StremioManifestCatalog {
  type: string;
  id: string;
  name: string;
  extra?: { name: string; isRequired?: boolean; options?: string[]; optionsLimit?: number }[];
  extraSupported?: string[];
  extraRequired?: string[];
}

export interface InstalledAddon {
  id: string;
  baseUrl: string;
  manifest: StremioManifest;
  installedAt: number;
  isDefault?: boolean;
  enabled?: boolean;
}

export interface StremioCatalogResponse {
  metas: StremioMetaPreview[];
  nextSkip?: number;
  cacheMaxAge?: number;
  staleRevalidate?: number;
  staleError?: number;
}

export interface StremioMetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  posterShape?: 'square' | 'poster' | 'landscape';
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  runtime?: string;
  genres?: string[];
  imdbRating?: string;
  year?: number;
  trailer?: string;
  links?: { name: string; category: string; url: string }[];
}

export interface StremioMeta extends StremioMetaPreview {
  cast?: string[];
  director?: string[];
  writer?: string[];
  awards?: string;
  dvdRelease?: string;
  released?: string;
  country?: string;
  language?: string;
  originalLanguage?: string;
  slug?: string;
  behaviorHints?: { defaultVideoId?: string; hasScheduledVideos?: boolean };
  videos?: StremioVideo[];
}

export interface StremioVideo {
  id: string;
  title: string;
  released: string;
  season?: number;
  episode?: number;
  thumbnail?: string;
  description?: string;
  overview?: string;
  streams?: StremioStream[];
}

export interface StremioStream {
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  name?: string;
  title?: string;
  description?: string;
  subtitles?: { id: string; url: string; lang: string }[];
  behaviorHints?: { notWebReady?: boolean; bingeGroup?: string; proxyHeaders?: Record<string, string>; videoHash?: string; videoSize?: number; filename?: string };
  addonName?: string;
}

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
  label?: string;
  /** OpenSubtitles-style add-ons name the underlying file (e.g. "Example.Movie.en.srt"). */
  subtitleFileName?: string;
  addonName?: string;
}

export interface StremioStreamBadge {
  label: string;
  color: string;
  textColor?: string;
  imageUrl?: string;
  borderColor?: string;
}

export interface ImportedBadgeFilter {
  id: string;
  groupId: string;
  name: string;
  pattern: string;
  imageURL: string;
  isEnabled: boolean;
  tagColor: string;
  tagStyle: string;
  textColor: string;
  borderColor: string;
  type?: string;
}

export interface ImportedBadgeGroup {
  id: string;
  name: string;
  color: string;
  isExpanded: boolean;
  borderColor?: string;
}

export interface ImportedBadgePayload {
  filters: ImportedBadgeFilter[];
  groups: ImportedBadgeGroup[];
}

export interface BadgeSource {
  url: string;
  name: string;
  payload: ImportedBadgePayload;
  isActive: boolean;
  isDefault?: boolean;
}

export type StremioStreamPickerMode = 'modal' | 'autoplay';

export type StreamAutoPlayMode = 'manual' | 'first-stream' | 'regex-match';
export type StreamAutoPlaySourceScope = 'all' | 'installed-addons' | 'enabled-plugins';
