import Store from 'electron-store';
import { safeStorage } from 'electron';
import type { Source } from '@sbtltv/core';

// Store schema - passwords and API keys stored encrypted
interface StoreSchema {
  sources: StoredSource[];
  settings: StoredSettings;
}

// Source as stored (password encrypted)
interface StoredSource {
  id: string;
  name: string;
  type: 'xtream' | 'm3u' | 'stalker' | 'epg';
  url: string;
  enabled: boolean;
  epg_url?: string;
  auto_load_epg?: boolean; // Auto-fetch EPG from source (default: true for xtream)
  user_agent?: string;     // Custom User-Agent
  epg_timeshift_hours?: number; // EPG time offset
  // Xtream-specific (encrypted)
  username?: string;
  encryptedPassword?: string; // Base64 encoded encrypted buffer
  backup_credentials?: Array<{ username: string; encryptedPassword: string }>;
  // Stalker-specific
  mac?: string;
  backup_macs?: string[];
}

interface AppSettings {
  theme: 'dark' | 'light';
  lastSourceId?: string;
  tmdbApiKey?: string;  // Decrypted value returned to callers
  vodRefreshHours: number;  // 0 = manual only, default 24
  epgRefreshHours: number;  // 0 = manual only, default 6
  movieGenresEnabled?: number[];   // TMDB genre IDs to show as carousels
  seriesGenresEnabled?: number[];  // TMDB genre IDs for TV shows
  posterDbApiKey?: string;         // RatingPosterDB API key
  rpdbBackdropsEnabled?: boolean;  // Use RPDB for backdrop images (tier 2+)
  allowLanSources?: boolean;       // Allow requests to LAN IPs (SSRF protection bypass)
  debugLoggingEnabled?: boolean;   // Write verbose logs to file for debugging
  channelSortOrder?: 'alphabetical' | 'number';  // Channel list ordering (default: alphabetical)
  tmdbMatchingEnabled?: boolean;   // Enable automatic TMDB export download and matching (default: true)
  lastTmdbMatch?: number;          // Timestamp of last successful TMDB match
  shortcuts?: Record<string, string>; // Custom keyboard shortcuts
}

// Internal storage format (encrypted)
interface StoredSettings {
  theme: 'dark' | 'light';
  lastSourceId?: string;
  encryptedTmdbApiKey?: string;  // Base64 encoded encrypted buffer
  vodRefreshHours: number;
  epgRefreshHours: number;
  movieGenresEnabled?: number[];   // TMDB genre IDs to show as carousels
  seriesGenresEnabled?: number[];  // TMDB genre IDs for TV shows
  encryptedPosterDbApiKey?: string; // Base64 encoded encrypted buffer
  rpdbBackdropsEnabled?: boolean;   // Use RPDB for backdrop images
  allowLanSources?: boolean;        // Allow requests to LAN IPs
  debugLoggingEnabled?: boolean;    // Write verbose logs to file
  channelSortOrder?: 'alphabetical' | 'number';  // Channel list ordering
  tmdbMatchingEnabled?: boolean;    // Enable automatic TMDB matching
  lastTmdbMatch?: number;           // Timestamp of last match
  shortcuts?: Record<string, string>; // Custom keyboard shortcuts
}

const store = new Store<StoreSchema>({
  name: 'sbtltv-config',
  defaults: {
    sources: [],
    settings: {
      theme: 'dark',
      vodRefreshHours: 24,  // Default: refresh VOD every 24 hours
      epgRefreshHours: 6,   // Default: refresh EPG every 6 hours
      tmdbMatchingEnabled: true, // Default: enabled
    },
  },
});

/**
 * Encrypt a password using OS-level encryption
 */
function encryptPassword(password: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: base64 encode (not secure, but works)
    console.warn('[storage] safeStorage not available, using base64 fallback');
    return Buffer.from(password).toString('base64');
  }
  const encrypted = safeStorage.encryptString(password);
  return encrypted.toString('base64');
}

/**
 * Decrypt a password
 */
function decryptPassword(encryptedBase64: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: base64 decode
    return Buffer.from(encryptedBase64, 'base64').toString('utf-8');
  }
  const encrypted = Buffer.from(encryptedBase64, 'base64');
  return safeStorage.decryptString(encrypted);
}

/**
 * Get all sources (with passwords decrypted)
 */
export function getSources(): Source[] {
  const stored = store.get('sources', []);
  return stored.map((s) => {
    const source: Source = {
      id: s.id,
      name: s.name,
      type: s.type,
      url: s.url,
      enabled: s.enabled,
      epg_url: s.epg_url,
      auto_load_epg: s.auto_load_epg,
      user_agent: s.user_agent,
      epg_timeshift_hours: s.epg_timeshift_hours,
    };
    if (s.type === 'xtream' && s.username) {
      source.username = s.username;
      if (s.encryptedPassword) {
        source.password = decryptPassword(s.encryptedPassword);
      }
      if (s.backup_credentials) {
        source.backup_credentials = s.backup_credentials.map(c => ({
          username: c.username,
          password: decryptPassword(c.encryptedPassword)
        }));
      }
    }
    if (s.type === 'stalker') {
      source.mac = s.mac;
      if (s.backup_macs) source.backup_macs = s.backup_macs;
    }
    return source;
  });
}

/**
 * Get a single source by ID
 */
export function getSource(id: string): Source | undefined {
  const sources = getSources();
  return sources.find((s) => s.id === id);
}

/**
 * Add or update a source
 */
