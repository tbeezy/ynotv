import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoredChannel } from '../db';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { useCurrentProgram } from '../hooks/useChannels';
import { db } from '../db';
import './FavoritesWidget.css';

interface FavoriteChannelItemProps {
  channel: StoredChannel;
  onChannelClick: (channel: StoredChannel) => void;
}

function FavoriteChannelItem({ channel, onChannelClick }: FavoriteChannelItemProps) {
  const currentProgram = useCurrentProgram(channel.stream_id);

  const handleClick = useCallback(() => {
    onChannelClick(channel);
  }, [channel, onChannelClick]);

  return (
    <div
      className="favorite-channel-item"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      title={`${channel.name}${currentProgram ? ` - ${currentProgram.title}` : ''}`}
    >
      <div className="favorite-channel-name">{channel.alias || channel.name}</div>
      {currentProgram && (
        <div className="favorite-channel-program">{currentProgram.title}</div>
      )}
    </div>
  );
}

interface FavoritesWidgetProps {
  showControls: boolean;
  activeView: string;
  onChannelClick: (channel: StoredChannel) => void;
  isVod: boolean;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

export function FavoritesWidget({
  showControls,
  activeView,
  onChannelClick,
  isVod,
  onMoveLeft,
  onMoveRight,
}: FavoritesWidgetProps) {
  const { t } = useTranslation('widgets');
  const favoriteChannels = useLiveQuery(
    async () => {
      const results = await db.channels.whereRaw('(is_favorite = 1 OR is_favorite = true)').toArray();
      // Sort by fav_order (nulls last, then by name)
      results.sort((a, b) => {
        if (a.fav_order != null && b.fav_order != null) return a.fav_order - b.fav_order;
        if (a.fav_order != null) return -1;
        if (b.fav_order != null) return 1;
        return (a.alias || a.name).localeCompare(b.alias || b.name);
      });
      return results;
    },
    [],
    [],
    0,
    ['channels', 'favorites']
  );

  // Only visible on main screen when controls are shown
  const isMainScreen = activeView === 'none';
  const isVisible = isMainScreen && showControls && (favoriteChannels?.length ?? 0) > 0 && !isVod;

  if (!isVisible) {
    return null;
  }

  return (
    <div className="favorites-widget">
      <div className="favorites-header" style={{ display: 'flex', alignItems: 'center' }}>
        <span>{t('favorites')}</span>
        {(onMoveLeft || onMoveRight) && (
          <div className="widget-move-controls">
            <button className="widget-move-btn" onClick={onMoveLeft} disabled={!onMoveLeft} title={t('moveLeft')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            </button>
            <button className="widget-move-btn" onClick={onMoveRight} disabled={!onMoveRight} title={t('moveRight')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
            </button>
          </div>
        )}
      </div>
      <div className="favorites-list">
        {favoriteChannels?.map((channel) => (
          <FavoriteChannelItem
            key={channel.stream_id}
            channel={channel}
            onChannelClick={onChannelClick}
          />
        ))}
      </div>
    </div>
  );
}
