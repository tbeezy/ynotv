import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './TVCalendarTab.css';
import { db, addTvEpisodeToWatchlist, type AutoAddEpisode } from '../../db';

export function TVCalendarTab() {
  const [tvCalendarEnabled, setTvCalendarEnabled] = useState(true);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    if (!window.storage) return;
    const result = await window.storage.getSettings();
    if (result.data) {
      setTvCalendarEnabled(result.data.tvCalendarEnabled ?? true);
      setAutoSyncEnabled(result.data.tvCalendarAutoSync ?? true);
    }
  }

  async function handleToggleEnabled(value: boolean) {
    setTvCalendarEnabled(value);
    if (window.storage) {
      await window.storage.updateSettings({ tvCalendarEnabled: value });
    }
  }

  async function handleToggleAutoSync(value: boolean) {
    setAutoSyncEnabled(value);
    if (window.storage) {
      await window.storage.updateSettings({ tvCalendarAutoSync: value });
    }
  }

  async function handleManualSync() {
    setLoading(true);
    setSyncStatus('Syncing...');
    try {
      const result = await invoke<{
        synced_count: number;
        watchlist_added_count: number;
        episodes_to_add: AutoAddEpisode[];
      }>('sync_tvmaze_shows');

      // Add auto-added episodes to watchlist
      let addedCount = 0;
      if (result.episodes_to_add && result.episodes_to_add.length > 0) {
        for (const ep of result.episodes_to_add) {
          if (ep.channel_id) {
            const channel = await db.channels.get(ep.channel_id);
            if (channel) {
              const added = await addTvEpisodeToWatchlist(ep, channel);
              if (added) addedCount++;
            }
          }
        }
      }

      setSyncStatus(`Synced ${result.synced_count} shows${addedCount > 0 ? `, added ${addedCount} episodes to watchlist` : ''}`);
    } catch (e: any) {
      setSyncStatus(`Sync failed: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>TV Calendar</h3>
        </div>
        <p className="section-description">
          Track your favorite TV shows and view upcoming episodes on a calendar.
        </p>

        <div className="settings-option">
          <div className="option-label">
            <span>Enable TV Calendar</span>
            <small>Show the TV Calendar in the sidebar navigation</small>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={tvCalendarEnabled}
              onChange={(e) => handleToggleEnabled(e.target.checked)}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="settings-option">
          <div className="option-label">
            <span>Auto-sync episodes</span>
            <small>Automatically refresh episode data every 24 hours for running shows</small>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={autoSyncEnabled}
              onChange={(e) => handleToggleAutoSync(e.target.checked)}
              disabled={!tvCalendarEnabled}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="settings-option sync-option">
          <div className="option-label">
            <span>Manual Sync</span>
            <small>Force refresh all tracked shows now</small>
          </div>
          <button
            className="sync-btn"
            onClick={handleManualSync}
            disabled={loading || !tvCalendarEnabled}
          >
            {loading ? 'Syncing...' : '🔄 Sync Now'}
          </button>
        </div>

        {syncStatus && (
          <div className={`sync-status ${syncStatus.includes('failed') ? 'error' : 'success'}`}>
            {syncStatus}
          </div>
        )}

        <div className="tv-calendar-info">
          <h4>How it works</h4>
          <ul>
            <li>Right-click any program in the EPG and select &quot;Track Show&quot;</li>
            <li>Search for the show and select the correct one from TVMaze</li>
            <li>The show and all its episodes will be saved locally</li>
            <li>View upcoming episodes in the TV Calendar</li>
            <li>Click an episode to switch to that channel</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
