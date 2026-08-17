import { type ChangeEvent, useEffect, useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import type { StoredChannel } from '../db';
import type { VodPlayInfo } from '../types/media';
import { useCurrentProgram, parseCategoryIds } from '../hooks/useChannels';
import { useSettingsStore } from '../stores/settingsStore';
import { MetadataBadge } from './MetadataBadge';
import { scheduleRecording, getDvrSettings, updatePlayingStream, detectScheduleConflicts, db, type DvrSchedule } from '../db';
import { StalkerClient } from '@ynotv/local-adapter';
import { useModal } from './Modal';
import { type AspectRatioMode, getAspectRatioLabel, Bridge } from '../services/tauri-bridge';
import { SourcePickerModal } from './SourcePickerModal';
import type { StremioStream, StremioStreamBadge } from '../types/stremio';
import type { VisualizerMode } from './AudioVisualizer';
import { useActivePlaylistStore, isActivePlaylistItem } from '../stores/activePlaylistStore';
import { TeamChannelOverlay } from './sports/TeamChannelOverlay';
import './NowPlayingBar.css';

interface NowPlayingBarProps {
  visible: boolean;
  channel: StoredChannel | null;
  playing: boolean;
  muted: boolean;
  volume: number;
  mpvReady: boolean;
  position: number;
  duration: number;
  isVod?: boolean;
  vodInfo?: VodPlayInfo | null;
  isCatchup?: boolean;
  catchupInfo?: {
    channelId: string;
    programTitle: string;
    startTime: number;
    duration: number; // in minutes
    programDesc?: string;
  } | null;
  channelInfoOverlayEnabled?: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  onToggleMute: () => void;
  onVolumeChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onSeek?: (seconds: number) => void;
  onVolumeDragStart?: () => void;
  onVolumeDragEnd?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onCycleSubtitle: () => void;
  onCycleAudio: () => void;
  onToggleStats: () => void;
  onToggleFullscreen: () => void;
  onShowSubtitleModal: () => void;
  onShowAudioModal: () => void;
  onCatchupSeek?: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, seekSeconds: number, programDesc?: string) => void;
  onGoToLive?: () => void;
  timeshiftEnabled?: boolean;
  timeshiftState?: {
    cacheStart: number;
    cacheEnd: number;
    timePos: number;
    behindLive: number;
    cachedDuration: number;
  } | null;
  onTimeshiftCatchUp?: () => void;
  onChannelUp?: () => void;
  onChannelDown?: () => void;
  onPlaylistQueueClick?: () => void;
  onPlaylistPreviousItem?: () => void;
  onPlaylistNextItem?: () => void;
  aspectRatio?: AspectRatioMode;
  onSetAspectRatio?: (mode: AspectRatioMode) => void;
  overlay?: React.ReactNode;
  onNavigateDvr?: () => void;
  onReplayStream?: () => void;
  onSwitchStream?: (stream: StremioStream) => void;
  compiledBadgeRules?: { pattern: RegExp; badge: StremioStreamBadge }[];
  compiledNuvioBadgeRules?: { pattern: RegExp; badge: StremioStreamBadge }[];
  onTogglePip?: () => void;
  pipMode?: boolean;
  hasAudioDelay?: boolean;
  playerControlDesign?: 'default' | 'clean';
  showVolumePercent?: boolean;
  onToggleTransparentGuide?: () => void;
  guideTransparent?: boolean;
  isAudioOnly?: boolean;
  audioVisualizerMode?: VisualizerMode;
  onSetAudioVisualizerMode?: (mode: VisualizerMode) => void;
  onPlayChannel?: (channel: StoredChannel) => void;
}

