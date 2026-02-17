import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { StoredProgram, StoredChannel, WatchlistOptions } from '../db';
import type { WatchlistItem } from '../db';
import './WatchlistOptionsModal.css';

interface WatchlistOptionsModalProps {
  isOpen: boolean;
  program: StoredProgram | null;
  channel: StoredChannel | null;
  existingItem?: WatchlistItem | null;
  onConfirm: (options: WatchlistOptions) => void;
  onCancel: () => void;
}

export function WatchlistOptionsModal({
  isOpen,
  program,
  channel,
  existingItem,
  onConfirm,
  onCancel,
}: WatchlistOptionsModalProps) {
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderMinutes, setReminderMinutes] = useState(0);
  const [autoswitchEnabled, setAutoswitchEnabled] = useState(false);
  const [autoswitchSeconds, setAutoswitchSeconds] = useState(0);

  const isEditMode = !!existingItem;

  // Reset defaults when opening
  useEffect(() => {
    if (isOpen) {
      if (existingItem) {
        // Edit mode - use existing values
        setReminderEnabled(existingItem.reminder_enabled);
        setReminderMinutes(existingItem.reminder_minutes);
        setAutoswitchEnabled(existingItem.autoswitch_enabled);
        setAutoswitchSeconds(existingItem.autoswitch_seconds_before ?? 0);
      } else {
        // Add mode - use defaults
        setReminderEnabled(true);
        setReminderMinutes(0);
        setAutoswitchEnabled(false);
        setAutoswitchSeconds(0);
      }
    }
  }, [isOpen, existingItem]);

  const handleConfirm = useCallback(() => {
    onConfirm({
      reminder_enabled: reminderEnabled,
      reminder_minutes: reminderMinutes,
      autoswitch_enabled: autoswitchEnabled,
      autoswitch_seconds_before: autoswitchSeconds,
    });
  }, [onConfirm, reminderEnabled, reminderMinutes, autoswitchEnabled, autoswitchSeconds]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onCancel]);

  if (!isOpen || !program || !channel) return null;

  const formatTime = (timestamp: number | Date) => {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return createPortal(
    <div className="watchlist-modal-overlay" onClick={onCancel}>
      <div className="watchlist-modal" onClick={(e) => e.stopPropagation()}>
        <div className="watchlist-modal-header">
          <h3>{isEditMode ? '✏️ Edit Watchlist' : '📋 Add to Watchlist'}</h3>
          <button className="watchlist-modal-close" onClick={onCancel}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="watchlist-modal-body">
          {/* Program Info */}
          <div className="watchlist-program-info">
            <div className="watchlist-program-title">{program.title}</div>
            <div className="watchlist-program-channel">{channel.name}</div>
            <div className="watchlist-program-time">
              {formatTime(new Date(program.start))} - {formatTime(new Date(program.end))}
            </div>
          </div>

          {/* Reminder Section */}
          <div className="watchlist-option-section">
            <label className="watchlist-option-label">
              <input
                type="checkbox"
                checked={reminderEnabled}
                onChange={(e) => setReminderEnabled(e.target.checked)}
              />
              <span className="watchlist-option-text">🔔 Set Reminder</span>
            </label>

            {reminderEnabled && (
              <div className="watchlist-option-detail">
                <label>Remind me</label>
                <div className="watchlist-reminder-input">
                  <input
                    type="number"
                    min="0"
                    max="120"
                    value={reminderMinutes}
                    onChange={(e) => setReminderMinutes(Math.max(0, Math.min(120, parseInt(e.target.value) || 0)))}
                  />
                  <span>minutes before start</span>
                </div>
                {reminderMinutes === 0 && (
                  <span className="watchlist-hint">(at program start time)</span>
                )}
              </div>
            )}
          </div>

          {/* AutoSwitch Section */}
          <div className="watchlist-option-section">
            <label className="watchlist-option-label">
              <input
                type="checkbox"
                checked={autoswitchEnabled}
                onChange={(e) => setAutoswitchEnabled(e.target.checked)}
              />
              <span className="watchlist-option-text">🔄 Auto-Switch Channel</span>
            </label>

            {autoswitchEnabled && (
              <div className="watchlist-option-detail">
                <label>Auto-switch</label>
                <div className="watchlist-reminder-input">
                  <input
                    type="number"
                    min="0"
                    max="300"
                    value={autoswitchSeconds}
                    onChange={(e) => setAutoswitchSeconds(Math.max(0, Math.min(300, parseInt(e.target.value) || 0)))}
                  />
                  <span>seconds before program starts</span>
                </div>
                {autoswitchSeconds === 0 ? (
                  <span className="watchlist-hint">(at program start time)</span>
                ) : (
                  <span className="watchlist-hint">
                    Will switch to {channel.name} {autoswitchSeconds} seconds early
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="watchlist-modal-footer">
          <button className="watchlist-btn secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="watchlist-btn primary" onClick={handleConfirm}>
            {isEditMode ? 'Save Changes' : 'Add to Watchlist'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
