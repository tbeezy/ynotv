import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { WatchlistItem } from '../db';
import './WatchlistNotification.css';

export interface WatchlistNotificationItem {
  id: number;
  watchlistId: number;
  programTitle: string;
  channelName: string;
  channelId: string;
  sourceId: string;
  startTime: number;
  type: 'reminder' | 'autoswitch';
}

interface WatchlistNotificationProps {
  notifications: WatchlistNotificationItem[];
  onSwitch: (notification: WatchlistNotificationItem) => void;
  onDismiss: (id: number) => void;
}

function NotificationItem({
  notification,
  onSwitch,
  onDismiss,
}: {
  notification: WatchlistNotificationItem;
  onSwitch: (n: WatchlistNotificationItem) => void;
  onDismiss: (id: number) => void;
}) {
  const [isHiding, setIsHiding] = useState(false);
  const [progress, setProgress] = useState(100);

  const handleDismiss = useCallback(() => {
    setIsHiding(true);
    setTimeout(() => onDismiss(notification.id), 300);
  }, [notification.id, onDismiss]);

  const handleSwitch = useCallback(() => {
    onSwitch(notification);
    handleDismiss();
  }, [onSwitch, notification, handleDismiss]);

  // Auto-dismiss after 10 seconds
  useEffect(() => {
    const duration = 10000;
    const interval = 50;
    const step = 100 / (duration / interval);

    const timer = setInterval(() => {
      setProgress((prev) => {
        if (prev <= step) {
          clearInterval(timer);
          handleDismiss();
          return 0;
        }
        return prev - step;
      });
    }, interval);

    return () => clearInterval(timer);
  }, [handleDismiss]);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isReminder = notification.type === 'reminder';
  const isAutoswitch = notification.type === 'autoswitch';

  return (
    <div className={`watchlist-notification ${isHiding ? 'hiding' : ''}`}>
      <div className="watchlist-notification-header">
        <span className="watchlist-notification-icon">{isReminder ? '🔔' : '🔄'}</span>
        <span className="watchlist-notification-title">
          {isReminder ? 'Program Starting' : 'Auto-Switched'}
        </span>
        <button className="watchlist-notification-close" onClick={handleDismiss}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="watchlist-notification-body">
        <div className="watchlist-notification-program">{notification.programTitle}</div>
        <div className="watchlist-notification-channel">{notification.channelName}</div>
        <div className="watchlist-notification-time">Starts at {formatTime(notification.startTime)}</div>
      </div>

      <div className="watchlist-notification-actions">
        <button className="watchlist-notification-btn switch" onClick={handleSwitch}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          {isAutoswitch ? 'Stay Here' : 'Switch Now'}
        </button>
        <button className="watchlist-notification-btn dismiss" onClick={handleDismiss}>
          Dismiss
        </button>
      </div>

      <div className="watchlist-notification-progress">
        <div
          className="watchlist-notification-progress-bar"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

export function WatchlistNotificationContainer({
  notifications,
  onSwitch,
  onDismiss,
}: WatchlistNotificationProps) {
  if (notifications.length === 0) return null;

  return createPortal(
    <div className="watchlist-notification-container">
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          notification={notification}
          onSwitch={onSwitch}
          onDismiss={onDismiss}
        />
      ))}
    </div>,
    document.body
  );
}
