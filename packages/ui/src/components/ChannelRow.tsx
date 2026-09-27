import { memo, useMemo, useState, useCallback } from 'react';
import i18n from '../i18n';
import { ProgramBlock, EmptyProgramBlock } from './ProgramBlock';
import { ProgramContextMenu } from './ProgramContextMenu';
import { ChannelContextMenu } from './ChannelContextMenu';
import { FavoriteButton } from './FavoriteButton';
import { MetadataBadge } from './MetadataBadge';
import { RecordingIndicator } from './RecordingIndicator';
import { addToRecentChannels } from '../utils/recentChannels';
import { ChannelLogo } from './ChannelLogo';
import type { StoredChannel, StoredProgram } from '../db';
import { normalizeBoolean } from '../utils/db-helpers';
import { useSettingsStore } from '../stores/settingsStore';
import type { RecordingInfo } from '../hooks/useActiveRecordings';

// Channel column width is controlled via CSS custom property for resizability

interface ChannelRowProps {
  channel: StoredChannel;
  index: number;
  sortOrder: 'alphabetical' | 'number' | 'provider';
  programs: StoredProgram[];
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  visibleHours: number;
  onPlay: () => void;
  onPlayCatchup?: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, programDesc?: string) => void;
  onFavoriteToggle?: () => void;
  categoryId?: string | null;
  activeRecordings?: RecordingInfo[];
  currentLayout?: string;
  onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null) => void;
  onPlayInPopout?: (channel: StoredChannel) => void;
  onPlayInExternal?: (channel: StoredChannel) => void;
  isCurrentlyPlaying?: boolean;
  showPlaylistName?: boolean;
  sourceNames?: Map<string, string>;
  epgMetadataBadgeResolution?: boolean;
  epgMetadataBadgeFps?: boolean;
  epgMetadataBadgeSound?: boolean;
  epgMetadataBadgeBitrate?: boolean;
  epgMetadataBadgeAudioBitrate?: boolean;
  altView?: boolean;
  currentTime?: Date | number;
}

export interface CurrentProgramInfo {
  program: StoredProgram;
  startMs: number;
  endMs: number;
  pct: number;
}

export function getCurrentProgramInfo(programs: StoredProgram[], currentTimeMs: number = Date.now()): CurrentProgramInfo | null {
  if (!programs || programs.length === 0) return null;
  const now = currentTimeMs;
  for (const p of programs) {
    const s = p.start instanceof Date ? p.start.getTime() : new Date(p.start).getTime();
    const e = p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && s <= now && e > now) {
      const pct = e > s ? Math.max(0, Math.min(100, ((now - s) / (e - s)) * 100)) : 0;
      return { program: p, startMs: s, endMs: e, pct };
    }
  }
  return null;
}

