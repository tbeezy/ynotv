import { memo, useState, useCallback } from 'react';
import { FavoriteButton } from './FavoriteButton';
import { MetadataBadge } from './MetadataBadge';
import { ChannelContextMenu } from './ChannelContextMenu';
import { ProgramContextMenu } from './ProgramContextMenu';
import { addToRecentChannels } from '../utils/recentChannels';
import { ChannelLogo } from './ChannelLogo';
import type { StoredChannel, StoredProgram } from '../db';
import { normalizeBoolean } from '../utils/db-helpers';
import type { RecordingInfo } from '../hooks/useActiveRecordings';
import { useEpgClockFormat } from '../stores/uiStore';
import { formatTime, formatDate } from '../utils/dateTime';
import i18n from '../i18n';
import { useTranslation } from 'react-i18next';
import './ChannelPanel.css';

interface SearchResultRowProps {
  channel: StoredChannel;
  programs: StoredProgram[];
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  visibleHours: number;
  onPlay: () => void;
  onFavoriteToggle?: () => void;
  activeRecordings?: RecordingInfo[];
  currentLayout?: string;
  onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null) => void;
  onPlayInPopout?: (channel: StoredChannel) => void;
  onPlayInExternal?: (channel: StoredChannel) => void;
  includeSourceInSearch?: boolean;
  currentChannel?: StoredChannel | null;
}

// Channel column width is controlled via CSS custom property for resizability
const HOUR_WIDTH = 230; // Fixed width per program slot (expanded for time range and status badges)

// Format date for display
function formatProgramDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isTomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();

  if (isToday) return i18n.t('time:today');
  if (isTomorrow) return i18n.t('time:tomorrow');
  return formatDate(d, { weekday: 'short', month: 'short', day: 'numeric' });
}

// Format duration into readable format (e.g. 30m, 1h 15m)
function formatProgramDuration(startMs: number, endMs: number): string {
  const totalMins = Math.round((endMs - startMs) / 60000);
  if (totalMins < 1) return i18n.t('time:lessThanMinute');
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0 && mins > 0) return i18n.t('time:durationHM', { hours, minutes: mins });
  if (hours > 0) return i18n.t('time:durationH', { hours });
  return i18n.t('time:durationM', { minutes: totalMins });
}

// Format remaining time for live programs (e.g. 24m left)
function formatProgramRemaining(endMs: number, nowMs: number): string {
  const remMins = Math.max(1, Math.round((endMs - nowMs) / 60000));
  const hours = Math.floor(remMins / 60);
  const mins = remMins % 60;
  if (hours > 0 && mins > 0) return i18n.t('time:leftHM', { hours, minutes: mins });
  if (hours > 0) return i18n.t('time:leftH', { hours });
  return i18n.t('time:leftM', { minutes: remMins });
}

