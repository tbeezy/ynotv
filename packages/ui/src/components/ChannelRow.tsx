import { memo, useMemo, useState, useCallback } from 'react';
import { ProgramBlock, EmptyProgramBlock } from './ProgramBlock';
import { ProgramContextMenu } from './ProgramContextMenu';
import { ChannelContextMenu } from './ChannelContextMenu';
import { FavoriteButton } from './FavoriteButton';
import { MetadataBadge } from './MetadataBadge';
import { RecordingIndicator } from './RecordingIndicator';
import type { StoredChannel, StoredProgram } from '../db';
import { normalizeBoolean } from '../utils/db-helpers';
import type { RecordingInfo } from '../hooks/useActiveRecordings';

// Width of the channel info column (must match ChannelPanel)
const CHANNEL_COLUMN_WIDTH = 264;

interface ChannelRowProps {
  channel: StoredChannel;
  index: number;
  sortOrder: 'alphabetical' | 'number';
  programs: StoredProgram[];
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  visibleHours: number;
  onPlay: () => void;
  onFavoriteToggle?: () => void;
  categoryId?: string | null;
  activeRecordings?: RecordingInfo[];
  currentLayout?: string;
  onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string) => void;
}

export const ChannelRow = memo(function ChannelRow({
  channel,
  index,
  sortOrder,
  programs,
  windowStart,
  windowEnd,
  pixelsPerHour,
  visibleHours,
  onPlay,
  onFavoriteToggle,
  categoryId,
  activeRecordings = [],
  currentLayout,
  onSendToSlot,
}: ChannelRowProps) {
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ program: StoredProgram; x: number; y: number } | null>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Show channel_num when sorting by number, otherwise show list position
  const displayNumber = sortOrder === 'number' && channel.channel_num !== undefined
    ? channel.channel_num
    : index + 1;

  // Normalize the is_favorite value (SQLite stores BOOLEAN as 0/1)
  const isFavorite = normalizeBoolean(channel.is_favorite);

  // Channel name is already filtered at the data level (useChannels hook)
  // No need to apply filter words here anymore

  // Check if this channel is being recorded
  const isRecording = useMemo(() => {
    return activeRecordings.some(r =>
      r.channelId === channel.stream_id && r.isRecording
    );
  }, [activeRecordings, channel.stream_id]);

  // Check if a program is scheduled to be recorded
  const isProgramScheduled = useCallback((program: StoredProgram): boolean => {
    const progStartMs = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
    const progEndMs = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();
    return activeRecordings.some(r =>
      r.channelId === channel.stream_id &&
      r.startTime <= Math.floor(progEndMs / 1000) &&
      r.endTime >= Math.floor(progStartMs / 1000)
    );
  }, [activeRecordings, channel.stream_id]);

  // Handle context menu on programs
  function handleContextMenu(e: React.MouseEvent, program: StoredProgram) {
    e.preventDefault();
    e.stopPropagation();

    setContextMenu({
      program,
      x: e.clientX,
      y: e.clientY,
    });
  }

  // Handle context menu on channel
  function handleChannelContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    setChannelContextMenu({
      x: e.clientX,
      y: e.clientY,
    });
  }

  return (
    <div className="guide-channel-row">
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
            <RecordingIndicator size="small" />
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
        </div>
        <div className="channel-row-metadata">
          <MetadataBadge streamId={channel.stream_id} variant="detailed" />
        </div>
      </div>

      {/* Program grid */}
      <div className="guide-program-grid">
        {programs.length > 0 ? (
          programs.map((program) => {
            // Check if this specific program is being recorded or scheduled
            // Use programStartTime/programEndTime for precise matching (without padding)
            const progStartMs = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
            const progEndMs = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();
            const progStartSec = Math.floor(progStartMs / 1000);
            const progEndSec = Math.floor(progEndMs / 1000);

            const matchingRecording = activeRecordings.find(r =>
              r.channelId === channel.stream_id &&
              // Match based on program times (without padding) for precise program matching
              r.programStartTime <= progEndSec &&
              r.programEndTime >= progStartSec &&
              // Also verify the recording actually overlaps with this program
              r.startTime < progEndSec &&
              r.endTime > progStartSec
            );
            const isProgramRecording = matchingRecording?.isRecording ?? false;
            const isProgramScheduled = matchingRecording?.isScheduled ?? false;

            return (
              <ProgramBlock
                key={program.id}
                program={program}
                windowStart={windowStart}
                windowEnd={windowEnd}
                pixelsPerHour={pixelsPerHour}
                onClick={onPlay}
                onContextMenu={(e) => handleContextMenu(e, program)}
                isRecording={isProgramRecording}
                isScheduled={isProgramScheduled}
              />
            );
          })
        ) : (
          <EmptyProgramBlock pixelsPerHour={pixelsPerHour} visibleHours={visibleHours} />
        )}
      </div>

      {/* Program Context Menu */}
      {contextMenu && (
        <ProgramContextMenu
          program={contextMenu.program}
          sourceId={channel.source_id}
          channelId={channel.stream_id}
          channelName={channel.name}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Channel Context Menu */}
      {channelContextMenu && (
        <ChannelContextMenu
          channel={channel}
          position={{ x: channelContextMenu.x, y: channelContextMenu.y }}
          onClose={() => setChannelContextMenu(null)}
          currentLayout={currentLayout}
          onSendToSlot={onSendToSlot}
        />
      )}
    </div>
  );
});
