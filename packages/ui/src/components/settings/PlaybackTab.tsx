import { useState, useEffect } from 'react';
import './PlaybackTab.css';

interface PlaybackTabProps {
  mpvParams: string;
  onMpvParamsChange: (params: string) => void;
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

export function PlaybackTab({ mpvParams, onMpvParamsChange }: PlaybackTabProps) {
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
    </div>
  );
}
