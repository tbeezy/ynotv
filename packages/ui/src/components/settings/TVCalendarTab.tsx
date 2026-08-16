import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './TVCalendarTab.css';
import { db, addTvEpisodeToWatchlist, clearAutoAddedEpisodesForShow, type AutoAddEpisode } from '../../db';
import { useSettingsStore } from '../../stores/settingsStore';

export function TVCalendarTab() {
  useTranslation();
  const autoSyncEnabled = useSettingsStore((s) => s.tvCalendarAutoSync);
  const setTvCalendarAutoSync = useSettingsStore((s) => s.setTvCalendarAutoSync);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [loading, setLoading] = useState(false);

  function handleToggleAutoSync(value: boolean) {
    setTvCalendarAutoSync(value);
  }

  async function handleManualSync() {
    setLoading(true);
    setSyncStatus(i18n.t('common:syncing'));
    try {
      const result = await invoke<{
        synced_count: number;
        watchlist_added_count: number;
        episodes_to_add: AutoAddEpisode[];
      }>('sync_tvmaze_shows');

      // Add auto-added episodes to watchlist
      let addedCount = 0;
      if (result.episodes_to_add && result.episodes_to_add.length > 0) {
        // Group episodes by show to clear each show's old entries before adding new ones
        const episodesByShow = new Map<number, AutoAddEpisode[]>();
        for (const ep of result.episodes_to_add) {
          const existing = episodesByShow.get(ep.tvmaze_id) || [];
          existing.push(ep);
          episodesByShow.set(ep.tvmaze_id, existing);
        }

        // Batch resolve channels to avoid N+1 lookups
        const allChannelIds = [...new Set([...episodesByShow.values()].flat().filter(ep => ep.channel_id).map(ep => ep.channel_id!))];
        const channelMap = new Map<string, import('../../db').StoredChannel>();
        if (allChannelIds.length > 0) {
          const CHUNK_SIZE = 500;
          for (let i = 0; i < allChannelIds.length; i += CHUNK_SIZE) {
            const chunk = allChannelIds.slice(i, i + CHUNK_SIZE);
            const channels = await db.channels.where('stream_id').anyOf(chunk).toArray();
            for (const ch of channels) channelMap.set(ch.stream_id, ch);
          }
        }
        for (const [tvmazeId, episodes] of episodesByShow) {
          // Clear existing auto-added episodes for this show
          await clearAutoAddedEpisodesForShow(tvmazeId);

          // Add new episodes
          for (const ep of episodes) {
            if (ep.channel_id) {
              const channel = channelMap.get(ep.channel_id);
              if (channel) {
                const added = await addTvEpisodeToWatchlist(ep, channel);
                if (added) addedCount++;
              }
            }
          }
        }
      }

      setSyncStatus(`${i18n.t('settings:tvcalendar.syncedShows', { count: result.synced_count })}${addedCount > 0 ? i18n.t('settings:tvcalendar.addedEpisodes', { count: addedCount }) : ''}`);
    } catch (e: any) {
      setSyncStatus(i18n.t('settings:tvcalendar.syncFailed', { error: e }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:tvcalendar.title')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:tvcalendar.titleSub')}
        </p>

        <div className="tvcal-settings-option">
          <div className="tvcal-option-label">
            <span>{i18n.t('settings:tvcalendar.autoSync')}</span>
            <small>{i18n.t('settings:tvcalendar.autoSyncSub')}</small>
          </div>
          <label className="tvcal-toggle-switch">
            <input
              type="checkbox"
              checked={autoSyncEnabled}
              onChange={(e) => handleToggleAutoSync(e.target.checked)}
            />
            <span className="tvcal-toggle-slider"></span>
          </label>
        </div>

        <div className="tvcal-settings-option sync-option">
          <div className="tvcal-option-label">
            <span>{i18n.t('settings:tvcalendar.manualSync')}</span>
            <small>{i18n.t('settings:tvcalendar.manualSyncSub')}</small>
          </div>
          <button
            className="tvcal-sync-btn"
            onClick={handleManualSync}
            disabled={loading}
          >
            {loading ? i18n.t('common:syncing') : i18n.t('settings:tvcalendar.syncNow')}
          </button>
        </div>

        {syncStatus && (
          <div className={`tvcal-sync-status ${syncStatus.includes('failed') ? 'error' : 'success'}`}>
            {syncStatus}
          </div>
        )}
      </div>
    </div>
  );
}