export function saveSource(source: Source): void {
  console.log('[storage] saveSource called with:', source.name, 'UA:', source.user_agent);
  const sources = store.get('sources', []);
  const stored: StoredSource = {
    id: source.id,
    name: source.name,
    type: source.type,
    url: source.url,
    enabled: source.enabled,
    auto_load_epg: source.auto_load_epg,
    user_agent: source.user_agent,
    epg_timeshift_hours: source.epg_timeshift_hours,
  };

  // Only assign epg_url if it's present in the source object
  if (source.epg_url) {
    stored.epg_url = source.epg_url;
  }

  console.log('[storage] Stored object prepared:', JSON.stringify(stored));

  if (source.type === 'xtream') {
    stored.username = source.username;
    if (source.password) {
      stored.encryptedPassword = encryptPassword(source.password);
    }
    if (source.backup_credentials) {
      stored.backup_credentials = source.backup_credentials.map(c => ({
        username: c.username,
        encryptedPassword: encryptPassword(c.password)
      }));
    }
  }

  if (source.type === 'stalker') {
    stored.mac = source.mac;
    stored.backup_macs = source.backup_macs;
  }

  const existingIndex = sources.findIndex((s) => s.id === source.id);
  if (existingIndex >= 0) {
    console.log('[storage] Updating existing source at index:', existingIndex);
    sources[existingIndex] = stored;
  } else {
    console.log('[storage] Adding new source');
    sources.push(stored);
  }

  store.set('sources', sources);
  console.log('[storage] Store saved. New sources count:', sources.length);
}

/**
 * Delete a source
 */
export function deleteSource(id: string): void {
  const sources = store.get('sources', []);
  store.set(
    'sources',
    sources.filter((s) => s.id !== id)
  );
}

/**
 * Get app settings (with TMDB API key decrypted)
 */
export function getSettings(): AppSettings {
  const stored = store.get('settings');
  const result: AppSettings = {
    theme: stored.theme,
    lastSourceId: stored.lastSourceId,
    vodRefreshHours: stored.vodRefreshHours ?? 24,
    epgRefreshHours: stored.epgRefreshHours ?? 6,
    movieGenresEnabled: stored.movieGenresEnabled,
    seriesGenresEnabled: stored.seriesGenresEnabled,
  };
  if (stored.encryptedTmdbApiKey) {
    result.tmdbApiKey = decryptPassword(stored.encryptedTmdbApiKey);
  }
  if (stored.encryptedPosterDbApiKey) {
    result.posterDbApiKey = decryptPassword(stored.encryptedPosterDbApiKey);
  }
  result.rpdbBackdropsEnabled = stored.rpdbBackdropsEnabled ?? false;
  result.allowLanSources = stored.allowLanSources ?? false;
  result.debugLoggingEnabled = stored.debugLoggingEnabled ?? false;
  result.channelSortOrder = stored.channelSortOrder ?? 'alphabetical';
  result.tmdbMatchingEnabled = stored.tmdbMatchingEnabled ?? true;
  result.lastTmdbMatch = stored.lastTmdbMatch;
  result.shortcuts = stored.shortcuts;
  return result;
}

/**
 * Update app settings (encrypts TMDB API key)
 */
export function updateSettings(settings: Partial<AppSettings>): void {
  const current = store.get('settings');
  const updated: StoredSettings = { ...current };

  if (settings.theme !== undefined) updated.theme = settings.theme;
  if (settings.lastSourceId !== undefined) updated.lastSourceId = settings.lastSourceId;
  if (settings.tmdbApiKey !== undefined) {
    updated.encryptedTmdbApiKey = settings.tmdbApiKey ? encryptPassword(settings.tmdbApiKey) : undefined;
  }
  if (settings.vodRefreshHours !== undefined) updated.vodRefreshHours = settings.vodRefreshHours;
  if (settings.epgRefreshHours !== undefined) updated.epgRefreshHours = settings.epgRefreshHours;
  if (settings.movieGenresEnabled !== undefined) updated.movieGenresEnabled = settings.movieGenresEnabled;
  if (settings.seriesGenresEnabled !== undefined) updated.seriesGenresEnabled = settings.seriesGenresEnabled;
  if (settings.posterDbApiKey !== undefined) {
    updated.encryptedPosterDbApiKey = settings.posterDbApiKey ? encryptPassword(settings.posterDbApiKey) : undefined;
  }
  if (settings.rpdbBackdropsEnabled !== undefined) {
    updated.rpdbBackdropsEnabled = settings.rpdbBackdropsEnabled;
  }
  if (settings.allowLanSources !== undefined) {
    updated.allowLanSources = settings.allowLanSources;
  }
  if (settings.debugLoggingEnabled !== undefined) {
    updated.debugLoggingEnabled = settings.debugLoggingEnabled;
  }
  if (settings.channelSortOrder !== undefined) {
    updated.channelSortOrder = settings.channelSortOrder;
  }
  if (settings.tmdbMatchingEnabled !== undefined) {
    updated.tmdbMatchingEnabled = settings.tmdbMatchingEnabled;
  }
  if (settings.tmdbMatchingEnabled !== undefined) {
    updated.tmdbMatchingEnabled = settings.tmdbMatchingEnabled;
  }
  if (settings.lastTmdbMatch !== undefined) {
    updated.lastTmdbMatch = settings.lastTmdbMatch;
  }
  if (settings.shortcuts !== undefined) {
    updated.shortcuts = settings.shortcuts;
  }

  store.set('settings', updated);
}

/**
 * Clear all data (for debugging/reset)
 */
export function clearAll(): void {
  store.clear();
}

/**
 * Check if secure encryption is available
 * Returns false on Linux without a keyring daemon
 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}
