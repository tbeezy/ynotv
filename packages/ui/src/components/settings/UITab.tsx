import { useState, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './SourcesTab.css'; // Import shared tooltip styles

interface UITabProps {
  settings: {
    startupWidth?: number;
    startupHeight?: number;
    dontSaveWindowSizeOnClose?: boolean;
    minimizeToTray?: boolean;
    modernUiEnabled?: boolean | string;
    collapseSourceCategoriesOnStartup?: boolean;
    overlayAutohideTimer?: number;
    overlayOnClickOnly?: boolean;
    uiScale?: number;
    playerControlDesign?: 'default' | 'clean';
    showVolumePercent?: boolean;
    channelInfoOverlayEnabled?: boolean;
    channelInfoOverlayFontSize?: number;
    channelInfoOverlayLogoSize?: number;
    channelInfoOverlayBoxWidth?: number;
    channelInfoOverlayOpacity?: number;
    channelInfoOverlayHideDescription?: boolean;
    channelInfoOverlayHideMetaBadge?: boolean;
    channelInfoOverlayHideLogo?: boolean;
    channelInfoOverlayHideTimer?: boolean;
    channelInfoOverlayPosition?: 'left' | 'right';
    channelInfoOverlayLogoShape?: 'square' | 'horizontal';
  };
  onSettingsChange: (settings: {
    startupWidth?: number;
    startupHeight?: number;
    dontSaveWindowSizeOnClose?: boolean;
    minimizeToTray?: boolean;
    modernUiEnabled?: boolean | string;
    collapseSourceCategoriesOnStartup?: boolean;
    overlayAutohideTimer?: number;
    overlayOnClickOnly?: boolean;
    uiScale?: number;
    playerControlDesign?: 'default' | 'clean';
    showVolumePercent?: boolean;
    channelInfoOverlayEnabled?: boolean;
    channelInfoOverlayFontSize?: number;
    channelInfoOverlayLogoSize?: number;
    channelInfoOverlayBoxWidth?: number;
    channelInfoOverlayOpacity?: number;
    channelInfoOverlayHideDescription?: boolean;
    channelInfoOverlayHideMetaBadge?: boolean;
    channelInfoOverlayHideLogo?: boolean;
    channelInfoOverlayHideTimer?: boolean;
    channelInfoOverlayPosition?: 'left' | 'right';
    channelInfoOverlayLogoShape?: 'square' | 'horizontal';
  }) => void;
}

function WindowSizeSettings({ width, height, onChange }: { width: number; height: number; onChange: (w: number, h: number) => void }) {
  useTranslation();
  const [localWidth, setLocalWidth] = useState(width);
  const [localHeight, setLocalHeight] = useState(height);
  const [status, setStatus] = useState<'' | 'saved'>('');

  // Update local state when props change (e.g. initial load)
  useEffect(() => {
    setLocalWidth(width);
    setLocalHeight(height);
  }, [width, height]);

  const handleApply = () => {
    onChange(localWidth, localHeight);
    setStatus('saved');
    setTimeout(() => setStatus(''), 2000);
  };

  const handleReset = () => {
    const defW = 1920;
    const defH = 1080;
    setLocalWidth(defW);
    setLocalHeight(defH);
    onChange(defW, defH);
    setStatus('saved');
    setTimeout(() => setStatus(''), 2000);
  };

  const handleUseCurrentSize = async () => {
    try {
      const appWindow = getCurrentWindow();
      // Use innerSize to match what we save and apply (inner size, not outer)
      const size = await appWindow.innerSize();
      // Convert from physical pixels to logical pixels
      const factor = await appWindow.scaleFactor();
      const logicalWidth = Math.round(size.width / factor);
      const logicalHeight = Math.round(size.height / factor);

      setLocalWidth(logicalWidth);
      setLocalHeight(logicalHeight);
      onChange(logicalWidth, logicalHeight);
      setStatus('saved');
      setTimeout(() => setStatus(''), 2000);
    } catch (err) {
      console.error('Failed to get current window size:', err);
    }
  };

  return (
    <div className="form-group" style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:ui.widthPx')}</label>
          <input
            type="number"
            min="400"
            max="7680"
            value={localWidth}
            onChange={(e) => setLocalWidth(parseInt(e.target.value) || 1920)}
            className="query-input"
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:ui.heightPx')}</label>
          <input
            type="number"
            min="300"
            max="4320"
            value={localHeight}
            onChange={(e) => setLocalHeight(parseInt(e.target.value) || 1080)}
            className="query-input"
            style={{ width: '100%' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1rem', flexWrap: 'wrap' }}>
        <button
          className="sync-btn"
          onClick={handleApply}
          style={{ padding: '0.5rem 1.5rem', background: '#00d4ff', color: 'black', fontWeight: 600 }}
        >
          {status === 'saved' ? i18n.t('settings:ui.saved') : i18n.t('settings:ui.apply')}
        </button>

        <button
          className="sync-btn secondary"
          onClick={handleUseCurrentSize}
          style={{ background: 'var(--surface-color)' }}
        >
          {i18n.t('settings:ui.useCurrentSize')}
        </button>

        <button
          className="sync-btn secondary"
          onClick={handleReset}
          style={{ background: 'var(--surface-color)' }}
        >
          {i18n.t('common:resetToDefault')}
        </button>
      </div>

      <p className="form-hint" style={{ marginTop: '0.75rem' }}>
        {i18n.t('settings:ui.windowSizeHint')}
      </p>
    </div>
  );
}

export function UITab({ settings, onSettingsChange }: UITabProps) {
  useTranslation();
  const [activeSubTab, setActiveSubTab] = useState<'general' | 'player'>('general');
  const appFontFamily = useSettingsStore((s) => s.appFontFamily);
  const appCustomFontBase64 = useSettingsStore((s) => s.appCustomFontBase64);
  const appCustomFontFormat = useSettingsStore((s) => s.appCustomFontFormat);
  const appCustomFontName = useSettingsStore((s) => s.appCustomFontName);
  const updateAppFont = useSettingsStore((s) => s.updateAppFont);
  const enableCustomScrollbarWidth = useSettingsStore((s) => s.enableCustomScrollbarWidth);
  const setEnableCustomScrollbarWidth = useSettingsStore((s) => s.setEnableCustomScrollbarWidth);
  const customScrollbarWidth = useSettingsStore((s) => s.customScrollbarWidth);
  const setCustomScrollbarWidth = useSettingsStore((s) => s.setCustomScrollbarWidth);

  const [localScale, setLocalScale] = useState(settings.uiScale ?? 100);
  const [scaleStatus, setScaleStatus] = useState<'' | 'applied'>('');

  // Keep localScale in sync if setting changes externally
  useEffect(() => {
    setLocalScale(settings.uiScale ?? 100);
  }, [settings.uiScale]);

  const handleApplyScale = () => {
    onSettingsChange({ ...settings, uiScale: localScale });
    setScaleStatus('applied');
    setTimeout(() => setScaleStatus(''), 2000);
  };

  const handleDesignChange = (newDesign: 'default' | 'clean') => {
    onSettingsChange({
      ...settings,
      playerControlDesign: newDesign,
    });
  };

  return (
    <div className="playback-tab-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="settings-tabs" style={{ padding: '0 20px', flexShrink: 0 }}>
        <button
          className={`settings-tab ${activeSubTab === 'general' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('general')}
        >
          {i18n.t('settings:ui.general')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'player' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('player')}
        >
          {i18n.t('settings:ui.player')}
        </button>
      </div>

      <div className="settings-tab-content">
        {activeSubTab === 'general' && (
        <>
          {/* Modern UI Section */}
          <div className="settings-section" style={{ paddingTop: '8px' }}>
            <div className="timeshift-settings">
              <div className="timeshift-toggle-row" style={{ position: 'relative' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.uiDesign')}
                    <div className="epg-tooltip">
                      <span className="epg-tooltip-icon">?</span>
                      <div className="epg-tooltip-content">
                        {i18n.t('settings:ui.uiDesignTooltip')}
                      </div>
                    </div>
                  </span>
                </div>
                <select
                  value={
                    settings.modernUiEnabled === false || settings.modernUiEnabled === 'v1'
                      ? 'v1'
                      : settings.modernUiEnabled === 'v3'
                      ? 'v3'
                      : 'v2'
                  }
                  onChange={(e) => onSettingsChange({ ...settings, modernUiEnabled: e.target.value })}
                  style={{
                    padding: '0.4rem 0.8rem',
                    backgroundColor: 'var(--bg-tertiary, #1f1f2e)',
                    border: '1px solid var(--border-color, var(--surface-border))',
                    borderRadius: '6px',
                    color: 'var(--text-primary, var(--text-primary))',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    minWidth: '130px',
                    outline: 'none'
                  }}
                >
                  <option value="v1" style={{ backgroundColor: 'var(--bg-tertiary)' }}>{i18n.t('settings:ui.v1Classic')}</option>
                  <option value="v2" style={{ backgroundColor: 'var(--bg-tertiary)' }}>{i18n.t('settings:ui.v2Modern')}</option>
                  <option value="v3" style={{ backgroundColor: 'var(--bg-tertiary)' }}>v3</option>
                </select>
              </div>

              {/* Collapse Source Categories on Startup */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.collapseCategories')}
                    <div className="epg-tooltip">
                      <span className="epg-tooltip-icon">?</span>
                      <div className="epg-tooltip-content">
                        {i18n.t('settings:ui.collapseCategoriesTooltip')}
                      </div>
                    </div>
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.collapseSourceCategoriesOnStartup ?? false}
                    onChange={(e) => onSettingsChange({ ...settings, collapseSourceCategoriesOnStartup: e.target.checked })}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Minimize to Tray */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.minimizeTray')}
                    <div className="epg-tooltip">
                      <span className="epg-tooltip-icon">?</span>
                      <div className="epg-tooltip-content">
                        {i18n.t('settings:ui.minimizeTrayTooltip')}
                      </div>
                    </div>
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.minimizeToTray ?? false}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      onSettingsChange({ ...settings, minimizeToTray: enabled });
                      invoke('set_minimize_to_tray', { enabled }).catch((err) =>
                        console.error('[Tray] Failed to update minimize-to-tray flag:', err)
                      );
                    }}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Override Scrollbar Width */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.scrollbarWidth')}
                    <div className="epg-tooltip">
                      <span className="epg-tooltip-icon">?</span>
                      <div className="epg-tooltip-content">
                        {i18n.t('settings:ui.scrollbarWidthTooltip')}
                      </div>
                    </div>
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={enableCustomScrollbarWidth}
                    onChange={(e) => setEnableCustomScrollbarWidth(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {enableCustomScrollbarWidth && (
                <div className="timeshift-toggle-row">
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {i18n.t('settings:ui.customScrollbarWidthLabel', { px: customScrollbarWidth })}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="range"
                      min="6"
                      max="20"
                      step="1"
                      value={customScrollbarWidth}
                      onChange={(e) => setCustomScrollbarWidth(parseInt(e.target.value) || 12)}
                      style={{ width: '130px', cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary, var(--text-secondary))', minWidth: '35px' }}>
                      {customScrollbarWidth}px
                    </span>
                  </div>
                </div>
              )}

              {/* Autohide Overlay Timer */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.autohideTimer')}
                    <div className="epg-tooltip">
                      <span className="epg-tooltip-icon">?</span>
                      <div className="epg-tooltip-content">
                        {i18n.t('settings:ui.autohideTimerTooltip')}
                      </div>
                    </div>
                  </span>
                </div>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={settings.overlayAutohideTimer ?? 3}
                  onChange={(e) => onSettingsChange({ ...settings, overlayAutohideTimer: parseInt(e.target.value) || 3 })}
                  className="query-input"
                  style={{ width: '80px', textAlign: 'center' }}
                />
              </div>

              {/* Overlay on Click Only */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.overlayClickOnly')}
                    <div className="epg-tooltip">
                      <span className="epg-tooltip-icon">?</span>
                      <div className="epg-tooltip-content">
                        {i18n.t('settings:ui.overlayClickOnlyTooltip')}
                      </div>
                    </div>
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.overlayOnClickOnly ?? false}
                    onChange={(e) => onSettingsChange({ ...settings, overlayOnClickOnly: e.target.checked })}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Application UI Scale */}
              <div className="timeshift-toggle-row" style={{ alignItems: 'flex-start', gap: '1rem' }}>
                <div className="timeshift-toggle-info" style={{ flex: 1 }}>
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.uiScale')}
                    <div className="epg-tooltip">
                      <span className="epg-tooltip-icon">?</span>
                      <div className="epg-tooltip-content">
                        {i18n.t('settings:ui.uiScaleTooltip')}
                      </div>
                    </div>
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '220px', alignItems: 'stretch' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <input
                      type="range"
                      min="70"
                      max="150"
                      step="5"
                      value={localScale}
                      onChange={(e) => setLocalScale(parseInt(e.target.value) || 100)}
                      style={{ flex: 1, cursor: 'pointer' }}
                    />
                    <span style={{ minWidth: '3.5rem', textAlign: 'right', color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                      {localScale}%
                    </span>
                  </div>
                  <button
                    className="sync-btn"
                    onClick={handleApplyScale}
                    style={{
                      padding: '0.4rem 1.25rem',
                      background: '#00d4ff',
                      color: 'black',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      alignSelf: 'flex-end',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    {scaleStatus === 'applied' ? i18n.t('settings:ui.applied') : i18n.t('settings:ui.applyScale')}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Window Settings Section */}
          <div className="settings-section" style={{ paddingTop: '8px' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:ui.windowSettings')}</h3>
            </div>

            <p className="section-description" style={{ marginBottom: '12px' }}>
              {i18n.t('settings:ui.windowSettingsSub')}
            </p>

            <WindowSizeSettings
              width={settings.startupWidth || 1920}
              height={settings.startupHeight || 1080}
              onChange={(w, h) => onSettingsChange({ ...settings, startupWidth: w, startupHeight: h })}
            />

            {/* Don't Save Window Size on Close */}
            <div style={{ marginTop: '1rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.75rem 0',
                  borderTop: '1px solid var(--surface-border)',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ color: 'var(--text-primary)', fontSize: '0.95rem' }}>
                    {i18n.t('settings:ui.doNotSaveSize')}
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    {i18n.t('settings:ui.doNotSaveSizeSub')}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.dontSaveWindowSizeOnClose ?? false}
                  onChange={(e) => onSettingsChange({ ...settings, dontSaveWindowSizeOnClose: e.target.checked })}
                  style={{ cursor: 'pointer', marginLeft: '1rem' }}
                />
              </div>
            </div>
          </div>

          {/* Typography & Fonts Section */}
          <div className="settings-section" style={{ paddingTop: '8px', borderTop: '1px solid var(--surface-border)', marginTop: '20px' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:ui.typographyFonts')}</h3>
            </div>

            <p className="section-description" style={{ marginBottom: '16px' }}>
              {i18n.t('settings:ui.typographyFontsSub')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', background: 'var(--surface-color)', border: '1px solid var(--surface-border)', borderRadius: '8px', padding: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                  {i18n.t('settings:ui.appFontFamily')}
                </label>
                <select
                  value={appFontFamily}
                  onChange={(e) => updateAppFont(e.target.value, appCustomFontBase64, appCustomFontFormat, appCustomFontName)}
                  style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    color: 'var(--text-primary)',
                    fontSize: '0.85rem',
                    outline: 'none',
                    cursor: 'pointer',
                    width: '100%',
                    height: '36px'
                  }}
                >
                  <option value="inter" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:ui.interDefault')}</option>
                  <option value="switzer" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:ui.switzer')}</option>
                  <option value="cabinet-grotesk" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:ui.cabinetGrotesk')}</option>
                  <option value="fraunces" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:ui.fraunces')}</option>
                  <option value="sentient" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:ui.sentient')}</option>
                  <option value="custom" style={{ background: 'var(--surface-color)', color: 'var(--text-primary)' }}>{i18n.t('settings:ui.customUploadedFont')}</option>
                </select>
              </div>

              {/* Custom Font Upload UI */}
              {appFontFamily === 'custom' && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                  background: 'var(--surface-color)',
                  border: '1px dashed var(--surface-border)',
                  borderRadius: '6px',
                  padding: '12px'
                }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                    {i18n.t('settings:ui.fontUploadHint')}
                  </div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                      onClick={() => document.getElementById('ui-font-uploader')?.click()}
                      style={{
                        background: 'var(--surface-color)',
                        border: '1px solid var(--surface-border)',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        color: 'var(--text-primary)',
                        fontSize: '0.8rem',
                        fontWeight: 500,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'all 0.2s ease',
                        height: '32px'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface-color)'}
                    >
                      {i18n.t('settings:ui.chooseFontFile')}
                    </button>
                    <input
                      id="ui-font-uploader"
                      type="file"
                      accept=".ttf,.otf,.woff,.woff2"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            const base64 = event.target?.result as string;
                            let format = 'woff2';
                            if (file.name.endsWith('.ttf')) format = 'truetype';
                            else if (file.name.endsWith('.otf')) format = 'opentype';
                            else if (file.name.endsWith('.woff')) format = 'woff';
                            
                            updateAppFont('custom', base64, format, file.name);
                          };
                          reader.readAsDataURL(file);
                        }
                      }}
                    />
                    
                    {appCustomFontName && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--accent-primary, #00d4ff)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '240px' }} title={appCustomFontName}>
                        {appCustomFontName}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {activeSubTab === 'player' && (
        <>
          {/* Player Media Control Design Section */}
          <div className="settings-section" style={{ paddingTop: '8px' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:ui.mediaControlDesign')}</h3>
            </div>
            <p className="section-description" style={{ marginBottom: '12px' }}>
              {i18n.t('settings:ui.mediaControlDesignSub')}
            </p>

            <div className="timeshift-settings">
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.controlDesign')}
                  </span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:ui.controlDesignSub')}
                  </span>
                </div>
                <select
                  value={settings.playerControlDesign ?? 'clean'}
                  onChange={(e) => handleDesignChange(e.target.value as 'default' | 'clean')}
                  style={{
                    padding: '0.4rem 0.8rem',
                    backgroundColor: 'var(--bg-tertiary, #1f1f2e)',
                    border: '1px solid var(--border-color, var(--surface-border))',
                    borderRadius: '6px',
                    color: 'var(--text-primary, var(--text-primary))',
                    fontSize: '0.85rem',
                    cursor: 'pointer',
                    minWidth: '150px',
                    outline: 'none'
                  }}
                >
                  <option value="default" style={{ backgroundColor: 'var(--bg-tertiary)' }}>{i18n.t('settings:ui.legacy')}</option>
                  <option value="clean" style={{ backgroundColor: 'var(--bg-tertiary)' }}>{i18n.t('settings:ui.cleanBorderless')}</option>
                </select>
              </div>

              <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {i18n.t('settings:ui.showVolumePercent')}
                  </span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:ui.showVolumePercentSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.showVolumePercent ?? false}
                    onChange={(e) => onSettingsChange({ ...settings, showVolumePercent: e.target.checked })}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>
          </div>

          {/* Channel Info Overlay Settings */}
          <div className="settings-section" style={{ paddingTop: '8px' }}>
            <div className="section-header">
              <h3>{i18n.t('settings:overlay.channelInfoOverlay')}</h3>
            </div>
            <p className="section-description" style={{ marginBottom: '12px' }}>
              {i18n.t('settings:ui.channelInfoOverlaySub')}
            </p>

            <div className="timeshift-settings">
              {/* Enable Channel Information Overlay */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:ui.enableChannelInfoOverlay')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:ui.enableChannelInfoOverlaySub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.channelInfoOverlayEnabled ?? false}
                    onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayEnabled: e.target.checked })}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Hide Program Summary */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:overlay.hideProgramSummary')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:ui.hideProgramSummarySub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.channelInfoOverlayHideDescription ?? false}
                    onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayHideDescription: e.target.checked })}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Hide Metadata Badge */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:overlay.hideMetadataBadge')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:ui.hideMetadataBadgeSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.channelInfoOverlayHideMetaBadge ?? false}
                    onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayHideMetaBadge: e.target.checked })}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Hide Channel Logo */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:overlay.hideChannelLogo')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:ui.hideChannelLogoSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.channelInfoOverlayHideLogo ?? false}
                    onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayHideLogo: e.target.checked })}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>

              {/* Hide Program Timer */}
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:overlay.hideTimer')}</span>
                  <span className="timeshift-toggle-sub">
                    {i18n.t('settings:ui.hideTimerSub')}
                  </span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={settings.channelInfoOverlayHideTimer ?? false}
                    onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayHideTimer: e.target.checked })}
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
                  value={settings.channelInfoOverlayPosition ?? 'left'}
                  onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayPosition: e.target.value as 'left' | 'right' })}
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
            </div>

            {/* Appearance Controls */}
            {(settings.channelInfoOverlayEnabled ?? false) && (
              <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {/* Font Size */}
                <div className="form-group">
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.textSize')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <input
                      type="range"
                      min="10"
                      max="28"
                      value={settings.channelInfoOverlayFontSize ?? 16}
                      onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayFontSize: parseInt(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {settings.channelInfoOverlayFontSize ?? 16}px
                    </span>
                  </div>
                </div>

                {/* Logo Size */}
                <div className="form-group">
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.logoSize')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <input
                      type="range"
                      min="24"
                      max="72"
                      value={settings.channelInfoOverlayLogoSize ?? 42}
                      onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayLogoSize: parseInt(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {settings.channelInfoOverlayLogoSize ?? 42}px
                    </span>
                  </div>
                </div>

                {/* Logo Shape */}
                <div className="form-group" style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.logoShape')}</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      onClick={() => onSettingsChange({ ...settings, channelInfoOverlayLogoShape: 'square' })}
                      style={{
                        flex: 1,
                        padding: '6px 10px',
                        fontSize: '0.85rem',
                        background: (settings.channelInfoOverlayLogoShape ?? 'square') === 'square' ? 'var(--accent-primary, #00d4ff)' : 'var(--surface-color)',
                        color: (settings.channelInfoOverlayLogoShape ?? 'square') === 'square' ? '#000' : 'var(--text-primary)',
                        fontWeight: (settings.channelInfoOverlayLogoShape ?? 'square') === 'square' ? 600 : 400,
                        border: '1px solid var(--surface-border)',
                        borderRadius: '6px',
                        cursor: 'pointer'
                      }}
                    >
                      {i18n.t('settings:overlay.square11')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onSettingsChange({ ...settings, channelInfoOverlayLogoShape: 'horizontal' })}
                      style={{
                        flex: 1,
                        padding: '6px 10px',
                        fontSize: '0.85rem',
                        background: (settings.channelInfoOverlayLogoShape ?? 'square') === 'horizontal' ? 'var(--accent-primary, #00d4ff)' : 'var(--surface-color)',
                        color: (settings.channelInfoOverlayLogoShape ?? 'square') === 'horizontal' ? '#000' : 'var(--text-primary)',
                        fontWeight: (settings.channelInfoOverlayLogoShape ?? 'square') === 'horizontal' ? 600 : 400,
                        border: '1px solid var(--surface-border)',
                        borderRadius: '6px',
                        cursor: 'pointer'
                      }}
                    >
                      {i18n.t('settings:overlay.horizontal169')}
                    </button>
                  </div>
                </div>

                {/* Box Width */}
                <div className="form-group">
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.boxWidth')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <input
                      type="range"
                      min="200"
                      max="600"
                      step="10"
                      value={settings.channelInfoOverlayBoxWidth ?? 380}
                      onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayBoxWidth: parseInt(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {settings.channelInfoOverlayBoxWidth ?? 380}px
                    </span>
                  </div>
                </div>

                {/* Background Opacity */}
                <div className="form-group">
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:overlay.bgOpacity')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <input
                      type="range"
                      min="20"
                      max="90"
                      value={settings.channelInfoOverlayOpacity ?? 55}
                      onChange={(e) => onSettingsChange({ ...settings, channelInfoOverlayOpacity: parseInt(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {settings.channelInfoOverlayOpacity ?? 55}%
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
      </div>
    </div>
  );
}
