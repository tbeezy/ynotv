import { useState } from 'react';
import { clearAllCachedData } from '../../db';
import { syncAllSources, clearEpgCacheOnly } from '../../db/sync';
import { useCacheClearing, useSetCacheClearing, useSetChannelSyncing, useSetSyncStatusMessage } from '../../stores/uiStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

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
  useTranslation();
  const [showConfirm, setShowConfirm] = useState(false);
  const [showEpgConfirm, setShowEpgConfirm] = useState(false);
  const [isClearingEpg, setIsClearingEpg] = useState(false);
  const [epgCleared, setEpgCleared] = useState(false);
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

  async function handleClearEpgCache() {
    setIsClearingEpg(true);
    setShowEpgConfirm(false);
    setEpgCleared(false);
    try {
      await clearEpgCacheOnly();
      setEpgCleared(true);
    } catch (error) {
      console.error('[Settings] Failed to clear EPG cache:', error);
    } finally {
      setIsClearingEpg(false);
    }
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:dataRefresh.title')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:dataRefresh.titleSub')}
        </p>

        <div className="refresh-settings">
          <div className="form-group inline">
            <label>{i18n.t('settings:dataRefresh.vodLabel')}</label>
            <select
              value={vodRefreshHours}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                onVodRefreshChange(val);
                saveRefreshSettings(val, epgRefreshHours);
              }}
            >
              <option value={0}>{i18n.t('settings:dataRefresh.manualOnly')}</option>
              <option value={1}>{i18n.t('settings:dataRefresh.every1h')}</option>
              <option value={6}>{i18n.t('settings:dataRefresh.every6h')}</option>
              <option value={12}>{i18n.t('settings:dataRefresh.every12h')}</option>
              <option value={24}>{i18n.t('settings:dataRefresh.every24h')}</option>
              <option value={48}>{i18n.t('settings:dataRefresh.every2d')}</option>
              <option value={168}>{i18n.t('settings:dataRefresh.everyWeek')}</option>
            </select>
          </div>

          <div className="form-group inline">
            <label>{i18n.t('settings:dataRefresh.epgLabel')}</label>
            <select
              value={epgRefreshHours}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                onEpgRefreshChange(val);
                saveRefreshSettings(vodRefreshHours, val);
              }}
            >
              <option value={0}>{i18n.t('settings:dataRefresh.manualOnly')}</option>
              <option value={0.0833333333}>{i18n.t('settings:dataRefresh.every5m')}</option>
              <option value={0.5}>{i18n.t('settings:dataRefresh.every30m')}</option>
              <option value={1}>{i18n.t('settings:dataRefresh.every1h')}</option>
              <option value={3}>{i18n.t('settings:dataRefresh.every3h')}</option>
              <option value={6}>{i18n.t('settings:dataRefresh.every6h')}</option>
              <option value={12}>{i18n.t('settings:dataRefresh.every12h')}</option>
              <option value={24}>{i18n.t('settings:dataRefresh.every24h')}</option>
            </select>
          </div>

          <div className="form-group inline" style={{ alignItems: 'flex-start', gap: '0.5rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', flex: 1 }}>
              <label style={{ marginBottom: 0 }}>{i18n.t('settings:dataRefresh.simSyncs')}</label>
              <span style={{ fontSize: '0.75rem', opacity: 0.6, lineHeight: 1.3 }}>
                {i18n.t('settings:dataRefresh.simSyncsHintPre')}<strong>{i18n.t('settings:dataRefresh.simSyncsHintStrong')}</strong>{i18n.t('settings:dataRefresh.simSyncsHintPost')}
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
          <h3>{i18n.t('settings:dataRefresh.clearCache')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:dataRefresh.clearCacheSub')}
        </p>

        <div style={{ marginTop: '0.75rem' }}>
          {isClearing ? (
            <button className="sync-btn danger" disabled>
              {i18n.t('common:clearing')}
            </button>
          ) : !showConfirm ? (
            <button
              className="sync-btn danger"
              onClick={() => setShowConfirm(true)}
            >
              {i18n.t('settings:dataRefresh.clearAllCached')}
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ color: '#ff9900', fontSize: '0.85rem' }}>
                {i18n.t('settings:dataRefresh.deleteCachedConfirm')}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="sync-btn danger"
                  onClick={handleClearCache}
                  disabled={isClearing}
                >
                  {isClearing ? i18n.t('common:clearing') : i18n.t('settings:dataRefresh.yesClear')}
                </button>
                <button
                  className="sync-btn"
                  onClick={() => setShowConfirm(false)}
                  disabled={isClearing}
                >
                  {i18n.t('common:cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="settings-section" style={{ marginTop: '1.5rem' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:dataRefresh.clearEpgCache')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:dataRefresh.clearEpgCacheSub')}
        </p>

        <div style={{ marginTop: '0.75rem' }}>
          {isClearingEpg ? (
            <button className="sync-btn danger" disabled>
              {i18n.t('common:clearing')}
            </button>
          ) : epgCleared ? (
            <span style={{ color: '#4ade80', fontSize: '0.85rem' }}>
              {i18n.t('settings:dataRefresh.epgCacheCleared')}
            </span>
          ) : !showEpgConfirm ? (
            <button
              className="sync-btn"
              onClick={() => setShowEpgConfirm(true)}
            >
              {i18n.t('settings:dataRefresh.clearEpgCache')}
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <span style={{ color: '#ff9900', fontSize: '0.85rem' }}>
                {i18n.t('settings:dataRefresh.clearEpgCacheConfirm')}
              </span>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="sync-btn danger"
                  onClick={handleClearEpgCache}
                  disabled={isClearingEpg}
                >
                  {i18n.t('settings:dataRefresh.yesClear')}
                </button>
                <button
                  className="sync-btn"
                  onClick={() => setShowEpgConfirm(false)}
                  disabled={isClearingEpg}
                >
                  {i18n.t('common:cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