// Format seconds to "H:MM:SS" or "M:SS"
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function NowPlayingBar({
  visible,
  channel,
  playing,
  muted,
  volume,
  mpvReady,
  position,
  duration,
  isVod,
  vodInfo,
  isCatchup,
  catchupInfo,
  channelInfoOverlayEnabled,
  onTogglePlay,
  onStop,
  onToggleMute,
  onVolumeChange,
  onSeek,
  onVolumeDragStart,
  onVolumeDragEnd,
  onMouseEnter,
  onMouseLeave,
  onCycleSubtitle,
  onCycleAudio,
  onToggleStats,
  onToggleFullscreen,
  onShowSubtitleModal,
  onShowAudioModal,
  onCatchupSeek,
  onGoToLive,
  timeshiftEnabled,
  timeshiftState,
  onTimeshiftCatchUp,
  onChannelUp,
  onChannelDown,
  onPlaylistQueueClick,
  onPlaylistPreviousItem,
  onPlaylistNextItem,
  aspectRatio = 'fit',
  onSetAspectRatio,
  overlay,
  onNavigateDvr,
  onReplayStream,
  onSwitchStream,
  compiledBadgeRules,
  compiledNuvioBadgeRules,
  onTogglePip,
  pipMode,
  hasAudioDelay,
  playerControlDesign = 'clean',
  showVolumePercent: propShowVolumePercent,
  onToggleTransparentGuide,
  guideTransparent = false,
  isAudioOnly,
  audioVisualizerMode = 'spectrum',
  onSetAudioVisualizerMode,
  onPlayChannel,
}: NowPlayingBarProps) {
  const { t } = useTranslation('player');
  const showVolumePercentSetting = useSettingsStore((s) => s.showVolumePercent);
  const showVolumePercent = propShowVolumePercent ?? showVolumePercentSetting ?? false;

  // scrubMode: 'timeshift' | 'epgcatchup' — local toggle when channel supports both
  const [scrubMode, setScrubMode] = useState<'timeshift' | 'epgcatchup'>('timeshift');
  // Modal state
  const [recording, setRecording] = useState(false);
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [recordDuration, setRecordDuration] = useState(5);
  const [recordTitle, setRecordTitle] = useState('');
  const [isStopAndRecord, setIsStopAndRecord] = useState(false);
  const canControl = mpvReady && channel !== null;
  const currentProgram = useCurrentProgram(channel?.stream_id ?? null);
  const { showSuccess, showError, showConfirmThree, showPrompt, ModalComponent } = useModal();

  // Active playlist context: only reported when the currently playing video is
  // actually the playlist's current item (a stale session can't show here).
  const { activePlaylistId, activePlaylistName, items, currentIndex, isShuffle } = useActivePlaylistStore();
  const isPlaylistActive =
    activePlaylistId != null &&
    currentIndex >= 0 &&
    currentIndex < items.length &&
    isActivePlaylistItem(vodInfo, items[currentIndex]);
  const nextUpItem = isPlaylistActive && currentIndex < items.length - 1 ? items[currentIndex + 1] : null;

  // Prev/next navigation: playlist queue takes over while a playlist item is
  // playing; otherwise fall back to the existing channel/episode navigation.
  const showPrevNav = isPlaylistActive ? !!onPlaylistPreviousItem : !!(onChannelUp && (!isVod || vodInfo?.type === 'series'));
  const showNextNav = isPlaylistActive ? !!onPlaylistNextItem : !!(onChannelDown && (!isVod || vodInfo?.type === 'series'));
  const isEpisodeNav = !isPlaylistActive && isVod && vodInfo?.type === 'series';
  const handleNavPrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isPlaylistActive) {
      onPlaylistPreviousItem?.();
    } else {
      onChannelUp?.();
    }
  };
  const handleNavNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isPlaylistActive) {
      onPlaylistNextItem?.();
    } else {
      onChannelDown?.();
    }
  };

  // Shared playlist indicator (playlist name, position, shuffle, next-up preview)
  const playlistIndicator = isPlaylistActive ? (
    <div className="npb-playlist-info">
      <button
        type="button"
        className="npb-playlist-badge"
        onClick={onPlaylistQueueClick}
        title={`${t('fromPlaylist')}: ${activePlaylistName ?? ''} · ${currentIndex + 1}/${items.length}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
        {activePlaylistName}
        <span className="npb-playlist-pos">{currentIndex + 1}/{items.length}</span>
        <svg className="npb-playlist-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isShuffle && <span className="npb-playlist-shuffle">· {t('shuffle')}</span>}
      {nextUpItem && (
        <span className="npb-next-up" title={`${t('nextUp')}: ${nextUpItem.title}`}>
          {t('nextUp')}: {nextUpItem.title}
        </span>
      )}
    </div>
  ) : null;

  // Playback speed state
  const [speed, setSpeed] = useState<number>(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const lastUrlRef = useRef<string | null>(null);
  const currentUrl = isVod ? vodInfo?.url : channel?.direct_url;

  useEffect(() => {
    if (currentUrl !== lastUrlRef.current) {
      setSpeed(1);
      setShowSpeedMenu(false);
      lastUrlRef.current = currentUrl || null;
    }
  }, [currentUrl, isVod]);

  // Close playback speed menu on outside click
  useEffect(() => {
    if (!showSpeedMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (speedMenuRef.current && !speedMenuRef.current.contains(e.target as Node)) {
        setShowSpeedMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSpeedMenu]);

  const SPEED_OPTIONS = [1.0, 1.25, 1.5, 1.75, 2.0];

  const handleSelectSpeed = useCallback((newSpeed: number) => {
    setSpeed(newSpeed);
    Bridge.setProperty('speed', newSpeed).catch(console.error);
    setShowSpeedMenu(false);
  }, []);

  // Source picker modal state
  const [showSourcePicker, setShowSourcePicker] = useState(false);

  // Show source picker button only for Stremio/Nuvio VOD content
  const isStremioNuvio = isVod && vodInfo && (vodInfo.source_id === 'stremio' || vodInfo.source_id === 'nuvio');
  const stremioSourceId = isStremioNuvio && vodInfo?.stremioId ? vodInfo.stremioId : null;
  const stremioSourceType = isStremioNuvio && vodInfo?.stremioType ? vodInfo.stremioType : null;

  // Aspect ratio menu state
  const [showAspectMenu, setShowAspectMenu] = useState(false);
  const aspectMenuRef = useRef<HTMLDivElement>(null);

  // Visualizer menu state
  const [showVisualizerMenu, setShowVisualizerMenu] = useState(false);
  const visualizerMenuRef = useRef<HTMLDivElement>(null);

  // Close aspect ratio menu & visualizer menu on outside click
  useEffect(() => {
    if (!showAspectMenu && !showVisualizerMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (aspectMenuRef.current && !aspectMenuRef.current.contains(e.target as Node)) {
        setShowAspectMenu(false);
      }
      if (visualizerMenuRef.current && !visualizerMenuRef.current.contains(e.target as Node)) {
        setShowVisualizerMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAspectMenu, showVisualizerMenu]);

  const isClean = playerControlDesign === 'clean';
  // When channel info overlay is enabled or clean design is active, hide channel details from the bar for live TV
  const hideChannelInfo = isClean || (channelInfoOverlayEnabled && !isVod && !isCatchup);

  // Update DVR with currently playing stream info
  useEffect(() => {
    if (channel && playing) {
      updatePlayingStream(
        channel.source_id,
        channel.stream_id,
        channel.name,
        channel.direct_url || null,
        true
      );
    } else {
      // Clear playing stream info when stopped
      updatePlayingStream(null, null, null, null, false);
    }
  }, [channel, playing]);

  // Note: DVR URL resolution is handled by App.tsx to ensure it's always active
  // This avoids duplicate listeners and ensures resolution works on all pages

  // Quick record - check conflicts first, then show modal
  const handleQuickRecord = useCallback(async () => {
    if (!channel) return;

    const defaultTitle = currentProgram?.title || t('quickRecordTitle', { name: channel.name });
    setRecordTitle(defaultTitle);
    setIsStopAndRecord(false);

    const now = Math.floor(Date.now() / 1000);
    const tempSchedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'> = {
      source_id: channel.source_id,
      channel_id: channel.stream_id,
      channel_name: channel.name,
      program_title: defaultTitle,
      scheduled_start: now,
      scheduled_end: now + (5 * 60),
      start_padding_sec: 0,
      end_padding_sec: 0,
      stream_url: undefined,
    };

    const conflictResult = await detectScheduleConflicts(tempSchedule);
    if (conflictResult.hasConflict) {
      showConfirmThree(
        t('schedulingConflict'),
        t('schedulingConflictMsg'),
        () => {
          setIsStopAndRecord(true);
          setShowRecordModal(true);
          setRecordDuration(5);
        },
        () => {
          setIsStopAndRecord(false);
          setShowRecordModal(true);
          setRecordDuration(5);
        },
        undefined,
        t('stopAndRecord'),
        t('ignore'),
        t('cancel')
      );
      return;
    }

    setShowRecordModal(true);
    setRecordDuration(5);
  }, [channel, currentProgram, showConfirmThree]);

  // Start recording with selected duration (no-conflict or Ignore flow)
  const handleStartRecording = useCallback(async () => {
    if (!channel) return;

    setShowRecordModal(false);
    setRecording(true);
    try {
      if (isStopAndRecord) {
        onStop();
      }
      const now = Math.floor(Date.now() / 1000);
      const isStalker = channel.direct_url?.startsWith('stalker_');
      const defaultTitle = currentProgram?.title || t('quickRecordTitle', { name: channel.name });
      const finalTitle = recordTitle.trim() || defaultTitle;

      const schedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'> = {
        source_id: channel.source_id,
        channel_id: channel.stream_id,
        channel_name: channel.name,
        program_title: finalTitle,
        scheduled_start: now,
        scheduled_end: now + (recordDuration * 60),
        start_padding_sec: 0,
        end_padding_sec: 0, // Quick recording has 0 padding
        series_match_title: undefined,
        recurrence: undefined,
        stream_url: isStalker ? undefined : channel.direct_url,
      };

      await scheduleRecording(schedule);
      if (isStopAndRecord) {
        onNavigateDvr?.();
        await new Promise(r => setTimeout(r, 100));
      }
      showSuccess(
        t('recordingScheduled'),
        t('recordingScheduledMsg', { minutes: recordDuration })
      );
    } catch (error: any) {
      console.error('Failed to start quick record:', error);
      showError(
        t('recordingFailed'),
        error?.message || t('failedToStartRecording')
      );
    } finally {
      setRecording(false);
      setIsStopAndRecord(false);
    }
  }, [channel, currentProgram, isStopAndRecord, onStop, recordDuration, recordTitle, showSuccess, showError, onNavigateDvr]);

  // Progress tracking for live TV - updates every second
  const [progress, setProgress] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState('');

  // VOD scrubber state
  const [isHovering, setIsHovering] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverPosition, setHoverPosition] = useState(0);
  const progressBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!currentProgram) {
      setProgress(0);
      setTimeRemaining('');
      return;
    }

    const updateProgress = () => {
      const now = new Date().getTime();
      const start = new Date(currentProgram.start).getTime();
      const end = new Date(currentProgram.end).getTime();
      const duration = end - start;
      const elapsed = now - start;

      const pct = Math.min(100, Math.max(0, (elapsed / duration) * 100));
      setProgress(pct);

      // Calculate time remaining
      const remainingMs = Math.max(0, end - now);
      const remainingMins = Math.ceil(remainingMs / 60000);
      if (remainingMins >= 60) {
        const hrs = Math.floor(remainingMins / 60);
        const mins = remainingMins % 60;
        setTimeRemaining(`${hrs}h ${mins}m left`);
      } else {
        setTimeRemaining(`${remainingMins}m left`);
      }
    };

    updateProgress();
    const interval = setInterval(updateProgress, 1000);
    return () => clearInterval(interval);
  }, [currentProgram]);

  // Calculate position from mouse/touch event on progress bar
  const getSeekPosition = useCallback((clientX: number): number => {
    if (!progressBarRef.current || duration <= 0) return 0;
    const rect = progressBarRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }, [duration]);

  // Handle click to seek
  const handleProgressClick = useCallback((e: React.MouseEvent) => {
    const isLiveCatchup = !isVod && !isCatchup && currentProgram && (Boolean(channel?.tv_archive) || channel?.tv_archive === 1);
    const hasTimeshift = !isVod && !isCatchup && timeshiftEnabled && timeshiftState && timeshiftState.cachedDuration > 1;

    if (hasTimeshift && timeshiftState && onSeek) {
      if (!progressBarRef.current) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetPos = timeshiftState.cacheStart + ratio * timeshiftState.cachedDuration;
      onSeek(Math.min(Math.max(targetPos, timeshiftState.cacheStart), timeshiftState.cacheEnd - 1));
    } else if (isVod || isCatchup) {
      if (!onSeek) return;
      const seekTo = getSeekPosition(e.clientX);
      onSeek(seekTo);
    } else if (isLiveCatchup && onCatchupSeek && channel) {
      if (!progressBarRef.current) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

      const rawStartMs = currentProgram.raw_start
        ? new Date(currentProgram.raw_start).getTime()
        : new Date(currentProgram.start).getTime();
      const progStartMs = new Date(currentProgram.start).getTime();
      const elapsedMins = Math.max(1, Math.ceil((Date.now() - progStartMs) / 60000));
      const seekSeconds = ratio * (elapsedMins * 60);

      onCatchupSeek(channel, currentProgram.title, rawStartMs, elapsedMins, seekSeconds, currentProgram.description);
    }
  }, [isVod, isCatchup, currentProgram, channel, onSeek, onCatchupSeek, getSeekPosition, timeshiftEnabled, timeshiftState]);

  // Handle mouse move for hover tooltip
  const handleProgressMouseMove = useCallback((e: React.MouseEvent) => {
    const isLiveCatchup = !isVod && !isCatchup && currentProgram && (Boolean(channel?.tv_archive) || channel?.tv_archive === 1);
    const hasTimeshift = !isVod && !isCatchup && timeshiftEnabled && timeshiftState && timeshiftState.cachedDuration > 1;
    if (!isVod && !isCatchup && !isLiveCatchup && !hasTimeshift) return;

    if (hasTimeshift && timeshiftState) {
      if (!progressBarRef.current) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHoverPosition(timeshiftState.cacheStart + ratio * timeshiftState.cachedDuration);
    } else if (isLiveCatchup) {
      if (!progressBarRef.current) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const progStartMs = new Date(currentProgram.start).getTime();
      const durationSecs = Math.max(1, (Date.now() - progStartMs) / 1000);
      setHoverPosition(ratio * durationSecs);
    } else {
      if (!progressBarRef.current || duration <= 0) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      setHoverPosition(ratio * duration);
    }
  }, [isVod, isCatchup, channel, currentProgram, duration, timeshiftEnabled, timeshiftState]);

  // Handle drag start
  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const isLiveCatchup = !isVod && !isCatchup && currentProgram && (Boolean(channel?.tv_archive) || channel?.tv_archive === 1);
    const hasTimeshift = !isVod && !isCatchup && timeshiftEnabled && timeshiftState && timeshiftState.cachedDuration > 1;

    if (hasTimeshift && timeshiftState) {
      e.preventDefault();
      setIsDragging(true);
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      if (!progressBarRef.current) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setHoverPosition(timeshiftState.cacheStart + ratio * timeshiftState.cachedDuration);
    } else if (isVod || isCatchup) {
      e.preventDefault();
      setIsDragging(true);
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      if (!progressBarRef.current || duration <= 0) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setHoverPosition(ratio * duration);
    } else if (isLiveCatchup && onCatchupSeek && channel) {
      e.preventDefault();
      setIsDragging(true);
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;

      if (!progressBarRef.current) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

      const startMs = new Date(currentProgram.raw_start ?? currentProgram.start).getTime();
      const durationSecs = Math.max(1, (Date.now() - startMs) / 1000);
      setHoverPosition(ratio * durationSecs);
    }
  }, [isVod, isCatchup, currentProgram, channel, onSeek, onCatchupSeek, getSeekPosition, duration, timeshiftEnabled, timeshiftState]);

  // Handle drag (mouse/touch move while dragging)
  useEffect(() => {
    const isLiveCatchup = !isVod && !isCatchup && currentProgram && (Boolean(channel?.tv_archive) || channel?.tv_archive === 1);

    if (!isDragging) return;

    const handleMove = (e: MouseEvent | TouchEvent) => {
      try {
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const hasTimeshift = !isVod && !isCatchup && timeshiftEnabled && timeshiftState && timeshiftState.cachedDuration > 1;

        if (hasTimeshift && timeshiftState) {
          if (!progressBarRef.current) return;
          const rect = progressBarRef.current.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
          setHoverPosition(timeshiftState.cacheStart + ratio * timeshiftState.cachedDuration);
        } else if (isVod || isCatchup) {
          if (!progressBarRef.current || duration <= 0) return;
          const rect = progressBarRef.current.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
          setHoverPosition(ratio * duration);
        } else if (isLiveCatchup && onCatchupSeek && channel) {
          if (!progressBarRef.current) return;
          const rect = progressBarRef.current.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

          const startMs = new Date(currentProgram.raw_start ?? currentProgram.start).getTime();
          const durationSecs = Math.max(1, (Date.now() - startMs) / 1000);
          setHoverPosition(ratio * durationSecs);
        }
      } catch (err) { /* ignore */ }
    };

    const handleEnd = (e: MouseEvent | TouchEvent) => {
      setIsDragging(false);
      try {
        const clientX = 'changedTouches' in e ? e.changedTouches[0].clientX : e.clientX;
        const hasTimeshift = !isVod && !isCatchup && timeshiftEnabled && timeshiftState && timeshiftState.cachedDuration > 1;

        if (hasTimeshift && timeshiftState && onSeek) {
          if (!progressBarRef.current) return;
          const rect = progressBarRef.current.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
          const targetPos = timeshiftState.cacheStart + ratio * timeshiftState.cachedDuration;
          onSeek(Math.min(Math.max(targetPos, timeshiftState.cacheStart), timeshiftState.cacheEnd - 1));
        } else if (isVod || isCatchup) {
          if (onSeek) {
            if (!progressBarRef.current || duration <= 0) return;
            const rect = progressBarRef.current.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            onSeek(ratio * duration);
          }
        } else if (isLiveCatchup && onCatchupSeek && channel) {
          if (!progressBarRef.current) return;
          const rect = progressBarRef.current.getBoundingClientRect();
          const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

          const startMs = new Date(currentProgram.raw_start ?? currentProgram.start).getTime();
          const elapsedMins = Math.max(1, Math.ceil((Date.now() - startMs) / 60000));
          const seekSeconds = ratio * (elapsedMins * 60);

          onCatchupSeek(channel, currentProgram.title, startMs, elapsedMins, seekSeconds, currentProgram.description);
        }
      } catch (err) { /* ignore */ }
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);

    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging, isVod, isCatchup, currentProgram, channel, onSeek, onCatchupSeek, getSeekPosition, duration, timeshiftEnabled, timeshiftState]);

  // VOD progress calculation
  const vodProgress = duration > 0 ? (position / duration) * 100 : 0;
  const vodRemaining = duration - position;

  return (
    <div
      className={`now-playing-bar ${isClean ? 'clean-design' : ''} ${visible ? 'visible' : 'hidden'}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Overlay slot — rendered above the bar, e.g. failover group members */}
      {overlay && (
        <div className="npb-overlay-slot">
          {overlay}
        </div>
      )}
      {channel ? (
        <>
          {isClean ? (
            <div className="npb-clean-layout">
            {playlistIndicator}
            {/* Top Row: Full-width Seekbar with left & right timestamps and sub-row */}
            <div className="npb-clean-seekbar-row">
              <div className="npb-clean-seekbar-container">
                <span className="npb-clean-time-elapsed">
                  {isVod || isCatchup
                    ? formatTime(position)
                    : timeshiftState
                    ? formatTime(timeshiftState.timePos - timeshiftState.cacheStart)
                    : (position > 0 ? formatTime(position) : '0:00')}
                </span>

                <div
                  ref={progressBarRef}
                  className={`npb-clean-progressbar ${isHovering || isDragging ? 'active' : ''}`}
                  onClick={handleProgressClick}
                  onMouseEnter={() => setIsHovering(true)}
                  onMouseLeave={() => setIsHovering(false)}
                  onMouseMove={handleProgressMouseMove}
                  onMouseDown={handleDragStart}
                  onTouchStart={handleDragStart}
                >
                  <div
                    className="npb-clean-progress-fill"
                    style={{ width: `${isVod || isCatchup ? vodProgress : (timeshiftState ? Math.max(0, Math.min(100, ((timeshiftState.timePos - timeshiftState.cacheStart) / timeshiftState.cachedDuration) * 100)) : progress)}%` }}
                  />
                  <div
                    className="npb-clean-scrubber-handle"
                    style={{ left: `${isVod || isCatchup ? vodProgress : (timeshiftState ? Math.max(0, Math.min(100, ((timeshiftState.timePos - timeshiftState.cacheStart) / timeshiftState.cachedDuration) * 100)) : progress)}%` }}
                  />
                  {isHovering && !isDragging && (
                    <div
                      className="npb-time-tooltip"
                      style={{
                        left: `${!isVod && !isCatchup && timeshiftEnabled && timeshiftState && timeshiftState.cachedDuration > 1
                          ? Math.max(0, Math.min(100, ((hoverPosition - timeshiftState.cacheStart) / timeshiftState.cachedDuration) * 100))
                          : (hoverPosition / (duration || 1)) * 100}%`
                      }}
                    >
                      {formatTime(!isVod && !isCatchup && timeshiftEnabled && timeshiftState && timeshiftState.cachedDuration > 1 ? hoverPosition - timeshiftState.cacheStart : hoverPosition)}
                    </div>
                  )}
                </div>

                <span className="npb-clean-time-remaining">
                  {isVod || isCatchup
                    ? `-${formatTime(vodRemaining)}`
                    : timeshiftState
                    ? (timeshiftState.behindLive < 5 ? 'LIVE' : `-${formatTime(timeshiftState.behindLive)}`)
                    : (timeRemaining ? `-${timeRemaining}` : 'LIVE')}
                </span>
              </div>
            </div>

            {/* Bottom Row: Controls (Left, Center, Right) */}
            <div className="npb-clean-controls-row">
              {/* Left Group: Volume, DVR, & LIVE status */}
              <div className="npb-clean-left">
                <button
                  className="npb-clean-btn"
                  onClick={onToggleMute}
                  disabled={!mpvReady}
                  title={muted ? t('unmute') : t('mute')}
                >
                  <VolumeIcon muted={muted} volume={volume} />
                </button>
                <input
                  type="range"
                  className="npb-clean-volume-slider"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={onVolumeChange}
                  onMouseDown={onVolumeDragStart}
                  onMouseUp={onVolumeDragEnd}
                  onTouchStart={onVolumeDragStart}
                  onTouchEnd={onVolumeDragEnd}
                  disabled={!mpvReady}
                />
                {showVolumePercent && (
                  <span className="npb-clean-volume-value" title={t('volumeValue', { volume })}>
                    {volume}
                  </span>
                )}
                {!isVod && (
                  <button
                    className="npb-clean-dvr-btn"
                    onClick={handleQuickRecord}
                    disabled={!canControl || recording}
                    title={t('quickRecordDvr')}
                  >
                    <span className="npb-clean-dvr-dash">-</span> DVR
                  </button>
                )}
                {!isVod && !isCatchup && (
                  timeshiftState && timeshiftState.behindLive >= 5 ? (
                    <div className="npb-clean-behind-live-group">
                      {onTimeshiftCatchUp ? (
                        <button className="npb-clean-live-btn active" onClick={onTimeshiftCatchUp} title={t('catchUpToLive')}>
                          <span className="npb-clean-live-dot red" />
                          LIVE
                        </button>
                      ) : (
                        <span className="npb-clean-live-badge">
                          <span className="npb-clean-live-dot red" />
                          LIVE
                        </span>
                      )}
                      <span className="npb-clean-behind-text">
                        −{t('behindLive', { time: formatTime(timeshiftState.behindLive) })}
                      </span>
                    </div>
                  ) : (
                    <span className="npb-clean-live-badge">
                      <span className="npb-clean-live-dot red" />
                      LIVE
                    </span>
                  )
                )}
                {isCatchup && onGoToLive && (
                  <button
                    className="npb-clean-live-btn active"
                    onClick={onGoToLive}
                    title={t('goToLive')}
                  >
                    {t('goLive')}
                  </button>
                )}
              </div>

              {/* Center Group: Channel Up, Channel Down, Circular Play/Pause, Stop, Reload */}
              <div className="npb-clean-center">
                {showPrevNav && (
                  <button
                    className="npb-clean-sm-btn"
                    onClick={handleNavPrev}
                    disabled={!canControl}
                    title={isPlaylistActive ? t('previousPlaylistItem') : (isEpisodeNav ? t('previousEpisode') : t('previousChannel'))}
                  >
                    {isPlaylistActive || isEpisodeNav ? <PrevIcon /> : <ChannelUpIcon />}
                  </button>
                )}

                {showNextNav && (
                  <button
                    className="npb-clean-sm-btn"
                    onClick={handleNavNext}
                    disabled={!canControl}
                    title={isPlaylistActive ? t('nextPlaylistItem') : (isEpisodeNav ? t('nextEpisode') : t('nextChannel'))}
                  >
                    {isPlaylistActive || isEpisodeNav ? <NextIcon /> : <ChannelDownIcon />}
                  </button>
                )}

                <button
                  className="npb-clean-play-btn"
                  onClick={onTogglePlay}
                  disabled={!canControl}
                  title={playing ? t('pauseSpace') : t('playSpace')}
                >
                  {playing ? <PauseIcon /> : <PlayIcon />}
                </button>

                {!isVod && !isCatchup && onReplayStream && (
                  <button
                    className="npb-clean-sm-btn"
                    onClick={onReplayStream}
                    disabled={!canControl}
                    title={t('reloadChannel')}
                  >
                    <ReloadIcon />
                  </button>
                )}

                {onStop && (
                  <button
                    className="npb-clean-sm-btn"
                    onClick={onStop}
                    disabled={!canControl}
                    title={t('stop')}
                  >
                    <StopIcon />
                  </button>
                )}
              </div>

              {/* Right Group: Toggle Stats, Aspect Ratio, Speed, Audio, Subtitles, Source Picker, PiP, Fullscreen */}
              <div className="npb-clean-right">
                {isVod && (
                  <div style={{ position: 'relative' }} ref={speedMenuRef}>
                    <button
                      className={`npb-clean-btn npb-speed-btn${showSpeedMenu ? ' active' : ''}`}
                      onClick={() => setShowSpeedMenu(v => !v)}
                      disabled={!canControl}
                      title={t('playbackSpeed', { speed })}
                      style={{ fontWeight: 700, fontSize: '0.8rem', minWidth: '28px' }}
                    >
                      {`${speed}x`}
                    </button>
                    {showSpeedMenu && (
                      <div className="npb-aspect-menu npb-speed-menu">
                        {SPEED_OPTIONS.map((s) => (
                          <button
                            key={s}
                            className={`npb-aspect-item ${speed === s ? 'active' : ''}`}
                            onClick={() => handleSelectSpeed(s)}
                          >
                            {`${s}x`}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {!isVod && !vodInfo && onToggleTransparentGuide && (
                  <button
                    className={`npb-clean-btn${guideTransparent ? ' active' : ''}`}
                    onClick={onToggleTransparentGuide}
                    title={t('toggleTransparentGuide')}
                  >
                    <TvIcon />
                  </button>
                )}

                {onToggleStats && (
                  <button
                    className="npb-clean-btn"
                    onClick={onToggleStats}
                    disabled={!canControl}
                    title={t('toggleStats')}
                  >
                    <StatsIcon />
                  </button>
                )}

                {onSetAspectRatio && (
                  <div style={{ position: 'relative' }} ref={aspectMenuRef}>
                    <button
                      className="npb-clean-btn"
                      onClick={() => setShowAspectMenu(v => !v)}
                      disabled={!canControl}
                      title={t('aspectRatio')}
                    >
                      <AspectRatioIcon />
                    </button>
                    {showAspectMenu && (
                      <div className="npb-aspect-menu">
                        {(['fit', 'fill', 'stretch', '4:3', '16:9'] as AspectRatioMode[]).map((mode) => (
                          <button
                            key={mode}
                            className={`npb-aspect-item ${aspectRatio === mode ? 'active' : ''}`}
                            onClick={() => {
                              onSetAspectRatio(mode);
                              setShowAspectMenu(false);
                            }}
                          >
                            {getAspectRatioLabel(mode)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {isAudioOnly && onSetAudioVisualizerMode && (
                  <div style={{ position: 'relative' }} ref={visualizerMenuRef}>
                    <button
                      className={`npb-clean-btn ${showVisualizerMenu ? 'active' : ''}`}
                      onClick={() => setShowVisualizerMenu(v => !v)}
                      title={t('audioVisualizerStyle')}
                    >
                      <VisualizerIcon />
                    </button>
                    {showVisualizerMenu && (
                      <div className="npb-aspect-menu npb-visualizer-menu">
                        <div className="npb-menu-title">{t('audioVisualizer')}</div>
                        <button
                          className={`npb-aspect-item ${audioVisualizerMode === 'spectrum' ? 'active' : ''}`}
                          onClick={() => { onSetAudioVisualizerMode('spectrum'); setShowVisualizerMenu(false); }}
                        >
                          📊 {t('visualizerSpectrum')}
                        </button>
                        <button
                          className={`npb-aspect-item ${audioVisualizerMode === 'circular' ? 'active' : ''}`}
                          onClick={() => { onSetAudioVisualizerMode('circular'); setShowVisualizerMenu(false); }}
                        >
                          ⭕ {t('visualizerCircular')}
                        </button>

                        <button
                          className={`npb-aspect-item ${audioVisualizerMode === 'vinyl' ? 'active' : ''}`}
                          onClick={() => { onSetAudioVisualizerMode('vinyl'); setShowVisualizerMenu(false); }}
                        >
                          💿 {t('visualizerVinyl')}
                        </button>
                        <button
                          className={`npb-aspect-item ${audioVisualizerMode === 'off' ? 'active' : ''}`}
                          onClick={() => { onSetAudioVisualizerMode('off'); setShowVisualizerMenu(false); }}
                        >
                          🚫 {t('visualizerOff')}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <button
                  className={`npb-clean-btn${hasAudioDelay ? ' has-badge' : ''}`}
                  onClick={onShowAudioModal}
                  disabled={!canControl}
                  title={t('audioLanguage')}
                >
                  <TranslateIcon />
                </button>

                <button
                  className="npb-clean-btn"
                  onClick={onShowSubtitleModal}
                  disabled={!canControl}
                  title={t('subtitlesTracks')}
                >
                  <SubtitleIcon />
                </button>

                {isStremioNuvio && onSwitchStream && stremioSourceId && stremioSourceType && (
                  <button
                    className="npb-clean-btn npb-source-picker-btn"
                    onClick={() => setShowSourcePicker(true)}
                    disabled={!canControl}
                    title={t('switchSource')}
                  >
                    <SourcePickerIcon />
                  </button>
                )}

                {onTogglePip && (
                  <button
                    className="npb-clean-btn"
                    onClick={onTogglePip}
                    disabled={!canControl}
                    title={pipMode ? t('exitPip') : t('pip')}
                  >
                    <PiPIcon active={!!pipMode} />
                  </button>
                )}

                {onPlayChannel && !isVod && (
                  <TeamChannelOverlay
                    currentChannel={channel}
                    onChannelClick={onPlayChannel}
                    isCleanDesign={true}
                  />
                )}

                <button
                  className="npb-clean-btn"
                  onClick={onToggleFullscreen}
                  disabled={!canControl}
                  title={t('toggleFullscreen')}
                >
                  <FullscreenIcon />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Row 1: Channel/VOD info with description */}
            {!hideChannelInfo && (
              <div className="npb-row npb-info-row">
                {/* Left: Logo + Channel/Program or VOD info */}
                <div className="npb-channel-section">
                {channel.stream_icon && (
                  <img
                    key={channel.stream_icon}
                    src={channel.stream_icon}
                    alt=""
                    className="npb-channel-logo"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                )}
                <div className="npb-channel-text">
                  {isVod && vodInfo ? (
                    <>
                      <span className="npb-channel-name" title={vodInfo.title}>
                        {vodInfo.title}
                        {vodInfo.year && <span className="npb-vod-year"> ({vodInfo.year})</span>}
                      </span>
                      {vodInfo.episodeInfo && (
                        <span className="npb-program-title" title={vodInfo.episodeInfo}>
                          {vodInfo.episodeInfo}
                        </span>
                      )}

                      {playlistIndicator}
                    </>
                  ) : isCatchup && catchupInfo ? (
                    <>
                      <span className="npb-channel-name" title={channel.alias || channel.name}>
                        {channel.alias || channel.name} <span className="npb-catchup-badge" style={{ fontSize: '0.7em', backgroundColor: '#e5a00d', padding: '2px 6px', borderRadius: '4px', verticalAlign: 'middle', marginLeft: '6px' }}>{t('catchup')}</span>
                      </span>
                      <MetadataBadge streamId={channel.stream_id} variant="detailed" />
                      <span className="npb-program-title" title={catchupInfo.programTitle}>
                        {catchupInfo.programTitle}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="npb-channel-name" title={channel.alias || channel.name}>
                        {channel.alias || channel.name}
                      </span>
                      <MetadataBadge streamId={channel.stream_id} variant="detailed" />
                      {currentProgram ? (
                        <>
                          <span className="npb-program-title" title={currentProgram.title}>
                            {currentProgram.title}
                          </span>
                          {(currentProgram as any).subtitle && (
                            <span className="npb-program-subtitle" title={(currentProgram as any).subtitle}>
                              {(currentProgram as any).subtitle}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="npb-no-program">{t('noProgramInfo')}</span>
                      )}
                    </>
                  )}
                </div>
              </div>

                {/* Divider + Description (VOD plot or TV program description) */}
                {(isVod ? vodInfo?.plot : (isCatchup ? catchupInfo?.programDesc : currentProgram?.description)) && (
                  <>
                    <div className="npb-divider" />
                    <div className="npb-description-section">
                      <span className="npb-program-desc" title={isVod ? vodInfo?.plot : (isCatchup ? catchupInfo?.programDesc : currentProgram?.description)}>
                        {isVod ? vodInfo?.plot : (isCatchup ? catchupInfo?.programDesc : currentProgram?.description)}
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Row 2: Progress and controls */}
            <div className="npb-row npb-controls-row">
              {/* Progress section - VOD/Catchup vs Live TV */}
              {isVod || isCatchup ? (
                <div className="npb-progress-section npb-progress-vod">
                  <span className="npb-time-elapsed">{formatTime(position)}</span>
                  <div
                    ref={progressBarRef}
                    className={`npb-progress-bar npb-progress-interactive ${isHovering || isDragging ? 'active' : ''}`}
                    onClick={handleProgressClick}
                    onMouseEnter={() => setIsHovering(true)}
                    onMouseLeave={() => setIsHovering(false)}
                    onMouseMove={handleProgressMouseMove}
                    onMouseDown={handleDragStart}
                    onTouchStart={handleDragStart}
                  >
                    <div
                      className="npb-progress-fill"
                      style={{ width: `${vodProgress}%` }}
                    />
                    <div
                      className={`npb-scrubber-handle ${isDragging ? 'dragging' : ''}`}
                      style={{ left: `${vodProgress}%` }}
                    />
                    {isHovering && !isDragging && (
                      <div
                        className="npb-time-tooltip"
                        style={{ left: `${(hoverPosition / duration) * 100}%` }}
                      >
                        {formatTime(hoverPosition)}
                      </div>
                    )}
                  </div>
                  <span className="npb-time-remaining">-{formatTime(vodRemaining)}</span>

                  {isCatchup && onGoToLive && (
                    <button
                      className="npb-btn npb-live-btn"
                      onClick={() => {
                        onGoToLive();
                      }}
                      title={t('goToLive')}
                    >
                      {t('goLive')}
                    </button>
                  )}
                </div>
              ) : (
                <div className="npb-progress-section">
                  {(() => {
                    const hasTimeshiftData = timeshiftEnabled && timeshiftState && timeshiftState.cachedDuration > 1;
                    const hasEpgCatchup = (Boolean(channel?.tv_archive) || channel?.tv_archive === 1) && currentProgram;
                    const showTimeshiftScrubber = hasTimeshiftData && (!hasEpgCatchup || scrubMode === 'timeshift');
                    const showEpgCatchupScrubber = hasEpgCatchup && (!hasTimeshiftData || scrubMode === 'epgcatchup');

                    if (showTimeshiftScrubber && timeshiftState) {
                      const { cacheStart, cacheEnd, timePos, behindLive, cachedDuration } = timeshiftState;
                      const playheadPct = Math.max(0, Math.min(100, ((timePos - cacheStart) / cachedDuration) * 100));
                      const isLive = behindLive < 5;

                      const handleTimeshiftClick = (e: React.MouseEvent<HTMLDivElement>) => {
                        if (!progressBarRef.current || !onSeek) return;
                        const rect = progressBarRef.current.getBoundingClientRect();
                        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const targetPos = cacheStart + ratio * cachedDuration;
                        onSeek(Math.min(Math.max(targetPos, cacheStart), cacheEnd - 1));
                      };

                      const handleTimeshiftMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
                        if (!progressBarRef.current) return;
                        const rect = progressBarRef.current.getBoundingClientRect();
                        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        setHoverPosition(cacheStart + ratio * cachedDuration);
                      };

                      return (
                        <>
                          <span className="npb-time-elapsed">{formatTime(timePos - cacheStart)}</span>
                          <div className="npb-ts-container">
                            <div
                              ref={progressBarRef}
                              className="npb-ts-scrubber"
                              onClick={handleTimeshiftClick}
                              onMouseEnter={() => setIsHovering(true)}
                              onMouseLeave={() => setIsHovering(false)}
                              onMouseMove={handleTimeshiftMouseMove}
                            >
                              <div className="npb-ts-fill" style={{ width: `${playheadPct}%` }} />
                              <div className="npb-ts-handle" style={{ left: `${playheadPct}%` }} />
                              {isHovering && (
                                <div
                                  className="npb-time-tooltip"
                                  style={{ left: `${((hoverPosition - cacheStart) / cachedDuration) * 100}%` }}
                                >
                                  {formatTime(hoverPosition - cacheStart)}
                                </div>
                              )}
                              {/* Live edge marker */}
                              <div className="npb-live-edge-marker" />
                            </div>
                            {/* Below-bar row: cached duration + mode toggle + live state */}
                            <div className="npb-timeshift-meta">
                              <span className="npb-timeshift-window">↩ {t('buffered', { time: formatTime(cachedDuration) })}</span>
                              {hasEpgCatchup && (
                                <button
                                  className="npb-scrub-mode-btn"
                                  onClick={() => setScrubMode('epgcatchup')}
                                  title={t('switchToEpgCatchup')}
                                >
                                  ⏱ {t('epgCatchup')}
                                </button>
                              )}
                              {isLive ? (
                                <span className="npb-live-badge">● LIVE</span>
                              ) : (
                                <span className="npb-behind-live">−{t('behindLive', { time: formatTime(behindLive) })}</span>
                              )}
                            </div>
                          </div>
                          <span className="npb-time-remaining">−{formatTime(behindLive)}</span>
                          {!isLive && onTimeshiftCatchUp && (
                            <button className="npb-btn npb-live-btn" onClick={onTimeshiftCatchUp} title={t('catchUpToLive')}>
                              ⏭ {t('live')}
                            </button>
                          )}
                        </>
                      );
                    } else if (showEpgCatchupScrubber && currentProgram) {
                      return (
                        <>
                          {hasTimeshiftData && (
                            <button
                              className="npb-scrub-mode-btn npb-scrub-mode-btn--back"
                              onClick={() => setScrubMode('timeshift')}
                              title={t('switchToTimeshift')}
                            >
                              ⏮ TimeShift
                            </button>
                          )}
                          <span className="npb-time-elapsed">{formatTime(Math.max(0, (Date.now() - new Date(currentProgram.start).getTime()) / 1000))}</span>
                          <div
                            ref={progressBarRef}
                            className={`npb-progress-bar npb-progress-interactive ${isHovering || isDragging ? 'active' : ''}`}
                            onClick={handleProgressClick}
                            onMouseEnter={() => setIsHovering(true)}
                            onMouseLeave={() => setIsHovering(false)}
                            onMouseMove={handleProgressMouseMove}
                            onMouseDown={handleDragStart}
                            onTouchStart={handleDragStart}
                          >
                            <div className="npb-progress-fill" style={{ width: `100%` }} />
                            <div className={`npb-scrubber-handle ${isDragging ? 'dragging' : ''}`} style={{ left: `100%` }} />
                            {isHovering && !isDragging && (
                              <div
                                className="npb-time-tooltip"
                                style={{ left: `${(hoverPosition / Math.max(1, (Date.now() - new Date(currentProgram.start).getTime()) / 1000)) * 100}%` }}
                              >
                                {formatTime(hoverPosition)}
                              </div>
                            )}
                          </div>
                          <span className="npb-time-remaining">-0:00</span>
                        </>
                      );
                    } else {
                      // Regular live (no timeshift, no epg catchup)
                      return (
                        <>
                          <div className="npb-progress-bar">
                            <div
                              className="npb-progress-fill"
                              style={{ width: currentProgram ? `${progress}%` : '0%' }}
                            />
                          </div>
                          <span className="npb-time-remaining">
                            {timeRemaining || '--'}
                          </span>
                        </>
                      );
                    }
                  })()}
                </div>
              )}

              {/* Playback controls */}
              <div className="npb-controls">
                {showPrevNav && (
                  <button
                    className="npb-btn npb-channel-up-btn"
                    onClick={handleNavPrev}
                    disabled={!canControl}
                    title={isPlaylistActive ? t('previousPlaylistItem') : (isEpisodeNav ? t('previousEpisode') : t('previousChannelUp'))}
                  >
                    {isPlaylistActive || isEpisodeNav ? <PrevIcon /> : <ChannelUpIcon />}
                  </button>
                )}
                {showNextNav && (
                  <button
                    className="npb-btn npb-channel-down-btn"
                    onClick={handleNavNext}
                    disabled={!canControl}
                    title={isPlaylistActive ? t('nextPlaylistItem') : (isEpisodeNav ? t('nextEpisode') : t('nextChannelDown'))}
                  >
                    {isPlaylistActive || isEpisodeNav ? <NextIcon /> : <ChannelDownIcon />}
                  </button>
                )}
                <button
                  className="npb-btn"
                  onClick={onTogglePlay}
                  disabled={!canControl}
                  title={playing ? t('pauseSpace') : t('playSpace')}
                >
                  {playing ? <PauseIcon /> : <PlayIcon />}
                </button>
                {!isVod && !isCatchup && onReplayStream && (
                  <button
                    className="npb-btn npb-reload-btn"
                    onClick={onReplayStream}
                    disabled={!canControl}
                    title={t('reloadChannel')}
                  >
                    <ReloadIcon />
                  </button>
                )}
                <button
                  className="npb-btn"
                  onClick={onStop}
                  disabled={!canControl}
                  title={t('stop')}
                >
                  <StopIcon />
                </button>
              </div>

              {/* Extra Controls (Subtitle, Audio, Stats, Record) */}
              <div className="npb-controls npb-extra-controls">
                <button
                  className="npb-btn"
                  onClick={onShowSubtitleModal}
                  disabled={!canControl}
                  title={t('selectSubtitle')}
                >
                  <SubtitleIcon />
                </button>
                <button
                  className={`npb-btn${hasAudioDelay ? ' has-badge' : ''}`}
                  onClick={onShowAudioModal}
                  disabled={!canControl}
                  title={t('selectAudioTrack')}
                >
                  <AudioIcon />
                </button>
                <button
                  className="npb-btn"
                  onClick={onToggleStats}
                  disabled={!canControl}
                  title={t('toggleStats')}
                >
                  <StatsIcon />
                </button>
                {isStremioNuvio && onSwitchStream && stremioSourceId && stremioSourceType && (
                  <button
                    className="npb-btn npb-source-picker-btn"
                    onClick={() => setShowSourcePicker(true)}
                    disabled={!canControl}
                    title={t('switchSource')}
                  >
                    <SourcePickerIcon />
                  </button>
                )}
                {onPlayChannel && !isVod && (
                  <TeamChannelOverlay
                    currentChannel={channel}
                    onChannelClick={onPlayChannel}
                    isCleanDesign={false}
                  />
                )}
                {!isVod && (
                  <button
                    className="npb-btn npb-record-btn"
                    onClick={handleQuickRecord}
                    disabled={!canControl || recording}
                    title={t('quickRecord')}
                    style={{ color: recording ? '#ff4444' : undefined }}
                  >
                    <RecordIcon recording={recording} />
                  </button>
                )}
              </div>

              {/* Aspect Ratio controls */}
              {onSetAspectRatio && (
                <div className="npb-controls npb-aspect-controls" ref={aspectMenuRef}>
                  <button
                    className="npb-btn"
                    onClick={() => setShowAspectMenu(v => !v)}
                    disabled={!canControl}
                    title={t('aspectRatio')}
                  >
                    <AspectRatioIcon />
                  </button>
                  {showAspectMenu && (
                    <div className="npb-aspect-menu">
                      {(['fit', 'fill', 'stretch', '4:3', '16:9'] as AspectRatioMode[]).map((mode) => (
                        <button
                          key={mode}
                          className={`npb-aspect-item ${aspectRatio === mode ? 'active' : ''}`}
                          onClick={() => {
                            onSetAspectRatio(mode);
                            setShowAspectMenu(false);
                          }}
                        >
                          {getAspectRatioLabel(mode)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Audio Visualizer controls */}
              {isAudioOnly && onSetAudioVisualizerMode && (
                <div className="npb-controls npb-aspect-controls" ref={visualizerMenuRef}>
                  <button
                    className={`npb-btn ${showVisualizerMenu ? 'active' : ''}`}
                    onClick={() => setShowVisualizerMenu(v => !v)}
                    disabled={!canControl}
                    title={t('audioVisualizerStyle')}
                  >
                    <VisualizerIcon />
                  </button>
                  {showVisualizerMenu && (
                    <div className="npb-aspect-menu npb-visualizer-menu">
                      <div className="npb-menu-title">{t('audioVisualizer')}</div>
                      <button
                        className={`npb-aspect-item ${audioVisualizerMode === 'spectrum' ? 'active' : ''}`}
                        onClick={() => { onSetAudioVisualizerMode('spectrum'); setShowVisualizerMenu(false); }}
                      >
                        📊 {t('visualizerSpectrum')}
                      </button>
                      <button
                        className={`npb-aspect-item ${audioVisualizerMode === 'circular' ? 'active' : ''}`}
                        onClick={() => { onSetAudioVisualizerMode('circular'); setShowVisualizerMenu(false); }}
                      >
                        ⭕ {t('visualizerCircular')}
                      </button>

                      <button
                        className={`npb-aspect-item ${audioVisualizerMode === 'vinyl' ? 'active' : ''}`}
                        onClick={() => { onSetAudioVisualizerMode('vinyl'); setShowVisualizerMenu(false); }}
                      >
                        💿 {t('visualizerVinyl')}
                      </button>
                      <button
                        className={`npb-aspect-item ${audioVisualizerMode === 'off' ? 'active' : ''}`}
                        onClick={() => { onSetAudioVisualizerMode('off'); setShowVisualizerMenu(false); }}
                      >
                        🚫 {t('visualizerOff')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Playback speed controls (VOD only) */}
              {isVod && (
                <div className="npb-controls npb-speed-controls" style={{ position: 'relative' }} ref={speedMenuRef}>
                  <button
                    className={`npb-btn npb-speed-btn${showSpeedMenu ? ' active' : ''}`}
                    onClick={() => setShowSpeedMenu(v => !v)}
                    disabled={!canControl}
                    title={t('playbackSpeed', { speed })}
                  >
                    {`${speed}x`}
                  </button>
                  {showSpeedMenu && (
                    <div className="npb-aspect-menu npb-speed-menu">
                      {SPEED_OPTIONS.map((s) => (
                        <button
                          key={s}
                          className={`npb-aspect-item ${speed === s ? 'active' : ''}`}
                          onClick={() => handleSelectSpeed(s)}
                        >
                          {`${s}x`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Volume controls */}
              <div className="npb-volume">
                <button
                  className="npb-btn npb-volume-btn"
                  onClick={onToggleMute}
                  disabled={!mpvReady}
                  title={muted ? t('unmute') : t('mute')}
                >
                  <VolumeIcon muted={muted} volume={volume} />
                </button>
                <input
                  type="range"
                  className="npb-volume-slider"
                  min="0"
                  max="100"
                  value={volume}
                  onChange={onVolumeChange}
                  onMouseDown={onVolumeDragStart}
                  onMouseUp={onVolumeDragEnd}
                  onTouchStart={onVolumeDragStart}
                  onTouchEnd={onVolumeDragEnd}
                  disabled={!mpvReady}
                />
                {showVolumePercent && <span className="npb-volume-value">{volume}</span>}
              </div>

              {/* PiP button */}
              {onTogglePip && (
                <button
                  className="npb-btn"
                  onClick={onTogglePip}
                  disabled={!canControl}
                  title={pipMode ? t('exitPip') : t('pip')}
                >
                  <PiPIcon active={!!pipMode} />
                </button>
              )}

              {/* Fullscreen button */}
              <button
                className="npb-btn npb-fullscreen-btn"
                onClick={onToggleFullscreen}
                disabled={!canControl}
                title={t('toggleFullscreen')}
              >
                <FullscreenIcon />
              </button>
            </div>
          </>
        )}

        {/* Quick Record Modal - rendered via portal to center in viewport */}
        {showRecordModal && createPortal(
          <div className="npb-modal-overlay" onClick={() => setShowRecordModal(false)}>
            <div className="npb-modal" onClick={(e) => e.stopPropagation()}>
              <div className="npb-modal-header">
                <h3>{t('quickRecord')}</h3>
                <button className="npb-modal-close" onClick={() => setShowRecordModal(false)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
              <div className="npb-modal-body">
                <p>{t('recordChannel', { name: channel?.name })}</p>
                <div className="npb-form-group">
                  <label>{t('recordingTitle')}</label>
                  <input
                    type="text"
                    value={recordTitle}
                    onChange={(e) => setRecordTitle(e.target.value)}
                    placeholder={currentProgram?.title || `${t('quickRecord')} - ${channel?.name || ''}`}
                    autoFocus
                  />
                </div>
                <div className="npb-form-group">
                  <label>{t('durationMinutes')}</label>
                  <input
                    type="number"
                    min="1"
                    max="180"
                    value={recordDuration}
                    onChange={(e) => setRecordDuration(Math.max(1, Math.min(180, parseInt(e.target.value) || 1)))}
                  />
                </div>
              </div>
              <div className="npb-modal-footer">
                <button className="npb-btn secondary" onClick={() => setShowRecordModal(false)}>{t('cancel')}</button>
                <button className="npb-btn primary" onClick={handleStartRecording}>{t('startRecording')}</button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {/* Source Picker Modal */}
        {isStremioNuvio && showSourcePicker && stremioSourceId && stremioSourceType && onSwitchStream && (
          <SourcePickerModal
            source={vodInfo?.source_id === 'nuvio' ? 'nuvio' : 'stremio'}
            type={stremioSourceType}
            id={stremioSourceId}
            currentAddonName={vodInfo?.addonName}
            currentUrl={vodInfo?.url}
            compiledBadgeRules={vodInfo?.source_id === 'nuvio' ? (compiledNuvioBadgeRules || compiledBadgeRules) : compiledBadgeRules}
            onSelect={(stream) => {
              setShowSourcePicker(false);
              onSwitchStream(stream);
            }}
            onClose={() => setShowSourcePicker(false)}
          />
        )}
      </>
    ) : (
        /* Empty state - show minimal controls (volume, fullscreen) */
        <div className="npb-row npb-controls-row" style={{ justifyContent: 'flex-end', gap: '16px' }}>
          {/* Volume controls - always available */}
          <div className="npb-volume">
            <button
              className="npb-btn npb-volume-btn"
              onClick={onToggleMute}
              disabled={!mpvReady}
              title={muted ? t('unmute') : t('mute')}
            >
              <VolumeIcon muted={muted} volume={volume} />
            </button>
            <input
              type="range"
              className="npb-volume-slider"
              min="0"
              max="100"
              value={volume}
              onChange={onVolumeChange}
              onMouseDown={onVolumeDragStart}
              onMouseUp={onVolumeDragEnd}
              onTouchStart={onVolumeDragStart}
              onTouchEnd={onVolumeDragEnd}
              disabled={!mpvReady}
            />
            {showVolumePercent && <span className="npb-volume-value">{volume}</span>}
          </div>

          {/* Fullscreen button - always available */}
          <button
            className="npb-btn npb-fullscreen-btn"
            onClick={onToggleFullscreen}
            title={t('toggleFullscreen')}
          >
            <FullscreenIcon />
          </button>
        </div>
      )}

      {/* Themed Modal */}
      <ModalComponent />
    </div>
  );
}

// Icon components

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function ChannelUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 15l-6-6-6 6" />
    </svg>
  );
}

function ChannelDownIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function TranslateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2v3" />
      <path d="M11 19h7" />
      <path d="m13 22 4-8 4 8" />
      <path d="m15 18 3.5-1.5" />
    </svg>
  );
}

function SubtitleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <line x1="6" y1="10" x2="12" y2="10" />
      <line x1="14" y1="10" x2="18" y2="10" />
      <line x1="6" y1="14" x2="15" y2="14" />
    </svg>
  );
}

function AudioIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 5L6 9H2V15H6L11 19V5Z" />
      <path d="M15.54 8.46C16.4774 9.39764 17.0039 10.6692 17.0039 11.995C17.0039 13.3208 16.4774 14.5924 15.54 15.53" />
      <path d="M18.13 5.87C19.7981 7.53809 20.744 9.79441 20.744 12.145C20.744 14.4956 19.7981 16.7519 18.13 18.42" />
    </svg>
  );
}

function StatsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
    </svg>
  );
}

interface VolumeIconProps {
  muted: boolean;
  volume: number;
}

function TvIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="18" height="13" rx="2" ry="2" />
      <polyline points="16 3 12 8 8 3" />
    </svg>
  );
}

function VisualizerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 10v4" />
      <path d="M6 6v12" />
      <path d="M10 3v18" />
      <path d="M14 8v8" />
      <path d="M18 5v14" />
      <path d="M22 11v2" />
    </svg>
  );
}

function VolumeIcon({ muted, volume }: VolumeIconProps) {
  if (muted) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
      </svg>
    );
  }

  if (volume > 50) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
      </svg>
    );
  }

  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
    </svg>
  );
}

function AspectRatioIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M7 9h2M7 15h2M15 9h2M15 15h2" strokeLinecap="round" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
    </svg>
  );
}

function ReloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function SourcePickerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-10 5 10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  );
}

function RecordIcon({ recording }: { recording: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      {recording ? (
        <>
          <circle cx="12" cy="12" r="10" fill="currentColor" />
          <circle cx="12" cy="12" r="6" fill="#fff" opacity="0.3">
            <animate attributeName="r" values="6;8;6" dur="1s" repeatCount="indefinite" />
          </circle>
        </>
      ) : (
        <circle cx="12" cy="12" r="8" />
      )}
    </svg>
  );
}

function PiPIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? '#00d4ff' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="18" rx="2" />
      <rect x="10" y="10" width="10" height="8" rx="1" fill={active ? '#00d4ff' : 'none'} />
    </svg>
  );
}
