import { useState } from 'react';
import { clearAllCachedData } from '../../db';
import { syncAllSources } from '../../db/sync';
import { useCacheClearing, useSetCacheClearing, useSetChannelSyncing, useSetSyncStatusMessage } from '../../stores/uiStore';

interface DataRefreshTabProps {
  vodRefreshHours: number;
  epgRefreshHours: number;
  epgSyncConcurrency: number;
  onVodRefreshChange: (hours: number) => void;
  onEpgRefreshChange: (hours: number) => void;
  onEpgSyncConcurrencyChange: (value: number) => void;
}

export function DataRefreshTab({
  vodRefreshHours,
  epgRefreshHours,
  epgSyncConcurrency,
  onVodRefreshChange,
  onEpgRefreshChange,
  onEpgSyncConcurrencyChange,
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
      await syncAllSources(setSyncStatusMessage, epgSyncConcurrency);
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
            <label>VOD (Movies &amp; Series)</label>
            <select
              value={vodRefreshHours}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
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
                const val = parseFloat(e.target.value);
                onEpgRefreshChange(val);
                saveRefreshSettings(vodRefreshHours, val);
              }}
            >
              <option value={0}>Manual only</option>
              <option value={0.0833333333}>Every 5 minutes</option>
              <option value={0.5}>Every 30 minutes</option>
              <option value={3}>Every 3 hours</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Every 24 hours</option>
            </select>
          </div>

          <div className="form-group inline" style={{ alignItems: 'flex-start', gap: '0.5rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1 }}>
              <label style={{ marginBottom: 0 }}>Simultaneous EPG Syncs</label>
              <span style={{ fontSize: '0.75rem', opacity: 0.6, lineHeight: 1.3 }}>
                How many sources to sync in parallel. <strong>0&nbsp;=&nbsp;all at once</strong> (fastest — recommended when each source is a different provider).
              </span>
            </div>
            <input
              id="epg-sync-concurrency"
              type="number"
              min={0}
              max={50}
              step={1}
              value={epgSyncConcurrency}
              onChange={(e) => {
                const val = Math.max(0, parseInt(e.target.value, 10) || 0);
                onEpgSyncConcurrencyChange(val);
                if (window.storage) {
                  window.storage.updateSettings({ epgSyncConcurrency: val });
                }
              }}
              style={{
                width: '70px',
                textAlign: 'center',
                flexShrink: 0,
              }}
            />
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
