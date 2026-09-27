import './PlaybackTab.css'; // Reuse existing tab styles
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

interface LiveViewTabProps {
  channelInfoOverlayEnabled: boolean;
  onChannelInfoOverlayChange: (enabled: boolean) => void;
  channelInfoOverlayFontSize: number;
  onChannelInfoOverlayFontSizeChange: (size: number) => void;
  channelInfoOverlayLogoSize: number;
  onChannelInfoOverlayLogoSizeChange: (size: number) => void;
  channelInfoOverlayBoxWidth: number;
  onChannelInfoOverlayBoxWidthChange: (width: number) => void;
  channelInfoOverlayOpacity: number;
  onChannelInfoOverlayOpacityChange: (opacity: number) => void;
  channelInfoOverlayHideDescription: boolean;
  onChannelInfoOverlayHideDescriptionChange: (hide: boolean) => void;
  channelInfoOverlayHideMetaBadge: boolean;
  onChannelInfoOverlayHideMetaBadgeChange: (hide: boolean) => void;
  channelInfoOverlayHideLogo: boolean;
  onChannelInfoOverlayHideLogoChange: (hide: boolean) => void;
  channelInfoOverlayHideTimer: boolean;
  onChannelInfoOverlayHideTimerChange: (hide: boolean) => void;
  channelInfoOverlayShowFullPath: boolean;
  onChannelInfoOverlayShowFullPathChange: (show: boolean) => void;
  channelInfoOverlayPosition: 'left' | 'right';
  onChannelInfoOverlayPositionChange: (pos: 'left' | 'right') => void;
  channelInfoOverlayLogoShape: 'square' | 'horizontal';
  onChannelInfoOverlayLogoShapeChange: (shape: 'square' | 'horizontal') => void;
  failoverGroupShowSource: boolean;
  onFailoverGroupShowSourceChange: (enabled: boolean) => void;
}

