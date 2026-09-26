import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import {
  formatBytes,
  getLocalStorageUsage,
  type StorageUsageEntry,
} from '../../services/safeStorage';

interface DebugTabProps {
  debugLoggingEnabled: boolean;
  onDebugLoggingChange: (enabled: boolean) => void;
  logRetentionDays: number;
  onLogRetentionChange: (days: number) => void;
  supportModeEnabled: boolean;
  onSupportModeChange: (enabled: boolean) => void;
}

export function DebugTab({
  debugLoggingEnabled,
  onDebugLoggingChange,
  logRetentionDays,
  onLogRetentionChange,
  supportModeEnabled,
  onSupportModeChange,
}: DebugTabProps) {
  useTranslation();
  const [logPath, setLogPath] = useState<string>('');
  const [storageUsage, setStorageUsage] = useState<{
    entries: StorageUsageEntry[];
    totalBytes: number;
  } | null>(null);

  useEffect(() => {
    // Get log file path on mount
    if (window.debug) {
      window.debug.getLogPath().then((result) => {
        if (result.data) {
          setLogPath(result.data);
        }
      });
    }
  }, []);

  async function handleDebugLoggingChange(enabled: boolean) {
    if (!window.storage) return;
    onDebugLoggingChange(enabled);
    await window.storage.updateSettings({ debugLoggingEnabled: enabled });
    // Update the debug logging state in the bridge
    if (window.debug?.setDebugLoggingEnabled) {
      window.debug.setDebugLoggingEnabled(enabled);
    }
  }

  async function handleSupportModeChange(enabled: boolean) {
    if (!window.storage) return;
    onSupportModeChange(enabled);
    await window.storage.updateSettings({ supportModeEnabled: enabled });
  }

  async function handleOpenLogFolder() {
    if (window.debug) {
      await window.debug.openLogFolder();
    }
  }

  return (
    <div className="settings-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:debug.title')}</h3>
        </div>

        <p className="section-description">
          {i18n.t('settings:debug.description')}
        </p>

        <div className="tmdb-form" style={{ marginTop: '1rem' }}>
          <label className="genre-checkbox" style={{ maxWidth: '320px' }}>
            <input
              type="checkbox"
              checked={debugLoggingEnabled}
              onChange={(e) => handleDebugLoggingChange(e.target.checked)}
            />
            <span className="genre-name">{i18n.t('settings:debug.enableLogging')}</span>
          </label>
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            {i18n.t('settings:debug.enableLoggingHint')}
          </p>
        </div>

        <div className="tmdb-form" style={{ marginTop: '1.5rem' }}>
          <label className="genre-checkbox" style={{ maxWidth: '420px' }}>
            <input
              type="checkbox"
              checked={supportModeEnabled}
              onChange={(e) => handleSupportModeChange(e.target.checked)}
            />
            <span className="genre-name">{i18n.t('settings:debug.supportModeLabel')}</span>
          </label>
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            {i18n.t('settings:debug.supportModeHint')}
          </p>
        </div>

        <div className="tmdb-form" style={{ marginTop: '1.5rem', maxWidth: '320px' }}>
          <label className="settings-label" style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
            {i18n.t('settings:debug.retentionLabel')}
          </label>
          <select
            value={logRetentionDays}
            onChange={(e) => onLogRetentionChange(parseInt(e.target.value, 10))}
            style={{
              width: '100%',
              padding: '0.5rem',
              backgroundColor: 'var(--bg-tertiary)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '0.85rem'
            }}
          >
            <option value={1}>{i18n.t('settings:debug.retentionOptions.1day')}</option>
            <option value={3}>{i18n.t('settings:debug.retentionOptions.3days')}</option>
            <option value={5}>{i18n.t('settings:debug.retentionOptions.5days')}</option>
            <option value={7}>{i18n.t('settings:debug.retentionOptions.7days')}</option>
            <option value={0}>{i18n.t('settings:debug.retentionOptions.indefinite')}</option>
          </select>
          <p className="form-hint" style={{ marginTop: '0.5rem' }}>
            {i18n.t('settings:debug.retentionHint')}
          </p>
        </div>

        {logPath && (
          <div style={{ marginTop: '1.5rem' }}>
            <h4 style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              {i18n.t('settings:debug.logFileLocation')}
            </h4>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              backgroundColor: 'var(--bg-tertiary)',
              padding: '0.75rem 1rem',
              borderRadius: '6px',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              wordBreak: 'break-all'
            }}>
              <span style={{ flex: 1 }}>{logPath}</span>
              <button
                onClick={handleOpenLogFolder}
                className="sync-button"
                style={{
                  padding: '0.4rem 0.75rem',
                  fontSize: '0.8rem',
                  whiteSpace: 'nowrap'
                }}
              >
                {i18n.t('settings:debug.openFolder')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="settings-section" style={{ marginTop: '1.5rem' }}>
        <div className="section-header">
          <h3>LocalStorage Usage</h3>
        </div>
        <p className="section-description">
          Reports how much browser storage each key consumes. Useful when the app crashes with a
          storage-quota error (the error screen shows the same breakdown) or when local state
          seems to be growing out of control.
        </p>
        <button
          className="sync-btn"
          onClick={() => {
            try {
              setStorageUsage(getLocalStorageUsage());
            } catch (e) {
              console.error('[DebugTab] Failed to measure localStorage:', e);
            }
          }}
          style={{ maxWidth: '220px', borderColor: 'var(--surface-border)' }}
        >
          Report localStorage usage
        </button>
        {storageUsage && (
          <div
            style={{
              marginTop: '12px',
              maxWidth: '520px',
              maxHeight: '280px',
              overflow: 'auto',
              backgroundColor: 'var(--bg-tertiary)',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              padding: '10px 12px',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              lineHeight: 1.7,
              color: 'var(--text-secondary)',
            }}
          >
            <div style={{ color: 'var(--text-primary)', marginBottom: '6px' }}>
              Total: <b>{formatBytes(storageUsage.totalBytes)}</b> across{' '}
              {storageUsage.entries.length} key(s)
            </div>
            {storageUsage.entries.map((entry) => (
              <div
                key={entry.key}
                style={{
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={entry.key}
              >
                <span style={{ color: '#00d4ff', marginRight: '8px' }}>
                  {formatBytes(entry.bytes)}
                </span>
                {entry.key}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="settings-disclaimer">
        {i18n.t('settings:debug.disclaimer')}
      </p>
    </div>
  );
}
