import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './PlaybackTab.css';

const CACHE_PRESETS = [
  { label: '256 MB', bytes: 268_435_456 },
  { label: '512 MB', bytes: 536_870_912 },
  { label: '1 GB', bytes: 1_073_741_824 },
  { label: '2 GB', bytes: 2_147_483_648 },
  { label: '4 GB', bytes: 4_294_967_296 },
];

function estimateMinutes(bytes: number, mbps: number): number {
  return Math.round((bytes * 8) / (mbps * 1_000_000) / 60);
}

interface CacheTabProps {
  timeshiftEnabled: boolean;
  timeshiftCacheBytes: number;
  liveBufferOffset?: number;
  onTimeshiftChange: (enabled: boolean, cacheBytes: number, bufferOffset?: number) => void;
}

export function CacheTab({ timeshiftEnabled, timeshiftCacheBytes, liveBufferOffset = 0, onTimeshiftChange }: CacheTabProps) {
  const [debugInfo, setDebugInfo] = useState<string | null>(null);

  const handleTimeshiftToggle = (enabled: boolean) => {
    onTimeshiftChange(enabled, timeshiftCacheBytes, liveBufferOffset);
  };

  const handlePreset = (bytes: number) => {
    onTimeshiftChange(timeshiftEnabled, bytes, liveBufferOffset);
  };

  const handleBufferOffsetChange = (offset: number) => {
    onTimeshiftChange(timeshiftEnabled, timeshiftCacheBytes, offset);
  };

  const checkMpvCache = async () => {
    try {
      const result = await invoke('mpv_get_cache_debug') as Record<string, unknown>;
      setDebugInfo(JSON.stringify(result, null, 2));
    } catch (e) {
      setDebugInfo(`Error: ${e}`);
    }
  };

  return (
    <div className="settings-tab-content playback-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>Cache Time Shift</h3>
        </div>
        <p className="section-description">
          When enabled, MPV keeps a rolling in-memory buffer of the live stream so you can rewind and fast-forward within the cached window.
        </p>

        <div className="timeshift-settings">
          {/* Enable toggle */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">Enable Time Shift</span>
              <span className="timeshift-toggle-sub">Allows rewinding live TV up to the cache window. Takes effect on next channel load.</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={timeshiftEnabled}
                onChange={(e) => handleTimeshiftToggle(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {timeshiftEnabled && (
            <>
              <div className="timeshift-presets-label">Cache Size</div>
              <div className="timeshift-presets">
                {CACHE_PRESETS.map((preset) => (
                  <button
                    key={preset.bytes}
                    className={`timeshift-preset-btn ${timeshiftCacheBytes === preset.bytes ? 'active' : ''}`}
                    onClick={() => handlePreset(preset.bytes)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <table className="timeshift-estimate-table">
                <thead>
                  <tr>
                    <th>Stream Quality</th>
                    <th>Estimated Rewind Window</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>SD (~4 Mbps)</td>
                    <td>~{estimateMinutes(timeshiftCacheBytes, 4)} min</td>
                  </tr>
                  <tr>
                    <td>HD (~8 Mbps)</td>
                    <td>~{estimateMinutes(timeshiftCacheBytes, 8)} min</td>
                  </tr>
                  <tr>
                    <td>4K (~20 Mbps)</td>
                    <td>~{estimateMinutes(timeshiftCacheBytes, 20)} min</td>
                  </tr>
                </tbody>
              </table>

              <div className="timeshift-buffer-offset" style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                <div className="timeshift-presets-label">Live Now Buffer Offset</div>
                <p className="section-description" style={{ marginTop: '4px', fontSize: '0.8125rem' }}>
                  When pressing "Go Live" during time shift, seek to this many seconds behind the live edge. Helps prevent buffer stalls on some networks.
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' }}>
                  <input
                    type="range"
                    min="0"
                    max="30"
                    step="1"
                    value={liveBufferOffset}
                    onChange={(e) => handleBufferOffsetChange(parseInt(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ minWidth: '60px', textAlign: 'right', fontSize: '0.875rem' }}>
                    {liveBufferOffset}s
                  </span>
                </div>
              </div>

              <p className="timeshift-note">
                ⚠️ Changes take effect on next restart. Buffer lives only in RAM and is reset on channel change.
              </p>

              {/* Debug section */}
              <div style={{ marginTop: '20px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '16px' }}>
                <button
                  className="sync-btn"
                  onClick={checkMpvCache}
                  style={{ maxWidth: '200px' }}
                >
                  Check MPV Cache Settings
                </button>
                {debugInfo && (
                  <pre style={{
                    marginTop: '12px',
                    padding: '12px',
                    background: 'rgba(0,0,0,0.3)',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    overflow: 'auto',
                    maxHeight: '300px',
                    color: 'rgba(255,255,255,0.8)'
                  }}>
                    {debugInfo}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