export function LiveViewTab({
  channelInfoOverlayEnabled,
  onChannelInfoOverlayChange,
  channelInfoOverlayFontSize,
  onChannelInfoOverlayFontSizeChange,
  channelInfoOverlayLogoSize,
  onChannelInfoOverlayLogoSizeChange,
  channelInfoOverlayBoxWidth,
  onChannelInfoOverlayBoxWidthChange,
  channelInfoOverlayOpacity,
  onChannelInfoOverlayOpacityChange,
  channelInfoOverlayHideDescription,
  onChannelInfoOverlayHideDescriptionChange,
  channelInfoOverlayHideMetaBadge,
  onChannelInfoOverlayHideMetaBadgeChange,
  channelInfoOverlayHideLogo,
  onChannelInfoOverlayHideLogoChange,
  channelInfoOverlayHideTimer,
  onChannelInfoOverlayHideTimerChange,
  channelInfoOverlayShowFullPath,
  onChannelInfoOverlayShowFullPathChange,
  channelInfoOverlayPosition,
  onChannelInfoOverlayPositionChange,
  channelInfoOverlayLogoShape,
  onChannelInfoOverlayLogoShapeChange,
  failoverGroupShowSource,
  onFailoverGroupShowSourceChange,
}: LiveViewTabProps) {
  useTranslation();
  return (
    <div className="settings-tab-content playback-tab-content">
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:overlay.channelInfoOverlay')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:overlay.channelInfoOverlaySub')}
        </p>

        <div className="timeshift-settings">
          {/* Enable Channel Information Overlay */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:overlay.enableChannelInfo')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:overlay.enableChannelInfoSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={channelInfoOverlayEnabled}
                onChange={(e) => onChannelInfoOverlayChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Hide Program Description */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:overlay.hideProgramSummary')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:overlay.hideProgramSummarySub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={channelInfoOverlayHideDescription}
                onChange={(e) => onChannelInfoOverlayHideDescriptionChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Hide Metadata Badge */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:overlay.hideMetadataBadge')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:overlay.hideMetadataBadgeSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={channelInfoOverlayHideMetaBadge}
                onChange={(e) => onChannelInfoOverlayHideMetaBadgeChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Hide Channel Logo */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:overlay.hideChannelLogo')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:overlay.hideChannelLogoSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={channelInfoOverlayHideLogo}
                onChange={(e) => onChannelInfoOverlayHideLogoChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Hide Program Timer */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:overlay.hideTimer')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:overlay.hideTimerSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={channelInfoOverlayHideTimer}
                onChange={(e) => onChannelInfoOverlayHideTimerChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Display Full Channel Path */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:overlay.showFullPath')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:overlay.showFullPathSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={channelInfoOverlayShowFullPath}
                onChange={(e) => onChannelInfoOverlayShowFullPathChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Overlay Position */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:overlay.overlayPosition')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:overlay.overlayPositionSub')}
              </span>
            </div>
            <select
              value={channelInfoOverlayPosition}
              onChange={(e) => onChannelInfoOverlayPositionChange(e.target.value as 'left' | 'right')}
              style={{
                padding: '0.4rem 0.8rem',
                backgroundColor: 'var(--bg-tertiary, #1f1f2e)',
                border: '1px solid var(--border-color, var(--surface-border))',
                borderRadius: '6px',
                color: 'var(--text-primary, var(--text-primary))',
                fontSize: '0.85rem',
                cursor: 'pointer',
                minWidth: '120px',
                outline: 'none'
              }}
            >
              <option value="left" style={{ backgroundColor: 'var(--bg-tertiary)' }}>{i18n.t('common:left')}</option>
              <option value="right" style={{ backgroundColor: 'var(--bg-tertiary)' }}>{i18n.t('common:right')}</option>
            </select>
          </div>

          {/* Show Source for Failover Group */}
          <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:overlay.showSourceFailover')}</span>
              <span className="timeshift-toggle-sub">
                {i18n.t('settings:overlay.showSourceFailoverSub')}
              </span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={failoverGroupShowSource}
                onChange={(e) => onFailoverGroupShowSourceChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>

      {channelInfoOverlayEnabled && (
        <>
          {/* Overlay Appearance Settings */}
          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('settings:overlay.appearance')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:overlay.appearanceSub')}
            </p>

            <div className="timeshift-settings">
              {/* Font Size */}
              <div className="form-group" style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.textSize')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input
                    type="range"
                    min="10"
                    max="80"
                    value={channelInfoOverlayFontSize}
                    onChange={(e) => onChannelInfoOverlayFontSizeChange(parseInt(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {channelInfoOverlayFontSize}px
                  </span>
                </div>
                <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                  {i18n.t('settings:overlay.textSizeHint')}
                </p>
              </div>

              {/* Logo Size */}
              <div className="form-group" style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.logoSize')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input
                    type="range"
                    min="24"
                    max="200"
                    value={channelInfoOverlayLogoSize}
                    onChange={(e) => onChannelInfoOverlayLogoSizeChange(parseInt(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {channelInfoOverlayLogoSize}px
                  </span>
                </div>
                <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                  {i18n.t('settings:overlay.logoSizeHint')}
                </p>
              </div>

              {/* Logo Shape */}
              <div className="form-group" style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.logoShape')}</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => onChannelInfoOverlayLogoShapeChange('square')}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      background: channelInfoOverlayLogoShape === 'square' ? 'var(--accent-primary, #00d4ff)' : 'var(--surface-color)',
                      color: channelInfoOverlayLogoShape === 'square' ? '#000' : 'var(--text-primary)',
                      fontWeight: channelInfoOverlayLogoShape === 'square' ? 600 : 400,
                      border: '1px solid var(--surface-border)',
                      borderRadius: '6px',
                      cursor: 'pointer'
                    }}
                  >
                    {i18n.t('settings:overlay.square11')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChannelInfoOverlayLogoShapeChange('horizontal')}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      background: channelInfoOverlayLogoShape === 'horizontal' ? 'var(--accent-primary, #00d4ff)' : 'var(--surface-color)',
                      color: channelInfoOverlayLogoShape === 'horizontal' ? '#000' : 'var(--text-primary)',
                      fontWeight: channelInfoOverlayLogoShape === 'horizontal' ? 600 : 400,
                      border: '1px solid var(--surface-border)',
                      borderRadius: '6px',
                      cursor: 'pointer'
                    }}
                  >
                    {i18n.t('settings:overlay.horizontal169')}
                  </button>
                </div>
                <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                  {i18n.t('settings:overlay.logoShapeHint')}
                </p>
              </div>

              {/* Box Width */}
              <div className="form-group" style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.boxWidth')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input
                    type="range"
                    min="200"
                    max="1200"
                    step="10"
                    value={channelInfoOverlayBoxWidth}
                    onChange={(e) => onChannelInfoOverlayBoxWidthChange(parseInt(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {channelInfoOverlayBoxWidth}px
                  </span>
                </div>
                <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                  {i18n.t('settings:overlay.boxWidthHint')}
                </p>
              </div>

              {/* Background Opacity */}
              <div className="form-group" style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.bgOpacity')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input
                    type="range"
                    min="20"
                    max="90"
                    value={channelInfoOverlayOpacity}
                    onChange={(e) => onChannelInfoOverlayOpacityChange(parseInt(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {channelInfoOverlayOpacity}%
                  </span>
                </div>
                <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                  {i18n.t('settings:overlay.bgOpacityHint')}
                </p>
              </div>

              {/* Reset Button */}
              <div style={{ marginTop: '16px' }}>
                <button
                  className="sync-btn"
                  onClick={() => {
                    onChannelInfoOverlayFontSizeChange(16);
                    onChannelInfoOverlayLogoSizeChange(42);
                    onChannelInfoOverlayLogoShapeChange('square');
                    onChannelInfoOverlayBoxWidthChange(380);
                    onChannelInfoOverlayOpacityChange(55);
                  }}
                  style={{ maxWidth: '200px' }}
                >
                  {i18n.t('common:resetToDefault')}
                </button>
              </div>
            </div>
          </div>

          {/* Live Preview */}
          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('common:preview')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:overlay.previewSub')}
            </p>
            <div style={{ marginTop: '16px', padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
              <div
                style={{
                  maxWidth: `${channelInfoOverlayBoxWidth}px`,
                  background: `rgba(0, 0, 0, ${channelInfoOverlayOpacity / 100})`,
                  backdropFilter: 'blur(12px)',
                  borderRadius: '10px',
                  padding: '14px 18px',
                  border: '1px solid var(--surface-border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div
                    style={{
                      width: channelInfoOverlayLogoShape === 'horizontal' ? `${channelInfoOverlayLogoSize * 1.75}px` : `${channelInfoOverlayLogoSize}px`,
                      height: `${channelInfoOverlayLogoSize}px`,
                      borderRadius: '6px',
                      background: 'var(--surface-color)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.7rem',
                      color: 'var(--text-muted)',
                      flexShrink: 0,
                    }}
                  >
                    {i18n.t('settings:overlay.logoPlaceholder')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                    <span style={{ fontSize: `${channelInfoOverlayFontSize}px`, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {i18n.t('settings:overlay.channelNamePlaceholder')}
                    </span>
                    <span style={{ fontSize: `${Math.max(10, channelInfoOverlayFontSize - 4)}px`, color: 'var(--text-secondary)' }}>
                      {i18n.t('settings:overlay.programTitlePlaceholder')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
