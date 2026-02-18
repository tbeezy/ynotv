import { useState } from 'react';
import { clearAllCachedData } from '../../db';
import { syncAllSources } from '../../db/sync';
import { useCacheClearing, useSetCacheClearing, useSetChannelSyncing, useSetSyncStatusMessage } from '../../stores/uiStore';

interface DataRefreshTabProps {
  vodRefreshHours: number;
  epgRefreshHours: number;
  onVodRefreshChange: (hours: number) => void;
  onEpgRefreshChange: (hours: number) => void;
}

export function DataRefreshTab({
  vodRefreshHours,
  epgRefreshHours,
  onVodRefreshChange,
  onEpgRefreshChange,
}: DataRefreshTabProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const isClearing = useCacheClearing();
  const setCacheClearing = useSetCacheClearing();
  const setChannelSyncing = useSetChannelSyncing();
  const setSyncStatusMessage = useSetSyncStatusMessage();

  async function saveRefreshSettings(vod: number, epg: number) {
    if (!window.storage) return;
    await window.storage.updateSettings({ vodRefreshHours: vod, epgRefreshHours: epg });
  }

  async function handleClearCache() {
    setCacheClearing(true);
    setShowConfirm(false);
    try {
      await clearAllCachedData();
      // Trigger fresh sync (no page reload needed)
      setCacheClearing(false);
      setChannelSyncing(true);
      setSyncStatusMessage('Re-syncing sources...');
      await syncAllSources(setSyncStatusMessage);
      setSyncStatusMessage(null);
      setChannelSyncing(false);
    } catch (error) {
      console.error('[Settings] Failed to clear cache:', error);
      setCacheClearing(false);
      setChannelSyncing(false);
      setSyncStatusMessage(null);
    }
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>Data Refresh</h3>
        </div>
        <p className="section-description">
          Configure how often data is automatically refreshed on app startup.
          Set to "Manual only" to disable automatic refresh.
        </p>

        <div className="refresh-settings">
          <div className="form-group inline">
            <label>VOD (Movies & Series)</label>
            <select
              value={vodRefreshHours}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                onVodRefreshChange(val);
                saveRefreshSettings(val, epgRefreshHours);
              }}
            >
              <option value={0}>Manual only</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Every 24 hours</option>
              <option value={48}>Every 2 days</option>
              <option value={168}>Every week</option>
            </select>
          </div>

          <div className="form-group inline">
            <label>EPG (TV Guide)</label>
            <select
              value={epgRefreshHours}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                onEpgRefreshChange(val);
                saveRefreshSettings(vodRefreshHours, val);
              }}
            >
              <option value={0}>Manual only</option>
              <option value={3}>Every 3 hours</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Every 24 hours</option>
            </select>
          </div>
        </div>
      </div>

      <div className="settings-section" style={{ marginTop: '1.5rem' }}>
        <div className="section-header">
          <h3>Clear Cache</h3>
        </div>
        <p className="section-description">
          Clear all cached channel, EPG, and VOD data, then compact the database to reclaim disk space.
          Use this if you're experiencing issues like duplicate entries, stale EPG, or data not updating properly.
          Your sources and settings will be preserved.
        </p>

        <div style={{ marginTop: '0.75rem' }}>
          {isClearing ? (
            <button className="sync-btn danger" disabled>
              Clearing...
            </button>
          ) : !showConfirm ? (
            <button
              className="sync-btn danger"
              onClick={() => setShowConfirm(true)}
            >
              Clear All Cached Data
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ color: '#ff9900', fontSize: '0.85rem' }}>
                Delete all cached data?
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="sync-btn danger"
                  onClick={handleClearCache}
                  disabled={isClearing}
                >
                  {isClearing ? 'Clearing...' : 'Yes, Clear'}
                </button>
                <button
                  className="sync-btn"
                  onClick={() => setShowConfirm(false)}
                  disabled={isClearing}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