export const ChannelRow = memo(function ChannelRow({
  channel,
  index,
  programs,
  windowStart,
  windowEnd,
  pixelsPerHour,
  visibleHours,
  onPlay,
  onPlayCatchup,
  onFavoriteToggle,
  categoryId,
  activeRecordings = [],
  currentLayout,
  onSendToSlot,
  onPlayInPopout,
  onPlayInExternal,
  isCurrentlyPlaying,
  showPlaylistName,
  sourceNames,
  epgMetadataBadgeResolution,
  epgMetadataBadgeFps,
  epgMetadataBadgeSound,
  epgMetadataBadgeBitrate,
  epgMetadataBadgeAudioBitrate,
  altView,
  currentTime,
}: ChannelRowProps) {
  // Per-source logo overrides are read straight from the store so changes
  // apply live without re-running the channel query.
  const sourceLogoDisplayOverrides = useSettingsStore((s) => s.sourceLogoDisplayOverrides);
  const sourceLogoBackgroundOverrides = useSettingsStore((s) => s.sourceLogoBackgroundOverrides);
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ program: StoredProgram; x: number; y: number } | null>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Show metadata badges in the 3-column strip row (3rd line under the channel
  // name + current program) only when at least one badge is enabled.
  const showAltMetadata = altView && Boolean(
    epgMetadataBadgeResolution || epgMetadataBadgeFps || epgMetadataBadgeSound ||
    epgMetadataBadgeBitrate || epgMetadataBadgeAudioBitrate
  );

  // Normalize the is_favorite value (SQLite stores BOOLEAN as 0/1)
  const isFavorite = normalizeBoolean(channel.is_favorite);

  // Display name is already filtered at the data level (useChannels hook).
  const channelDisplayName = channel.alias || channel.name;
  // Surface which filter words were applied so users can see why a name looks trimmed.
  const channelTitle = channel.applied_filter_words && channel.applied_filter_words.length > 0
    ? `${channelDisplayName}\n${i18n.t('settings:channelManager.filterWords')}: ${channel.applied_filter_words.join(', ')}`
    : channelDisplayName;

  // Channel name is already filtered at the data level (useChannels hook)
  // No need to apply filter words here anymore

  // Alternate view: the single program currently airing, shown instead of the
  // full horizontal grid cells. Picked in JS from the same per-channel program
  // array the grid renders, so it shares the grid's memoized data and never
  // issues an extra query or re-runs on scroll.
  const currentProgramInfo = useMemo(() => {
    if (!altView) return null;
    const nowMs = currentTime instanceof Date ? currentTime.getTime() : (typeof currentTime === 'number' ? currentTime : Date.now());
    return getCurrentProgramInfo(programs, nowMs);
  }, [altView, programs, currentTime]);

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

  const isPlaylistNameShown = Boolean(showPlaylistName);
  const isBitrateBadgeShown = Boolean(epgMetadataBadgeBitrate || epgMetadataBadgeAudioBitrate);
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
        console.error('[ChannelRow] Failed to resolve multiview URL:', err);
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
    <div className={`guide-channel-row ${isCurrentlyPlaying ? 'currently-playing' : ''} ${isPlaylistNameShown ? 'has-playlist-name' : ''} ${isBitrateBadgeShown ? 'has-bitrate-badge' : ''} ${showMultiviewButtons ? 'has-multiview-buttons' : ''} ${altView ? 'alt-mode' : ''}`}>
      {/* Channel info column */}
      <div
        className={`guide-channel-info guide-channel-item ${isRecording ? 'is-recording' : ''} ${isPlaylistNameShown ? 'has-playlist-name' : ''} ${isBitrateBadgeShown ? 'has-bitrate-badge' : ''} ${showMultiviewButtons ? 'has-multiview-buttons' : ''} ${altView ? 'alt-mode' : ''}`}
        data-stream-id={channel.stream_id}
        data-index={index}
        style={altView
          ? { width: '100%', minWidth: 0, maxWidth: '100%', flex: '1 1 auto' }
          : {
              width: 'var(--epg-channel-column-width, 264px)',
              minWidth: 'var(--epg-channel-column-width, 264px)',
              maxWidth: 'var(--epg-channel-column-width, 264px)'
            }}
        onClick={onPlay}
        onContextMenu={handleChannelContextMenu}
        tabIndex={0}
        role="button"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPlay();
          }
        }}
      >
        {!altView && isRecording && (
          <div className="channel-recording-indicator">
            <RecordingIndicator size="small" />
          </div>
        )}
        <FavoriteButton
          streamId={channel.stream_id}
          isFavorite={isFavorite}
          onToggle={onFavoriteToggle}
        />
        <ChannelLogo
          src={channel.stream_icon}
          name={channelDisplayName}
          className="guide-channel-logo"
          background={channel.logo_background as 'auto' | 'light' | 'dark' | undefined}
          defaultBackground={sourceLogoBackgroundOverrides[channel.source_id]}
          padding={channel.logo_padding as 'default' | 'none' | undefined}
          shape={sourceLogoDisplayOverrides[channel.source_id]}
        />
        <div className="guide-channel-name-container">
          <span className="guide-channel-name" title={channelTitle}>
            {channelDisplayName}
            {(Boolean(channel.tv_archive) || channel.tv_archive === 1) && (
              <span style={{ color: '#e5a00d', marginLeft: '4px', fontSize: '1.1em', verticalAlign: 'middle' }}>↺</span>
            )}
            {channel.is_adult && (
              <span className="adult-badge" title={i18n.t('live:adultChannel')} style={{
                backgroundColor: 'rgba(220, 53, 69, 0.85)',
                color: '#fff',
                fontSize: '0.65em',
                fontWeight: 700,
                padding: '1px 4px',
                borderRadius: '3px',
                marginLeft: '5px',
                verticalAlign: 'middle',
                letterSpacing: '0.3px',
                lineHeight: 1,
                display: 'inline-block',
              }}>18+</span>
            )}
          </span>
          {altView ? (
            <>
              {currentProgramInfo ? (
                <span className="guide-channel-alt-program-title" title={currentProgramInfo.program.title}>
                  {currentProgramInfo.program.title}
                </span>
              ) : (
                <span className="guide-channel-alt-no-program">
                  {i18n.t('common:noProgramInfo', { defaultValue: 'No Program Information' })}
                </span>
              )}
              {/* Playlist/source name line, matching the non-3-column rows:
                  shown under the program title when the show-source toggle is on. */}
              {isPlaylistNameShown && (
                <span
                  className="guide-channel-playlist-name"
                  title={channel.source_category_display || channel.source_name || sourceNames?.get(channel.source_id) || channel.source_id}
                >
                  {channel.source_category_display || channel.source_name || sourceNames?.get(channel.source_id) || channel.source_id}
                </span>
              )}
            </>
          ) : isPlaylistNameShown && (
            <span
              className="guide-channel-playlist-name"
              title={channel.source_category_display || channel.source_name || sourceNames?.get(channel.source_id) || channel.source_id}
            >
              {channel.source_category_display || channel.source_name || sourceNames?.get(channel.source_id) || channel.source_id}
            </span>
          )}
          {showAltMetadata && (
            <div className="guide-channel-alt-metadata">
              <MetadataBadge
                streamId={channel.stream_id}
                variant="detailed"
                showResolution={epgMetadataBadgeResolution}
                showFps={epgMetadataBadgeFps}
                showSound={epgMetadataBadgeSound}
                showBitrate={epgMetadataBadgeBitrate}
                showAudioBitrate={epgMetadataBadgeAudioBitrate}
              />
            </div>
          )}
        </div>
        {!altView && showMultiviewButtons && (
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
        {!altView && (
        <div className="channel-row-metadata">
          <MetadataBadge
            streamId={channel.stream_id}
            variant="detailed"
            showResolution={epgMetadataBadgeResolution}
            showFps={epgMetadataBadgeFps}
            showSound={epgMetadataBadgeSound}
            showBitrate={epgMetadataBadgeBitrate}
            showAudioBitrate={epgMetadataBadgeAudioBitrate}
          />
        </div>
        )}
      </div>

      {/* Program grid — or, in the alternate view, a thin progress bar at the bottom of the row */}
      {altView ? (
        <div className="guide-channel-alt-progress-track">
          <div
            className="guide-channel-alt-progress-fill"
            style={{ width: `${currentProgramInfo?.pct ?? 0}%` }}
          />
        </div>
      ) : (
      <div className="guide-program-grid">
        {programs.length > 0 ? (
          programs.map((program, index, arr) => {
            // Check if this specific program is being recorded or scheduled
            // Use programStartTime/programEndTime for precise matching (without padding)
            const progStartMs = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
            const originalEndMs = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();
            
            let progEndMs = originalEndMs;
            if (index < arr.length - 1) {
              const nextProgram = arr[index + 1];
              const nextStartMs = nextProgram.start instanceof Date ? nextProgram.start.getTime() : new Date(nextProgram.start).getTime();
              if (progEndMs > nextStartMs) {
                progEndMs = nextStartMs;
              }
            }

            const clampedProgram = progEndMs !== originalEndMs ? { ...program, end: new Date(progEndMs) } : program;

            const progStartSec = Math.floor(progStartMs / 1000);
            const progEndSec = Math.floor(originalEndMs / 1000);

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
            const isCatchupAvailable = Boolean(channel.tv_archive) || channel.tv_archive === 1;

            return (
              <ProgramBlock
                key={program.id}
                program={clampedProgram}
                channel={channel}
                windowStart={windowStart}
                windowEnd={windowEnd}
                pixelsPerHour={pixelsPerHour}
                onClick={onPlay}
                onPlayCatchup={onPlayCatchup}
                onContextMenu={(e) => handleContextMenu(e, program)}
                isRecording={isProgramRecording}
                isScheduled={isProgramScheduled}
                isCatchupAvailable={isCatchupAvailable}
              />
            );
          })
        ) : (
          <EmptyProgramBlock pixelsPerHour={pixelsPerHour} visibleHours={visibleHours} />
        )}
      </div>
      )}

      {/* Program Context Menu */}
      {contextMenu && (
        <ProgramContextMenu
          program={contextMenu.program}
          sourceId={channel.source_id}
          channelId={channel.stream_id}
          channelName={channel.name}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          isCatchupAvailable={Boolean(channel.tv_archive) || channel.tv_archive === 1}
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
          onPlayInPopout={onPlayInPopout}
          onPlayInExternal={onPlayInExternal}
        />
      )}
    </div>
  );
});
