// Type declarations for APIs exposed by Electron preload script

export interface MpvStatus {
  playing: boolean;
  volume: number;
  muted: boolean;
  position: number;
  duration: number;
}

export interface MpvResult {
  success?: boolean;
  error?: string;
}

export interface MpvApi {
  load: (url: string, options?: { userAgent?: string }) => Promise<MpvResult>;
  play: () => Promise<MpvResult>;
  pause: () => Promise<MpvResult>;
  togglePause: () => Promise<MpvResult>;
  stop: () => Promise<MpvResult>;
  setVolume: (volume: number) => Promise<MpvResult>;
  toggleMute: () => Promise<MpvResult>;
  seek: (seconds: number) => Promise<MpvResult>;
  getStatus: () => Promise<MpvStatus>;
  cycleSubtitle: () => Promise<MpvResult>;
  cycleAudio: () => Promise<MpvResult>;
  toggleStats: () => Promise<MpvResult>;
  setProperty: (name: string, value: unknown) => Promise<MpvResult>;
  onReady: (callback: (ready: boolean) => void) => void;
  onStatus: (callback: (status: MpvStatus) => void) => void;
  onError: (callback: (error: string) => void) => void;
  removeAllListeners: () => void;
}

export interface ElectronWindowApi {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  getSize: () => Promise<[number, number]>;
  setSize: (width: number, height: number) => Promise<void>;
}

export interface StorageResult<T = void> {
  success?: boolean;
  error?: string;
  data?: T;
}

export interface AppSettings {
  theme: 'dark' | 'light';
  lastSourceId?: string;
  tmdbApiKey?: string;
  vodRefreshHours?: number;  // 0 = manual only, default 24
  epgRefreshHours?: number;  // 0 = manual only, default 6
  movieGenresEnabled?: number[];   // TMDB genre IDs to show as carousels
  seriesGenresEnabled?: number[];  // TMDB genre IDs for TV shows
  posterDbApiKey?: string;         // RatingPosterDB API key for rating posters
  rpdbBackdropsEnabled?: boolean;  // Use RPDB backdrops (requires tier 2+ key)
  allowLanSources?: boolean;       // Allow requests to LAN IPs (SSRF bypass)
  debugLoggingEnabled?: boolean;   // Write verbose logs to file for debugging
  channelSortOrder?: 'alphabetical' | 'number';  // Channel list ordering
  tmdbMatchingEnabled?: boolean;   // Enable automatic TMDB matching on startup
  lastTmdbMatch?: number;          // Timestamp of last successful TMDB match
  shortcuts?: ShortcutsMap;        // Custom keyboard shortcuts
}

export type ShortcutAction =
  | 'togglePlay'
  | 'toggleMute'
  | 'cycleSubtitle'
  | 'cycleAudio'
  | 'toggleStats'
  | 'toggleGuide'
  | 'toggleCategories'
  | 'close'
  | 'seekForward'
  | 'seekBackward';

export type ShortcutsMap = Partial<Record<ShortcutAction, string>>;

export interface Source {
  id: string;
  name: string;
  type: 'xtream' | 'm3u' | 'stalker' | 'epg';
  url: string;
  enabled: boolean;
  epg_url?: string;
  auto_load_epg?: boolean;
  username?: string;
  password?: string;
  mac?: string;
  user_agent?: string;
  epg_timeshift_hours?: number;
  backup_macs?: string[];  // Stalker backup MAC addresses
  backup_credentials?: Array<{  // Xtream backup credentials
    username: string;
    password: string;
  }>;
}

export interface M3UImportResult {
  content: string;
  fileName: string;
}

export interface StorageApi {
  getSources: () => Promise<StorageResult<Source[]>>;
  getSource: (id: string) => Promise<StorageResult<Source | undefined>>;
  saveSource: (source: Source) => Promise<StorageResult>;
  deleteSource: (id: string) => Promise<StorageResult>;
  getSettings: () => Promise<StorageResult<AppSettings>>;
  updateSettings: (settings: Partial<AppSettings>) => Promise<StorageResult>;
  isEncryptionAvailable: () => Promise<StorageResult<boolean>>;
  importM3UFile: () => Promise<StorageResult<M3UImportResult> & { canceled?: boolean }>;
  saveJsonFile: (data: string, defaultName: string) => Promise<StorageResult<{ filePath: string }> & { canceled?: boolean }>;
  openJsonFile: () => Promise<StorageResult<string> & { canceled?: boolean }>;
}

export interface FetchProxyResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

export interface FetchProxyApi {
  fetch: (url: string, options?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<StorageResult<FetchProxyResponse>>;
  fetchBinary: (url: string) => Promise<StorageResult<string>>; // Returns base64-encoded data
}

export interface PlatformApi {
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
}

export interface DebugApi {
  getLogPath: () => Promise<StorageResult<string>>;
  logFromRenderer: (message: string) => Promise<StorageResult>;
  openLogFolder: () => Promise<StorageResult>;
}

declare global {
  interface Window {
    mpv?: MpvApi;
    electronWindow?: ElectronWindowApi;
    storage?: StorageApi;
    fetchProxy?: FetchProxyApi;
    platform?: PlatformApi;
    debug?: DebugApi;
  }
}

export { };
