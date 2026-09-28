import { XtreamClient, StalkerClient } from '@ynotv/local-adapter';
import type { StoredChannel } from '../db';
import type { VodPlayInfo } from '../types/media';

export interface ProviderConnectionStats {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  streamTitle?: string;
  status: 'active' | 'expired' | 'disabled' | 'banned' | 'error' | 'unknown';
  statusText: string;
  activeConnections: string;
  maxConnections: string;
  expiryDate?: string;
  username?: string;
  mac?: string;
  serverUrl?: string;
  isCachedFallback?: boolean;
  rawError?: string;
}

/**
 * Normalizes vendor expiry strings and timestamps into human-readable format
 * (e.g. "January 27, 2027" or "Unlimited").
 */
export function formatExpiryDateDisplay(expDate?: string | number | null): string {
  if (!expDate || expDate === 'null' || expDate === '0' || expDate === 0) {
    return 'Unlimited';
  }
  const str = String(expDate).trim();
  if (!str) return 'Unlimited';

  // Check if it's a numeric unix timestamp in seconds
  const ts = parseInt(str, 10);
  if (!isNaN(ts) && ts > 0 && str.length >= 9 && str.length <= 11) {
    const d = new Date(ts * 1000);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
  }

  // Try standard Date parsing for string representations (e.g. "August 18, 2026 at 12:00 am")
  const parsed = new Date(str.replace(' at ', ' '));
  if (!isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  return str;
}

/**
 * Formats a clean stream or channel title for display in the HUD overlay.
 */
export function resolveStreamTitle(
  channel?: StoredChannel | null,
  vodInfo?: VodPlayInfo | null,
  catchupInfo?: { programTitle: string } | null
): string | undefined {
  if (channel) {
    const channelName = channel.alias || channel.name;
    if (catchupInfo?.programTitle) {
      return `${channelName} · ${catchupInfo.programTitle}`;
    }
    return channelName;
  }
  if (vodInfo) {
    if (vodInfo.type === 'series') {
      const ep = vodInfo.episodeInfo || `S${vodInfo.seasonNum || 1} E${vodInfo.episodeNum || 1}`;
      return `${vodInfo.title} · ${ep}`;
    }
    return `${vodInfo.title}${vodInfo.year ? ` (${vodInfo.year})` : ''}`;
  }
  return undefined;
}

/**
 * Strips password and sensitive parameters from server URLs for clean HUD display.
 */
export function sanitizeServerDisplayUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url.replace(/\/\/([^:]+):([^@]+)@/, '//');
  }
}

/**
 * Fetches fresh connection and account status from the provider API
 * for the currently playing stream.
 */
