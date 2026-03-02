import { useState, useEffect } from 'react';
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

interface PlaybackTabProps {
  mpvParams: string;
  onMpvParamsChange: (params: string) => void;
  timeshiftEnabled: boolean;
  timeshiftCacheBytes: number;
  onTimeshiftChange: (enabled: boolean, cacheBytes: number) => void;
}

const DEFAULT_MPV_PARAMS = `--hwdec=auto
--vo=gpu
--cache=yes
--demuxer-max-bytes=50MiB
--network-timeout=10
--video-sync=display-resample
--audio-stream-silence=yes
--stream-lavf-o=reconnect=1
--stream-lavf-o=reconnect_streamed=1
--stream-lavf-o=reconnect_delay_max=5`;

export function PlaybackTab({ mpvParams, onMpvParamsChange, timeshiftEnabled, timeshiftCacheBytes, onTimeshiftChange }: PlaybackTabProps) {
  const [localParams, setLocalParams] = useState(mpvParams);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setLocalParams(mpvParams);
  }, [mpvParams]);

  const handleChange = (value: string) => {
    setLocalParams(value);
    setHasChanges(value !== mpvParams);
  };

  const handleSave = () => {
    onMpvParamsChange(localParams.trim());
    setHasChanges(false);
  };

  const handleReset = () => {
    if (confirm('Reset to recommended default parameters?')) {
      setLocalParams(DEFAULT_MPV_PARAMS);
      onMpvParamsChange(DEFAULT_MPV_PARAMS);
      setHasChanges(false);
    }
  };

  const handleClear = () => {
    if (confirm('Clear all custom parameters?')) {
      setLocalParams('');
      onMpvParamsChange('');
      setHasChanges(false);
    }
  };

  const handleTimeshiftToggle = (enabled: boolean) => {
    onTimeshiftChange(enabled, timeshiftCacheBytes);
  };

  const handlePreset = (bytes: number) => {
    onTimeshiftChange(timeshiftEnabled, bytes);
  };

  return (
    <div className="settings-tab-content playback-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>Playback Settings</h3>
        </div>
        <p className="section-description">
          Configure MPV player parameters for stream playback. Changes take effect on next channel load.
        </p>

        <div className="playback-section">
          <div className="playback-label">
            <span>MPV Parameters</span>
            <small>
              One parameter per line. These flags are passed to MPV on startup.
              <br />
              Example: --hwdec=auto --cache=yes --network-timeout=10
            </small>
          </div>

          <textarea
            className="mpv-params-input"
            value={localParams}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="--hwdec=auto&#10;--cache=yes&#10;--network-timeout=10"
            rows={12}
            spellCheck={false}
          />

          <div className="playback-help">
            <h4>Common Parameters</h4>
            <div className="help-grid">
              <div className="help-item">
                <code>--hwdec=auto</code>
                <span>Enable hardware decoding</span>
              </div>
              <div className="help-item">
                <code>--cache=yes</code>
                <span>Enable stream caching</span>
              </div>
              <div className="help-item">
                <code>--network-timeout=10</code>
                <span>Network timeout in seconds</span>
              </div>
              <div className="help-item">
                <code>--video-sync=display-resample</code>
                <span>Smooth video playback</span>
              </div>
              <div className="help-item">
                <code>--demuxer-max-bytes=50MiB</code>
                <span>Maximum cache size</span>
              </div>
              <div className="help-item">
                <code>--stream-lavf-o=reconnect=1</code>
                <span>Auto-reconnect on disconnect</span>
              </div>
            </div>
          </div>

          <div className="playback-actions">
            <button
              className="save-btn"
              onClick={handleSave}
              disabled={!hasChanges}
            >
              {hasChanges ? 'Save Changes' : 'Saved'}
            </button>
            <button className="reset-btn" onClick={handleReset}>
              Reset to Defaults
            </button>
            <button className="clear-btn" onClick={handleClear}>
              Clear All
            </button>
          </div>
        </div>
      </div>

      {/* TimeShift / Cache Section */}
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

              <p className="timeshift-note">
                ⚠️ Changes take effect the next time a channel is opened. Buffer lives only in RAM and is reset on channel change.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
