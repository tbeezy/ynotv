import { memo, useState } from 'react';
import { FavoriteButton } from './FavoriteButton';
import { ChannelContextMenu } from './ChannelContextMenu';
import { ProgramContextMenu } from './ProgramContextMenu';
import type { StoredChannel, StoredProgram } from '../db';
import { normalizeBoolean } from '../utils/db-helpers';
import type { RecordingInfo } from '../hooks/useActiveRecordings';
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
}

// Width of the channel info column (must match ChannelPanel)
const CHANNEL_COLUMN_WIDTH = 264;
const HOUR_WIDTH = 175; // Fixed width per program slot (75% wider than before: 100 * 1.75 = 175)

// Format date for display
function formatProgramDate(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isTomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  
  if (isToday) return 'Today';
  if (isTomorrow) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
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
}: SearchResultRowProps) {
  const now = new Date();

  // Context menu state
  const [channelContextMenu, setChannelContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [programContextMenu, setProgramContextMenu] = useState<{ program: StoredProgram; x: number; y: number } | null>(null);

  const formatProgramTime = (date: Date | string) => {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Handle context menu on channel
  function handleChannelContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    // Account for preview panel height at top of EPG
    const topSection = document.querySelector('.guide-top-section');
    const offset = topSection ? topSection.getBoundingClientRect().height : 0;

    setChannelContextMenu({
      x: e.clientX,
      y: e.clientY - offset,
    });
  }

  // Get the horizontal offset based on sidebar and categories visibility
  function getXOffset(): number {
    const guidePanel = document.querySelector('.guide-panel');
    if (!guidePanel) return 0;
    
    const computedStyle = window.getComputedStyle(guidePanel);
    const paddingLeft = parseInt(computedStyle.paddingLeft) || 0;
    return paddingLeft;
  }

  // Get the vertical offset based on preview panel height
  function getYOffset(): number {
    const topSection = document.querySelector('.guide-top-section');
    return topSection ? topSection.getBoundingClientRect().height : 0;
  }

  // Handle context menu on program
  function handleProgramContextMenu(e: React.MouseEvent, program: StoredProgram) {
    e.preventDefault();
    e.stopPropagation();

    const xOffset = getXOffset();
    const yOffset = getYOffset();

    setProgramContextMenu({
      program,
      x: e.clientX - xOffset,
      y: e.clientY - yOffset,
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

  // Limit to max 4 programs per row to prevent overflow
  const displayPrograms = sortedPrograms.slice(0, 4);

  return (
    <div className={`guide-channel-row search-result-row ${isRecording ? 'is-recording' : ''}`}>
      {/* Channel info column */}
      <div
        className={`guide-channel-info ${isRecording ? 'is-recording' : ''}`}
        style={{
          width: CHANNEL_COLUMN_WIDTH,
          minWidth: CHANNEL_COLUMN_WIDTH,
          maxWidth: CHANNEL_COLUMN_WIDTH
        }}
        onClick={onPlay}
        onContextMenu={handleChannelContextMenu}
      >
        {isRecording && (
          <div className="channel-recording-indicator">
            <div className="recording-indicator small">
              <div className="recording-dot pulse"></div>
              <span className="recording-text">REC</span>
            </div>
          </div>
        )}
        <FavoriteButton
          streamId={channel.stream_id}
          isFavorite={isFavorite}
          onToggle={onFavoriteToggle}
        />
        <div className="guide-channel-logo">
          {channel.stream_icon ? (
            <img
              src={channel.stream_icon}
              alt=""
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            <span className="logo-placeholder">{channel.name.charAt(0)}</span>
          )}
        </div>
        <div className="guide-channel-name-container">
          <span className="guide-channel-name" title={channel.name}>{channel.name}</span>
          {channel.channel_num && (
            <span className="guide-channel-number">Ch. {channel.channel_num}</span>
          )}
        </div>
      </div>

      {/* Program grid - Fixed hour slots */}
      <div className="search-programs-container">
        {displayPrograms.length > 0 ? (
          displayPrograms.map((program, index) => {
            const progStartMs = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
            const progEndMs = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();
            const isLive = progStartMs <= now.getTime() && progEndMs > now.getTime();
            const isPast = progEndMs <= now.getTime();
            const isFuture = progStartMs > now.getTime();

            // Check if this specific program is being recorded or scheduled
            const matchingRecording = activeRecordings.find(r =>
              r.channelId === channel.stream_id &&
              r.programStartTime <= Math.floor(progEndMs / 1000) &&
              r.programEndTime >= Math.floor(progStartMs / 1000)
            );
            const isProgramRecording = matchingRecording?.isRecording ?? false;
            const isProgramScheduled = matchingRecording?.isScheduled ?? false;

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
                title={`${program.title} (${formatProgramTime(program.start)} - ${formatProgramTime(program.end)})`}
              >
                <div className="search-program-content">
                  <div className="search-program-title">{program.title}</div>
                  <div className="search-program-datetime">
                    {formatProgramDate(program.start)} {formatProgramTime(program.start)}
                  </div>
                  <div className="search-program-badge">
                    {isLive && <span className="live-badge">LIVE</span>}
                    {isPast && <span className="past-badge">ENDED</span>}
                    {isFuture && <span className="future-badge">UPCOMING</span>}
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="search-empty-programs">
            No program information
          </div>
        )}
      </div>

      {/* Channel Context Menu */}
      {channelContextMenu && (
        <ChannelContextMenu
          channel={channel}
          position={{ x: channelContextMenu.x, y: channelContextMenu.y }}
          onClose={() => setChannelContextMenu(null)}
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
        />
      )}
    </div>
  );
});