export async function fetchProviderConnectionInfo(
  sourceId: string,
  channel?: StoredChannel | null,
  vodInfo?: VodPlayInfo | null,
  catchupInfo?: { programTitle: string } | null
): Promise<ProviderConnectionStats> {
  const streamTitle = resolveStreamTitle(channel, vodInfo, catchupInfo);

  // Handle special virtual sources
  if (sourceId === 'jellyfin') {
    return {
      sourceId,
      sourceName: 'Jellyfin',
      sourceType: 'Jellyfin Server',
      streamTitle,
      status: 'active',
      statusText: 'Active',
      activeConnections: '1',
      maxConnections: 'Unlimited',
      expiryDate: 'Unlimited',
    };
  }

  if (sourceId === 'stremio') {
    return {
      sourceId,
      sourceName: vodInfo?.addonName ? `Stremio (${vodInfo.addonName})` : 'Stremio',
      sourceType: 'Stremio Addon',
      streamTitle,
      status: 'active',
      statusText: 'Active',
      activeConnections: '1',
      maxConnections: 'Unlimited',
      expiryDate: 'Unlimited',
    };
  }

  if (sourceId === 'nuvio') {
    return {
      sourceId,
      sourceName: 'Nuvio',
      sourceType: 'Nuvio Stream',
      streamTitle,
      status: 'active',
      statusText: 'Active',
      activeConnections: '1',
      maxConnections: 'Unlimited',
      expiryDate: 'Unlimited',
    };
  }

  if (sourceId === 'local') {
    return {
      sourceId,
      sourceName: 'Local Storage',
      sourceType: 'Local Media',
      streamTitle,
      status: 'active',
      statusText: 'Active',
      activeConnections: '1',
      maxConnections: 'Unlimited',
      expiryDate: 'Unlimited',
    };
  }

  // Fetch source configuration from local storage
  if (!window.storage?.getSource) {
    throw new Error('Storage service is unavailable');
  }

  const sourceRes = await window.storage.getSource(sourceId);
  const source = sourceRes?.data;

  if (!source) {
    throw new Error(`Source not found (ID: ${sourceId})`);
  }

  const sourceName = source.name || 'IPTV Provider';
  const cleanServerUrl = sanitizeServerDisplayUrl(source.url);

  // 1. Xtream Codes Provider
  if (source.type === 'xtream') {
    try {
      const client = new XtreamClient(
        {
          baseUrl: source.url,
          username: source.username || '',
          password: source.password || '',
          userAgent: source.user_agent,
        },
        source.id
      );

      const auth = await client.authenticate();
      const user = auth?.user_info;

      if (!user) {
        throw new Error('Invalid authentication response from Xtream server');
      }

      let status: ProviderConnectionStats['status'] = 'active';
      let statusText = 'Active';

      if (user.auth === 0) {
        status = 'error';
        statusText = user.message || 'Auth Failed';
      } else {
        const raw = (user.status || '').toLowerCase().trim();
        if (raw === 'active') {
          status = 'active';
          statusText = 'Active';
        } else if (raw === 'expired') {
          status = 'expired';
          statusText = 'Expired';
        } else if (raw === 'banned') {
          status = 'banned';
          statusText = 'Banned';
        } else if (raw === 'disabled') {
          status = 'disabled';
          statusText = 'Disabled';
        } else if (user.status) {
          statusText = user.status;
        }
      }

      const activeConnections =
        user.active_cons !== undefined && user.active_cons !== null
          ? String(user.active_cons)
          : '1';

      const maxConnections =
        user.max_connections !== undefined && user.max_connections !== null && String(user.max_connections).trim() !== '' && String(user.max_connections) !== '0'
          ? String(user.max_connections)
          : source.max_connections
          ? String(source.max_connections)
          : 'Unlimited';

      return {
        sourceId: source.id,
        sourceName,
        sourceType: 'Xtream Codes',
        streamTitle,
        status,
        statusText,
        activeConnections,
        maxConnections,
        expiryDate: formatExpiryDateDisplay(user.exp_date),
        username: user.username || source.username,
        serverUrl: cleanServerUrl,
      };
    } catch (err: any) {
      // Fallback to cached metadata if live fetch fails
      const meta = (source as any).meta;
      if (meta?.active_cons || meta?.max_connections || meta?.expiry_date) {
        return {
          sourceId: source.id,
          sourceName,
          sourceType: 'Xtream Codes',
          streamTitle,
          status: 'active',
          statusText: 'Active',
          activeConnections: meta.active_cons ? String(meta.active_cons) : '1',
          maxConnections: meta.max_connections && String(meta.max_connections) !== '0'
            ? String(meta.max_connections)
            : source.max_connections
            ? String(source.max_connections)
            : 'Unlimited',
          expiryDate: formatExpiryDateDisplay(meta.expiry_date),
          username: source.username,
          serverUrl: cleanServerUrl,
          isCachedFallback: true,
          rawError: err?.message || String(err),
        };
      }
      throw err;
    }
  }

  // 2. Stalker Portal Provider
  if (source.type === 'stalker') {
    try {
      const client = new StalkerClient(
        {
          baseUrl: source.url,
          mac: source.mac || '',
          userAgent: source.user_agent,
        },
        source.id
      );

      const acc = await client.getAccountInfo();
      const meta = (source as any).meta;

      if (acc.error && !meta?.expiry_date) {
        throw new Error(acc.error);
      }

      const hasExpiry = Boolean(acc.expiry && acc.expiry !== 'null' && acc.expiry !== '0');
      const expiryDate = hasExpiry
        ? formatExpiryDateDisplay(acc.expiry)
        : meta?.expiry_date
        ? formatExpiryDateDisplay(meta.expiry_date)
        : 'N/A';
      const isFallback = (!hasExpiry && Boolean(meta?.expiry_date)) || Boolean(acc.error);

      return {
        sourceId: source.id,
        sourceName,
        sourceType: 'Stalker Portal',
        streamTitle,
        status: 'active',
        statusText: 'Active',
        activeConnections: '1',
        maxConnections: source.max_connections ? String(source.max_connections) : 'N/A',
        mac: acc.mac || source.mac,
        expiryDate,
        serverUrl: cleanServerUrl,
        isCachedFallback: isFallback,
      };
    } catch (err: any) {
      const meta = (source as any).meta;
      if (meta?.expiry_date) {
        return {
          sourceId: source.id,
          sourceName,
          sourceType: 'Stalker Portal',
          streamTitle,
          status: 'active',
          statusText: 'Active',
          activeConnections: '1',
          maxConnections: source.max_connections ? String(source.max_connections) : 'N/A',
          mac: source.mac,
          expiryDate: formatExpiryDateDisplay(meta.expiry_date),
          serverUrl: cleanServerUrl,
          isCachedFallback: true,
          rawError: err?.message || String(err),
        };
      }
      throw err;
    }
  }

  // 3. M3U Playlist Provider
  if (source.type === 'm3u') {
    // If the M3U source has Xtream catchup credentials, query live Xtream stats
    const catchup = (source as any).xtream_catchup;
    if (catchup?.url && catchup?.username && catchup?.password) {
      try {
        const client = new XtreamClient(
          {
            baseUrl: catchup.url,
            username: catchup.username,
            password: catchup.password,
            userAgent: source.user_agent,
          },
          source.id
        );
        const auth = await client.authenticate();
        const user = auth?.user_info;

        if (user && user.auth !== 0) {
          return {
            sourceId: source.id,
            sourceName,
            sourceType: 'M3U (Xtream Catchup)',
            streamTitle,
            status: 'active',
            statusText: user.status ? user.status.charAt(0).toUpperCase() + user.status.slice(1) : 'Active',
            activeConnections: user.active_cons !== undefined && user.active_cons !== null ? String(user.active_cons) : '1',
            maxConnections: user.max_connections !== undefined && user.max_connections !== null && String(user.max_connections) !== '0' ? String(user.max_connections) : (source.max_connections ? String(source.max_connections) : 'Unlimited'),
            expiryDate: formatExpiryDateDisplay(user.exp_date),
            username: user.username || catchup.username,
            serverUrl: sanitizeServerDisplayUrl(catchup.url) || cleanServerUrl,
          };
        }
      } catch (catchupErr) {
        console.debug('[ConnectionInfo] M3U Xtream catchup probe failed:', catchupErr);
      }
    }

    const meta = (source as any).meta;
    const maxConnections = source.max_connections
      ? String(source.max_connections)
      : meta?.max_connections
      ? String(meta.max_connections)
      : 'Unlimited';

    return {
      sourceId: source.id,
      sourceName,
      sourceType: 'M3U Playlist',
      streamTitle,
      status: source.enabled ? 'active' : 'disabled',
      statusText: source.enabled ? 'Active' : 'Disabled',
      activeConnections: '1',
      maxConnections,
      expiryDate: formatExpiryDateDisplay(meta?.expiry_date),
      serverUrl: cleanServerUrl,
    };
  }

  // Generic fallback
  return {
    sourceId: source.id,
    sourceName,
    sourceType: source.type.toUpperCase(),
    streamTitle,
    status: source.enabled ? 'active' : 'disabled',
    statusText: source.enabled ? 'Active' : 'Disabled',
    activeConnections: '1',
    maxConnections: source.max_connections ? String(source.max_connections) : 'Unlimited',
    expiryDate: 'Unlimited',
    serverUrl: cleanServerUrl,
  };
}

