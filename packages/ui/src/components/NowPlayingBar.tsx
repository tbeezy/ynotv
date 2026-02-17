import { type ChangeEvent, useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import type { StoredChannel } from '../db';
import type { VodPlayInfo } from '../types/media';
import { useCurrentProgram } from '../hooks/useChannels';
import { TrackSelectionModal } from './TrackSelectionModal';
import { MetadataBadge } from './MetadataBadge';
import { scheduleRecording, getDvrSettings, updatePlayingStream, db, type DvrSchedule } from '../db';
import { StalkerClient } from '@ynotv/local-adapter';
import { useModal } from './Modal';
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
}: NowPlayingBarProps) {
  // Modal state
  const [showSubtitleModal, setShowSubtitleModal] = useState(false);
  const [showAudioModal, setShowAudioModal] = useState(false);
  const [recording, setRecording] = useState(false);
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [recordDuration, setRecordDuration] = useState(5);
  const canControl = mpvReady && channel !== null;
  const currentProgram = useCurrentProgram(channel?.stream_id ?? null);
  const { showSuccess, showError, ModalComponent } = useModal();

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

  // Quick record - show modal to enter duration
  const handleQuickRecord = useCallback(() => {
    if (!channel) return;
    setShowRecordModal(true);
    setRecordDuration(5); // Default to 5 minutes
  }, [channel]);

  // Start recording with selected duration
  const handleStartRecording = useCallback(async () => {
    if (!channel) return;

    setShowRecordModal(false);
    setRecording(true);
    try {
      // Get DVR settings for padding defaults
      const settings = await getDvrSettings();

      const now = Math.floor(Date.now() / 1000);

      // For Stalker sources, don't pre-resolve URL - tokens expire too quickly
      // The backend will emit dvr:resolve_url_now event right before FFmpeg starts
      const isStalker = channel.direct_url?.startsWith('stalker_');

      const schedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'> = {
        source_id: channel.source_id,
        channel_id: channel.stream_id,
        channel_name: channel.name,
        program_title: currentProgram?.title || `Quick Record - ${channel.name}`,
        scheduled_start: now,
        scheduled_end: now + (recordDuration * 60),
        start_padding_sec: 0, // No start padding for instant recording
        end_padding_sec: settings.default_end_padding_sec || 0,
        series_match_title: undefined,
        recurrence: undefined,
        // For Stalker, don't include stream_url - it will be resolved at recording time
        // For other sources, use the direct_url
        stream_url: isStalker ? undefined : channel.direct_url,
      };

      await scheduleRecording(schedule);
      showSuccess(
        'Recording Scheduled',
        `Recording scheduled for ${recordDuration} minutes`
      );
    } catch (error: any) {
      console.error('Failed to start quick record:', error);
      showError(
        'Recording Failed',
        error?.message || 'Failed to start recording'
      );
    } finally {
      setRecording(false);
    }
  }, [channel, currentProgram, recordDuration, showSuccess, showError]);

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
    if (!isVod || !onSeek) return;
    const seekTo = getSeekPosition(e.clientX);
    onSeek(seekTo);
  }, [isVod, onSeek, getSeekPosition]);

  // Handle mouse move for hover tooltip
  const handleProgressMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isVod) return;
    setHoverPosition(getSeekPosition(e.clientX));
  }, [isVod, getSeekPosition]);

  // Handle drag start
  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isVod || !onSeek) return;
    e.preventDefault();
    setIsDragging(true);

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const seekTo = getSeekPosition(clientX);
    onSeek(seekTo);
  }, [isVod, onSeek, getSeekPosition]);

  // Handle drag (mouse/touch move while dragging)
  useEffect(() => {
    if (!isDragging || !onSeek) return;

    const handleMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const seekTo = getSeekPosition(clientX);
      onSeek(seekTo);
    };

    const handleEnd = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleMove);
    document.addEventListener('touchend', handleEnd);

    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging, onSeek, getSeekPosition]);

  // VOD progress calculation
  const vodProgress = duration > 0 ? (position / duration) * 100 : 0;
  const vodRemaining = duration - position;

  return (
    <div
      className={`now-playing-bar ${visible ? 'visible' : 'hidden'}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {channel ? (
        <>
          {/* Row 1: Channel/VOD info with description */}
          <div className="npb-row npb-info-row">
            {/* Left: Logo + Channel/Program or VOD info */}
            <div className="npb-channel-section">
              {channel.stream_icon && (
                <img
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
                  </>
                ) : (
                  <>
                    <span className="npb-channel-name" title={channel.name}>
                      {channel.name}
                    </span>
                    <MetadataBadge streamId={channel.stream_id} variant="detailed" />
                    {currentProgram ? (
                      <span className="npb-program-title" title={currentProgram.title}>
                        {currentProgram.title}
                      </span>
                    ) : (
                      <span className="npb-no-program">No program info</span>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Divider + Description (VOD plot or TV program description) */}
            {(isVod ? vodInfo?.plot : currentProgram?.description) && (
              <>
                <div className="npb-divider" />
                <div className="npb-description-section">
                  <span className="npb-program-desc" title={isVod ? vodInfo?.plot : currentProgram?.description}>
                    {isVod ? vodInfo?.plot : currentProgram?.description}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Row 2: Progress and controls */}
          <div className="npb-row npb-controls-row">
            {/* Progress section - VOD vs Live TV */}
            {isVod ? (
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
              </div>
            ) : (
              <div className="npb-progress-section">
                <div className="npb-progress-bar">
                  <div
                    className="npb-progress-fill"
                    style={{ width: currentProgram ? `${progress}%` : '0%' }}
                  />
                </div>
                <span className="npb-time-remaining">
                  {timeRemaining || '--'}
                </span>
              </div>
            )}

            {/* Playback controls */}
            <div className="npb-controls">
              <button
                className="npb-btn"
                onClick={onTogglePlay}
                disabled={!canControl}
                title={playing ? 'Pause (Space)' : 'Play (Space)'}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button
                className="npb-btn"
                onClick={onStop}
                disabled={!canControl}
                title="Stop"
              >
                <StopIcon />
              </button>
            </div>

            {/* Extra Controls (Subtitle, Audio, Stats, Record) */}
            <div className="npb-controls npb-extra-controls">
              <button
                className="npb-btn"
                onClick={() => setShowSubtitleModal(true)}
                disabled={!canControl}
                title="Select Subtitle (J)"
              >
                <SubtitleIcon />
              </button>
              <button
                className="npb-btn"
                onClick={() => setShowAudioModal(true)}
                disabled={!canControl}
                title="Select Audio Track (A)"
              >
                <AudioIcon />
              </button>
              <button
                className="npb-btn"
                onClick={onToggleStats}
                disabled={!canControl}
                title="Toggle Stats (I)"
              >
                <StatsIcon />
              </button>
              {!isVod && (
                <button
                  className="npb-btn npb-record-btn"
                  onClick={handleQuickRecord}
                  disabled={!canControl || recording}
                  title="Quick Record"
                  style={{ color: recording ? '#ff4444' : undefined }}
                >
                  <RecordIcon recording={recording} />
                </button>
              )}
            </div>

            {/* Volume controls */}
            <div className="npb-volume">
              <button
                className="npb-btn npb-volume-btn"
                onClick={onToggleMute}
                disabled={!mpvReady}
                title={muted ? 'Unmute (M)' : 'Mute (M)'}
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
              <span className="npb-volume-value">{volume}</span>
            </div>

            {/* Fullscreen button */}
            <button
              className="npb-btn npb-fullscreen-btn"
              onClick={onToggleFullscreen}
              disabled={!canControl}
              title="Toggle Fullscreen (F)"
            >
              <FullscreenIcon />
            </button>
          </div>

          {/* Track Selection Modals */}
          <TrackSelectionModal
            isOpen={showSubtitleModal}
            type="subtitle"
            onClose={() => setShowSubtitleModal(false)}
          />
          <TrackSelectionModal
            isOpen={showAudioModal}
            type="audio"
            onClose={() => setShowAudioModal(false)}
          />

          {/* Quick Record Modal - rendered via portal to center in viewport */}
          {showRecordModal && createPortal(
            <div className="npb-modal-overlay" onClick={() => setShowRecordModal(false)}>
              <div className="npb-modal" onClick={(e) => e.stopPropagation()}>
                <div className="npb-modal-header">
                  <h3>Quick Record</h3>
                  <button className="npb-modal-close" onClick={() => setShowRecordModal(false)}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                <div className="npb-modal-body">
                  <p>Record <strong>{channel?.name}</strong></p>
                  {currentProgram?.title && <p>Program: {currentProgram.title}</p>}
                  <div className="npb-form-group">
                    <label>Duration (minutes)</label>
                    <input
                      type="number"
                      min="1"
                      max="180"
                      value={recordDuration}
                      onChange={(e) => setRecordDuration(Math.max(1, Math.min(180, parseInt(e.target.value) || 1)))}
                      autoFocus
                    />
                  </div>
                </div>
                <div className="npb-modal-footer">
                  <button className="npb-btn secondary" onClick={() => setShowRecordModal(false)}>Cancel</button>
                  <button className="npb-btn primary" onClick={handleStartRecording}>Start Recording</button>
                </div>
              </div>
            </div>,
            document.body
          )}

          {/* Themed Modal */}
          <ModalComponent />
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
              title={muted ? 'Unmute (M)' : 'Mute (M)'}
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
            <span className="npb-volume-value">{volume}</span>
          </div>

          {/* Fullscreen button - always available */}
          <button
            className="npb-btn npb-fullscreen-btn"
            onClick={onToggleFullscreen}
            title="Toggle Fullscreen (F)"
          >
            <FullscreenIcon />
          </button>
        </div>
      )}
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

function SubtitleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="15" width="20" height="4" rx="1" />
      <rect x="2" y="9" width="20" height="4" rx="1" />
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

function FullscreenIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
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
