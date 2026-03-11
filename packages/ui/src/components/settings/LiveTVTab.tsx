import './PlaybackTab.css'; // Reuse existing tab styles

interface LiveTVTabProps {
  epgDarkenCurrent: boolean;
  onEpgDarkenCurrentChange: (enabled: boolean) => void;
  miniMediaBarForEpgPreview: boolean;
  onMiniMediaBarForEpgPreviewChange: (enabled: boolean) => void;
}

export function LiveTVTab({
  epgDarkenCurrent,
  onEpgDarkenCurrentChange,
  miniMediaBarForEpgPreview,
  onMiniMediaBarForEpgPreviewChange,
}: LiveTVTabProps) {
  return (
    <div className="settings-tab-content playback-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>EPG Display</h3>
        </div>
        <p className="section-description">
          Customize how the Electronic Program Guide (EPG) displays program information.
        </p>

        <div className="timeshift-settings">
          {/* Enable darker current program block */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">Make EPG Current airing program blocks darker</span>
              <span className="timeshift-toggle-sub">When enabled, the currently airing program in the EPG will have a deeper/darker highlight, making it easier to identify on all themes.</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={epgDarkenCurrent}
                onChange={(e) => onEpgDarkenCurrentChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Preview example */}
          <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '0.875rem', color: 'rgba(255,255,255,0.6)' }}>Preview:</h4>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {/* Regular program block */}
              <div style={{
                padding: '8px 12px',
                background: 'rgba(255, 255, 255, 0.04)',
                borderRadius: '4px',
                borderLeft: '2px solid transparent',
                flex: 1,
                fontSize: '0.8rem'
              }}>
                <span style={{ color: 'rgba(255,255,255,0.6)' }}>Other Program</span>
              </div>
              {/* Current program block */}
              <div style={{
                padding: '8px 12px',
                background: epgDarkenCurrent
                  ? 'color-mix(in srgb, var(--accent-primary, #00d4ff) 25%, rgba(0,0,0,0.3))'
                  : 'color-mix(in srgb, var(--accent-primary, #00d4ff) 8%, transparent)',
                borderRadius: '4px',
                borderLeft: '3px solid var(--accent-primary, #00d4ff)',
                flex: 1,
                fontSize: '0.8rem'
              }}>
                <span style={{ color: 'rgba(255,255,255,0.95)' }}>Current Program</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Preview Panel Settings */}
      <div className="settings-section" style={{ marginTop: '24px' }}>
        <div className="section-header">
          <h3>Preview Panel</h3>
        </div>
        <p className="section-description">
          Customize the video preview panel in the LiveTV/EPG view.
        </p>

        <div className="timeshift-settings">
          {/* Enable mini media bar for EPG preview */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">Mini media bar for EPG Preview</span>
              <span className="timeshift-toggle-sub">When enabled, a mini play/pause control bar will appear at the bottom of the preview video panel in the LiveTV/EPG view. Requires restart to take effect.</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={miniMediaBarForEpgPreview}
                onChange={(e) => onMiniMediaBarForEpgPreviewChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