/**
 * Standalone countdown timer controller for auto-dismiss overlays.
 * Decouples timer ticking from component callback identity changes, preventing
 * timer starvation caused by frequent parent re-renders.
 */
export class AutoDismissController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private secondsRemaining: number;
  private isPaused: boolean = false;
  private onClose: () => void;
  private onTick?: (sec: number) => void;

  constructor(options: {
    initialSeconds?: number;
    onClose: () => void;
    onTick?: (sec: number) => void;
  }) {
    this.secondsRemaining = options.initialSeconds ?? 5;
    this.onClose = options.onClose;
    this.onTick = options.onTick;
  }

  updateOnClose(newOnClose: () => void) {
    this.onClose = newOnClose;
  }

  setPaused(paused: boolean) {
    this.isPaused = paused;
  }

  getIsPaused(): boolean {
    return this.isPaused;
  }

  /**
   * Set the remaining seconds without touching the pause state. Pausing is owned
   * by setPaused() and start(), so a Refresh click while the pointer is over the
   * card must not resume a hover-paused countdown.
   */
  reset(seconds = 5) {
    this.secondsRemaining = seconds;
    this.onTick?.(this.secondsRemaining);
  }

  start() {
    // A fresh start can never inherit a stale hover pause (e.g. the card was
    // closed while the pointer was still over it, then reopened).
    this.isPaused = false;
    this.stop();
    this.timer = setInterval(() => {
      if (this.isPaused) return;
      if (this.secondsRemaining <= 1) {
        this.stop();
        this.secondsRemaining = 0;
        this.onTick?.(0);
        this.onClose();
      } else {
        this.secondsRemaining -= 1;
        this.onTick?.(this.secondsRemaining);
      }
    }, 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSecondsRemaining(): number {
    return this.secondsRemaining;
  }

  getIsRunning(): boolean {
    return this.timer !== null;
  }
}

