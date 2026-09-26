import { useState, useEffect, useRef, useCallback } from 'react';
import type { RetryState } from '../components/StreamRetryOverlay';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { StoredChannel } from '../db';
import { getFailoverCandidatesAfter, getPrimaryChannelForGroup } from '../services/failover-groups';
import type { VodPlayInfo } from '../types/media';
import { Bridge, registerOnAppClose, unregisterOnAppClose, resolveSubAssOverride } from '../services/tauri-bridge';
import { resolvePlayUrl } from '../services/stream-resolver';
import { addToRecentChannels } from '../utils/recentChannels';
import { db, recordVodWatch, updateVodWatchProgress, getVodWatchProgress, recordEpisodeWatch, getEpisodeProgress, updateDvrRecordingProgress } from '../db';
import { useSettingsStore } from '../stores/settingsStore';
import { useDownloadStore } from '../stores/downloadStore';
import { useStremioWatchStore } from '../stores/stremioWatchStore';
import { useNuvioAuthStore } from '../stores/nuvioAuthStore';
import { fetchNuvioWatchProgress, pushNuvioWatchProgress, type NuvioWatchProgressSyncEntry } from '../services/nuvio-api';
import type { useMpvListeners } from './useMpvListeners';
import { logInfo, logWarn, logError } from '../utils/logger';
import { toSubSourceLang, fromSubSourceLang, LANG_MAP } from '../services/subsource';
import { snapshotPlaylistProgress } from '../utils/playlistPlayback';
import {
  clearSubtitleIntent,
  getSubtitleIntent,
  planSubtitleAutoSelect,
  restorableSubtitleTrackId,
} from '../utils/subtitleIntent';
import i18n, { translateNativeError } from '../i18n';

/**
 * Push Nuvio watch progress for the given item, building the entry from the
 * same fields the old per-tick sync used. Mirrors NuvioDesktop's cadence:
 * remote pushes happen only on discrete events (stop/pause/seek/natural end),
 * never on a timer. Local in-app progress saving is unaffected.
 */
export async function pushNuvioPlaybackProgress(
  info: VodPlayInfo | null,
  positionSec: number,
  durationSec: number
): Promise<void> {
  if (!info || info.source_id !== 'nuvio') return;
  if (!(positionSec > 0) || !(durationSec > 0)) return;
  const isSeries = info.type === 'series';
  const contentId = isSeries ? (info.seriesId || info.mediaId) : info.mediaId;
  if (!contentId) return;
  const entry: NuvioWatchProgressSyncEntry = {
    content_id: contentId,
    content_type: isSeries ? 'series' : 'movie',
    video_id: info.episodeId || info.mediaId || contentId,
    season: isSeries ? (info.seasonNum ?? null) : null,
    episode: isSeries ? (info.episodeNum ?? null) : null,
    position: Math.floor(positionSec * 1000),
    duration: Math.floor(durationSec * 1000),
    last_watched: Date.now(),
    progress_key:
      isSeries && info.seasonNum != null && info.episodeNum != null
        ? `${contentId}_s${info.seasonNum}e${info.episodeNum}`
        : info.mediaId || contentId,
  };
  const nuvioAuth = useNuvioAuthStore.getState();
  const token = nuvioAuth.token;
  const profile = nuvioAuth.activeProfile;
  if (!token || !profile) return;
  try {
    await pushNuvioWatchProgress(token, profile.profile_index, [entry]);
    window.dispatchEvent(new CustomEvent('ynotv:nuvio-sync-required'));
  } catch (e) {
    logWarn('[NuvioProgress] Failed to sync progress:', e);
  }
}

/**
 * Apply saved subtitle settings to MPV.
 */
async function applySubtitleSettings() {
  try {
    const ss = useSettingsStore.getState().subtitleSettings;
    if (!ss) return;

    const size = ss.defaultSize || 35;
    await Bridge.setSubtitleSize(size).catch(() => {});

    const effectiveOverride = resolveSubAssOverride(ss.subAssOverride);
    await Bridge.setSubAssOverride(effectiveOverride).catch(() => {});
    await Bridge.setProperty('sub-ass-scale-with-window', true).catch(() => {});

    const align = ss.subAlign || 'center';
    await Bridge.setSubtitleAlign(align).catch(() => {});

    if (ss.subColor) {
      await Bridge.setSubtitleColor(ss.subColor).catch(() => {});
    }
    if (ss.subBackgroundEnabled && ss.subBackgroundColor) {
      const opacityPercent = ss.subBackgroundOpacity ?? 80;
      await Bridge.setSubtitleBackColor(ss.subBackgroundColor, opacityPercent).catch(() => {});
      await Bridge.setSubtitleBorderStyle('background-box').catch(() => {});
    } else if (ss.subBackgroundEnabled === false) {
      await Bridge.setSubtitleBackColor(ss.subBackgroundColor ?? '#000000', 0).catch(() => {});
      await Bridge.setSubtitleBorderStyle('outline-and-shadow').catch(() => {});
    }
    if (ss.subOutlineColor) {
      await Bridge.setSubtitleBorderColor(ss.subOutlineColor).catch(() => {});
    }
    if (ss.subDelay) {
      await Bridge.setSubtitleDelay(ss.subDelay).catch(() => {});
    }
    if (ss.subVerticalOffset !== undefined) {
      const pos = Math.max(0, Math.min(100, ss.subVerticalOffset));
      await Bridge.setSubtitlePos(pos).catch(() => {});
    }
    if (ss.audioDevice) {
      await Bridge.setProperty('audio-device', ss.audioDevice).catch(() => {});
    }
  } catch (e) {
    console.warn('[Playback] Failed to apply subtitle settings:', e);
  }
}

/**
 * Checks if a URL points to localhost or a private local network IP.
 */
function isLocalUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;
    
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
    
    // IPv4 local network patterns
    if (hostname.startsWith('127.')) return true;
    if (hostname.startsWith('10.')) return true;
    if (hostname.startsWith('192.168.')) return true;
    
    // 172.16.x.x to 172.31.x.x
    const parts = hostname.split('.');
    if (parts.length === 4 && parts[0] === '172') {
      const secondPart = parseInt(parts[1], 10);
      if (secondPart >= 16 && secondPart <= 31) {
        return true;
      }
    }
    
    return false;
  } catch {
    return false;
  }
}

/**
 * Checks if a URL is a YouTube video URL (trailers, streams).
 */
function isYouTubeUrl(urlString?: string | null): boolean {
  if (!urlString) return false;
  return /^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(urlString);
}

/**
 * Generate fallback stream URLs when primary fails.
 * Live TV: .ts → .m3u8 → .m3u
 * VOD: provider extension → .m3u8 → .ts
 */
function getStreamFallbacks(url: string, isLive: boolean): string[] {
  if (isYouTubeUrl(url)) return [];
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;

    const extMatch = pathname.match(/\.([a-z0-9]+)$/i);
    if (!extMatch) return [];

    const currentExt = extMatch[1].toLowerCase();
    const basePathname = pathname.slice(0, -currentExt.length - 1);

    const generateUrl = (ext: string): string => {
      const newUrl = new URL(url);
      newUrl.pathname = `${basePathname}.${ext}`;
      return newUrl.toString();
    };

    if (isLive) {
      const fallbacks: string[] = [];
      if (currentExt !== 'm3u8') fallbacks.push(generateUrl('m3u8'));
      if (currentExt !== 'm3u') fallbacks.push(generateUrl('m3u'));
      return fallbacks;
    } else {
      const fallbacks: string[] = [];
      if (currentExt !== 'm3u8') fallbacks.push(generateUrl('m3u8'));
      if (currentExt !== 'ts') fallbacks.push(generateUrl('ts'));
      return fallbacks;
    }
  } catch {
    return [];
  }
}

const HEALTH_POLL_INTERVAL_MS = 1000;
const MIN_LOAD_GRACE_MS = 5000;
const MIN_BUFFER_STARVATION_MS = 3500;

function mpvNumber(value: any): number | null {
  const data = value && typeof value === 'object' && 'data' in value ? value.data : value;
  return typeof data === 'number' && Number.isFinite(data) ? data : null;
}

function mpvBoolean(value: any): boolean | null {
  const data = value && typeof value === 'object' && 'data' in value ? value.data : value;
  return typeof data === 'boolean' ? data : null;
}

function mpvObject(value: any): Record<string, any> | null {
  const data = value && typeof value === 'object' && 'data' in value ? value.data : value;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/**
 * Try loading a stream URL with fallbacks on failure.
 *
 * Note: we deliberately do NOT steer mpv's ytdl-format here. Modern YouTube
 * uploads (trailers included) often have no progressive 22/18 formats at all,
 * so overriding to a progressive format makes the load fail outright with
 * "Requested format is not available". yt-dlp's default (bestvideo*+bestaudio)
 * resolves and plays those correctly; transient 403s are handled by
 * yt-dlp/mpv internally and the trailer retry in maybeRetryTrailerStream.
 */
async function tryLoadWithFallbacks(
  primaryUrl: string,
  isLive: boolean,
  userAgent?: string,
  onError?: (msg: string) => void
): Promise<{ success: boolean; url: string; error?: string }> {
  logInfo('[Playback] Setting User-Agent:', userAgent || '(using default)');

  if (userAgent) {
    try {
      await Bridge.setProperty('user-agent', userAgent);
    } catch (e) {
      logWarn('Failed to set user-agent:', e);
    }
  }

  logInfo('[Playback] Loading URL:', primaryUrl);
  const result = await Bridge.loadVideo(primaryUrl, userAgent);

  if (result.success) {
    logInfo('[Playback] Successfully loaded:', primaryUrl);
    return { success: true, url: primaryUrl };
  }

  const errorMsg = translateNativeError((result as any).error) || i18n.t('player:unknownError');
  logWarn('[Playback] Failed to load:', primaryUrl, 'Error:', errorMsg);

  const fallbacks = getStreamFallbacks(primaryUrl, isLive);
  if (fallbacks.length > 0) {
    logInfo('[Playback] Trying fallback URLs:', fallbacks);
  }

  for (const fallbackUrl of fallbacks) {
    logInfo('[Playback] Trying fallback:', fallbackUrl);
    const fallbackResult = await Bridge.loadVideo(fallbackUrl, userAgent);
    if (fallbackResult.success) {
      logInfo('[Playback] Fallback succeeded:', fallbackUrl);
      return { success: true, url: fallbackUrl };
    }
    logWarn('[Playback] Fallback failed:', fallbackUrl);
  }

  logError('[Playback] All URLs failed. Final error:', errorMsg);
  return { success: false, url: primaryUrl, error: errorMsg };
}

function normalizeLangCode(code?: string): string {
  if (!code) return '';
  return fromSubSourceLang(toSubSourceLang(code));
}

/**
 * Detect closed-caption / teletext subtitle tracks (CEA-608/708, teletext,
 * "cc1".."cc4", "closed caption"). These are auxiliary accessibility tracks and
 * must never be auto-selected — the user enables them explicitly.
 */
function isClosedCaptionTrack(track: any): boolean {
  if (!track) return false;
  const title = (track.title || '').toLowerCase();
  const codec = (track.codec || '').toLowerCase();
  if (
    /\bcc[1-4]\b|^cc$|closed captions?|cea-?608|cea-?708|eia-?608|eia-?708|teletext|dvb_subtitle|dvb_teletext|scte-?2[07]|\[cc\]|\(cc\)/.test(title)
  ) {
    return true;
  }
  if (
    /eia_?608|cea_?608|eia_?708|cea_?708|teletext|dvb_subtitle|dvb_teletext|cc_dec|scte_?2[07]/.test(codec)
  ) {
    return true;
  }
  return false;
}

function getTrackLanguage(track: any): string {
  if (track.external && track['external-filename']) {
    const parts = track['external-filename'].split(/[/\\]/);
    const base = parts[parts.length - 1];
    if (base.startsWith('stremio__')) {
      const subParts = base.split('__');
      if (subParts.length >= 5) {
        return normalizeLangCode(subParts[4]);
      }
    } else if (base.startsWith('subsource__') || base.startsWith('opensubtitles__')) {
      const subParts = base.split('__');
      if (subParts.length >= 3) {
        return normalizeLangCode(subParts[2]);
      }
    }
  }
  const lang = normalizeLangCode(track.lang);
  if (lang) return lang;
  // Fallback: detect language from track title (many embedded tracks lack a proper lang field)
  if (track.title) {
    const title = track.title.toLowerCase();
    for (const [code, name] of Object.entries(LANG_MAP)) {
      if (code.length === 3 && title.includes(code)) return normalizeLangCode(code);
    }
    for (const [code, name] of Object.entries(LANG_MAP)) {
      if (code.length === 2 && title.includes(name)) return normalizeLangCode(code);
    }
    if (/cc[1-4]|closed caption|cea-608|eia-608|teletext/i.test(title)) {
      return normalizeLangCode('en');
    }
  }
  return '';
}

export interface FailoverState {
  isFailingOver: boolean;
  fromChannelName: string;
  toChannelName: string;
  attempt: number;
}

export interface PlaybackState {
  // MPV state
  mpvReady: boolean;
  playing: boolean;
  volume: number;
  muted: boolean;
  position: number;
  duration: number;
  error: string | null;

  // Playback info
  currentChannel: StoredChannel | null;
  vodInfo: VodPlayInfo | null;
  vodLoadingInfo: VodPlayInfo | null;
  catchupInfo: {
    channelId: string;
    programTitle: string;
    startTime: number;
    duration: number;
    programDesc?: string;
  } | null;
  loadingState: 'idle' | 'loading' | 'buffering' | 'unavailable';

  // Refs
  volumeDraggingRef: React.MutableRefObject<boolean>;
  seekingRef: React.MutableRefObject<boolean>;
  /** True while the current pause was initiated by the user (not an EOF/stop). */
  userPausedRef: React.MutableRefObject<boolean>;

  // Derived
  isCatchup: boolean;

  // Retry state (Live TV only)
  retryState: RetryState | null;

  // Failover state (Live TV only)
  failoverState: FailoverState | null;

  // Actions
  setError: (error: string | null) => void;
  setPlaying: (playing: boolean) => void;
  setPosition: (position: number) => void;
  setVolume: (volume: number) => void;
  setCurrentChannel: (channel: StoredChannel | null) => void;
  handlePlayChannel: (channel: StoredChannel, autoSwitched?: boolean, directPlay?: boolean) => void | Promise<void>;
  handlePlayCatchup: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, programDesc?: string) => Promise<void>;
  handleCatchupSeek: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, seekSeconds: number, programDesc?: string) => Promise<void>;
  handlePlayVod: (info: VodPlayInfo, onCloseView?: () => void) => Promise<boolean>;
  /**
   * Merge fields into the currently active VOD info (state + ref), e.g.
   * metadata that resolves after playback has already started. The optional
   * predicate can guard against patching a newer play (only patch the session
   * that initiated the async resolution). No-ops when nothing would change.
   */
  patchVodInfo: (patch: Partial<VodPlayInfo>, matches?: (current: VodPlayInfo) => boolean) => void;
  handlePlayRecording: (recording: import('../db').DvrRecording, onCloseView?: () => void) => Promise<void>;
  handleStop: () => Promise<void>;
  handleSeek: (seconds: number) => Promise<void>;
  handleTogglePlay: () => Promise<void>;
  handleVolumeChange: (e: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleToggleMute: () => Promise<void>;
  handleCycleSubtitle: () => Promise<void>;
  handleCycleAudio: () => Promise<void>;
  handleToggleStats: () => Promise<void>;
  handleToggleFullscreen: () => Promise<void>;
  syncMpvGeometry: () => Promise<void>;
  autoSelectSubtitle: () => Promise<void>;
  autoSelectAudio: () => Promise<void>;

  // Layout persistence integration
  notifyMainLoaded: (channelName: string, channelUrl: string, sourceName?: string | null) => void;
}

interface UsePlaybackOptions {
  rememberLastChannels: boolean;
  reopenLastOnStartup: boolean;
  savedLayoutState: import('./useLayoutPersistence').SavedLayoutState | null;
  mpvReadyState: boolean;
  syncMpvGeometry?: () => Promise<void>;
  notifyMainLoaded?: (channelName: string, channelUrl: string, sourceName?: string | null) => void;
  /** Callback to update current channel when swapped from multiview */
  onSetCurrentChannel?: (channel: StoredChannel | null) => void;
  /** Shared MPV listener state from parent (must be provided to avoid duplicate hook instances) */
  mpvListeners: ReturnType<typeof useMpvListeners>;
}

