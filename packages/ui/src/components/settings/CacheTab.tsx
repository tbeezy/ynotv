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
  onTimeshiftChange: (enabled: boolean, cacheBytes: number) => void;
}

export function CacheTab({ timeshiftEnabled, timeshiftCacheBytes, onTimeshiftChange }: CacheTabProps) {
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
