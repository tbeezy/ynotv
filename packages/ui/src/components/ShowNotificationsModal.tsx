import { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { addToWatchlist, db, type WatchlistOptions, type StoredChannel } from '../db';
import './ShowNotificationsModal.css';

interface Episode {
  id: number;
  name?: string;
  season?: number;
  number?: number;
  airdate?: string;
  airtime?: string;
  airstamp?: string;
  runtime?: number;
  summary?: string;
}

interface ShowNotificationsModalProps {
  isOpen: boolean;
  showName: string;
  channelName: string | null;
  episodes: Episode[];
  onConfirm: (addedCount: number, reminderEnabled: boolean, reminderMinutes: number, autoswitchEnabled: boolean, autoswitchSeconds: number) => void;
  onCancel: () => void;
  /** If true, modal only collects settings and returns them without adding to watchlist. Caller is responsible for adding. */
  configureOnly?: boolean;
}

export function ShowNotificationsModal({
  isOpen,
  showName,
  channelName,
  episodes,
  onConfirm,
  onCancel,
  configureOnly = false,
}: ShowNotificationsModalProps) {
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderMinutes, setReminderMinutes] = useState(5);
  const [autoswitchEnabled, setAutoswitchEnabled] = useState(false);
  const [autoswitchSeconds, setAutoswitchSeconds] = useState(30);
  const [isAdding, setIsAdding] = useState(false);
  const [channel, setChannel] = useState<StoredChannel | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);

  // Filter only future episodes
  const futureEpisodes = useCallback(() => {
    const now = new Date();
    return episodes.filter(ep => {
      if (!ep.airdate) return false;
      const epDate = new Date(ep.airdate);
      return epDate >= now;
    });
  }, [episodes]);

  // Lookup channel when modal opens
  useEffect(() => {
    if (isOpen && channelName) {
      lookupChannel();
    }
  }, [isOpen, channelName]);

  async function lookupChannel() {
    try {
      setChannelError(null);
      // Get all channels and find by name
      const allChannels = await db.channels.toArray();
      const matchedChannel = allChannels.find(c =>
        c.name.toLowerCase() === channelName?.toLowerCase()
      );
      if (matchedChannel) {
        setChannel(matchedChannel);
      } else {
        setChannelError(`Channel "${channelName}" not found. Please set a valid channel first.`);
      }
    } catch (error) {
      console.error('[ShowNotificationsModal] Failed to lookup channel:', error);
      setChannelError('Failed to lookup channel');
    }
  }

  const handleConfirm = useCallback(async () => {
    if (!channel) {
      setChannelError('No channel set for this show');
      return;
    }

    const upcomingEpisodes = futureEpisodes();

    // If configureOnly mode, just return settings without adding
    if (configureOnly) {
      onConfirm(upcomingEpisodes.length, reminderEnabled, reminderMinutes, autoswitchEnabled, autoswitchSeconds);
      return;
    }

    const options: WatchlistOptions = {
      reminder_enabled: reminderEnabled,
      reminder_minutes: reminderMinutes,
      autoswitch_enabled: autoswitchEnabled,
      autoswitch_seconds_before: autoswitchSeconds,
    };

    setIsAdding(true);
    let addedCount = 0;
    let skippedCount = 0;

    try {
      for (const episode of upcomingEpisodes) {
        // Create a synthetic program object for the watchlist
        const startTime = episode.airstamp
          ? new Date(episode.airstamp).getTime()
          : episode.airdate
            ? new Date(episode.airdate).getTime()
            : Date.now();

        const endTime = startTime + (episode.runtime || 60) * 60 * 1000;

        // Create synthetic program ID
        const programId = `myshows_${showName}_${episode.id}_${episode.airdate || 'unknown'}`;

        // Construct title with NEW indicator and show name
        const episodeTitle = episode.name || `Episode ${episode.number}`;
        const fullTitle = `*NEW* ${showName} - ${episodeTitle} (From My Shows)`;

        // Construct description
        let description = episode.summary || '';
        if (episode.season && episode.number) {
          description = `S${episode.season}E${episode.number}${description ? ' - ' + description : ''}`;
        }

        const syntheticProgram = {
          id: programId,
          stream_id: channel.stream_id,
          title: fullTitle,
          description: description,
          start: new Date(startTime),
          end: new Date(endTime),
          source_id: channel.source_id,
        };

        const added = await addToWatchlist(syntheticProgram, channel, options);
        if (added) {
          addedCount++;
        } else {
          skippedCount++;
        }
      }

      onConfirm(addedCount, reminderEnabled, reminderMinutes, autoswitchEnabled, autoswitchSeconds);
    } catch (error) {
      console.error('[ShowNotificationsModal] Failed to add episodes:', error);
    } finally {
      setIsAdding(false);
    }
  }, [channel, reminderEnabled, reminderMinutes, autoswitchEnabled, autoswitchSeconds, episodes, showName, futureEpisodes, onConfirm, configureOnly]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isAdding) {
        onCancel();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, isAdding, onCancel]);

  if (!isOpen) return null;

  const upcomingCount = futureEpisodes().length;

  return createPortal(
    <div className="show-notifications-overlay" onClick={isAdding ? undefined : onCancel}>
      <div className="show-notifications-modal" onClick={(e) => e.stopPropagation()}>
        <div className="show-notifications-header">
          <h3>{configureOnly ? '⚙️ Auto-Add Settings' : '🔔 Notifications'}</h3>
          <button className="show-notifications-close" onClick={isAdding ? undefined : onCancel} disabled={isAdding}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="show-notifications-body">
          {/* Show Info */}
          <div className="show-notifications-info">
            <div className="show-notifications-show-name">{showName}</div>
            <div className="show-notifications-channel">
              {channelName ? `Channel: ${channelName}` : 'No channel set'}
            </div>
            <div className="show-notifications-count">
              {configureOnly
                ? `${upcomingCount} upcoming episode${upcomingCount !== 1 ? 's' : ''} will be auto-added with these settings`
                : `${upcomingCount} upcoming episode${upcomingCount !== 1 ? 's' : ''} will be added to your watchlist`}
            </div>
            {channelError && (
              <div className="show-notifications-error">{channelError}</div>
            )}
          </div>

          {/* Episodes Preview */}
          {upcomingCount > 0 && (
            <div className="show-notifications-preview">
              <h4>Upcoming Episodes:</h4>
              <div className="show-notifications-episodes-list">
                {futureEpisodes().slice(0, 5).map((ep, idx) => (
                  <div key={ep.id} className="show-notifications-episode-item">
                    <span className="show-notifications-episode-new">*NEW*</span>
                    <span className="show-notifications-episode-title">
                      {ep.name || `Episode ${ep.number}`}
                      {ep.season && ep.number && (
                        <span className="show-notifications-episode-se">S{ep.season}E{ep.number}</span>
                      )}
                    </span>
                    <span className="show-notifications-episode-date">
                      {ep.airdate ? new Date(ep.airdate).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric'
                      }) : 'TBA'}
                    </span>
                  </div>
                ))}
                {upcomingCount > 5 && (
                  <div className="show-notifications-episode-more">
                    +{upcomingCount - 5} more episodes
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Options */}
          {upcomingCount > 0 && channel && (
            <>
              {/* Reminder Section */}
              <div className="show-notifications-option-section">
                <label className="show-notifications-option-label">
                  <input
                    type="checkbox"
                    checked={reminderEnabled}
                    onChange={(e) => setReminderEnabled(e.target.checked)}
                    disabled={isAdding}
                  />
                  <span className="show-notifications-option-text">🔔 Set Reminder</span>
                </label>

                {reminderEnabled && (
                  <div className="show-notifications-option-detail">
                    <label>Remind me</label>
                    <div className="show-notifications-reminder-input">
                      <input
                        type="number"
                        min="0"
                        max="120"
                        value={reminderMinutes}
                        onChange={(e) => setReminderMinutes(Math.max(0, Math.min(120, parseInt(e.target.value) || 0)))}
                        disabled={isAdding}
                      />
                      <span>minutes before start</span>
                    </div>
                    {reminderMinutes === 0 && (
                      <span className="show-notifications-hint">(at program start time)</span>
                    )}
                  </div>
                )}
              </div>

              {/* AutoSwitch Section */}
              <div className="show-notifications-option-section">
                <label className="show-notifications-option-label">
                  <input
                    type="checkbox"
                    checked={autoswitchEnabled}
                    onChange={(e) => setAutoswitchEnabled(e.target.checked)}
                    disabled={isAdding}
                  />
                  <span className="show-notifications-option-text">🔄 Auto-Switch Channel</span>
                </label>

                {autoswitchEnabled && (
                  <div className="show-notifications-option-detail">
                    <label>Auto-switch</label>
                    <div className="show-notifications-reminder-input">
                      <input
                        type="number"
                        min="0"
                        max="300"
                        value={autoswitchSeconds}
                        onChange={(e) => setAutoswitchSeconds(Math.max(0, Math.min(300, parseInt(e.target.value) || 0)))}
                        disabled={isAdding}
                      />
                      <span>seconds before program starts</span>
                    </div>
                    {autoswitchSeconds === 0 ? (
                      <span className="show-notifications-hint">(at program start time)</span>
                    ) : (
                      <span className="show-notifications-hint">
                        Will switch to {channelName} {autoswitchSeconds} seconds early
                      </span>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {upcomingCount === 0 && (
            <div className="show-notifications-no-episodes">
              No upcoming episodes found for this show.
            </div>
          )}
        </div>

        <div className="show-notifications-footer">
          <button
            className="show-notifications-btn secondary"
            onClick={onCancel}
            disabled={isAdding}
          >
            Cancel
          </button>
          <button
            className="show-notifications-btn primary"
            onClick={handleConfirm}
            disabled={isAdding || upcomingCount === 0 || !channel}
          >
            {isAdding ? (
              <>
                <span className="show-notifications-spinner" />
                Adding...
              </>
            ) : configureOnly ? (
              `Enable Auto-Add for ${upcomingCount} Episode${upcomingCount !== 1 ? 's' : ''}`
            ) : (
              `Add ${upcomingCount} Episode${upcomingCount !== 1 ? 's' : ''} to Watchlist`
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
