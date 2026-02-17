import { useState, useRef } from 'react';
import type { WatchlistItem, StoredChannel, StoredProgram } from '../db';
import { removeFromWatchlist, updateWatchlistOptions } from '../db';
import { WatchlistOptionsModal } from './WatchlistOptionsModal';
import { FavoriteButton } from './FavoriteButton';
import './ChannelPanel.css';

// Width of the channel info column (must match SearchResultRow)
const CHANNEL_COLUMN_WIDTH = 264;

interface WatchlistRowProps {
  item: WatchlistItem;
  channel?: StoredChannel;
  programs: StoredProgram[];
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  visibleHours: number;
  onPlay: () => void;
  onRefresh: () => void;
}

export function WatchlistRow({
  item,
  channel,
  programs,
  onPlay,
  onRefresh,
}: WatchlistRowProps) {
  const [showEditModal, setShowEditModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const now = new Date();

  // Early return if channel is not available
  if (!channel) {
    const handleDeleteUnavailable = async () => {
      if (!item.id) return;
      try {
        await removeFromWatchlist(item.id);
        onRefresh();
      } catch (error) {
        console.error('[Watchlist] Failed to delete:', error);
      }
    };

    return (
      <div className="guide-channel-row search-result-row" ref={rowRef}>
        <div
          className="guide-channel-info"
          style={{
            width: CHANNEL_COLUMN_WIDTH,
            minWidth: CHANNEL_COLUMN_WIDTH,
            maxWidth: CHANNEL_COLUMN_WIDTH,
            opacity: 0.5,
          }}
        >
          <div className="guide-channel-logo">
            <span className="logo-placeholder">?</span>
          </div>
          <div className="guide-channel-name-container">
            <span className="guide-channel-name">{item.channel_name} (Unavailable)</span>
          </div>
        </div>
        <div className="search-programs-container" style={{ display: 'flex', alignItems: 'center', padding: '0 16px' }}>
          <span style={{ color: 'rgba(255,255,255,0.5)' }}>{item.program_title}</span>
          <button
            className="watchlist-btn-delete"
            onClick={handleDeleteUnavailable}
            title="Remove from watchlist"
            style={{ marginLeft: 'auto' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  const isLive = item.start_time <= now.getTime() && item.end_time > now.getTime();

  const handleDelete = async () => {
    if (!item.id) return;
    setIsDeleting(true);
    try {
      await removeFromWatchlist(item.id);
      onRefresh();
    } catch (error) {
      console.error('[Watchlist] Failed to delete:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEdit = async (options: {
    reminder_enabled: boolean;
    reminder_minutes: number;
    autoswitch_enabled: boolean;
    autoswitch_seconds_before?: number;
  }) => {
    if (!item.id) return;
    try {
      await updateWatchlistOptions(item.id, options);
      onRefresh();
    } catch (error) {
      console.error('[Watchlist] Failed to update:', error);
    }
  };

  // Format time
  const formatTime = (timestamp: number | Date) => {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Status indicators
  const hasReminder = item.reminder_enabled;
  const hasAutoswitch = item.autoswitch_enabled;

  return (
    <>
      <div className="guide-channel-row search-result-row" ref={rowRef}>
        {/* Channel info column */}
        <div
          className="guide-channel-info"
          style={{
            width: CHANNEL_COLUMN_WIDTH,
            minWidth: CHANNEL_COLUMN_WIDTH,
            maxWidth: CHANNEL_COLUMN_WIDTH,
          }}
          onClick={onPlay}
        >
          <FavoriteButton
            streamId={channel.stream_id}
            isFavorite={!!channel.is_favorite}
            onToggle={() => {}}
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
            <span className="guide-channel-name" title={channel.name}>
              {isLive && <span className="live-indicator">●</span>}
              {channel.name}
            </span>
            {channel.channel_num && (
              <span className="guide-channel-number">Ch. {channel.channel_num}</span>
            )}
          </div>
        </div>

        {/* Program info */}
        <div className="search-programs-container" style={{ display: 'flex', alignItems: 'center', padding: '0 16px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500, color: 'white', marginBottom: 4 }}>
              {item.program_title}
            </div>
            <div style={{ fontSize: '0.85em', color: 'rgba(255,255,255,0.6)' }}>
              {formatTime(item.start_time)} - {formatTime(item.end_time)}
              {hasReminder && (
                <span style={{ marginLeft: 8 }} title={`Reminder: ${item.reminder_minutes} min before`}>🔔</span>
              )}
              {hasAutoswitch && (
                <span style={{ marginLeft: 8 }} title={`Auto-switch${item.autoswitch_seconds_before ? ` ${item.autoswitch_seconds_before}s before` : ''}`}>🔄</span>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="watchlist-actions" style={{ display: 'flex', gap: 8 }}>
            <button
              className="watchlist-btn-edit"
              onClick={(e) => {
                e.stopPropagation();
                setShowEditModal(true);
              }}
              title="Edit watchlist settings"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              className="watchlist-btn-delete"
              onClick={(e) => {
                e.stopPropagation();
                handleDelete();
              }}
              disabled={isDeleting}
              title="Remove from watchlist"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      <WatchlistOptionsModal
        isOpen={showEditModal}
        program={{
          id: item.program_id,
          stream_id: item.channel_id,
          title: item.program_title,
          description: item.description || '',
          start: new Date(item.start_time),
          end: new Date(item.end_time),
          source_id: item.source_id,
        }}
        channel={channel}
        existingItem={item}
        onConfirm={(options) => {
          handleEdit(options);
          setShowEditModal(false);
        }}
        onCancel={() => setShowEditModal(false)}
      />
    </>
  );
}