export function usePlayback(options: UsePlaybackOptions): PlaybackState {
  const {
    rememberLastChannels,
    reopenLastOnStartup,
    savedLayoutState,
    mpvReadyState,
    syncMpvGeometry,
    notifyMainLoaded,
    mpvListeners,
  } = options;

  // Use shared MPV listeners from parent to avoid duplicate hook instances
  // This ensures error state is shared between App.tsx and usePlayback
  const {
    mpvReady, playing, volume, muted, position, duration, error,
    pausedForCache, coreIdle,
    volumeDraggingRef, seekingRef,
    setError, setPlaying, setPosition, setVolume, setDuration,
    setIgnoreHttpErrors, isIgnoringHttpErrors,
    suppressStatusUpdates,
  } = mpvListeners;

  const playingRef = useRef(playing);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // Pending seek ref for deferred scrubbing
  const pendingCatchupSeekRef = useRef<number | null>(null);
  const pendingStremioSeekFractionRef = useRef<number | null>(null);
  const pendingResumeSeekRef = useRef<number | null>(null);
  const isInitialSeekPendingRef = useRef(false);
  const cancelPendingSeekRef = useRef<(() => void) | null>(null);
  const wasSeekingRef = useRef(false);

  // Trailer playback recovery: YouTube streams can die a few seconds in when
  // the CDN 403s the media segments. Track load time + retry count so an
  // unexpected early end can be retried (fresh yt-dlp resolve) while a genuine
  // natural end never is.
  const trailerLoadStartTimeRef = useRef(0);
  const trailerRetryCountRef = useRef(0);

  const seekWithRetry = useCallback((targetSeek: number, description: string, onSuccess?: () => void) => {
    cancelPendingSeekRef.current?.();
    wasSeekingRef.current = true;

    let attempts = 0;
    const maxAttempts = 15;
    const delayMs = 500;
    let timeoutId: any = null;

    const execute = () => {
      const isStillActive = playingRef.current || isInitialSeekPendingRef.current || vodInfoRef.current !== null || catchupInfoRef.current !== null;
      if (!isStillActive) {
        logInfo(`[Playback] Aborting seek retry for ${description}: player is no longer active`);
        cancelPendingSeekRef.current = null;
        return;
      }

      Bridge.seek(targetSeek)
        .then(() => {
          logInfo(`[Playback] Seek for ${description} succeeded at ${targetSeek}s (attempt ${attempts + 1})`);
          cancelPendingSeekRef.current = null;
          onSuccess?.();
        })
        .catch(e => {
          attempts++;
          const isActive = playingRef.current || isInitialSeekPendingRef.current || vodInfoRef.current !== null || catchupInfoRef.current !== null;
          if (!isActive) {
            logInfo(`[Playback] Aborting seek retry for ${description}: player is no longer active`);
            cancelPendingSeekRef.current = null;
            return;
          }
          if (attempts < maxAttempts) {
            logWarn(`[Playback] Seek for ${description} failed (attempt ${attempts}): ${e}. Retrying in ${delayMs}ms...`);
            timeoutId = setTimeout(execute, delayMs);
          } else {
            logError(`[Playback] Seek for ${description} failed after ${maxAttempts} attempts:`, e);
            cancelPendingSeekRef.current = null;
            onSuccess?.();
          }
        });
    };

    const cancel = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    cancelPendingSeekRef.current = cancel;
    execute();

    return cancel;
  }, []);

  const clearPendingSeeks = useCallback(() => {
    cancelPendingSeekRef.current?.();
    cancelPendingSeekRef.current = null;
    pendingCatchupSeekRef.current = null;
    pendingStremioSeekFractionRef.current = null;
    pendingResumeSeekRef.current = null;
    isInitialSeekPendingRef.current = false;
  }, []);

  // Playback state
  const [currentChannel, setCurrentChannel] = useState<StoredChannel | null>(null);
  const [vodInfo, setVodInfo] = useState<VodPlayInfo | null>(null);
  const [vodLoadingInfo, setVodLoadingInfo] = useState<VodPlayInfo | null>(null);
  const [loadingState, setLoadingState] = useState<'idle' | 'loading' | 'buffering' | 'unavailable'>('idle');
  const [loadInFlight, setLoadInFlight] = useState(false);
  const loadingStartedAtRef = useRef<number | null>(null);
  const showLoadingScreenRef = useRef(false);
  const [catchupInfo, setCatchupInfo] = useState<{
    channelId: string;
    programTitle: string;
    startTime: number;
    duration: number;
    programDesc?: string;
  } | null>(null);

  const vodInfoRef = useRef(vodInfo);
  useEffect(() => {
    vodInfoRef.current = vodInfo;
  }, [vodInfo]);

  const catchupInfoRef = useRef(catchupInfo);
  useEffect(() => {
    catchupInfoRef.current = catchupInfo;
  }, [catchupInfo]);

  // Retry state for Live TV stream recovery
  const [retryState, setRetryState] = useState<RetryState | null>(null);

  // Failover state for Live TV stream recovery
  const [failoverState, setFailoverState] = useState<FailoverState | null>(null);

  // Clear loader overlay when playback starts or an error is encountered
  const loaderLastPositionRef = useRef(position);
  const isPlayLoadingRef = useRef(false);
  useEffect(() => {
    if (vodLoadingInfo) {
      if (error) {
        setVodLoadingInfo(null);
        isPlayLoadingRef.current = false;
      } else if (isPlayLoadingRef.current) {
        loaderLastPositionRef.current = position;
        isPlayLoadingRef.current = false;
      } else if (position !== loaderLastPositionRef.current) {
        setVodLoadingInfo(null);
      }
    }
    loaderLastPositionRef.current = position;
  }, [position, error, vodLoadingInfo]);

  // Configurable retry settings — loaded from storage, stored in refs so
  // they're always current inside interval callbacks without stale closures.
  const maxRetriesRef = useRef(20);
  const stallThresholdMsRef = useRef(10_000);
  const useEventBasedReconnectRef = useRef(false);
  const stallDetectionEnabledRef = useRef(true);

  // Catch-up settings refs
  const catchupStartPaddingRef = useRef(0);
  const catchupEndPaddingRef = useRef(0);
  const catchupContinuePlayingRef = useRef(false);

  // Apply retry/catchup settings from the store to the live refs. Called at
  // mount AND on every store change. This must NOT be a one-shot read: boot
  // hydration is async (see settingsStoreHydration), so the store is still at
  // its seed defaults when this hook mounts — a saved "stall detection off"
  // would otherwise never reach these refs (the watchdog silently stayed on
  // in "event-based only" sessions), and Settings.tsx toggles write to the
  // DB + legacy event but not to the zustand store.
  const applyPlaybackSettingsFromStore = useCallback(() => {
    const s = useSettingsStore.getState();
    if (typeof s.streamMaxRetries === 'number' && s.streamMaxRetries > 0) {
      maxRetriesRef.current = s.streamMaxRetries;
    }
    if (typeof s.streamWatchdogSeconds === 'number' && s.streamWatchdogSeconds >= 3) {
      stallThresholdMsRef.current = s.streamWatchdogSeconds * 1_000;
    }
    if (typeof s.useEventBasedReconnect === 'boolean') {
      useEventBasedReconnectRef.current = s.useEventBasedReconnect;
    }
    if (typeof s.stallDetectionEnabled === 'boolean') {
      stallDetectionEnabledRef.current = s.stallDetectionEnabled;
    }
    if (typeof s.showLoadingScreen === 'boolean') {
      showLoadingScreenRef.current = s.showLoadingScreen;
    }
    if (typeof s.catchupStartPadding === 'number') {
      catchupStartPaddingRef.current = s.catchupStartPadding;
    }
    if (typeof s.catchupEndPadding === 'number') {
      catchupEndPaddingRef.current = s.catchupEndPadding;
    }
    if (typeof s.catchupContinuePlaying === 'boolean') {
      catchupContinuePlayingRef.current = s.catchupContinuePlaying;
    }
  }, []);

  // Sync refs at mount and re-apply whenever the store changes so async boot
  // hydration reconciles them with the persisted settings.
  useEffect(() => {
    applyPlaybackSettingsFromStore();
    const unsubscribe = useSettingsStore.subscribe(applyPlaybackSettingsFromStore);
    return unsubscribe;
  }, [applyPlaybackSettingsFromStore]);

  // Listen for real-time changes dispatched by Settings.tsx — no restart required
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ streamWatchdogSeconds?: number; streamMaxRetries?: number; useEventBasedReconnect?: boolean; stallDetectionEnabled?: boolean; showLoadingScreen?: boolean }>).detail;
      if (typeof detail.streamWatchdogSeconds === 'number' && detail.streamWatchdogSeconds >= 3) {
        stallThresholdMsRef.current = detail.streamWatchdogSeconds * 1_000;
        logInfo(`[Retry] Watchdog threshold updated to ${detail.streamWatchdogSeconds}s`);
      }
      if (typeof detail.streamMaxRetries === 'number' && detail.streamMaxRetries > 0) {
        maxRetriesRef.current = detail.streamMaxRetries;
        logInfo(`[Retry] Max retries updated to ${detail.streamMaxRetries}`);
      }
      if (typeof detail.useEventBasedReconnect === 'boolean') {
        useEventBasedReconnectRef.current = detail.useEventBasedReconnect;
        logInfo(`[Retry] Event-based reconnect ${detail.useEventBasedReconnect ? 'enabled' : 'disabled'}`);
      }
      if (typeof detail.stallDetectionEnabled === 'boolean') {
        stallDetectionEnabledRef.current = detail.stallDetectionEnabled;
        logInfo(`[Retry] Stall detection ${detail.stallDetectionEnabled ? 'enabled' : 'disabled'}`);
      }
      if (typeof detail.showLoadingScreen === 'boolean') {
        showLoadingScreenRef.current = detail.showLoadingScreen;
        logInfo(`[Playback] Show loading screen option ${detail.showLoadingScreen ? 'enabled' : 'disabled'}`);
      }
    };
    window.addEventListener('ynotv:retry-settings-changed', handler);
    return () => window.removeEventListener('ynotv:retry-settings-changed', handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ catchupStartPadding?: number; catchupEndPadding?: number; catchupContinuePlaying?: boolean }>).detail;
      if (typeof detail.catchupStartPadding === 'number') {
        catchupStartPaddingRef.current = detail.catchupStartPadding;
        logInfo(`[Catchup] Start padding updated to ${detail.catchupStartPadding}m`);
      }
      if (typeof detail.catchupEndPadding === 'number') {
        catchupEndPaddingRef.current = detail.catchupEndPadding;
        logInfo(`[Catchup] End padding updated to ${detail.catchupEndPadding}m`);
      }
      if (typeof detail.catchupContinuePlaying === 'boolean') {
        catchupContinuePlayingRef.current = detail.catchupContinuePlaying;
        logInfo(`[Catchup] Continue playing updated to ${detail.catchupContinuePlaying}`);
      }
    };
    window.addEventListener('ynotv:catchup-settings-changed', handler);
    return () => window.removeEventListener('ynotv:catchup-settings-changed', handler);
  }, []);



  // Effect to transition loadingState based on MPV player status
  useEffect(() => {
    // If show loading screen setting is disabled, keep loadingState 'idle'
    if (!showLoadingScreenRef.current) {
      if (loadingState !== 'idle') setLoadingState('idle');
      return;
    }

    // If a load is currently in-flight, keep loadingState as 'loading'
    if (loadInFlight) {
      if (loadingState !== 'loading') setLoadingState('loading');
      return;
    }

    // Only apply loading/buffering overlays to Live TV channels when not casting
    if (!currentChannel || vodInfo || catchupInfo || Bridge.getIsCasting?.()) {
      if (loadingState !== 'idle') setLoadingState('idle');
      return;
    }

    // If there is an active error, clear loading screen so error overlay can show
    if (error) {
      if (loadingState !== 'idle') setLoadingState('idle');
      return;
    }

    // Transition rules:
    if (playing && position > 0 && !pausedForCache) {
      // Stream is playing and position is advancing: hide overlay
      setLoadingState('idle');
    } else if (pausedForCache) {
      // MPV is paused waiting for cache: show buffering
      setLoadingState('buffering');
    }
  }, [currentChannel, playing, position, pausedForCache, error, loadingState, vodInfo, catchupInfo, loadInFlight]);

  // Effect to check timeout (12s) when loading or buffering
  useEffect(() => {
    if (loadingState === 'idle') return;

    // Reset the start timestamp whenever we enter a loading or buffering state
    loadingStartedAtRef.current = Date.now();

    const interval = setInterval(() => {
      if (loadingStartedAtRef.current && Date.now() - loadingStartedAtRef.current > 12000) {
        if (loadingState === 'loading' || loadingState === 'buffering') {
          setLoadingState('unavailable');
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [loadingState]);

  const retryAttemptRef = useRef(0);
  const isRetryingRef = useRef(false);
  const retryFailedDuringLoadRef = useRef(false);
  const retryCountdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPositionRef = useRef<number>(0);
  const lastPositionTimeRef = useRef<number>(Date.now());
  const lastHealthPositionRef = useRef<number>(0);
  const lastHealthCacheEndRef = useRef<number | null>(null);
  const lastHealthForwardBytesRef = useRef<number | null>(null);
  const lastHealthActivityTimeRef = useRef<number>(Date.now());
  const bufferStarvedSinceRef = useRef<number | null>(null);
  const healthCheckInFlightRef = useRef(false);
  const healthLoadGraceUntilRef = useRef(0);
  const hasAutoSelectedSubRef = useRef(false);
  const hasAutoSelectedAudioRef = useRef(false);
  // Sticky: once auto-selection has completed at least once for a stream, later
  // track-count changes (e.g. the user manually adding a subtitle mid-playback)
  // must NOT reset the auto-select state and fight the manual selection.
  const subAutoSelectEverCompletedRef = useRef(false);
  const lastSubTracksCountRef = useRef(0);
  const lastAudioTracksCountRef = useRef(0);
  const autoSelectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoSelectAttemptsRef = useRef(0);
  const jellyfinResolvedSubsRef = useRef<Map<string, string>>(new Map());
  // Monotonic sequence for handlePlayChannel: guards against the async
  // failover-primary lookup resolving out of order during rapid channel zaps.
  const playChannelSeqRef = useRef(0);
  const streamFailureHandlingRef = useRef(false);
  const recoveryArmedRef = useRef(false);
  const userPausedRef = useRef(false);
  // When true, the next stream death event should be ignored because the
  // main player was intentionally stopped (e.g. popout opened with "stop main").
  const intentionallyStoppedRef = useRef(false);
  // Tracks whether we're currently playing a stalker_portal VOD over HLS (.m3u8).
  const isStalkerVodRef = useRef(false);
  // Cleanup autoSelectTimer on unmount
  useEffect(() => {
    return () => {
      if (autoSelectTimerRef.current) {
        clearInterval(autoSelectTimerRef.current);
      }
    };
  }, []);
  // Stable refs for use inside intervals (avoids stale closure issues)
  const currentChannelRef = useRef(currentChannel);

  // Failover state
  const failoverActiveRef = useRef(false);
  const failoverSwitchingRef = useRef(false);
  const failoverOriginChannelRef = useRef<StoredChannel | null>(null);
  const failoverAttemptRef = useRef(0);
  const failoverCursorStreamIdRef = useRef<string | null>(null);
  const failoverCycleStartStreamIdRef = useRef<string | null>(null);
  const failoverAttemptedStreamIdsRef = useRef<Set<string>>(new Set());
  const failoverFailedDuringSwitchRef = useRef(false);

  useEffect(() => { currentChannelRef.current = currentChannel; }, [currentChannel]);



  // Refs to track current values for interval callbacks
  const positionRef = useRef(position);
  const durationRef = useRef(duration);
  
  useEffect(() => {
    positionRef.current = position;
  }, [position]);
  
  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  const isCatchup = catchupInfo !== null;

  const resetHealthTracking = useCallback((graceMs: number = MIN_LOAD_GRACE_MS) => {
    const now = Date.now();
    lastPositionRef.current = positionRef.current;
    lastPositionTimeRef.current = now;
    lastHealthPositionRef.current = positionRef.current;
    lastHealthCacheEndRef.current = null;
    lastHealthForwardBytesRef.current = null;
    lastHealthActivityTimeRef.current = now;
    bufferStarvedSinceRef.current = null;
    healthCheckInFlightRef.current = false;
    healthLoadGraceUntilRef.current = now + graceMs;
  }, []);

  // Handle pending catchup seek when duration becomes available
  useEffect(() => {
    if (pendingCatchupSeekRef.current !== null && duration > 0 && !coreIdle) {
      const targetSeek = pendingCatchupSeekRef.current;
      pendingCatchupSeekRef.current = null;
      logInfo(`[usePlayback] Seeking Catchup to position: ${targetSeek} seconds`);
      setPosition(targetSeek);
      const cancelSeek = seekWithRetry(targetSeek, 'catchup', () => {
        isInitialSeekPendingRef.current = false;
      });
      return () => {
        cancelSeek();
      };
    }
  }, [duration, setPosition, seekWithRetry, catchupInfo, coreIdle]);

  // Handle pending Stremio synced progress seek when duration becomes available
  useEffect(() => {
    if (pendingStremioSeekFractionRef.current !== null && duration > 0 && !coreIdle) {
      const fraction = pendingStremioSeekFractionRef.current;
      pendingStremioSeekFractionRef.current = null;
      const targetSeek = Math.floor(fraction * duration);
      if (targetSeek > 0) {
        logInfo(`[usePlayback] Seeking Stremio VOD to synced fraction: ${fraction} at ${targetSeek} seconds`);
        setPosition(targetSeek);
        const cancelSeek = seekWithRetry(targetSeek, 'Stremio synced fraction', () => {
          isInitialSeekPendingRef.current = false;
        });
        return () => {
          cancelSeek();
        };
      }
    }
  }, [duration, setPosition, seekWithRetry, vodInfo, coreIdle]);

  // Handle pending resume seek when duration becomes available (immune to load delays).
  // Jellyfin supplies its authoritative position as startTimeTicks in the stream
  // URL; it must use this same deferred seek path as local VOD resumes.
  useEffect(() => {
    if (pendingResumeSeekRef.current !== null && duration > 0 && !coreIdle) {
      const targetSeek = pendingResumeSeekRef.current;
      pendingResumeSeekRef.current = null;
      logInfo(`[usePlayback] Seeking VOD to resume position: ${targetSeek} seconds`);
      setPosition(targetSeek);
      const cancelSeek = seekWithRetry(targetSeek, 'database resume', () => {
        isInitialSeekPendingRef.current = false;
      });
      return () => {
        cancelSeek();
      };
    }
  }, [duration, setPosition, seekWithRetry, vodInfo, coreIdle]);

  // Periodic progress saving for VOD playback + save on app close
  useEffect(() => {
    if (!vodInfo || !playing || duration <= 0 || vodInfo.source_id === 'trailer' || vodInfo.source_id === 'jellyfin' || isYouTubeUrl(vodInfo.url)) {
      return;
    }

    console.log('[Playback] Setting up progress save - initial position:', position);

    const saveProgress = async (): Promise<void> => {
      // Read current values from refs (always up to date)
      const currentVodInfo = vodInfoRef.current;
      const currentPosition = positionRef.current;
      const currentDuration = durationRef.current;
      
      console.log('[Playback] Interval firing - current position:', currentPosition);
      
      if (isInitialSeekPendingRef.current) {
        console.log('[Playback] Initial seek is still pending, skipping progress save');
        return;
      }
      
      if (!currentVodInfo) {
        console.log('[Playback] No vodInfo in ref, skipping save');
        return;
      }
      
      if (currentVodInfo.type === 'recording' && currentPosition > 0) {
        console.log('[Playback] Auto-saving progress for recording:', Math.floor(currentPosition), '/', Math.floor(currentDuration));
        if (currentVodInfo.recordingId) {
          await updateDvrRecordingProgress(currentVodInfo.recordingId, Math.floor(currentPosition), Math.floor(currentDuration));
        } else {
          useDownloadStore.getState().saveDownloadProgress(currentVodInfo.url, Math.floor(currentPosition), Math.floor(currentDuration));
        }
      } else {
        // Snapshot playlist-item progress into localStorage so playlists keep
        // their resume/last-watched info even after a cache clear wipes the
        // DB history written below.
        snapshotPlaylistProgress(currentVodInfo, currentPosition, currentDuration);

        const mediaId = currentVodInfo.mediaId || (currentVodInfo.source_id && currentVodInfo.url
          ? `${currentVodInfo.source_id}_${currentVodInfo.url}`
          : null);
        
        if (mediaId && currentPosition > 0) {
          console.log('[Playback] Auto-saving progress:', Math.floor(currentPosition), '/', Math.floor(currentDuration));
          
          // For series episodes, save both levels
          if (currentVodInfo.type === 'series' && mediaId.includes('_ep_')) {
            const parts = mediaId.split('_ep_');
            if (parts.length === 2) {
              const seriesId = parts[0];
              const episodeId = parts[1];
              
              // Save series-level progress (for Recently Watched)
              const p1 = updateVodWatchProgress(
                seriesId,
                'series',
                Math.floor(currentPosition),
                Math.floor(currentDuration),
                currentVodInfo.source_id || '',
                currentVodInfo.title || '',
                currentVodInfo.posterUrl
              );
              
              // Save episode-level progress (for episode resume)
              const p2 = recordEpisodeWatch(
                episodeId,
                seriesId,
                currentVodInfo.source_id || '',
                currentVodInfo.seasonNum ?? 0,
                currentVodInfo.episodeNum ?? 0,
                currentVodInfo.episodeInfo || '',
                Math.floor(currentPosition),
                Math.floor(currentDuration)
              );
              
              await Promise.all([p1, p2]);
              console.log('[Playback] ✅ Auto-saved series progress at position:', Math.floor(currentPosition));
            }
          } else {
            // For movies or series without episode info
            await updateVodWatchProgress(
              mediaId,
              currentVodInfo.type as 'movie' | 'series',
              Math.floor(currentPosition),
              Math.floor(currentDuration),
              currentVodInfo.source_id || '',
              currentVodInfo.title || '',
              currentVodInfo.posterUrl
            );
            console.log('[Playback] ✅ Auto-saved VOD progress at position:', Math.floor(currentPosition));
          }
        } else {
          console.log('[Playback] Save conditions not met:', { 
            hasMediaId: !!mediaId, 
            type: currentVodInfo?.type, 
            position: currentPosition 
          });
        }
      }
    };

    // Save every 30 seconds while playing
    console.log('[Playback] Starting 30s progress save interval');
    const saveInterval = setInterval(() => { void saveProgress(); }, 30000);
    
    // Do an immediate save when starting
    console.log('[Playback] Doing immediate initial save');
    void saveProgress();

    // Save when user closes/refreshes the page - use synchronous approach
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      console.log('[Playback] beforeunload triggered - saving progress');
      void saveProgress();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Register app close callback for Tauri
    console.log('[Playback] Registering app close callback');
    registerOnAppClose(saveProgress);

    return () => {
      console.log('[Playback] Cleaning up progress save (position was:', position + ')');
      clearInterval(saveInterval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      unregisterOnAppClose();
    };
  }, [vodInfo, playing, duration]); // Dependencies control when to start/stop the interval

  // Playback handlers
  const handleLoadStream = useCallback(async (
    channel: StoredChannel,
    options: { recoveryMode?: boolean } = {}
  ): Promise<boolean> => {
    // Clear error immediately - stale errors from old channel will be ignored
    setError(null);

    // Set candidate channel immediately so UI and loading overlay reflect the new channel
    currentChannelRef.current = channel;
    setCurrentChannel(channel);

    // Suppress status updates from MPV for up to 1.5 seconds during channel transition
    // to prevent stale position/playing events from the old channel from overriding our state,
    // and reset the progress latch so HTTP errors aren't masked by the previous channel.
    suppressStatusUpdates?.(1500);

    if (showLoadingScreenRef.current) {
      setLoadingState('loading');
      loadingStartedAtRef.current = Date.now();

      // Clear last frame and reset state
      Bridge.stop().catch(() => {});
      setPlaying(false);
      setPosition(0);
    }
    setLoadInFlight(true);
    userPausedRef.current = false;
    if (options.recoveryMode) {
      recoveryArmedRef.current = true;
    }
    resetHealthTracking();

    try {
      logInfo('[Playback] Loading channel:', channel.name);
      logInfo('[Playback] Raw URL:', channel.direct_url);

      let resolved;
      try {
        resolved = await resolvePlayUrl(channel.source_id, channel.direct_url);
      } catch (e) {
        logError('Stalker resolution failed:', e);
        setError(i18n.t('player:failedToResolveStalkerLink'));
        return false;
      }

      logInfo('[Playback] Resolved URL:', resolved.url);
      logInfo('[Playback] User-Agent:', resolved.userAgent || '(default)');
      logInfo('[Playback] Source:', resolved.sourceName || channel.source_id);

      let sourceData: { type?: string } | undefined;
      if (window.storage && channel.source_id) {
        try {
          const srcResult = await window.storage.getSource(channel.source_id);
          sourceData = srcResult?.data;
        } catch (e) {
          logWarn('Failed to look up source type for error suppression:', e);
        }
      }

      const isStalker = sourceData?.type === 'stalker';
      const isLocal = isLocalUrl(resolved.url);
      const isTrailer = channel.source_id === 'trailer' || isYouTubeUrl(resolved.url) || isYouTubeUrl(channel.direct_url);
      setIgnoreHttpErrors(isStalker || isLocal || isTrailer);

      if (Bridge.getIsCasting?.()) {
        Bridge.setCastMetadata(channel.name, 'Live TV');
      }

      const result = await tryLoadWithFallbacks(
        resolved.url,
        true,
        resolved.userAgent,
        (msg) => setError(msg)
      );

      if (!result.success) {
        setIgnoreHttpErrors(false);
        const errMsg = translateNativeError(result.error) || i18n.t('player:failedToLoadStream');
        setError(errMsg);
        return false;
      } else {
        const resolvedChannel = result.url !== channel.direct_url
          ? { ...channel, direct_url: result.url }
          : channel;
        currentChannelRef.current = resolvedChannel;
        setCurrentChannel(resolvedChannel);
        setPlaying(true);
        resetHealthTracking();
        // Arm recovery as soon as the live load succeeds so both event-based
        // reconnect AND stall detection can react to a later death. Previously
        // this was only armed by the stall-detection watchdog after observing
        // progress — with stall detection disabled, recovery never armed and
        // event-based reconnect silently ignored every stream death.
        recoveryArmedRef.current = true;
        // Explicitly force MPV to unpause after loading.
        // If a previous stream ended/was interrupted, MPV may hold pause=true,
        // causing the new stream to load but not start playing.
        // Skip when casting: cast_load_media auto-starts playback on the Chromecast,
        // and calling cast_play here races against the concurrent castCurrentMedia()
        // call (triggered by the cast-status listener), causing INVALID_MEDIA_SESSION_ID.
        if (!Bridge.getIsCasting?.()) {
          Bridge.play().catch(e => console.warn('[usePlayback] play() after load failed:', e));
        }
        
        // Restore saved audio delay if it exists (store-backed — no IPC read)
        try {
          const delays = useSettingsStore.getState().channelAudioDelays || {};
          const key = `${channel.source_id}_${channel.stream_id}`;
          const delayToApply = delays[key] ?? 0.0;
          if (delayToApply !== 0.0) {
            logInfo(`[Playback] Restoring saved audio delay of ${delayToApply}s for channel ${key}`);
            Bridge.setProperty('audio-delay', delayToApply).catch((e: any) => {
              logWarn('Failed to restore audio-delay property:', e);
            });
          }
        } catch (e) {
          console.warn('[Playback] Failed to load channel audio delay:', e);
        }

        applySubtitleSettings();
        notifyMainLoaded?.(channel.name, result.url, resolved.sourceName ?? null);

        import('../services/video-metadata').then(({ captureAndSaveMetadata }) => {
          captureAndSaveMetadata(channel.stream_id, channel.source_id).catch(console.error);
        });
        return true;
      }
    } finally {
      setLoadInFlight(false);
    }
  }, [notifyMainLoaded, resetHealthTracking, setIgnoreHttpErrors, suppressStatusUpdates]);

  // ── Retry helpers ──────────────────────────────────────────────────────────

  /**
   * Clear all retry timers. Call before starting a new retry cycle or when
   * cancelling retries (channel switch, stop, etc.).
   */
  const clearRetryTimers = useCallback(() => {
    if (retryCountdownTimerRef.current) {
      clearInterval(retryCountdownTimerRef.current);
      retryCountdownTimerRef.current = null;
    }
  }, []);

  /**
   * Clear the watchdog interval (called on channel switch / stop).
   */
  const clearWatchdog = useCallback(() => {
    if (watchdogIntervalRef.current) {
      clearInterval(watchdogIntervalRef.current);
      watchdogIntervalRef.current = null;
    }
  }, []);

  // Listen for intentional-stop signals (e.g. popout opened with "stop main")
  useEffect(() => {
    const handler = () => {
      logInfo('[Playback] Received intentional-stop signal — suppressing next stream-death retry');
      intentionallyStoppedRef.current = true;
      clearRetryTimers();
      clearWatchdog();
      setPlaying(false);
      setLoadingState('idle');
    };
    window.addEventListener('ynotv:intentional-stop', handler);
    return () => window.removeEventListener('ynotv:intentional-stop', handler);
  }, [clearRetryTimers, clearWatchdog]);

  // When the popout closes, clear the intentional-stop flag so that the main
  // player can recover from stream failures normally again.
  useEffect(() => {
    const handler = () => {
      logInfo('[Playback] Popout closed — clearing intentional-stop flag, resuming stream-death handling');
      intentionallyStoppedRef.current = false;
    };
    window.addEventListener('ynotv:popout-closed', handler);
    return () => window.removeEventListener('ynotv:popout-closed', handler);
  }, []);

  /**
   * Kick off a 5-second countdown and then reload the current channel.
   * Expects `currentChannelRef.current` to be set.
   */
  const startRetryCountdown = useCallback(() => {
    const channel = currentChannelRef.current;
    if (!channel) return;

    if (retryAttemptRef.current >= maxRetriesRef.current) {
      logError('[Retry] Max retries reached, giving up');
      setError(i18n.t('player:streamUnavailableMaxRetries'));
      setRetryState(null);
      isRetryingRef.current = false;
      retryFailedDuringLoadRef.current = false;
      clearWatchdog();
      return;
    }

    retryAttemptRef.current += 1;
    const attempt = retryAttemptRef.current;

    logInfo(`[Retry] Attempt ${attempt}/${maxRetriesRef.current} — stopping MPV frame and starting countdown`);

    // Stop MPV immediately so the frozen video frame is cleared.
    // This is critical — without it the frozen frame sits on top of the overlay.
    Bridge.stop().catch(() => {});

    // Show overlay with ramping countdown: attempt 1=1s, 2=2s, 3=3s, 4=4s, 5+=5s
    let countdown = Math.min(attempt, 5);
    setRetryState({ isRetrying: true, countdown, attempt, maxRetries: maxRetriesRef.current });
    isRetryingRef.current = true;

    // Tick every second
    clearRetryTimers();
    retryCountdownTimerRef.current = setInterval(() => {
      countdown -= 1;

      if (countdown <= 0) {
        clearRetryTimers();
        // Show "Reconnecting…" state (countdown = 0)
        setRetryState({ isRetrying: true, countdown: 0, attempt, maxRetries: maxRetriesRef.current });

        // Reset position tracking so watchdog doesn't immediately re-fire
        resetHealthTracking(10_000); // give the reload time to connect and buffer
        retryFailedDuringLoadRef.current = false;

        // Reload the stream
        handleLoadStream(channel, { recoveryMode: true })
          .then((loaded) => {
            const failedDuringLoad = retryFailedDuringLoadRef.current;
            retryFailedDuringLoadRef.current = false;
            if (loaded && !failedDuringLoad) {
              logInfo(`[Retry] Stream accepted on attempt ${attempt}; waiting for playback progress`);
              setRetryState(null);
              isRetryingRef.current = false;
            } else {
              logWarn(`[Retry] Stream load failed on attempt ${attempt}`);
              isRetryingRef.current = false;
              if (retryAttemptRef.current >= maxRetriesRef.current) {
                logError('[Retry] Max retries reached, giving up');
                setError(i18n.t('player:streamUnavailableMaxRetries'));
                setRetryState(null);
                clearWatchdog();
              } else {
                startRetryCountdown();
              }
            }
          })
          .catch((err) => {
            logWarn(`[Retry] handleLoadStream threw on attempt ${attempt}:`, err);
            retryFailedDuringLoadRef.current = false;
            isRetryingRef.current = false;
            if (retryAttemptRef.current >= maxRetriesRef.current) {
              logError('[Retry] Max retries reached, giving up');
              setError(i18n.t('player:streamUnavailableMaxRetries'));
              setRetryState(null);
              clearWatchdog();
            } else {
              startRetryCountdown();
            }
          });
      } else {
        setRetryState({ isRetrying: true, countdown, attempt, maxRetries: maxRetriesRef.current });
      }
    }, 1000);
  }, [clearRetryTimers, clearWatchdog, handleLoadStream, resetHealthTracking, setError]);

  /**
   * Switch to a failover backup channel.
   */
  const handleFailover = useCallback(async (nextChannel: StoredChannel): Promise<boolean> => {
    const dying = currentChannelRef.current;
    if (!dying || failoverSwitchingRef.current) return false;

    // Switching to another stream drops the track the user picked: it belonged
    // to the channel that just died, and the post-reload restore must not
    // re-apply that id to a channel where it may mean another language entirely.
    // A candidate that turns out to be the same channel (rotating back to a
    // group's primary, which is how a plain retry of a group member arrives
    // here) keeps the choice, so the restore can put the track back.
    if (nextChannel.stream_id !== dying.stream_id) clearSubtitleIntent();

    failoverAttemptRef.current += 1;
    failoverActiveRef.current = true;
    failoverSwitchingRef.current = true;
    recoveryArmedRef.current = true;
    failoverCursorStreamIdRef.current = nextChannel.stream_id;
    failoverAttemptedStreamIdsRef.current.add(nextChannel.stream_id);
    failoverFailedDuringSwitchRef.current = false;

    logInfo(`[Failover] Switching from "${dying.name}" → "${nextChannel.name}" (attempt ${failoverAttemptRef.current})`);

    // Clear any error overlay so failover UI is visible (z-index stacking)
    setError(null);

    // Show the failover overlay
    setFailoverState({
      isFailingOver: true,
      fromChannelName: dying.name,
      toChannelName: nextChannel.name,
      attempt: failoverAttemptRef.current,
    });

    // Clear the frozen frame immediately
    Bridge.stop().catch(() => {});

    // Switch immediately — the failover overlay stays visible until the new
    // stream finishes loading, so no artificial pause is needed.

    // Treat the candidate as current while loading so immediate failures can
    // advance to the next group member instead of retrying the previous stream.
    currentChannelRef.current = nextChannel;
    setCurrentChannel(nextChannel);

    // Load the backup channel (reuse existing path — this sets currentChannel)
    try {
      const loaded = await handleLoadStream(nextChannel, { recoveryMode: true });
      const failedDuringSwitch = failoverFailedDuringSwitchRef.current;
      failoverFailedDuringSwitchRef.current = false;
      const usable = loaded && !failedDuringSwitch;
      if (usable) {
        // On success, clear failover UI but keep failoverActiveRef true
        // (so if THIS stream also dies, we continue cycling, not restart from the primary)
        setFailoverState(null);
        // Reset stall tracking so watchdog gives the new stream time to buffer
        resetHealthTracking();
      } else {
        logWarn(`[Failover] Backup "${nextChannel.name}" failed to load; trying next candidate`);
        setFailoverState(null);
      }
      return usable;
    } catch {
      // handleLoadStream normally returns false, but keep this path defensive.
      logWarn(`[Failover] Backup "${nextChannel.name}" threw while loading; trying next candidate`);
      setFailoverState(null);
      return false;
    } finally {
      failoverSwitchingRef.current = false;
    }
  }, [handleLoadStream, resetHealthTracking]);

  /**
   * Entry point for both the event-based and watchdog-based stream failure detection.
   * Guards against double-firing and max retry exhaustion.
   */
  const handleStreamDied = useCallback(async () => {
    // Only retry for Live TV (not VOD, not catchup)
    if (!currentChannelRef.current || vodInfoRef.current || catchupInfoRef.current) return;
    if (Bridge.getIsCasting?.()) {
      logInfo('[Retry] Ignoring stream failure — casting is active');
      return;
    }
    if (intentionallyStoppedRef.current) {
      logInfo('[Retry] Ignoring stream failure — main player was intentionally stopped');
      return;
    }
    if (userPausedRef.current) {
      logInfo('[Retry] Ignoring stream failure while user-paused');
      return;
    }
    if (isRetryingRef.current) {
      retryFailedDuringLoadRef.current = true;
      return;
    }
    if (!recoveryArmedRef.current) {
      logInfo('[Retry] Ignoring stream failure before playback was established');
      return;
    }
    // The global re-entrancy guard must win over failoverSwitchingRef: a single
    // death can arrive through multiple paths (mpv-stream-ended, mpv-http-error,
    // mpv-error, mpv-end-file-error). If a redundant signal lands while the
    // first is mid-switch, it must NOT mark the in-flight switch as failed —
    // that burns a healthy backup. failoverSwitchingRef is always true inside a
    // running handleStreamDied, so a genuine new death during a manual switch
    // still reaches the failoverSwitching branch below.
    if (streamFailureHandlingRef.current) return;
    if (failoverSwitchingRef.current) {
      failoverFailedDuringSwitchRef.current = true;
      return;
    }
    streamFailureHandlingRef.current = true;

    try {
      if (!failoverActiveRef.current) {
        failoverCycleStartStreamIdRef.current = currentChannelRef.current.stream_id;
        failoverAttemptedStreamIdsRef.current = new Set([currentChannelRef.current.stream_id]);
      } else {
        failoverAttemptedStreamIdsRef.current.add(currentChannelRef.current.stream_id);
        if (failoverCursorStreamIdRef.current) {
          failoverAttemptedStreamIdsRef.current.add(failoverCursorStreamIdRef.current);
        }
      }

      // Walk the ordered group from the stream that started this failover cycle.
      // The attempted set prevents getting stuck retrying one bad backup while
      // later backups are still available.
      while (currentChannelRef.current && failoverCycleStartStreamIdRef.current) {
        const candidates = await getFailoverCandidatesAfter(failoverCycleStartStreamIdRef.current);
        const nextChannel = candidates.find(
          candidate => !failoverAttemptedStreamIdsRef.current.has(candidate.stream_id)
        );
        if (!nextChannel) break;

        const loaded = await handleFailover(nextChannel);
        if (loaded) return;
      }

      // Failover groups are circular: when the tail of the group is exhausted,
      // rotate back to the primary channel and start a fresh pass. This must
      // NOT be gated on failoverAttemptRef — a channel that is the LAST member
      // of its group has zero untried candidates, so handleFailover never runs
      // and failoverAttemptRef stays 0, yet it should still roll over to the
      // first stream instead of retrying the dead channel.
      const primary = await getPrimaryChannelForGroup(
        failoverCycleStartStreamIdRef.current ?? currentChannelRef.current.stream_id
      );
      if (primary) {
        logWarn('[Failover] End of group reached, rotating back to primary');
        failoverCycleStartStreamIdRef.current = primary.stream_id;
        failoverAttemptedStreamIdsRef.current = new Set();
        failoverCursorStreamIdRef.current = null;
        failoverFailedDuringSwitchRef.current = false;
        setFailoverState(null);

        const loadedPrimary = await handleFailover(primary);
        if (loadedPrimary) return;

        // If the primary fails immediately, continue through the rest of the
        // fresh cycle instead of falling into retry on the last backup.
        while (currentChannelRef.current && failoverCycleStartStreamIdRef.current) {
          const candidates = await getFailoverCandidatesAfter(failoverCycleStartStreamIdRef.current);
          const nextChannel = candidates.find(
            candidate => !failoverAttemptedStreamIdsRef.current.has(candidate.stream_id)
          );
          if (!nextChannel) break;

          const loaded = await handleFailover(nextChannel);
          if (loaded) return;
        }

        logWarn('[Failover] All backups exhausted, falling back to retry on current stream');
        failoverActiveRef.current = false;
        failoverSwitchingRef.current = false;
        failoverAttemptRef.current = 0;
        failoverCursorStreamIdRef.current = null;
        failoverCycleStartStreamIdRef.current = null;
        failoverAttemptedStreamIdsRef.current = new Set();
        failoverFailedDuringSwitchRef.current = false;
        setFailoverState(null);
        startRetryCountdown();
        return;
      }

      // Standard retry path (no failover group configured)
      if (retryAttemptRef.current >= maxRetriesRef.current) {
        logError('[Retry] Max retries reached, giving up');
        setError(i18n.t('player:streamUnavailableMaxRetries'));
        setRetryState(null);
        clearWatchdog();
        return;
      }
      startRetryCountdown();
    } finally {
      streamFailureHandlingRef.current = false;
    }
  }, [handleFailover, startRetryCountdown, clearWatchdog, setError]);

  // Trailers can die a few seconds in when YouTube 403s the media segments
  // (bot detection / transient). handleStreamDied ignores VOD entirely, so
  // without this the trailer just stops. Re-resolve + reload up to 2 times;
  // a genuine natural end (played roughly the full duration) is never retried.
  const maybeRetryTrailerStream = useCallback(async (): Promise<boolean> => {
    const info = vodInfoRef.current;
    if (!info || (info.source_id !== 'trailer' && !isYouTubeUrl(info.url))) return false;
    if (intentionallyStoppedRef.current || userPausedRef.current) return false;
    if (Bridge.getIsCasting?.()) return false;

    const dur = durationRef.current;
    const elapsed = (Date.now() - trailerLoadStartTimeRef.current) / 1000;
    const threshold = dur > 0 ? Math.max(10, dur - 5) : 45;
    if (elapsed >= threshold) {
      logInfo(`[Trailer] Stream ended after ${elapsed.toFixed(1)}s (>= ${threshold.toFixed(1)}s threshold), treating as natural end`);
      return false;
    }
    if (trailerRetryCountRef.current >= 2) {
      logWarn('[Trailer] Stream ended early; max retries reached, giving up');
      return false;
    }

    trailerRetryCountRef.current += 1;
    logInfo(`[Trailer] Stream ended early (elapsed=${elapsed.toFixed(1)}s of ${dur}s), retrying ${trailerRetryCountRef.current}/2`);
    try {
      const resolved = await resolvePlayUrl(info.source_id, info.url);
      if (resolved.url.startsWith('infoHash:')) return false;
      suppressStatusUpdates?.(1500);
      setIgnoreHttpErrors(true);
      setPosition(0);
      setDuration(0);
      // Start the retry from 0 — never re-apply a stale resume seek.
      pendingResumeSeekRef.current = null;
      isInitialSeekPendingRef.current = false;
      let playbackUrl = resolved.url;
      if (info.source_id === 'jellyfin') {
        try {
          const u = new URL(playbackUrl);
          if (info.jellyfinSubtitleStreamId != null) {
            u.searchParams.set('SubtitleStreamIndex', String(info.jellyfinSubtitleStreamId));
          }
          if (info.jellyfinAudioStreamId != null) {
            u.searchParams.set('AudioStreamIndex', String(info.jellyfinAudioStreamId));
          }
          playbackUrl = u.toString();
        } catch {
          // Keep the original stream URL if it cannot be augmented.
        }
      }
      const result = await tryLoadWithFallbacks(playbackUrl, false, resolved.userAgent);
      if (!result.success) {
        logWarn('[Trailer] Retry failed to load:', result.error);
        return false;
      }
      setPlaying(true);
      if (!Bridge.getIsCasting?.()) {
        Bridge.play().catch((e) => console.warn('[usePlayback] play() after trailer retry failed:', e));
      }
      return true;
    } catch (err) {
      logWarn('[Trailer] Retry threw:', err);
      return false;
    }
  }, [setIgnoreHttpErrors, setPosition, setDuration, setPlaying, suppressStatusUpdates]);

  // ── mpv-stream-ended / mpv-end-file-error / mpv-http-error listeners ───────
  // All three failure signals route through handleStreamDied so failover runs.
  useEffect(() => {
    if (!Bridge.isTauri) return;

    let unlistenEnded: (() => void) | null = null;
    let unlistenEndFileError: (() => void) | null = null;
    let unlistenHttpError: (() => void) | null = null;
    let unlistenMpvError: (() => void) | null = null;
    let disposed = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('mpv-stream-ended', async () => {
        if (!useEventBasedReconnectRef.current) {
          logInfo('[Retry] Ignoring mpv-stream-ended event (event-based reconnect disabled)');
          return;
        }
        logInfo('[Retry] Received mpv-stream-ended event');
        if (await maybeRetryTrailerStream()) {
          return;
        }
        handleStreamDied();
      }).then((fn) => {
        if (disposed) fn();
        else unlistenEnded = fn;
      });

      listen('mpv-end-file-error', () => {
        if (!useEventBasedReconnectRef.current) {
          logInfo('[Retry] Ignoring mpv-end-file-error event (event-based reconnect disabled)');
          return;
        }
        logInfo('[Retry] Received mpv-end-file-error event');
        handleStreamDied();
      }).then((fn) => {
        if (disposed) fn();
        else unlistenEndFileError = fn;
      });

      listen('mpv-http-error', (e: any) => {
        // The Rust side maps ffmpeg's `HTTP error <code>` line to a readable
        // message and emits it as the payload. Log it before any early return so
        // a failing stream's status code always reaches ynoTV.log.
        const reason = typeof e?.payload === 'string' && e.payload.trim()
          ? e.payload
          : 'unknown HTTP error';
        if (!useEventBasedReconnectRef.current) {
          logInfo(`[Retry] Ignoring mpv-http-error event (event-based reconnect disabled): ${reason}`);
          return;
        }
        if (isIgnoringHttpErrors()) {
          logInfo(`[Retry] Ignoring mpv-http-error event for current stream: ${reason}`);
          return;
        }
        logInfo(`[Retry] Received mpv-http-error event: ${reason}`);
        handleStreamDied();
      }).then((fn) => {
        if (disposed) fn();
        else unlistenHttpError = fn;
      });

      listen('mpv-error', () => {
        if (!useEventBasedReconnectRef.current) {
          logInfo('[Retry] Ignoring mpv-error event (event-based reconnect disabled)');
          return;
        }
        logInfo('[Retry] Received mpv-error event');
        handleStreamDied();
      }).then((fn) => {
        if (disposed) fn();
        else unlistenMpvError = fn;
      });
    });

    return () => {
      disposed = true;
      unlistenEnded?.();
      unlistenEndFileError?.();
      unlistenHttpError?.();
      unlistenMpvError?.();
    };
  }, [handleStreamDied, isIgnoringHttpErrors, maybeRetryTrailerStream]);

  // ── Live recording duration updater ────────────────────────────────────────
  // When playing a recording that's still being recorded, dynamically update
  // the duration state to reflect the elapsed recording time (seconds since actual start).
  // This allows the timeline and seeker to grow smoothly as the file is recorded.
  useEffect(() => {
    if (
      vodInfo?.type !== 'recording' ||
      vodInfo?.recordingStatus !== 'recording' ||
      !vodInfo?.recordingStart
    ) {
      return;
    }

    const startMs = vodInfo.recordingStart * 1000;

    const interval = setInterval(() => {
      const elapsedSecs = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      setDuration(elapsedSecs);
    }, 1000);

    // Initial update
    const elapsedSecs = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    setDuration(elapsedSecs);

    return () => clearInterval(interval);
  }, [vodInfo?.type, vodInfo?.recordingStatus, vodInfo?.recordingStart, setDuration]);

  // ── Live recording completed event listener ───────────────────────────────
  // Listens to the dvr:event event from Tauri. If the currently playing active
  // recording completes or fails, updates the recordingStatus to 'completed'
  // so that we stop the dynamic duration updater and handle it as a static VOD.
  useEffect(() => {
    if (
      vodInfo?.type !== 'recording' ||
      vodInfo?.recordingStatus !== 'recording' ||
      !currentChannel?.stream_id
    ) {
      return;
    }

    let unlistenFn: (() => void) | undefined;
    let disposed = false;

    const setupListener = async () => {
      try {
        const playingRecordingId = parseInt(currentChannel.stream_id.replace('recording_', '') || '0');
        if (!playingRecordingId) return;

        const unlisten = await listen<any>('dvr:event', (event) => {
          const data = event.payload;
          if (
            data.recording_id === playingRecordingId &&
            (data.event_type === 'completed' || data.event_type === 'failed')
          ) {
            logInfo('[Recording] Active recording ended (event:', data.event_type, '), transitioning to completed VOD');
            setVodInfo((prev) => {
              if (prev && prev.type === 'recording') {
                return {
                  ...prev,
                  recordingStatus: 'completed',
                };
              }
              return prev;
            });
          }
        });

        if (disposed) {
          unlisten();
        } else {
          unlistenFn = unlisten;
        }
      } catch (err) {
        logError('[Recording] Failed to setup dvr:event listener:', err);
      }
    };

    setupListener();

    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
  }, [vodInfo?.type, vodInfo?.recordingStatus, currentChannel?.stream_id]);

  // ── Watchdog interval ──────────────────────────────────────────────────────
  // Runs every 2 seconds while a Live TV channel is active. If position hasn't
  // advanced in STALL_THRESHOLD_MS, treats it as a stalled/dead stream.
  useEffect(() => {
    // Only run for Live TV
    if (!currentChannel || vodInfo || catchupInfo) {
      clearWatchdog();
      return;
    }

    resetHealthTracking();

    const watchdog = setInterval(async () => {
      const now = Date.now();
      if (
        healthCheckInFlightRef.current ||
        isRetryingRef.current ||
        failoverSwitchingRef.current ||
        userPausedRef.current ||
        now < healthLoadGraceUntilRef.current ||
        Bridge.getIsCasting?.()
      ) {
        return;
      }

      if (!stallDetectionEnabledRef.current) {
        // With stall detection off, event-based reconnect is fully event-driven:
        // the Rust side now synthesizes mpv-stream-ended on the eof-reached
        // rising edge (see mpv_windows.rs), so no polling is needed here.
        healthCheckInFlightRef.current = false;
        return;
      }

      healthCheckInFlightRef.current = true;

      try {
        const [
          timePosResult,
          pausedForCacheResult,
          bufferingStateResult,
          cacheStateResult,
          eofReachedResult,
          coreIdleResult,
          idleActiveResult,
        ] = await Promise.allSettled([
          Bridge.getProperty('time-pos'),
          Bridge.getProperty('paused-for-cache'),
          Bridge.getProperty('cache-buffering-state'),
          Bridge.getProperty('demuxer-cache-state'),
          Bridge.getProperty('eof-reached'),
          Bridge.getProperty('core-idle'),
          Bridge.getProperty('idle-active'),
        ]);

        const getValue = (result: PromiseSettledResult<any>) =>
          result.status === 'fulfilled' ? result.value : null;

        const sampledPosition = mpvNumber(getValue(timePosResult)) ?? positionRef.current;
        const pausedForCache = mpvBoolean(getValue(pausedForCacheResult)) === true;
        const bufferingState = mpvNumber(getValue(bufferingStateResult));
        const cacheState = mpvObject(getValue(cacheStateResult));
        const eofReached = mpvBoolean(getValue(eofReachedResult)) === true;
        const coreIdle = mpvBoolean(getValue(coreIdleResult)) === true;
        const idleActive = mpvBoolean(getValue(idleActiveResult)) === true;

        const cacheStart = mpvNumber(cacheState?.['cache-start']);
        const cacheEnd = mpvNumber(cacheState?.['cache-end']);
        const cacheDurationProp = mpvNumber(cacheState?.['cache-duration']);
        const readerPts = mpvNumber(cacheState?.['reader-pts']);
        const forwardBytes = mpvNumber(cacheState?.['fw-bytes']);
        const cacheDuration = cacheDurationProp
          ?? (cacheStart !== null && cacheEnd !== null ? Math.max(0, cacheEnd - cacheStart) : null);

        const positionAdvanced = sampledPosition > lastHealthPositionRef.current + 0.25;
        const cacheEndAdvanced = cacheEnd !== null && (
          lastHealthCacheEndRef.current === null ||
          cacheEnd > lastHealthCacheEndRef.current + 0.25
        );
        const readerAdvanced = readerPts !== null && readerPts > sampledPosition + 0.5;
        const forwardBytesAdvanced = forwardBytes !== null && (
          lastHealthForwardBytesRef.current === null ||
          forwardBytes > lastHealthForwardBytesRef.current
        );
        const cacheHasPlayableData = cacheDuration !== null && cacheDuration > 1.5;
        const cacheIsGrowing = cacheEndAdvanced || readerAdvanced || forwardBytesAdvanced;
        const buffering = pausedForCache || (bufferingState !== null && bufferingState < 100);
        const madeProgress = positionAdvanced || cacheIsGrowing;

        if (positionAdvanced) {
          lastHealthPositionRef.current = sampledPosition;
          lastPositionRef.current = sampledPosition;
        }
        if (cacheEnd !== null) {
          lastHealthCacheEndRef.current = cacheEnd;
        }
        if (forwardBytes !== null) {
          lastHealthForwardBytesRef.current = forwardBytes;
        }
        if (madeProgress) {
          if (retryAttemptRef.current > 0 && !isRetryingRef.current) {
            logInfo('[Retry] Playback progress detected, resetting retry attempts');
            retryAttemptRef.current = 0;
          }
          recoveryArmedRef.current = true;
          lastHealthActivityTimeRef.current = now;
          lastPositionTimeRef.current = now;
          bufferStarvedSinceRef.current = null;
        }

        if (!recoveryArmedRef.current) {
          return;
        }

        if (eofReached || ((coreIdle || idleActive) && !madeProgress)) {
          logWarn('[Health] MPV reported idle/eof during live playback, triggering failover/retry');
          handleStreamDied();
          return;
        }

        if (buffering && !cacheIsGrowing && !cacheHasPlayableData) {
          bufferStarvedSinceRef.current ??= now;
          const starvedFor = now - bufferStarvedSinceRef.current;
          const starvationThreshold = Math.min(
            Math.max(MIN_BUFFER_STARVATION_MS, stallThresholdMsRef.current / 2),
            stallThresholdMsRef.current
          );
          if (starvedFor >= starvationThreshold) {
            logWarn(`[Health] MPV buffer starved for ${starvedFor}ms, triggering failover/retry`);
            handleStreamDied();
            return;
          }
        } else {
          bufferStarvedSinceRef.current = null;
        }

        const stalledFor = now - lastHealthActivityTimeRef.current;
        if (stalledFor >= stallThresholdMsRef.current) {
          logWarn(`[Health] No playback or cache progress for ${stalledFor}ms, triggering failover/retry`);
          handleStreamDied();
        }
      } catch (e) {
        logWarn('[Health] MPV health check failed:', e);
      } finally {
        healthCheckInFlightRef.current = false;
      }
    }, HEALTH_POLL_INTERVAL_MS);

    watchdogIntervalRef.current = watchdog;

    return () => { clearInterval(watchdog); watchdogIntervalRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChannel?.stream_id, !!vodInfo, !!catchupInfo, resetHealthTracking]);

  const handlePlayChannel = useCallback(async (
    channel: StoredChannel,
    autoSwitched: boolean = false,
    directPlay: boolean = false
  ) => {
    // Cancel any in-progress retry when the user switches channels
    if (autoSelectTimerRef.current) {
      clearInterval(autoSelectTimerRef.current);
      autoSelectTimerRef.current = null;
    }
    hasAutoSelectedSubRef.current = false;
    hasAutoSelectedAudioRef.current = false;
    subAutoSelectEverCompletedRef.current = false;
    clearSubtitleIntent();
    lastSubTracksCountRef.current = 0;
    lastAudioTracksCountRef.current = 0;
    isStalkerVodRef.current = false;
    startAutoSelectPolling();

    clearRetryTimers();
    clearWatchdog();
    clearPendingSeeks();
    setRetryState(null);
    isRetryingRef.current = false;
    retryAttemptRef.current = 0;
    retryFailedDuringLoadRef.current = false;
    streamFailureHandlingRef.current = false;
    recoveryArmedRef.current = autoSwitched;
    userPausedRef.current = false;
    intentionallyStoppedRef.current = false;
    resetHealthTracking();

    // Reset failover state on manual channel switch
    failoverActiveRef.current = false;
    failoverSwitchingRef.current = false;
    failoverOriginChannelRef.current = null;
    failoverAttemptRef.current = 0;
    failoverCursorStreamIdRef.current = null;
    failoverCycleStartStreamIdRef.current = null;
    failoverAttemptedStreamIdsRef.current = new Set();
    failoverFailedDuringSwitchRef.current = false;
    retryFailedDuringLoadRef.current = false;
    streamFailureHandlingRef.current = false;
    bufferStarvedSinceRef.current = null;
    healthCheckInFlightRef.current = false;
    recoveryArmedRef.current = autoSwitched;
    userPausedRef.current = false;
    setFailoverState(null);

    // Save local VOD progress before switching to Live TV. Jellyfin owns its
    // resume position on the server; never create/overwrite a second local
    // resume record for a Jellyfin handoff.
    if (vodInfo && vodInfo.source_id !== 'jellyfin' && position > 0 && duration > 0) {
      const mediaId = vodInfo.mediaId || (vodInfo.source_id && vodInfo.url
        ? `${vodInfo.source_id}_${vodInfo.url}`
        : null);
      if (mediaId && vodInfo.type !== 'recording') {
        // For series episodes, save both levels
        if (vodInfo.type === 'series' && mediaId.includes('_ep_')) {
          const parts = mediaId.split('_ep_');
          if (parts.length === 2) {
            const seriesId = parts[0];
            const episodeId = parts[1];
            
            // Save series-level progress (for Recently Watched)
            void updateVodWatchProgress(
              seriesId,
              'series',
              Math.floor(position),
              Math.floor(duration),
              vodInfo.source_id || '',
              vodInfo.title || '',
              vodInfo.posterUrl
            );
            
            // Save episode-level progress (for episode resume)
            void recordEpisodeWatch(
              episodeId,
              seriesId,
              vodInfo.source_id || '',
              vodInfo.seasonNum ?? 0,
              vodInfo.episodeNum ?? 0,
              vodInfo.episodeInfo || '',
              Math.floor(position),
              Math.floor(duration)
            );
          }
        } else {
          // For movies or series without episode info
          void updateVodWatchProgress(
            mediaId,
            vodInfo.type as 'movie' | 'series',
            Math.floor(position),
            Math.floor(duration),
            vodInfo.source_id || '',
            vodInfo.title || '',
            vodInfo.posterUrl
          );
        }
      }
    }
    setVodInfo(null);
    setCatchupInfo(null);

    // Monotonic guard: the primary-channel lookup below is async, so a fast
    // sequence of zaps could otherwise resolve out of order (a group-member
    // lookup also round-trips through storage, making it slower than a plain
    // non-member lookup) and load the wrong channel last. Bump a sequence
    // number per call and ignore this invocation if a newer one arrived while
    // we were awaiting.
    const playSeq = ++playChannelSeqRef.current;
    let channelToPlay = channel;
    if (!autoSwitched && !directPlay && useSettingsStore.getState().failoverAlwaysPlayPrimary) {
      try {
        const primary = await getPrimaryChannelForGroup(channel.stream_id);
        if (primary) {
          channelToPlay = primary;
        }
      } catch (err) {
        console.error('[Playback] Failed to lookup primary failover channel:', err);
      }
    }
    if (playSeq !== playChannelSeqRef.current) return; // superseded by a newer zap

    if (!autoSwitched) {
      addToRecentChannels(channelToPlay);
    }
    handleLoadStream(channelToPlay);
  }, [handleLoadStream, resetHealthTracking, vodInfo, position, duration]);

  const applyJellyfinSubtitleSelection = useCallback(
    async (vod: VodPlayInfo, resolvedExternalUrls?: Map<string, string>): Promise<boolean> => {
      if (vod.source_id !== 'jellyfin') return false;

      const targetSubId = vod.jellyfinSubtitleStreamId;
      if (targetSubId === -1) {
        logInfo('[Jellyfin] Subtitle explicitly set to None (-1). Disabling subtitles in MPV.');
        await Bridge.setSubtitleTrack(0).catch(() => {});
        return true;
      }

      if (targetSubId == null) {
        return false;
      }

      const metaTracks = vod.jellyfinSubtitleTracks || [];
      const pickedMeta = metaTracks.find((t) => t.index === targetSubId) || metaTracks.find((t) => t.selected || t.default);

      const normSubPath = (p?: string) => (p || '').replace(/\\/g, '/').toLowerCase().trim();

      // 1. If the target is an external subtitle track
      if (pickedMeta?.isExternal && pickedMeta.deliveryUrl) {
        const resolvedPath = resolvedExternalUrls?.get(pickedMeta.deliveryUrl) ||
                             jellyfinResolvedSubsRef.current.get(pickedMeta.deliveryUrl) ||
                             pickedMeta.deliveryUrl;
        const normResolved = normSubPath(resolvedPath);
        const normDelivery = normSubPath(pickedMeta.deliveryUrl);
        const normTitle = (pickedMeta.title || '').trim().toLowerCase();

        const trackList = (await Bridge.getTrackList().catch(() => [])) as any[];
        const subTracks = trackList.filter((t: any) => t.type === 'sub');
        const extTracks = subTracks.filter((t: any) => t.external);

        const match = extTracks.find((t: any) => {
          const extFile = normSubPath(t['external-filename']);
          if (normResolved && extFile && extFile === normResolved) return true;
          if (normDelivery && extFile && extFile === normDelivery) return true;
          if (normTitle && t.title && t.title.trim().toLowerCase() === normTitle) return true;
          return false;
        }) || (extTracks.length === 1 ? extTracks[0] : null);

        if (match?.id != null) {
          logInfo(`[Jellyfin] Selected external subtitle track ${match.id} (${pickedMeta.title || pickedMeta.lang || 'external'})`);
          await Bridge.setSubtitleTrack(match.id).catch(() => {});
          return true;
        }
        return false;
      }

      // 2. If the target is an embedded subtitle track
      const trackList = (await Bridge.getTrackList().catch(() => [])) as any[];
      const subTracks = trackList.filter((t: any) => t.type === 'sub');
      const embeddedSubTracks = subTracks.filter((t: any) => !t.external);

      if (embeddedSubTracks.length > 0) {
        // Calculate 1-based relative index among non-external subtitle streams (matching jellyfin-desktop)
        let foundInMeta = false;
        let relIndex = 1;
        for (const st of metaTracks) {
          if (st.isExternal) continue;
          if (st.index === targetSubId) {
            foundInMeta = true;
            break;
          }
          relIndex++;
        }

        // Match by 1-based relative index among embedded tracks if found in PlaybackInfo stream list
        if (foundInMeta && embeddedSubTracks[relIndex - 1]) {
          const matchByRel = embeddedSubTracks[relIndex - 1];
          if (matchByRel?.id != null) {
            logInfo(`[Jellyfin] Selected embedded subtitle track by relative index: track ${matchByRel.id} (relIndex ${relIndex}, stream ${targetSubId})`);
            await Bridge.setSubtitleTrack(matchByRel.id).catch(() => {});
            return true;
          }
        }

        // Fallback 1: match by language or title from metadata
        if (pickedMeta) {
          const wantLang = (pickedMeta.lang || '').toLowerCase();
          const wantTitle = (pickedMeta.title || '').toLowerCase();
          const match = embeddedSubTracks.find((t: any) => {
            const lang = String(t.lang || '').toLowerCase();
            const title = String(t.title || '').toLowerCase();
            return (wantLang && lang === wantLang) || (wantTitle && title === wantTitle);
          });
          if (match?.id != null) {
            logInfo(`[Jellyfin] Selected embedded subtitle track by metadata match: track ${match.id} (${wantLang || wantTitle})`);
            await Bridge.setSubtitleTrack(match.id).catch(() => {});
            return true;
          }
        }

        // Fallback 2: if targetSubId is a 1-based relative index within range
        if (targetSubId > 0 && targetSubId <= embeddedSubTracks.length) {
          const directMatch = embeddedSubTracks[targetSubId - 1];
          if (directMatch?.id != null) {
            logInfo(`[Jellyfin] Selected embedded subtitle track by direct index fallback: track ${directMatch.id} (relIndex ${targetSubId})`);
            await Bridge.setSubtitleTrack(directMatch.id).catch(() => {});
            return true;
          }
        }
      }

      return false;
    },
    [],
  );

  const applyJellyfinAudioSelection = useCallback(
    async (vod: VodPlayInfo) => {
      if (vod.source_id !== 'jellyfin') return false;
      const targetAudioId = vod.jellyfinAudioStreamId;
      if (targetAudioId == null) return false;

      const metaTracks = vod.jellyfinAudioTracks || [];
      const pickedMeta = metaTracks.find((t) => t.index === targetAudioId);

      const trackList = (await Bridge.getTrackList().catch(() => [])) as any[];
      const audioTracks = trackList.filter((t: any) => t.type === 'audio');

      if (audioTracks.length > 0) {
        // 1. First priority: match by metadata (language and/or title)
        if (pickedMeta) {
          const wantLang = normalizeLangCode(pickedMeta.lang);
          const wantTitle = (pickedMeta.title || '').trim().toLowerCase();

          // Match both language AND title if available
          if (wantLang && wantTitle) {
            const bothMatch = audioTracks.find(
              (t: any) => normalizeLangCode(t.lang) === wantLang && (t.title || '').trim().toLowerCase() === wantTitle,
            );
            if (bothMatch?.id != null) {
              logInfo(`[Jellyfin] Selected audio track by lang+title match: track ${bothMatch.id} (${wantLang}, ${wantTitle})`);
              await Bridge.setAudioTrack(bothMatch.id).catch(() => {});
              return true;
            }
          }

          // Match by normalized language code
          if (wantLang) {
            const langMatch = audioTracks.find((t: any) => normalizeLangCode(t.lang) === wantLang);
            if (langMatch?.id != null) {
              logInfo(`[Jellyfin] Selected audio track by language match: track ${langMatch.id} (${wantLang})`);
              await Bridge.setAudioTrack(langMatch.id).catch(() => {});
              return true;
            }
          }

          // Match by title
          if (wantTitle) {
            const titleMatch = audioTracks.find((t: any) => (t.title || '').trim().toLowerCase() === wantTitle);
            if (titleMatch?.id != null) {
              logInfo(`[Jellyfin] Selected audio track by title match: track ${titleMatch.id} (${wantTitle})`);
              await Bridge.setAudioTrack(titleMatch.id).catch(() => {});
              return true;
            }
          }
        }

        // 2. Second priority: calculate 1-based relative index among audio streams
        let foundInMeta = false;
        let relIndex = 1;
        for (const st of metaTracks) {
          if (st.index === targetAudioId) {
            foundInMeta = true;
            break;
          }
          relIndex++;
        }

        if (foundInMeta && audioTracks[relIndex - 1]) {
          const matchByRel = audioTracks[relIndex - 1];
          if (matchByRel?.id != null) {
            logInfo(`[Jellyfin] Selected audio track by relative index fallback: track ${matchByRel.id} (relIndex ${relIndex}, stream ${targetAudioId})`);
            await Bridge.setAudioTrack(matchByRel.id).catch(() => {});
            return true;
          }
        }
      }
      return false;
    },
    [],
  );

  const autoSelectSubtitle = useCallback(async (providedSubTracks?: any[]) => {
    // A track the user picked (including Off) is authoritative for this stream:
    // re-applying the configured default over it is the bug this guard exists
    // for. The intent is cleared when a different stream takes over.
    if (getSubtitleIntent() !== null) {
      hasAutoSelectedSubRef.current = true;
      subAutoSelectEverCompletedRef.current = true;
      return;
    }

    // Jellyfin supplies the authoritative selected/default subtitle.
    if (vodInfoRef.current?.source_id === 'jellyfin') {
      const currentVod = vodInfoRef.current;
      const done = await applyJellyfinSubtitleSelection(currentVod);
      if (done || currentVod.jellyfinSubtitleStreamId === -1 || currentVod.jellyfinSubtitleStreamId == null) {
        hasAutoSelectedSubRef.current = true;
        if (autoSelectAttemptsRef.current >= 4) {
          subAutoSelectEverCompletedRef.current = true;
        }
      }
      return;
    }
    const ss = useSettingsStore.getState().subtitleSettings;
    const rawDefaultLanguage = ss?.defaultLanguage || 'en';

    const subTracks = providedSubTracks || (await Bridge.getTrackList()).filter((t: any) => t.type === 'sub');

    // Closed-caption/teletext tracks are opt-in only — never auto-select them.
    const selectableSubTracks = subTracks.filter((t: any) => !isClosedCaptionTrack(t));

    if (rawDefaultLanguage === 'off') {
      logInfo(`[Playback] Subtitle language set to off. Disabling subtitles. (found ${subTracks.length} tracks, attempt ${autoSelectAttemptsRef.current})`);
      await Bridge.setSubtitleTrack(0);
      if (subTracks.length > 0 || autoSelectAttemptsRef.current >= 5) {
        hasAutoSelectedSubRef.current = true;
        subAutoSelectEverCompletedRef.current = true;
      }
      return;
    }

    const defaultLanguage = normalizeLangCode(rawDefaultLanguage);
    if (!defaultLanguage) return;

    // Filter tracks matching target language
    const matchingTracks = selectableSubTracks.filter((t: any) => getTrackLanguage(t) === defaultLanguage);

    // Separate forced tracks (skip them if non-forced alternatives exist)
    const forcedTracks: any[] = [];
    const nonForcedTracks: any[] = [];
    for (const t of matchingTracks) {
      const title = (t.title || '').toLowerCase();
      if (title.includes('forced') || title.includes('forçado')) {
        forcedTracks.push(t);
      } else {
        nonForcedTracks.push(t);
      }
    }

    const candidates = nonForcedTracks.length > 0 ? nonForcedTracks : forcedTracks;

    if (candidates.length > 0) {
      // Prioritize embedded tracks (external is falsy) over external addon tracks
      candidates.sort((a: any, b: any) => {
        const aExt = !!a.external;
        const bExt = !!b.external;
        if (aExt !== bExt) {
          return aExt ? 1 : -1;
        }
        return a.id - b.id;
      });

      const bestTrack = candidates[0];
      logInfo(`[Playback] Auto-selecting subtitle track: ${bestTrack.id} language: ${defaultLanguage} external: ${bestTrack.external} title: ${bestTrack.title}`);
      await Bridge.setSubtitleTrack(bestTrack.id);
      hasAutoSelectedSubRef.current = true;
      subAutoSelectEverCompletedRef.current = true;
    } else if (subTracks.length > 0) {
      // No language match. If there's an unambiguous EMBEDDED subtitle track
      // (single track, or one explicitly flagged default/forced) select it so
      // embedded subs actually load for users with a default language set.
      // We deliberately skip external tracks here so we never force a foreign
      // subtitle the user didn't ask for. CC/teletext tracks are excluded too —
      // closed captions are opt-in only. Otherwise just apply full subtitle
      // settings so any active MPV subtitle gets proper styling.
      const fallback =
        selectableSubTracks.find((t: any) => !t.external && t.default === true) ||
        selectableSubTracks.find((t: any) => {
          if (t.external) return false;
          const title = (t.title || '').toLowerCase();
          return title.includes('default') || title.includes('forced') || title.includes('forçado');
        }) ||
        (selectableSubTracks.length === 1 && !selectableSubTracks[0].external ? selectableSubTracks[0] : null);

      if (fallback) {
        logInfo(`[Playback] No ${defaultLanguage} match (${subTracks.length} tracks); falling back to embedded subtitle track: ${fallback.id} title: ${fallback.title}`);
        await Bridge.setSubtitleTrack(fallback.id);
      } else {
        // Apply full subtitle settings so any active MPV subtitle (e.g. auto-selected CC/ASS track) gets proper sizing, scaling & ASS overrides.
        await applySubtitleSettings();
      }
      hasAutoSelectedSubRef.current = true;
      subAutoSelectEverCompletedRef.current = true;
    }
  }, []);

  // ── Universal seek subtitle cleanup ────────────────────────────────────────
  // On Live TV (timeshifting/seeking) and Stalker/HLS VODs, seeking backwards or
  // forwards can cause mpv's libass / FFmpeg EIA-608 CC decoder to retain past
  // dialogue events and decode duplicate dialogue events at the same timestamps,
  // producing double/triple/multi-layered stacked subtitles.
  // We do NOT disable subtitles during mid-seek scrubbing (which causes tracks to
  // unselect during seekbar drag). Instead, when seeking finishes (playback-restart),
  // we re-apply the user's active subtitle track so libass decodes cleanly from the
  // new timestamp with proper styling.
  useEffect(() => {
    if (!Bridge.isTauri) return;

    let unlistenRestart: (() => void) | null = null;
    let unlistenFileLoaded: (() => void) | null = null;
    let disposed = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('mpv-playback-restart', async () => {
        const wasSeeking = wasSeekingRef.current;
        wasSeekingRef.current = false;

        // Read the currently active/selected subtitle track (from Bridge or MPV track list)
        let currentSubId = Bridge.getSubtitleTrackId?.() ?? null;

        if (currentSubId === null) {
          // If we don't have a track recorded in Bridge, check MPV's track list
          try {
            const trackList = await Bridge.getTrackList();
            const selected = (trackList as any[]).find((t: any) => t.type === 'sub' && t.selected);
            if (selected && selected.id > 0) {
              currentSubId = selected.id;
            }
          } catch {}
        }

        if (wasSeeking && currentSubId !== null && currentSubId > 0) {
          logInfo(`[Subtitle] Playback-restart after seek — cycling subtitle track ${currentSubId} to clear libass/CC decoder cache`);
          // Toggle sid to 0 then restore target ID to purge stale dialogue events and reset the CC decoder
          await invoke('mpv_set_subtitle', { id: 0 }).catch(() => {});
          await Bridge.setSubtitleTrack(currentSubId).catch(() => {});
        } else if (isStalkerVodRef.current && !subAutoSelectEverCompletedRef.current) {
          logInfo('[Subtitle] Stalker VOD playback-restart — re-running subtitle auto-select');
          hasAutoSelectedSubRef.current = false;
          lastSubTracksCountRef.current = 0;
          await autoSelectSubtitle().catch(() => {});
        }
      }).then((fn) => {
        if (disposed) fn();
        else unlistenRestart = fn;
      });

      // Rust disables subtitles (`sid=no`) on every file load, which is why mpv
      // does not auto-enable half a dozen CC services at once. A retry or a
      // reload of the *same* stream therefore drops a track the user chose, and
      // auto-select will not bring it back (it has already settled). Re-apply it
      // once the reloaded stream exposes its track list again; a different
      // stream clears the intent, so this can never follow a channel change.
      listen('mpv-file-loaded', async () => {
        const requestedId = restorableSubtitleTrackId(getSubtitleIntent());
        if (requestedId === null) return;

        for (let attempt = 0; attempt < 10; attempt += 1) {
          if (disposed || restorableSubtitleTrackId(getSubtitleIntent()) !== requestedId) return;

          const trackList = await Bridge.getTrackList().catch(() => []);
          if ((trackList as any[]).some((t: any) => t.type === 'sub' && t.id === requestedId)) {
            logInfo(`[Subtitle] Restoring track ${requestedId} after a stream reload`);
            await Bridge.setSubtitleTrack(requestedId).catch(() => {});
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        logInfo(`[Subtitle] Track ${requestedId} is not present after the reload; leaving subtitles as mpv loaded them`);
      }).then((fn) => {
        if (disposed) fn();
        else unlistenFileLoaded = fn;
      });
    });

    return () => {
      disposed = true;
      unlistenRestart?.();
      unlistenFileLoaded?.();
    };
  }, [autoSelectSubtitle]);

  // Synchronize live MPV playback when subtitle settings change in store
  const subtitleSettings = useSettingsStore((s) => s.subtitleSettings);
  useEffect(() => {
    if (playing) {
      applySubtitleSettings().catch(() => {});
    }
  }, [subtitleSettings, playing]);

  const autoSelectAudio = useCallback(async (providedAudioTracks?: any[]) => {
    // Jellyfin supplies the authoritative selected audio stream index.
    if (vodInfoRef.current?.source_id === 'jellyfin' && vodInfoRef.current?.jellyfinAudioStreamId != null) {
      const done = await applyJellyfinAudioSelection(vodInfoRef.current);
      if (done) {
        hasAutoSelectedAudioRef.current = true;
        return;
      }
    }

    const ss = useSettingsStore.getState().subtitleSettings;
    const rawDefaultAudioLanguage = ss?.defaultAudioLanguage || 'default';

    if (rawDefaultAudioLanguage === 'default') {
      logInfo('[Playback] Audio language set to default. Keeping player default audio track.');
      hasAutoSelectedAudioRef.current = true;
      return;
    }

    const defaultAudioLanguage = normalizeLangCode(rawDefaultAudioLanguage);
    if (!defaultAudioLanguage) return;

    const audioTracks = providedAudioTracks || (await Bridge.getTrackList()).filter((t: any) => t.type === 'audio');

    // Filter tracks matching target language
    const matchingTracks = audioTracks.filter((t: any) => normalizeLangCode(t.lang) === defaultAudioLanguage);

    if (matchingTracks.length > 0) {
      // Prioritize default track
      matchingTracks.sort((a: any, b: any) => {
        const aDef = !!a.default;
        const bDef = !!b.default;
        if (aDef !== bDef) {
          return aDef ? -1 : 1;
        }
        return a.id - b.id;
      });

      const bestTrack = matchingTracks[0];
      logInfo(`[Playback] Auto-selecting audio track: ${bestTrack.id} language: ${defaultAudioLanguage}`);
      await Bridge.setAudioTrack(bestTrack.id);
      hasAutoSelectedAudioRef.current = true;
    }
  }, []);

  const startAutoSelectPolling = useCallback(() => {
    if (autoSelectTimerRef.current) {
      clearInterval(autoSelectTimerRef.current);
    }

    autoSelectAttemptsRef.current = 0;
    autoSelectTimerRef.current = setInterval(async () => {
      autoSelectAttemptsRef.current += 1;
      
      try {
        const trackList = await Bridge.getTrackList();
        const subTracks = trackList.filter((t: any) => t.type === 'sub');
        const audioTracks = trackList.filter((t: any) => t.type === 'audio');

        const subtitlePlan = planSubtitleAutoSelect({
          intent: getSubtitleIntent(),
          trackCountChanged: subTracks.length !== lastSubTracksCountRef.current,
          jellyfinWantsSubtitle: vodInfoRef.current?.source_id === 'jellyfin' &&
            vodInfoRef.current.jellyfinSubtitleStreamId !== -1 &&
            vodInfoRef.current.jellyfinSubtitleStreamId != null,
          hasSubtitleTracks: subTracks.length > 0,
          anySubtitleSelected: subTracks.some((t: any) => t.selected),
          attempts: autoSelectAttemptsRef.current,
          autoSelectSettled: subAutoSelectEverCompletedRef.current,
        });

        if (subTracks.length !== lastSubTracksCountRef.current) {
          // During the initial settling window (first 15 attempts / ~7.5s),
          // ANY track count change MUST reset auto-select so the final track set
          // is evaluated with the correct track IDs — unless the user has since
          // picked a track themselves, in which case there is nothing to evaluate.
          logInfo(subtitlePlan.resetSubtitleAutoSelect
            ? `[Playback] Subtitle track count changed from ${lastSubTracksCountRef.current} to ${subTracks.length}. Resetting auto-select state.`
            : `[Playback] Subtitle track count changed from ${lastSubTracksCountRef.current} to ${subTracks.length}; keeping the current subtitle selection.`);
          lastSubTracksCountRef.current = subTracks.length;
        }

        // For Jellyfin: if a subtitle was requested (not None) but MPV currently
        // has no subtitle selected (e.g. MKV demuxer reset sid to no / 0 upon
        // loading), retry selection during the initial settling window.
        if (subtitlePlan.settleSubtitleAutoSelect) {
          // The user's choice settles the subtitle half of auto-selection, so the
          // poll can stop re-evaluating it and wind down.
          hasAutoSelectedSubRef.current = true;
          subAutoSelectEverCompletedRef.current = true;
        } else if (subtitlePlan.resetSubtitleAutoSelect) {
          hasAutoSelectedSubRef.current = false;
        }

        if (audioTracks.length !== lastAudioTracksCountRef.current) {
          logInfo(`[Playback] Audio track count changed from ${lastAudioTracksCountRef.current} to ${audioTracks.length}. Resetting auto-select state.`);
          hasAutoSelectedAudioRef.current = false;
          lastAudioTracksCountRef.current = audioTracks.length;
        }

        if (!hasAutoSelectedSubRef.current) {
          await autoSelectSubtitle(subTracks);
        }
        if (!hasAutoSelectedAudioRef.current) {
          await autoSelectAudio(audioTracks);
        }
      } catch (err) {
        logWarn('[Playback] Error during auto-selection polling:', err);
      }

      const allDone = hasAutoSelectedSubRef.current && hasAutoSelectedAudioRef.current;
      if (allDone && autoSelectAttemptsRef.current >= 15) {
        if (autoSelectTimerRef.current) {
          clearInterval(autoSelectTimerRef.current);
          autoSelectTimerRef.current = null;
        }
      } else if (autoSelectAttemptsRef.current >= 40) {
        if (autoSelectTimerRef.current) {
          clearInterval(autoSelectTimerRef.current);
          autoSelectTimerRef.current = null;
        }
      }
    }, 500);
  }, [autoSelectSubtitle, autoSelectAudio]);

  // Trigger or restart auto-selection polling when playback starts (for Live TV, VODs, Catchup, Recordings, Stremio)
  useEffect(() => {
    if (playing) {
      if (!hasAutoSelectedSubRef.current || !hasAutoSelectedAudioRef.current) {
        startAutoSelectPolling();
      }
    }
  }, [playing, startAutoSelectPolling]);

  const handlePlayCatchup = useCallback(async (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, programDesc?: string) => {
    const startPaddingMs = catchupStartPaddingRef.current * 60_000;
    const endPaddingMs = catchupEndPaddingRef.current * 60_000;
    const adjustedStartTimeMs = startTimeMs - startPaddingMs;

    let adjustedDurationMinutes = durationMinutes;
    if (catchupContinuePlayingRef.current) {
      const maxPossibleMins = Math.ceil((Date.now() - adjustedStartTimeMs) / 60_000);
      adjustedDurationMinutes = Math.max(durationMinutes + catchupStartPaddingRef.current, Math.min(720, maxPossibleMins));
    } else {
      adjustedDurationMinutes = durationMinutes + catchupStartPaddingRef.current + catchupEndPaddingRef.current;
    }

    if (pendingCatchupSeekRef.current === null) {
      clearPendingSeeks();
    }
    // Save local VOD progress before switching to catchup. Jellyfin progress
    // is reported to Jellyfin itself, not stored in ynoTV's local history.
    if (vodInfo && vodInfo.source_id !== 'jellyfin' && position > 0 && duration > 0) {
      const mediaId = vodInfo.mediaId || (vodInfo.source_id && vodInfo.url
        ? `${vodInfo.source_id}_${vodInfo.url}`
        : null);
      if (mediaId && vodInfo.type !== 'recording') {
        // For series episodes, save both levels
        if (vodInfo.type === 'series' && mediaId.includes('_ep_')) {
          const parts = mediaId.split('_ep_');
          if (parts.length === 2) {
            const seriesId = parts[0];
            const episodeId = parts[1];
            
            // Save series-level progress (for Recently Watched)
            void updateVodWatchProgress(
              seriesId,
              'series',
              Math.floor(position),
              Math.floor(duration),
              vodInfo.source_id || '',
              vodInfo.title || '',
              vodInfo.posterUrl
            );
            
            // Save episode-level progress (for episode resume)
            void recordEpisodeWatch(
              episodeId,
              seriesId,
              vodInfo.source_id || '',
              vodInfo.seasonNum ?? 0,
              vodInfo.episodeNum ?? 0,
              vodInfo.episodeInfo || '',
              Math.floor(position),
              Math.floor(duration)
            );
          }
        } else {
          // For movies or series without episode info
          void updateVodWatchProgress(
            mediaId,
            vodInfo.type as 'movie' | 'series',
            Math.floor(position),
            Math.floor(duration),
            vodInfo.source_id || '',
            vodInfo.title || '',
            vodInfo.posterUrl
          );
        }
      }
    }
    setError(null);
    setVodInfo(null);

    // Use xtream_stream_id for M3U sources with Xtream catchup, otherwise strip prefix
    // Fallback: try extracting from direct_url if xtream_stream_id is not set
    let rawStreamId = (channel as any).xtream_stream_id;
    if (!rawStreamId) {
      const { extractXtreamStreamId } = await import('@ynotv/local-adapter');
      rawStreamId = extractXtreamStreamId(channel.direct_url) || channel.stream_id.replace(`${channel.source_id}_`, '');
    }

    console.log(`[Catchup] Channel:`, {
      name: channel.name,
      source_id: channel.source_id,
      stream_id: channel.stream_id,
      xtream_stream_id: (channel as any).xtream_stream_id,
      rawStreamId,
      direct_url: channel.direct_url,
      tv_archive: channel.tv_archive,
    });
    console.log(`[Catchup] Program:`, { programTitle, startTimeMs: new Date(adjustedStartTimeMs).toISOString(), durationMinutes: adjustedDurationMinutes });

    let resolved;
    try {
      resolved = await resolvePlayUrl(channel.source_id, channel.direct_url, {
        rawStreamId,
        startTimeMs: adjustedStartTimeMs,
        durationMinutes: adjustedDurationMinutes,
        catchupSource: (channel as any).catchup_source,
        catchupType: (channel as any).catchup_type,
        catchupDays: (channel as any).catchup_days,
        epgChannelId: channel.epg_channel_id || channel.stream_id,
      });
    } catch (e) {
      console.error('Failed to resolve catchup source:', e);
      setError(i18n.t('player:failedToResolveCatchupStream'));
      return;
    }

    // Catchup/timeshift is a stream transition like any other: reset the progress
    // latch and any deferred HTTP error so a fresh failure on a local URL isn't
    // masked as "stream is already playing".
    suppressStatusUpdates?.(1500);
    const isLocal = isLocalUrl(resolved.url);
    if (isLocal) {
      setIgnoreHttpErrors(true);
    }
    const result = await tryLoadWithFallbacks(resolved.url, false, resolved.userAgent);
      if (!result.success) {
      if (isLocal) setIgnoreHttpErrors(false);
      setError(translateNativeError(result.error) || i18n.t('player:failedToLoadCatchupStream'));
    } else {
      setCurrentChannel(channel);
      setCatchupInfo({ channelId: channel.stream_id, programTitle, startTime: adjustedStartTimeMs, duration: adjustedDurationMinutes, programDesc });
      setPlaying(true);
    }
  }, [vodInfo, position, duration, clearPendingSeeks, suppressStatusUpdates]);

  const handleCatchupSeek = useCallback(async (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, seekSeconds: number, programDesc?: string) => {
    seekingRef.current = true;
    wasSeekingRef.current = true;
    clearPendingSeeks();
    const startPaddingSecs = catchupStartPaddingRef.current * 60;
    pendingCatchupSeekRef.current = seekSeconds + startPaddingSecs;
    isInitialSeekPendingRef.current = true;
    await handlePlayCatchup(channel, programTitle, startTimeMs, durationMinutes, programDesc);
    setTimeout(() => { seekingRef.current = false; }, 200);
  }, [handlePlayCatchup, clearPendingSeeks]);

  const handlePlayVod = useCallback(async (info: VodPlayInfo, onCloseView?: () => void) => {
    setError(null);
    setCatchupInfo(null);
    clearPendingSeeks();
    setVodLoadingInfo(info);
    isPlayLoadingRef.current = true;

    // Reset playback state immediately so the new stream never inherits stale
    // position/duration from the previously loaded file. Otherwise a brief
    // window exists where position/duration still reflect the old episode
    // (e.g. >= 90%) while the new stream is loading.
    setPosition(0);
    setDuration(0);
    // A fresh stream is never user-paused; clear the flag so auto-play isn't
    // blocked for this episode by a pause on a previous one.
    userPausedRef.current = false;

    let resolved;
    let sourceData: { type?: string } | undefined;
    try {
      // Look up source type so we can decide whether to suppress HTTP errors
      if (window.storage && info.source_id && info.source_id !== 'stremio' && info.source_id !== 'trailer') {
        try {
          const srcResult = await window.storage.getSource(info.source_id);
          sourceData = srcResult?.data;
        } catch (e) {
          console.warn('[usePlayback] Failed to lookup source details:', e);
        }
      }
      resolved = await resolvePlayUrl(info.source_id, info.url);
    } catch (err) {
      logError('Failed to resolve Source info:', err);
      setError(i18n.t('common:contextMenu.failedResolveStreamUrl'));
      setVodLoadingInfo(null);
      return false;
    }

    if (resolved.url.startsWith('infoHash:')) {
      setError(i18n.t('player:torrentRequiresTorrServer'));
      setVodLoadingInfo(null);
      return false;
    }

    // Stalker/MAC sources require session headers that MPV doesn't send,
    // so they always trigger a 401/403 HTTP error — but the stream plays fine.
    // Suppress these false positives. We also suppress local and YouTube/trailer URLs
    // where mpv/yt-dlp handles format negotiation and transient 403s internally.
    const isStalker = sourceData?.type === 'stalker';
    const isLocal = isLocalUrl(resolved.url);
    const isTrailer = info.source_id === 'trailer' || isYouTubeUrl(resolved.url) || isYouTubeUrl(info.url);
    suppressStatusUpdates?.(1500);
    setIgnoreHttpErrors(isStalker || isLocal || isTrailer);
    if (isTrailer) {
      trailerLoadStartTimeRef.current = Date.now();
      trailerRetryCountRef.current = 0;
    }
    // Track whether this is a stalker portal VOD playing an HLS stream (m3u8).
    // CEA-608 CC + WebVTT tracks in these streams can duplicate on seek.
    const resolvedUrlLower = resolved.url.toLowerCase();
    isStalkerVodRef.current = isStalker && (resolvedUrlLower.includes('.m3u8') || resolvedUrlLower.includes('/hls/') || resolvedUrlLower.includes('type=m3u8'));

    if (Bridge.getIsCasting?.()) {
      Bridge.setCastMetadata(info.title, info.type || 'VOD');
    }

    // Jellyfin: apply the default subtitle stream (from PlaybackInfo) to the
    // direct-play URL so embedded subtitle tracks arrive pre-selected.
    let jellyfinPlayUrl = resolved.url;
    if (info.source_id === 'jellyfin') {
      try {
        const u = new URL(jellyfinPlayUrl);
        if (info.jellyfinSubtitleStreamId != null) {
          u.searchParams.set('SubtitleStreamIndex', String(info.jellyfinSubtitleStreamId));
        }
        if (info.jellyfinAudioStreamId != null) {
          u.searchParams.set('AudioStreamIndex', String(info.jellyfinAudioStreamId));
        }
        jellyfinPlayUrl = u.toString();
      } catch {
        // Keep the original stream URL if it cannot be augmented.
      }
    }
    const result = await tryLoadWithFallbacks(jellyfinPlayUrl, false, resolved.userAgent);
      if (!result.success) {
      setIgnoreHttpErrors(false);
      setError(translateNativeError(result.error) || i18n.t('player:failedToLoadStream'));
      setVodLoadingInfo(null);
      return false;
    } else {
      const workingUrl = result.url;
      
      // Use mediaId from info for progress tracking, fallback to generated ID
      const mediaId = info.mediaId || (info.source_id && info.url 
        ? `${info.source_id}_${info.url}`
        : null);
      
      // Check for saved progress (never for trailers — they're short previews
      // and stale resume positions make a 30s clip jump straight to the end)
      let resumePosition = 0;
      console.log('[Playback] Checking for progress. mediaId:', mediaId, 'type:', info.type);
      if (mediaId && info.type !== 'recording' && info.source_id !== 'trailer' && info.source_id !== 'jellyfin' && !isYouTubeUrl(info.url)) {
        // For series episodes, check episode-level progress first
        if (info.type === 'series' && mediaId.includes('_ep_')) {
          const parts = mediaId.split('_ep_');
          console.log('[Playback] Episode mediaId split:', parts);
          if (parts.length === 2) {
            const episodeId = parts[1];
            console.log('[Playback] Looking up episode progress for ID:', episodeId);
            const episodeProgress = await getEpisodeProgress(episodeId);
            console.log('[Playback] Episode progress result:', episodeProgress);
            console.log('[Playback] Episode progress fields:', {
              hasResult: !!episodeProgress,
              total_duration: episodeProgress?.total_duration,
              progress_seconds: episodeProgress?.progress_seconds,
              valid: episodeProgress && episodeProgress.total_duration && episodeProgress.total_duration > 0
            });
            if (episodeProgress && (episodeProgress.progress_seconds ?? 0) > 0) {
              const totalDuration = episodeProgress.total_duration ?? 0;
              const progressSeconds = episodeProgress.progress_seconds ?? 0;
              const progressPercent = totalDuration > 0 ? (progressSeconds / totalDuration) * 100 : 0;
              console.log('[Playback] Episode progress calculation:', { progressSeconds, totalDuration, progressPercent });
              if ((progressSeconds >= 10 || progressPercent > 1) && (totalDuration === 0 || progressPercent < 95)) {
                resumePosition = progressSeconds;
                logInfo('[Playback] Resuming episode from:', resumePosition, 'seconds');
              } else {
                console.log('[Playback] Episode progress outside resume range:', progressPercent + '%');
              }
            } else {
              console.log('[Playback] No episode progress found');
            }
          }
        }
        
        // If no episode progress found, try movie/series-level progress
        if (resumePosition === 0) {
          console.log('[Playback] Looking up VOD watch progress for:', mediaId, info.type);
          const savedProgress = await getVodWatchProgress(mediaId, info.type as 'movie' | 'series');
          console.log('[Playback] VOD progress result:', savedProgress);
          if (savedProgress && (savedProgress.progress_seconds ?? 0) > 0) {
            const totalDuration = savedProgress.total_duration ?? 0;
            const progressSeconds = savedProgress.progress_seconds ?? 0;
            const progressPercent = totalDuration > 0 ? (progressSeconds / totalDuration) * 100 : 0;
            // Only resume if between 10s/1% and 95% watched (or unknown total duration)
            if ((progressSeconds >= 10 || progressPercent > 1) && (totalDuration === 0 || progressPercent < 95)) {
              resumePosition = progressSeconds;
              logInfo('[Playback] Resuming VOD at:', resumePosition, 'seconds');
            }
          }
        }

        // If still no progress found in DB and this is a Stremio stream, check the Zustand store for fraction-based fallback
        if (resumePosition === 0 && info.source_id === 'stremio') {
          console.log('[Playback] Checking stremioWatchStore for fraction-based progress fallback');
          const watchStore = useStremioWatchStore.getState();
          let fraction = 0;
          if (info.type === 'series' && info.episodeId) {
            fraction = watchStore.getEpisodeProgressFraction(info.episodeId);
          } else if (info.type === 'movie' && info.mediaId) {
            fraction = (watchStore.history || []).find((h) => h.metaId === info.mediaId)?.progressFraction ?? 0;
          }
          
          if (fraction > 0.02 && fraction < 0.95) {
            logInfo(`[Playback] Found Stremio synced progress fraction fallback: ${fraction}`);
            pendingStremioSeekFractionRef.current = fraction;
            isInitialSeekPendingRef.current = true;
          }
        }

        // If still no progress found in DB and this is a Nuvio stream, check Nuvio Cloud for synced progress fallback
        if (resumePosition === 0 && info.source_id === 'nuvio') {
          console.log('[Playback] Checking Nuvio Cloud for synced progress fallback');
          const nuvioAuth = useNuvioAuthStore.getState();
          const nuvioToken = nuvioAuth.token;
          const nuvioProfile = nuvioAuth.activeProfile;
          if (nuvioToken && nuvioProfile) {
            try {
              const items = await fetchNuvioWatchProgress(nuvioToken, nuvioProfile.profile_index, null, 100);
              const progressKey = info.type === 'series' && info.seasonNum != null && info.episodeNum != null
                ? `${info.seriesId}_s${info.seasonNum}e${info.episodeNum}`
                : info.mediaId;
              const match = items.find(item => item.progress_key === progressKey || (item.content_id === info.seriesId && item.video_id === info.episodeId));
              if (match && match.duration > 0) {
                const progressPercent = (match.position / match.duration) * 100;
                if ((match.position >= 10000 || progressPercent > 1) && progressPercent < 95) {
                  resumePosition = match.position / 1000; // convert to seconds
                  logInfo('[Playback] Found Nuvio synced progress fallback:', resumePosition, 'seconds');
                }
              }
            } catch (err) {
              console.warn('[Playback] Failed to fetch Nuvio progress fallback:', err);
            }
          }
        }
      }
      
      console.log('[Playback] Final resume position:', resumePosition);
      
      // Ensure initial watch entry exists in vod_history with full metadata
      if (mediaId && info.type !== 'recording' && info.source_id !== 'jellyfin') {
        const seriesId = info.type === 'series' && mediaId.includes('_ep_') ? mediaId.split('_ep_')[0] : mediaId;
        void recordVodWatch(
          seriesId,
          info.type === 'series' ? 'series' : 'movie',
          info.source_id || 'unknown',
          info.title || 'Unknown',
          info.posterUrl,
          info.seasonNum,
          info.episodeNum,
          info.episodeInfo
        ).catch(e => console.warn('[usePlayback] Failed to record initial VOD watch:', e));
      }

      setCurrentChannel({
        stream_id: 'vod',
        name: info.title,
        stream_icon: '',
        epg_channel_id: '',
        category_ids: [],
        direct_url: workingUrl,
        source_id: 'vod',
      });
      const fullVodInfo = { ...info, url: workingUrl };
      setVodInfo(fullVodInfo);
      vodInfoRef.current = fullVodInfo;
      setPlaying(true);
      applySubtitleSettings();

      // Explicitly force MPV to unpause after loading
      if (!Bridge.getIsCasting?.()) {
        Bridge.play().catch(e => console.warn('[usePlayback] play() after VOD load failed:', e));
      }
      
      hasAutoSelectedSubRef.current = false;
      hasAutoSelectedAudioRef.current = false;
      subAutoSelectEverCompletedRef.current = false;
      clearSubtitleIntent();
      lastSubTracksCountRef.current = 0;
      lastAudioTracksCountRef.current = 0;
      startAutoSelectPolling();

      // Add all Jellyfin external subtitle tracks to MPV. The existing track
      // selector reads MPV's track-list, so these become first-class tracks.
      // Jellyfin's selected/default state is applied by the auto-select polling loop
      // once both the main container and external subtitle files are demuxed.
      if (info.source_id === 'jellyfin') {
        jellyfinResolvedSubsRef.current.clear();
        const resolvedByUrl = new Map<string, string>();
        if (info.jellyfinSubtitleTracks?.length) {
          for (const track of info.jellyfinSubtitleTracks) {
            if (!track.isExternal || !track.deliveryUrl) continue;
            try {
              const isTarget = track.index === info.jellyfinSubtitleStreamId;
              const resolved = await Bridge.addSubtitleFile(
                track.deliveryUrl,
                isTarget ? 'select' : 'cached',
                track.title,
                track.lang,
              );
              if (resolved) {
                resolvedByUrl.set(track.deliveryUrl, resolved);
                jellyfinResolvedSubsRef.current.set(track.deliveryUrl, resolved);
              }
            } catch (error) {
              logWarn('[Jellyfin] Failed to load external subtitle:', track.deliveryUrl, error);
            }
          }
        }
        if (info.jellyfinSubtitleStreamId === -1) {
          await Bridge.setSubtitleTrack(0).catch(() => {});
          hasAutoSelectedSubRef.current = true;
          subAutoSelectEverCompletedRef.current = true;
        } else {
          // Attempt early selection if tracks are already demuxed
          await applyJellyfinSubtitleSelection(fullVodInfo, resolvedByUrl).catch(() => false);
        }
      }
      
      // Resume from saved position if available. Jellyfin's server position is
      // carried in startTimeTicks by the captured URL and must not be replaced
      // by ynoTV's local history (which is intentionally skipped above).
      let urlResumePosition = 0;
      if (info.source_id === 'jellyfin') {
        try {
          const parsed = new URL(workingUrl);
          const ticks = Number(parsed.searchParams.get('startTimeTicks') || 0);
          if (Number.isFinite(ticks) && ticks > 0) urlResumePosition = ticks / 10_000_000;
        } catch {
          // The URL was already accepted by the loader; leave resume at zero
          // if it cannot be parsed here.
        }
      }
      const initialResumePosition = info.source_id === 'jellyfin' ? urlResumePosition : resumePosition;
      if (initialResumePosition > 0) {
        setPosition(initialResumePosition);
        pendingResumeSeekRef.current = initialResumePosition;
        isInitialSeekPendingRef.current = true;
      }
      
      // Close the VOD page when playing
      onCloseView?.();
      return true;
    }
  }, [setIgnoreHttpErrors, setPosition, setDuration, clearPendingSeeks, suppressStatusUpdates]);

  // Merge late-resolved metadata into the active play (e.g. Jellyfin
  // ProviderIds that arrive after playback already started). The optional
  // predicate only lets the patch through when the current session still
  // matches the play that initiated the async resolution.
  const patchVodInfo = useCallback((patch: Partial<VodPlayInfo>, matches?: (current: VodPlayInfo) => boolean) => {
    const current = vodInfoRef.current;
    if (!current) return;
    if (matches && !matches(current)) return;
    let hasChange = false;
    for (const k of Object.keys(patch) as (keyof VodPlayInfo)[]) {
      if (patch[k] !== current[k]) {
        hasChange = true;
        break;
      }
    }
    if (!hasChange) return;
    const next = { ...current, ...patch };
    vodInfoRef.current = next;
    setVodInfo(next);
  }, []);

  const handlePlayRecording = useCallback(async (recording: import('../db').DvrRecording, onCloseView?: () => void) => {
    setError(null);
    clearPendingSeeks();

    try {
      let url = recording.file_path;
      if (recording.status === 'recording') {
        // Use the native mpv appending:// protocol for active recordings.
        // Convert backslashes to forward slashes.
        const cleanPath = recording.file_path.replace(/\\/g, '/');
        // Strip any existing file:// or file:/// prefix
        const rawPath = cleanPath.replace(/^file:\/\/\/?/, '');
        url = `appending://${rawPath}`;
      } else {
        url = recording.file_path.startsWith('file://') ? recording.file_path : `file://${recording.file_path}`;
      }

      // Check if we have saved watch progress to resume
      let resumePosition = 0;
      if (recording.id) {
        // Real DVR recording (completed or partial)
        const freshRecord = await db.dvrRecordings.get(recording.id);
        if (freshRecord && freshRecord.progress_seconds && freshRecord.duration_sec) {
          const progressPercent = (freshRecord.progress_seconds / freshRecord.duration_sec) * 100;
          if ((freshRecord.progress_seconds >= 10 || progressPercent > 1) && progressPercent < 95) {
            resumePosition = freshRecord.progress_seconds;
            logInfo(`[Playback] Resuming DVR recording at: ${resumePosition} seconds`);
          }
        }
      } else {
        // Completed Download (represented as fake recording without id)
        const downloads = useDownloadStore.getState().downloads || [];
        const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '').toLowerCase();
        const normUrl = normalize(recording.file_path);
        const match = downloads.find(d => normalize(d.savePath) === normUrl);
        if (match && match.watchProgressSeconds) {
          let shouldResume = true;
          if (match.durationSecs) {
            const progressPercent = (match.watchProgressSeconds / match.durationSecs) * 100;
            shouldResume = (match.watchProgressSeconds >= 10 || progressPercent > 1) && progressPercent < 95;
          }
          if (shouldResume) {
            resumePosition = match.watchProgressSeconds;
            logInfo(`[Playback] Resuming download at: ${resumePosition} seconds`);
          }
        }
      }

      suppressStatusUpdates?.(1500);
      if (Bridge.getIsCasting?.()) {
        Bridge.setCastMetadata(recording.program_title, 'DVR Recording');
      }
      const result = await Bridge.loadVideo(url);

      if (result.success) {
        setCurrentChannel({
          stream_id: `recording_${recording.id || 'download'}`,
          name: recording.program_title,
          stream_icon: '',
          epg_channel_id: '',
          category_ids: [],
          direct_url: url,
          source_id: 'dvr',
        });
        setVodInfo({
          title: recording.program_title,
          url: url,
          type: 'recording',
          source_id: 'dvr',
          recordingStart: recording.actual_start,
          recordingStatus: recording.status,
          recordingId: recording.id,
        });
        setCatchupInfo(null);
        setPlaying(true);
        applySubtitleSettings();

        // Resume from saved position if available
        if (resumePosition > 0) {
          setPosition(resumePosition);
          pendingResumeSeekRef.current = resumePosition;
          isInitialSeekPendingRef.current = true;
        }

        // Explicitly force MPV to unpause after loading
        if (!Bridge.getIsCasting?.()) {
          Bridge.play().catch(e => console.warn('[usePlayback] play() after recording load failed:', e));
        }

        // Close DVR dashboard when playing
        onCloseView?.();
      } else {
        const errMsg = translateNativeError((result as any).error) || i18n.t('player:failedToLoadRecording');
        setError(errMsg);
      }
    } catch (error: any) {
      setError(translateNativeError(error?.message) || i18n.t('player:failedToPlayRecording'));
    }
  }, [clearPendingSeeks, suppressStatusUpdates]);

  const handleStop = useCallback(async () => {
    // Save progress before stopping if playing VOD and initial seek is not pending
    if (isInitialSeekPendingRef.current) {
      console.log('[Playback] Initial seek was still pending on stop, skipping progress save');
    } else if (vodInfo && position > 0 && duration > 0 && vodInfo.source_id !== 'trailer' && vodInfo.source_id !== 'jellyfin' && !isYouTubeUrl(vodInfo.url)) {
      if (vodInfo.type === 'recording') {
        console.log('[Playback] Saving progress for recording on stop:', position, '/', duration);
        if (vodInfo.recordingId) {
          await updateDvrRecordingProgress(vodInfo.recordingId, Math.floor(position), Math.floor(duration));
        } else {
          useDownloadStore.getState().saveDownloadProgress(vodInfo.url, Math.floor(position), Math.floor(duration));
        }
      } else {
        const mediaId = vodInfo.mediaId || (vodInfo.source_id && vodInfo.url
          ? `${vodInfo.source_id}_${vodInfo.url}`
          : null);
        
        if (mediaId) {
          console.log('[Playback] Saving progress on stop:', position, '/', duration);
          
          // For series episodes, extract series_id and save both levels
          if (vodInfo.type === 'series' && mediaId.includes('_ep_')) {
            const parts = mediaId.split('_ep_');
            if (parts.length === 2) {
              const episodeId = parts[1];
              const seriesId = parts[0];
              
              // Save series-level progress (for Recently Watched list)
              console.log('[Playback] Saving series-level progress:', seriesId);
              await updateVodWatchProgress(
                seriesId,  // Use series_id, not episode-specific mediaId
                'series',
                Math.floor(position),
                Math.floor(duration),
                vodInfo.source_id || '',
                vodInfo.title || '',
                vodInfo.posterUrl
              );
              
              // Save episode-level progress (for episode resume)
              console.log('[Playback] Saving episode-level progress:', episodeId, seriesId);
              console.log('[Playback] Episode save values:', {
                position: Math.floor(position),
                duration: Math.floor(duration),
                sourceId: vodInfo.source_id
              });
              await recordEpisodeWatch(
                episodeId,
                seriesId,
                vodInfo.source_id || '',
                vodInfo.seasonNum ?? 0,
                vodInfo.episodeNum ?? 0,
                vodInfo.episodeInfo || '',
                Math.floor(position),
                Math.floor(duration)
              );
            }
          } else {
            // For movies or series without episode info, save normally
            await updateVodWatchProgress(
              mediaId,
              vodInfo.type as 'movie' | 'series',
              Math.floor(position),
              Math.floor(duration),
              vodInfo.source_id || '',
              vodInfo.title || '',
              vodInfo.posterUrl
            );
          }
        }
      }
      console.log('[Playback] ✅ Progress saved on stop');
    }
    
    suppressStatusUpdates?.(0);
    clearPendingSeeks();
    await Bridge.stop();
    setPlaying(false);
    setCurrentChannel(null);
    setVodInfo(null); // Clear vodInfo on stop
    setVodLoadingInfo(null);
    setCatchupInfo(null);
    setError(null);
    setLoadingState('idle');

    if (autoSelectTimerRef.current) {
      clearInterval(autoSelectTimerRef.current);
      autoSelectTimerRef.current = null;
    }
    hasAutoSelectedSubRef.current = false;
    hasAutoSelectedAudioRef.current = false;
    subAutoSelectEverCompletedRef.current = false;
    clearSubtitleIntent();
    lastSubTracksCountRef.current = 0;
    lastAudioTracksCountRef.current = 0;

    // Reset failover state on stop
    failoverActiveRef.current = false;
    failoverSwitchingRef.current = false;
    failoverOriginChannelRef.current = null;
    failoverAttemptRef.current = 0;
    failoverCursorStreamIdRef.current = null;
    failoverCycleStartStreamIdRef.current = null;
    failoverAttemptedStreamIdsRef.current = new Set();
    failoverFailedDuringSwitchRef.current = false;
    retryFailedDuringLoadRef.current = false;
    streamFailureHandlingRef.current = false;
    bufferStarvedSinceRef.current = null;
    healthCheckInFlightRef.current = false;
    recoveryArmedRef.current = false;
    userPausedRef.current = false;
    setFailoverState(null);
  }, [vodInfo, position, duration, clearPendingSeeks, suppressStatusUpdates]);

  const handleSeek = useCallback(async (seconds: number) => {
    seekingRef.current = true;
    wasSeekingRef.current = true;
    setPosition(seconds);
    try {
      await Bridge.seek(seconds);
    } catch (e) {
      console.warn('[usePlayback] Seek command failed:', e);
    }
    // Nuvio: push the new position right after a seek so the cloud resume
    // point is current (matches NuvioDesktop's seek sync). No-op for non-Nuvio.
    void pushNuvioPlaybackProgress(vodInfoRef.current, seconds, durationRef.current);
    setTimeout(() => { seekingRef.current = false; }, 200);
  }, [setPosition]);

  const handleTogglePlay = useCallback(async () => {
    if (playing) {
      userPausedRef.current = true;
      resetHealthTracking(0);
      await Bridge.pause();
      // Nuvio: push the pause position so the cloud row reflects where the
      // user stopped mid-item (NuvioDesktop flushes on pause too).
      void pushNuvioPlaybackProgress(vodInfoRef.current, positionRef.current, durationRef.current);
    } else {
      userPausedRef.current = false;
      intentionallyStoppedRef.current = false;
      resetHealthTracking();
      await Bridge.resume();
    }
  }, [playing, resetHealthTracking]);

  const handleVolumeChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseInt(e.target.value);
    setVolume(newVolume);
    await Bridge.setVolume(newVolume);
  }, [setVolume]);

  const handleToggleMute = useCallback(async () => {
    await Bridge.toggleMute();
  }, []);

  const handleCycleSubtitle = useCallback(async () => {
    await Bridge.cycleSubtitle();
  }, []);

  const handleCycleAudio = useCallback(async () => {
    await Bridge.cycleAudio();
  }, []);

  const handleToggleStats = useCallback(async () => {
    await Bridge.toggleStats();
  }, []);

  const handleToggleFullscreen = useCallback(async () => {
    try {
      await Bridge.toggleFullscreen();
    } catch (e) {
      console.error('[usePlayback] Fullscreen error:', e);
    }
  }, []);

  return {
    mpvReady,
    playing,
    volume,
    muted,
    position,
    duration,
    error,
    currentChannel,
    vodInfo,
    vodLoadingInfo,
    loadingState,
    catchupInfo,
    volumeDraggingRef,
    seekingRef,
    userPausedRef,
    isCatchup,
    retryState,
    failoverState,
    setError,
    setPlaying,
    setPosition,
    setVolume,
    setCurrentChannel,
    handlePlayChannel,
    handlePlayCatchup,
    handleCatchupSeek,
    handlePlayVod,
    patchVodInfo,
    handlePlayRecording,
    handleStop,
    handleSeek,
    handleTogglePlay,
    handleVolumeChange,
    handleToggleMute,
    handleCycleSubtitle,
    handleCycleAudio,
    handleToggleStats,
    handleToggleFullscreen,
    autoSelectSubtitle,
    autoSelectAudio,
    syncMpvGeometry: syncMpvGeometry || (async () => {}),
    notifyMainLoaded: notifyMainLoaded || (() => {}),
  };
}
