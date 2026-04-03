import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { StoredChannel } from '../db';
import type { VodPlayInfo } from '../types/media';
import { Bridge, registerOnAppClose, unregisterOnAppClose } from '../services/tauri-bridge';
import { resolvePlayUrl } from '../services/stream-resolver';
import { addToRecentChannels } from '../utils/recentChannels';
import { db, recordVodWatch, updateVodWatchProgress, getVodWatchProgress, recordEpisodeWatch, getEpisodeProgress } from '../db';
import type { useMpvListeners } from './useMpvListeners';
import { logInfo, logWarn, logError } from '../utils/logger';

/**
 * Generate fallback stream URLs when primary fails.
 * Live TV: .ts → .m3u8 → .m3u
 * VOD: provider extension → .m3u8 → .ts
 */
function getStreamFallbacks(url: string, isLive: boolean): string[] {
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

/**
 * Try loading a stream URL with fallbacks on failure.
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
  const result = await Bridge.loadVideo(primaryUrl);

  if (result.success) {
    logInfo('[Playback] Successfully loaded:', primaryUrl);
    return { success: true, url: primaryUrl };
  }

  const errorMsg = (result as any).error || 'Unknown error';
  logWarn('[Playback] Failed to load:', primaryUrl, 'Error:', errorMsg);

  const fallbacks = getStreamFallbacks(primaryUrl, isLive);
  if (fallbacks.length > 0) {
    logInfo('[Playback] Trying fallback URLs:', fallbacks);
  }

  for (const fallbackUrl of fallbacks) {
    logInfo('[Playback] Trying fallback:', fallbackUrl);
    const fallbackResult = await Bridge.loadVideo(fallbackUrl);
    if (fallbackResult.success) {
      logInfo('[Playback] Fallback succeeded:', fallbackUrl);
      return { success: true, url: fallbackUrl };
    }
    logWarn('[Playback] Fallback failed:', fallbackUrl);
  }

  logError('[Playback] All URLs failed. Final error:', errorMsg);
  return { success: false, url: primaryUrl, error: errorMsg };
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
  catchupInfo: {
    channelId: string;
    programTitle: string;
    startTime: number;
    duration: number;
  } | null;

  // Refs
  volumeDraggingRef: React.MutableRefObject<boolean>;
  seekingRef: React.MutableRefObject<boolean>;

  // Derived
  isCatchup: boolean;

  // Actions
  setError: (error: string | null) => void;
  setPlaying: (playing: boolean) => void;
  setPosition: (position: number) => void;
  setVolume: (volume: number) => void;
  setCurrentChannel: (channel: StoredChannel | null) => void;
  handlePlayChannel: (channel: StoredChannel, autoSwitched?: boolean) => void;
  handlePlayCatchup: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number) => Promise<void>;
  handleCatchupSeek: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, seekSeconds: number) => Promise<void>;
  handlePlayVod: (info: VodPlayInfo, onCloseView?: () => void) => Promise<void>;
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
    volumeDraggingRef, seekingRef,
    setError, setPlaying, setPosition, setVolume,
    setIgnoreHttpErrors,
  } = mpvListeners;

  // Pending seek ref for deferred scrubbing
  const pendingCatchupSeekRef = useRef<number | null>(null);

  // Playback state
  const [currentChannel, setCurrentChannel] = useState<StoredChannel | null>(null);
  const [vodInfo, setVodInfo] = useState<VodPlayInfo | null>(null);
  const [catchupInfo, setCatchupInfo] = useState<{
    channelId: string;
    programTitle: string;
    startTime: number;
    duration: number;
  } | null>(null);

  // Refs to track current values for interval callbacks
  const vodInfoRef = useRef(vodInfo);
  const positionRef = useRef(position);
  const durationRef = useRef(duration);
  
  // Update refs whenever values change
  useEffect(() => {
    vodInfoRef.current = vodInfo;
  }, [vodInfo]);
  
  useEffect(() => {
    positionRef.current = position;
  }, [position]);
  
  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  const isCatchup = catchupInfo !== null;

  // Handle pending catchup seek when duration becomes available
  useEffect(() => {
    if (pendingCatchupSeekRef.current !== null && duration > 0 && playing) {
      const targetSeek = pendingCatchupSeekRef.current;
      pendingCatchupSeekRef.current = null;
      Bridge.seek(targetSeek).catch(e => console.warn('[usePlayback] Deferred seek failed:', e));
      setPosition(targetSeek);
    }
  }, [duration, playing, setPosition]);

  // Periodic progress saving for VOD playback + save on app close
  useEffect(() => {
    if (!vodInfo || !playing || duration <= 0) {
      return;
    }

    console.log('[Playback] Setting up progress save - initial position:', position);

    const saveProgress = () => {
      // Read current values from refs (always up to date)
      const currentVodInfo = vodInfoRef.current;
      const currentPosition = positionRef.current;
      const currentDuration = durationRef.current;
      
      console.log('[Playback] Interval firing - current position:', currentPosition);
      
      if (!currentVodInfo) {
        console.log('[Playback] No vodInfo in ref, skipping save');
        return;
      }
      
      const mediaId = currentVodInfo.mediaId || (currentVodInfo.source_id && currentVodInfo.url
        ? `${currentVodInfo.source_id}_${currentVodInfo.url}`
        : null);
      
      if (mediaId && currentVodInfo.type !== 'recording' && currentPosition > 0) {
        console.log('[Playback] Auto-saving progress:', Math.floor(currentPosition), '/', Math.floor(currentDuration));
        
        // For series episodes, save both levels
        if (currentVodInfo.type === 'series' && mediaId.includes('_ep_')) {
          const parts = mediaId.split('_ep_');
          if (parts.length === 2) {
            const seriesId = parts[0];
            const episodeId = parts[1];
            
            // Save series-level progress (for Recently Watched)
            void updateVodWatchProgress(
              seriesId,
              'series',
              Math.floor(currentPosition),
              Math.floor(currentDuration)
            );
            
            // Save episode-level progress (for episode resume)
            void recordEpisodeWatch(
              episodeId,
              seriesId,
              currentVodInfo.source_id || '',
              0,
              0,
              '',
              Math.floor(currentPosition),
              Math.floor(currentDuration)
            );
            
            console.log('[Playback] ✅ Auto-saved series progress at position:', Math.floor(currentPosition));
          }
        } else {
          // For movies or series without episode info
          void updateVodWatchProgress(
            mediaId,
            currentVodInfo.type as 'movie' | 'series',
            Math.floor(currentPosition),
            Math.floor(currentDuration)
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
    };

    // Save every 30 seconds while playing
    console.log('[Playback] Starting 30s progress save interval');
    const saveInterval = setInterval(saveProgress, 30000);
    
    // Do an immediate save when starting
    console.log('[Playback] Doing immediate initial save');
    saveProgress();

    // Save when user closes/refreshes the page - use synchronous approach
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      console.log('[Playback] beforeunload triggered - saving progress');
      saveProgress();
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
  const handleLoadStream = useCallback(async (channel: StoredChannel) => {
    // Clear error immediately - stale errors from old channel will be ignored
    setError(null);

    logInfo('[Playback] Loading channel:', channel.name);
    logInfo('[Playback] Raw URL:', channel.direct_url);

    let resolved;
    try {
      resolved = await resolvePlayUrl(channel.source_id, channel.direct_url);
    } catch (e) {
      logError('Stalker resolution failed:', e);
      setError('Failed to resolve Stalker link');
      return;
    }

    logInfo('[Playback] Resolved URL:', resolved.url);
    logInfo('[Playback] User-Agent:', resolved.userAgent || '(default)');
    logInfo('[Playback] Source:', resolved.sourceName || channel.source_id);

    const result = await tryLoadWithFallbacks(
      resolved.url,
      true,
      resolved.userAgent,
      (msg) => setError(msg)
    );

    if (!result.success) {
      const errMsg = result.error ?? 'Failed to load stream';
      setError(errMsg);
    } else {
      const resolvedChannel = result.url !== resolved.url
        ? { ...channel, direct_url: result.url }
        : channel;
      setCurrentChannel(resolvedChannel);
      setPlaying(true);
      // Explicitly force MPV to unpause after loading.
      // If a previous stream ended/was interrupted, MPV may hold pause=true,
      // causing the new stream to load but not start playing.
      Bridge.play().catch(e => console.warn('[usePlayback] play() after load failed:', e));
      notifyMainLoaded?.(channel.name, result.url, resolved.sourceName ?? null);

      import('../services/video-metadata').then(({ captureAndSaveMetadata }) => {
        captureAndSaveMetadata(channel.stream_id, channel.source_id).catch(console.error);
      });
    }
  }, [notifyMainLoaded]);

  const handlePlayChannel = useCallback((channel: StoredChannel, autoSwitched: boolean = false) => {
    // Save VOD progress before switching to Live TV
    if (vodInfo && position > 0 && duration > 0) {
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
              Math.floor(duration)
            );
            
            // Save episode-level progress (for episode resume)
            void recordEpisodeWatch(
              episodeId,
              seriesId,
              vodInfo.source_id || '',
              0,
              0,
              '',
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
            Math.floor(duration)
          );
        }
      }
    }
    setVodInfo(null);
    setCatchupInfo(null);
    if (!autoSwitched) {
      addToRecentChannels(channel);
    }
    handleLoadStream(channel);
  }, [handleLoadStream, vodInfo, position, duration]);

  const handlePlayCatchup = useCallback(async (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number) => {
    // Save VOD progress before switching to catchup
    if (vodInfo && position > 0 && duration > 0) {
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
              Math.floor(duration)
            );
            
            // Save episode-level progress (for episode resume)
            void recordEpisodeWatch(
              episodeId,
              seriesId,
              vodInfo.source_id || '',
              0,
              0,
              '',
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
            Math.floor(duration)
          );
        }
      }
    }
    setError(null);
    setVodInfo(null);

    const rawStreamId = channel.stream_id.replace(`${channel.source_id}_`, '');

    let resolved;
    try {
      resolved = await resolvePlayUrl(channel.source_id, channel.direct_url, {
        rawStreamId,
        startTimeMs,
        durationMinutes,
      });
    } catch (e) {
      console.error('Failed to resolve catchup source:', e);
      setError('Failed to resolve catchup stream');
      return;
    }

    const result = await tryLoadWithFallbacks(resolved.url, false, resolved.userAgent);
    if (!result.success) {
      setError(result.error ?? 'Failed to load catchup stream');
    } else {
      setCurrentChannel(channel);
      setCatchupInfo({ channelId: channel.stream_id, programTitle, startTime: startTimeMs, duration: durationMinutes });
      setPlaying(true);
    }
  }, [vodInfo, position, duration]);

  const handleCatchupSeek = useCallback(async (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, seekSeconds: number) => {
    seekingRef.current = true;
    pendingCatchupSeekRef.current = seekSeconds;
    await handlePlayCatchup(channel, programTitle, startTimeMs, durationMinutes);
    setTimeout(() => { seekingRef.current = false; }, 200);
  }, [handlePlayCatchup]);

  const handlePlayVod = useCallback(async (info: VodPlayInfo, onCloseView?: () => void) => {
    setError(null);
    setCatchupInfo(null);

    let resolved;
    let sourceData: { type?: string } | undefined;
    try {
      // Look up source type so we can decide whether to suppress HTTP errors
      if (window.storage && info.source_id) {
        const srcResult = await window.storage.getSource(info.source_id);
        sourceData = srcResult?.data;
      }
      resolved = await resolvePlayUrl(info.source_id, info.url);
    } catch (err) {
      logError('Failed to resolve Source info:', err);
      setError('Failed to resolve stream URL');
      return;
    }

    // Stalker/MAC sources require session headers that MPV doesn't send,
    // so they always trigger a 401/403 HTTP error — but the stream plays fine.
    // Suppress these false positives.
    const isStalker = sourceData?.type === 'stalker';
    setIgnoreHttpErrors(isStalker);

    const result = await tryLoadWithFallbacks(resolved.url, false, resolved.userAgent);
    if (!result.success) {
      setIgnoreHttpErrors(false);
      setError(result.error ?? 'Failed to load stream');
    } else {
      const workingUrl = result.url;
      
      // Use mediaId from info for progress tracking, fallback to generated ID
      const mediaId = info.mediaId || (info.source_id && info.url 
        ? `${info.source_id}_${info.url}`
        : null);
      
      // Check for saved progress
      let resumePosition = 0;
      console.log('[Playback] Checking for progress. mediaId:', mediaId, 'type:', info.type);
      if (mediaId && info.type !== 'recording') {
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
            if (episodeProgress && episodeProgress.total_duration && episodeProgress.total_duration > 0) {
              const totalDuration = episodeProgress.total_duration;
              const progressSeconds = episodeProgress.progress_seconds ?? 0;
              const progressPercent = (progressSeconds / totalDuration) * 100;
              console.log('[Playback] Episode progress calculation:', { progressSeconds, totalDuration, progressPercent });
              if (progressPercent > 5 && progressPercent < 95) {
                resumePosition = progressSeconds;
                logInfo('[Playback] Resuming episode from:', resumePosition, 'seconds');
              } else {
                console.log('[Playback] Episode progress outside resume range:', progressPercent + '%');
              }
            } else {
              console.log('[Playback] No episode progress found or invalid duration');
            }
          }
        }
        
        // If no episode progress found, try series-level progress
        if (resumePosition === 0) {
          console.log('[Playback] Trying series-level progress lookup');
          const savedProgress = await getVodWatchProgress(mediaId, info.type as 'movie' | 'series');
          console.log('[Playback] Series progress result:', savedProgress);
          if (savedProgress && savedProgress.total_duration > 0) {
            const progressPercent = (savedProgress.progress_seconds / savedProgress.total_duration) * 100;
            // Only resume if between 5% and 95% watched
            if (progressPercent > 5 && progressPercent < 95) {
              resumePosition = savedProgress.progress_seconds;
              logInfo('[Playback] Resuming VOD at:', resumePosition, 'seconds');
            }
          }
        }
      }
      
      console.log('[Playback] Final resume position:', resumePosition);
      
      setCurrentChannel({
        stream_id: 'vod',
        name: info.title,
        stream_icon: '',
        epg_channel_id: '',
        category_ids: [],
        direct_url: workingUrl,
        source_id: 'vod',
      });
      setVodInfo({ ...info, url: workingUrl });
      setPlaying(true);
      
      // Resume from saved position if available
      if (resumePosition > 0) {
        setPosition(resumePosition);
        // Seek after a delay to ensure video is loaded and playing
        setTimeout(() => {
          Bridge.seek(resumePosition).catch(e => {
            // Try once more after a longer delay
            setTimeout(() => {
              Bridge.seek(resumePosition).catch(e2 => 
                logWarn('[Playback] Resume seek failed:', e2)
              );
            }, 2000);
          });
        }, 1000);
      }
      
      // Close the VOD page when playing
      onCloseView?.();
    }
  }, [setIgnoreHttpErrors, setPosition]);

  const handlePlayRecording = useCallback(async (recording: import('../db').DvrRecording, onCloseView?: () => void) => {
    setError(null);

    try {
      const url = recording.file_path.startsWith('file://') ? recording.file_path : `file://${recording.file_path}`;
      const result = await Bridge.loadVideo(url);

      if (result.success) {
        setCurrentChannel({
          stream_id: `recording_${recording.id}`,
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
        });
        setCatchupInfo(null);
        setPlaying(true);
        // Close DVR dashboard when playing
        onCloseView?.();
      } else {
        const errMsg = (result as any).error || 'Failed to load recording';
        setError(errMsg);
      }
    } catch (error: any) {
      setError(error?.message || 'Failed to play recording');
    }
  }, []);

  const handleStop = useCallback(async () => {
    // Save progress before stopping if playing VOD
    if (vodInfo && position > 0 && duration > 0) {
      const mediaId = vodInfo.mediaId || (vodInfo.source_id && vodInfo.url
        ? `${vodInfo.source_id}_${vodInfo.url}`
        : null);
      
      if (mediaId && vodInfo.type !== 'recording') {
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
              Math.floor(duration)
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
              0, // We'll update these from DB
              0,
              '',
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
            Math.floor(duration)
          );
        }
        
        console.log('[Playback] ✅ Progress saved on stop');
      }
    }
    
    await Bridge.stop();
    setPlaying(false);
    setCurrentChannel(null);
    setVodInfo(null); // Clear vodInfo on stop
    setCatchupInfo(null);
    setError(null);
  }, [vodInfo, position, duration]);

  const handleSeek = useCallback(async (seconds: number) => {
    seekingRef.current = true;
    setPosition(seconds);
    try {
      await Bridge.seek(seconds);
    } catch (e) {
      console.warn('[usePlayback] Seek command failed:', e);
    }
    setTimeout(() => { seekingRef.current = false; }, 200);
  }, [setPosition]);

  const handleTogglePlay = useCallback(async () => {
    if (playing) {
      await Bridge.pause();
    } else {
      await Bridge.resume();
    }
  }, [playing]);

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
    catchupInfo,
    volumeDraggingRef,
    seekingRef,
    isCatchup,
    setError,
    setPlaying,
    setPosition,
    setVolume,
    setCurrentChannel,
    handlePlayChannel,
    handlePlayCatchup,
    handleCatchupSeek,
    handlePlayVod,
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
    syncMpvGeometry: syncMpvGeometry || (async () => {}),
    notifyMainLoaded: notifyMainLoaded || (() => {}),
  };
}