export const SearchResultRow = memo(function SearchResultRow({
  channel,
  programs,
  windowStart,
  windowEnd,
  pixelsPerHour,
  visibleHours,
  onPlay,
  onFavoriteToggle,
  activeRecordings = [],
  currentLayout,
  onSendToSlot,
  onPlayInPopout,
  onPlayInExternal,
  includeSourceInSearch,
  currentChannel,
}: SearchResultRowProps) {
  useTranslation();
  const now = new Date();
  const isCurrentlyPlaying = currentChannel?.stream_id === channel.stream_id;

  // Context menu state
  const [channelContextMenu, setChannelContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [programContextMenu, setProgramContextMenu] = useState<{ program: StoredProgram; x: number; y: number } | null>(null);

  const epgClockFormat = useEpgClockFormat();

  const formatProgramTime = (date: Date | string) => {
    const d = date instanceof Date ? date : new Date(date);
    return formatTime(d, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });
  };

  // Handle context menu on channel
  function handleChannelContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    setChannelContextMenu({
      x: e.clientX,
      y: e.clientY,
    });
  }

  // Handle context menu on program
  function handleProgramContextMenu(e: React.MouseEvent, program: StoredProgram) {
    e.preventDefault();
    e.stopPropagation();

    setProgramContextMenu({
      program,
      x: e.clientX,
      y: e.clientY,
    });
  }

  // Check if channel is being recorded
  const isRecording = activeRecordings.some(r =>
    r.channelId === channel.stream_id && r.isRecording
  );

  // Normalize the is_favorite value (SQLite stores BOOLEAN as 0/1)
  const isFavorite = normalizeBoolean(channel.is_favorite);

  // Filter out ended programs - only show live or upcoming
  const activePrograms = programs.filter(p => {
    const endTime = p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime();
    return endTime > now.getTime(); // Only keep programs that haven't ended yet
  });

  // Sort programs: currently live first, then by start time
  const sortedPrograms = [...activePrograms].sort((a, b) => {
    const aStart = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
    const aEnd = a.end instanceof Date ? a.end.getTime() : new Date(a.end).getTime();
    const bStart = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
    const bEnd = b.end instanceof Date ? b.end.getTime() : new Date(b.end).getTime();

    const aIsLive = aStart <= now.getTime() && aEnd > now.getTime();
    const bIsLive = bStart <= now.getTime() && bEnd > now.getTime();

    // Live programs come first
    if (aIsLive && !bIsLive) return -1;
    if (!aIsLive && bIsLive) return 1;

    // Then sort by start time
    return aStart - bStart;
  });

  // Determine if source info is shown (badge may overlap)
  const hasSourceInfo = includeSourceInSearch && (channel.source_category_display || channel.source_name);

  // Limit to max 4 programs per row to prevent overflow
  const displayPrograms = sortedPrograms.slice(0, 4);

  const showMultiviewButtons = Boolean(onSendToSlot && currentLayout && currentLayout !== 'main');

  const isSlotActive = useCallback((slotId: 1 | 2 | 3 | 4) => {
    if (slotId === 1) return true;
    if (!currentLayout) return false;
    if (currentLayout === 'pip' || currentLayout === 'sbs') {
      return slotId === 2;
    }
    return slotId === 2 || slotId === 3 || slotId === 4;
  }, [currentLayout]);

  const handlePlayMain = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onPlay();
  }, [onPlay]);

  const handleSendToSlot = useCallback(async (slotId: 2 | 3 | 4, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!onSendToSlot) return;

    let url = channel.direct_url ?? '';

    if (channel.source_id) {
      try {
        const { resolvePlayUrl } = await import('../services/stream-resolver');
        const resolved = await resolvePlayUrl(channel.source_id, url);
        url = resolved.url;
      } catch (err) {
        console.error('[SearchResultRow] Failed to resolve multiview URL:', err);
      }
    }

    let sourceName: string | null = null;
    if (channel.source_id && window.storage) {
      const result = await window.storage.getSource(channel.source_id);
      if (result.data) {
        sourceName = result.data.name;
      }
    }
    onSendToSlot(slotId, channel.name, url, sourceName);
    addToRecentChannels(channel);
  }, [channel, onSendToSlot]);

  return (
    <div className={`guide-channel-row search-result-row ${isRecording ? 'is-recording' : ''} ${isCurrentlyPlaying ? 'currently-playing' : ''} ${showMultiviewButtons ? 'has-multiview-buttons' : ''}`}>
      {/* Channel info column */}
      <div
        className={`guide-channel-info ${isRecording ? 'is-recording' : ''} ${hasSourceInfo ? 'with-source' : ''} ${showMultiviewButtons ? 'has-multiview-buttons' : ''}`}
        style={{
          width: 'var(--epg-channel-column-width, 264px)',
          minWidth: 'var(--epg-channel-column-width, 264px)',
          maxWidth: 'var(--epg-channel-column-width, 264px)'
        }}
        onClick={onPlay}
        onContextMenu={handleChannelContextMenu}
      >
        {isRecording && (
          <div className="channel-recording-indicator">
            <div className="recording-indicator small">
              <div className="recording-dot pulse"></div>
              <span className="recording-text">{i18n.t('common:rec')}</span>
            </div>
          </div>
        )}
        <FavoriteButton
          streamId={channel.stream_id}
          isFavorite={isFavorite}
          onToggle={onFavoriteToggle}
        />
        <ChannelLogo
          src={channel.stream_icon}
          name={channel.alias || channel.name}
          className="guide-channel-logo"
          background={channel.logo_background as 'auto' | 'light' | 'dark' | undefined}
          padding={channel.logo_padding as 'default' | 'none' | undefined}
          shape={channel.logo_display as 'square' | 'rectangle' | undefined}
        />
        <div className="guide-channel-name-container">
          <span className="guide-channel-name" title={channel.alias || channel.name}>
            {channel.alias || channel.name}
            {(Boolean(channel.tv_archive) || channel.tv_archive === 1) && (
              <span style={{ color: '#e5a00d', marginLeft: '4px', fontSize: '1.1em', verticalAlign: 'middle' }}>↺</span>
            )}
          </span>
          {channel.channel_num && (
            <span className="guide-channel-number">Ch. {channel.channel_num}</span>
          )}
          {hasSourceInfo && (
            <span className="guide-channel-source" style={{
              fontSize: '0.75rem',
              color: 'var(--text-muted, rgba(255, 255, 255, 0.5))',
              marginTop: '2px',
              display: 'block'
            }}>
              {channel.source_category_display || channel.source_name}
            </span>
          )}
        </div>
        {showMultiviewButtons && (
          <div className="multiview-slots-container">
            {[1, 2, 3, 4].map((slotId) => {
              const active = isSlotActive(slotId as 1 | 2 | 3 | 4);
              return (
                <button
                  key={slotId}
                  className={`multiview-slot-btn ${active ? 'active' : 'disabled'}`}
                  disabled={!active}
                  onClick={(slotId === 1) ? handlePlayMain : (e) => handleSendToSlot(slotId as 2 | 3 | 4, e)}
                  title={active
                    ? (slotId === 1 ? i18n.t('player:sendToViewerMain', { slot: slotId }) : i18n.t('player:sendToViewerSlot', { slot: slotId }))
                    : i18n.t('player:viewerNotAvailable', { slot: slotId })}
                >
                  {slotId}
                </button>
              );
            })}
          </div>
        )}
        <div className="channel-row-metadata">
          <MetadataBadge streamId={channel.stream_id} variant="detailed" />
        </div>
      </div>

      {/* Program grid - Fixed slots */}
      <div className="search-programs-container">
        {displayPrograms.length > 0 ? (
          displayPrograms.map((program) => {
            const progStartMs = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
            const progEndMs = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();
            const isLive = progStartMs <= now.getTime() && progEndMs > now.getTime();
            const isPast = progEndMs <= now.getTime();
            const isFuture = progStartMs > now.getTime();

            // Progress percentage for live program
            const totalMs = progEndMs - progStartMs;
            const elapsedMs = now.getTime() - progStartMs;
            const progressPercent = totalMs > 0 ? Math.min(100, Math.max(0, (elapsedMs / totalMs) * 100)) : 0;

            // Check if this specific program is being recorded or scheduled
            const matchingRecording = activeRecordings.find(r =>
              r.channelId === channel.stream_id &&
              r.programStartTime <= Math.floor(progEndMs / 1000) &&
              r.programEndTime >= Math.floor(progStartMs / 1000)
            );
            const isProgramRecording = matchingRecording?.isRecording ?? false;
            const isProgramScheduled = matchingRecording?.isScheduled ?? false;

            const startTimeStr = formatProgramTime(program.start);
            const endTimeStr = formatProgramTime(program.end);
            const dateStr = formatProgramDate(program.start);

            return (
              <div
                key={program.id}
                className={`search-program-slot ${isLive ? 'live' : ''} ${isPast ? 'past' : ''} ${isFuture ? 'future' : ''} ${isProgramRecording ? 'is-recording' : ''} ${isProgramScheduled ? 'is-scheduled' : ''}`}
                style={{
                  width: HOUR_WIDTH,
                  minWidth: HOUR_WIDTH,
                }}
                onClick={onPlay}
                onContextMenu={(e) => handleProgramContextMenu(e, program)}
                title={`${program.title}${program.subtitle ? ` - ${program.subtitle}` : ''}\n${dateStr} · ${startTimeStr} – ${endTimeStr}${isLive ? ` (${i18n.t('common:elapsedPercent', { percent: Math.round(progressPercent) })})` : ''}`}
              >
                <div className="search-program-header">
                  <div className="search-program-badge">
                    {isProgramRecording ? (
                      <span className="rec-badge"><span className="rec-dot" />{i18n.t('common:rec')}</span>
                    ) : isProgramScheduled ? (
                      <span className="sched-badge">🗓️ {i18n.t('common:scheduled')}</span>
                    ) : isLive ? (
                      <span className="live-badge"><span className="live-dot-pulse" />{i18n.t('common:live')}</span>
                    ) : isPast ? (
                      <span className="past-badge">{i18n.t('common:ended')}</span>
                    ) : (
                      <span className="future-badge">{i18n.t('common:upcoming')}</span>
                    )}
                  </div>
                  <div className="search-program-duration">
                    {isLive ? formatProgramRemaining(progEndMs, now.getTime()) : formatProgramDuration(progStartMs, progEndMs)}
                  </div>
                </div>

                <div className="search-program-body">
                  <div className="search-program-title" title={program.title}>
                    {program.title}
                  </div>
                  {program.subtitle && (
                    <div className="search-program-subtitle" title={program.subtitle}>
                      {program.subtitle}
                    </div>
                  )}
                </div>

                <div className="search-program-footer">
                  <div className="search-program-datetime">
                    <svg className="search-program-clock-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span className="search-program-date-label">{dateStr}</span>
                    <span className="search-program-time-sep">·</span>
                    <span className="search-program-time-range">{startTimeStr} – {endTimeStr}</span>
                  </div>
                </div>

                {isLive && (
                  <div className="search-program-progress-bar">
                    <div
                      className="search-program-progress-fill"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="search-empty-programs">
            {i18n.t('common:noProgramInfo')}
          </div>
        )}
      </div>

      {/* Channel Context Menu */}
      {channelContextMenu && (
        <ChannelContextMenu
          channel={channel}
          position={{ x: channelContextMenu.x, y: channelContextMenu.y }}
          onClose={() => setChannelContextMenu(null)}
          currentLayout={currentLayout}
          onSendToSlot={onSendToSlot}
          onPlayInPopout={onPlayInPopout}
          onPlayInExternal={onPlayInExternal}
        />
      )}

      {/* Program Context Menu */}
      {programContextMenu && (
        <ProgramContextMenu
          program={programContextMenu.program}
          sourceId={channel.source_id}
          channelId={channel.stream_id}
          channelName={channel.name}
          position={{ x: programContextMenu.x, y: programContextMenu.y }}
          onClose={() => setProgramContextMenu(null)}
          isCatchupAvailable={Boolean(channel.tv_archive) || channel.tv_archive === 1}
        />
      )}
    </div>
  );
});
