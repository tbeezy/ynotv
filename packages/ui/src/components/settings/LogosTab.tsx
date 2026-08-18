import { useCallback, useEffect, useState } from 'react';
import { clearLogoCache, getLogoCacheStats, pruneLogoCache, LogoCacheStats } from '../../services/logoCache';
import './PlaybackTab.css';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

interface LogosTabProps {
  epgPreferEpgLogos: boolean;
  onEpgPreferEpgLogosChange: (enabled: boolean) => void;
  epgLogoDisplay: 'square' | 'rectangle';
  onEpgLogoDisplayChange: (display: 'square' | 'rectangle') => void;
  channelLogoSize?: number;
  onChannelLogoSizeChange?: (size: number) => void;
  channelLogoRoundEdges?: boolean;
  onChannelLogoRoundEdgesChange?: (enabled: boolean) => void;
  channelLogoPadding?: 'none' | 'padded';
  onChannelLogoPaddingChange?: (padding: 'none' | 'padded') => void;
  logoSmartTrim?: boolean;
  onLogoSmartTrimChange?: (enabled: boolean) => void;
  logoLightBackgroundDetection?: boolean;
  onLogoLightBackgroundDetectionChange?: (enabled: boolean) => void;
  sourceLogoDisplayOverrides: Record<string, 'square' | 'rectangle'>;
  onSetSourceLogoDisplayOverride: (sourceId: string, display: 'square' | 'rectangle' | 'default') => void;
  logoCacheEnabled: boolean;
  onLogoCacheEnabledChange: (enabled: boolean) => void;
  logoCacheMaxMb: number;
  onLogoCacheMaxMbChange: (maxMb: number) => void;
  logoCacheTtlDays: number;
  onLogoCacheTtlDaysChange: (days: number) => void;
}

const LOGO_SIZE_PRESETS = [
  { labelKey: 'settings:livetv.logos.small32', value: 32 },
  { labelKey: 'settings:livetv.logos.default42', value: 42 },
  { labelKey: 'settings:livetv.logos.large48', value: 48 },
  { labelKey: 'settings:livetv.logos.xl56', value: 56 },
];

const SIZE_PRESETS = [
  { labelKey: 'settings:livetv.logos.mb100', value: 100 },
  { labelKey: 'settings:livetv.logos.mb250', value: 250 },
  { labelKey: 'settings:livetv.logos.mb500', value: 500 },
  { labelKey: 'settings:livetv.logos.gb1', value: 1000 },
  { labelKey: 'common:unlimited', value: 0 },
];

const TTL_PRESETS = [
  { labelKey: 'settings:livetv.logos.days', value: 7, count: 7 },
  { labelKey: 'settings:livetv.logos.days', value: 14, count: 14 },
  { labelKey: 'settings:livetv.logos.days', value: 30, count: 30 },
  { labelKey: 'settings:livetv.logos.days', value: 90, count: 90 },
  { labelKey: 'common:never', value: 0 },
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function LogosTab({
  epgPreferEpgLogos,
  onEpgPreferEpgLogosChange,
  epgLogoDisplay,
  onEpgLogoDisplayChange,
  channelLogoSize = 42,
  onChannelLogoSizeChange = () => {},
  channelLogoRoundEdges = true,
  onChannelLogoRoundEdgesChange = () => {},
  channelLogoPadding = 'none',
  onChannelLogoPaddingChange = () => {},
  logoSmartTrim = false,
  onLogoSmartTrimChange = () => {},
  logoLightBackgroundDetection = true,
  onLogoLightBackgroundDetectionChange = () => {},
  sourceLogoDisplayOverrides,
  onSetSourceLogoDisplayOverride,
  logoCacheEnabled,
  onLogoCacheEnabledChange,
  logoCacheMaxMb,
  onLogoCacheMaxMbChange,
  logoCacheTtlDays,
  onLogoCacheTtlDaysChange,
}: LogosTabProps) {
  useTranslation();
  const [stats, setStats] = useState<LogoCacheStats | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [showSourceDrawer, setShowSourceDrawer] = useState(false);
  const [sources, setSources] = useState<{ id: string; name: string; type?: string }[]>([]);

  const loadStats = useCallback(async () => {
    const res = await getLogoCacheStats(logoCacheEnabled, logoCacheMaxMb, logoCacheTtlDays);
    setStats(res);
  }, [logoCacheEnabled, logoCacheMaxMb, logoCacheTtlDays]);

  useEffect(() => {
    loadStats();
    if (window.storage) {
      window.storage.getSources().then((res) => {
        if (res.data) setSources(res.data);
      });
    }
  }, [loadStats]);

  // Evict entries immediately whenever the user changes the TTL / max-size
  // settings (or enables caching), then refresh the usage stats.
  useEffect(() => {
    if (!logoCacheEnabled) return;
    let cancelled = false;
    (async () => {
      await pruneLogoCache(
        logoCacheMaxMb > 0 ? logoCacheMaxMb * 1024 * 1024 : 0,
        logoCacheTtlDays
      );
      if (!cancelled) loadStats();
    })();
    return () => {
      cancelled = true;
    };
  }, [logoCacheEnabled, logoCacheMaxMb, logoCacheTtlDays, loadStats]);

  const handleClearCache = async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      await clearLogoCache();
      await loadStats();
      try {
        localStorage.removeItem('ynotv.logo-luminance.v1');
      } catch (e) {
        // Ignore localStorage clear errors
      }
      try {
        localStorage.removeItem('ynotv.logo-contentbox.v1');
      } catch (e) {
        // Ignore localStorage clear errors
      }
    } finally {
      setIsClearing(false);
    }
  };

  const usedBytes = stats?.total_bytes ?? 0;
  const maxBytes = logoCacheMaxMb > 0 ? logoCacheMaxMb * 1024 * 1024 : 0;
  const usagePercent = maxBytes > 0 ? Math.min(100, Math.round((usedBytes / maxBytes) * 100)) : 0;

  // Compute dimensions & styles for live preview
  const isRect = epgLogoDisplay === 'rectangle';
  const previewWidth = isRect ? Math.round(channelLogoSize * 1.83) : channelLogoSize;
  const previewHeight = isRect ? Math.round(channelLogoSize * 0.9) : channelLogoSize;
  const previewRadius = channelLogoRoundEdges ? (isRect ? 6 : 8) : 0;

  return (
    <div className="settings-tab-content playback-tab-content">
      {/* ── Logo Display & Preferences ── */}
      <div className="settings-section">
        <div className="section-header">
          <h3>{i18n.t('settings:livetv.logos.logoPreferences')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:livetv.logos.logoPreferencesSub')}
        </p>

        <div className="timeshift-settings">
          {/* Logo Size Control */}
          <div className="form-group" style={{ marginBottom: '14px', paddingBottom: '14px', borderBottom: '1px solid var(--surface-border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div>
                <span className="timeshift-toggle-label" style={{ display: 'block' }}>{i18n.t('settings:livetv.logos.logoSize')}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.logos.logoSizeSub')}</span>
              </div>
              <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--accent-color, #00d4ff)', minWidth: '3.5rem', textAlign: 'right' }}>
                {channelLogoSize}px
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '10px' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>20px</span>
              <input
                type="range"
                min="20"
                max="64"
                step="2"
                value={channelLogoSize}
                onChange={(e) => onChannelLogoSizeChange(parseInt(e.target.value, 10))}
                style={{ flex: 1, cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>64px</span>
            </div>

            <div className="timeshift-presets" style={{ gap: '6px' }}>                  {LOGO_SIZE_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={`timeshift-preset-btn ${channelLogoSize === preset.value ? 'active' : ''}`}
                  onClick={() => onChannelLogoSizeChange(preset.value)}
                >
                  {i18n.t(preset.labelKey, { defaultValue: preset.labelKey })}
                </button>
              ))}
            </div>
          </div>

          {/* Round Logo Edges Toggle */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:livetv.logos.roundLogoEdges')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.logos.roundLogoEdgesSub')}</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={channelLogoRoundEdges}
                onChange={(e) => onChannelLogoRoundEdgesChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Light Background Detection Toggle */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:livetv.logos.lightBgDetection')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.logos.lightBgDetectionSub')}</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={logoLightBackgroundDetection}
                onChange={(e) => onLogoLightBackgroundDetectionChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Smart Trim Logos Toggle */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:livetv.logos.smartTrim')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.logos.smartTrimSub')}</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={logoSmartTrim}
                onChange={(e) => onLogoSmartTrimChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Logo Tile Layout Toggle */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:livetv.logos.tileLayout')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.logos.tileLayoutSub')}</span>
            </div>
            <div className="timeshift-presets" style={{ gap: '6px' }}>
              <button
                type="button"
                className={`timeshift-preset-btn ${channelLogoPadding === 'none' ? 'active' : ''}`}
                onClick={() => onChannelLogoPaddingChange('none')}
              >
                {i18n.t('settings:livetv.logos.fullBleed')}
              </button>
              <button
                type="button"
                className={`timeshift-preset-btn ${channelLogoPadding === 'padded' ? 'active' : ''}`}
                onClick={() => onChannelLogoPaddingChange('padded')}
              >
                {i18n.t('settings:livetv.logos.paddedTile')}
              </button>
            </div>
          </div>

          {/* Interactive Live Preview Box */}
          <div
            style={{
              marginTop: '16px',
              marginBottom: '20px',
              padding: '16px',
              background: 'var(--bg-tertiary, #1e1e24)',
              borderRadius: '8px',
              border: '1px solid var(--surface-border)',
            }}
          >
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
              {i18n.t('settings:livetv.logos.livePreview')}
            </div>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
              {/* Sample Logo Tile 1 */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                <div
                  style={{
                    width: previewWidth,
                    height: previewHeight,
                    borderRadius: `${previewRadius}px`,
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 700,
                    fontSize: `${Math.max(10, Math.round(previewHeight * 0.4))}px`,
                    color: '#ffffff',
                    transition: 'all 0.2s ease',
                    overflow: 'hidden',
                  }}
                >
                  HBO
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{i18n.t('settings:livetv.logos.darkTile')}</span>
              </div>

              {/* Sample Logo Tile 2 (Light tile) */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                <div
                  style={{
                    width: previewWidth,
                    height: previewHeight,
                    borderRadius: `${previewRadius}px`,
                    background: 'rgba(255, 255, 255, 0.9)',
                    border: '1px solid rgba(255, 255, 255, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 700,
                    fontSize: `${Math.max(10, Math.round(previewHeight * 0.38))}px`,
                    color: '#111827',
                    transition: 'all 0.2s ease',
                    overflow: 'hidden',
                  }}
                >
                  ESPN
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{i18n.t('settings:livetv.logos.lightTile')}</span>
              </div>

              {/* Sample Logo Tile 3 */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
                <div
                  style={{
                    width: previewWidth,
                    height: previewHeight,
                    borderRadius: `${previewRadius}px`,
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 700,
                    fontSize: `${Math.max(10, Math.round(previewHeight * 0.4))}px`,
                    color: '#38bdf8',
                    transition: 'all 0.2s ease',
                    overflow: 'hidden',
                  }}
                >
                  CNN
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{i18n.t('settings:livetv.logos.coloredTile')}</span>
              </div>

              <div style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {i18n.t('settings:livetv.logos.formatLabel')} <strong>{isRect ? i18n.t('common:rectangle') : i18n.t('common:square')}</strong> ({previewWidth}px × {previewHeight}px), {i18n.t('settings:livetv.logos.cornersLabel')}: <strong>{channelLogoRoundEdges ? i18n.t('settings:livetv.logos.roundedPx', { radius: previewRadius }) : i18n.t('settings:livetv.logos.squarePx')}</strong>
              </div>
            </div>
          </div>

          {/* Prefer EPG channel logos globally */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:livetv.logos.preferEpgLogos')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.logos.preferEpgLogosSub')}</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={epgPreferEpgLogos}
                onChange={(e) => onEpgPreferEpgLogosChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {/* Display Icons as square or rectangle */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:livetv.logos.displayIcons')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.logos.displayIconsSub')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                value={epgLogoDisplay}
                onChange={(e) => onEpgLogoDisplayChange(e.target.value as 'square' | 'rectangle')}
                style={{ padding: '6px 12px', borderRadius: '6px', background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--surface-border)' }}
              >
                <option value="square">{i18n.t('settings:livetv.logos.squareDefault')}</option>
                <option value="rectangle">{i18n.t('settings:livetv.logos.rectangleHorizontal')}</option>
              </select>
              <button
                type="button"
                className="sync-btn"
                onClick={() => setShowSourceDrawer(!showSourceDrawer)}
                style={{ fontSize: '0.8rem', padding: '6px 12px' }}
              >
                {showSourceDrawer ? i18n.t('settings:livetv.logos.closeOverrides') : i18n.t('settings:livetv.logos.perSourceOverrides')}
              </button>
            </div>
          </div>

          {showSourceDrawer && (
            <div style={{ marginTop: 12, padding: 14, background: 'var(--bg-tertiary, #1e1e24)', borderRadius: 8, border: '1px solid var(--surface-border)' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
                {i18n.t('settings:livetv.logos.perSourceOverridesTitle')}
              </div>
              <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
                {i18n.t('settings:livetv.logos.perSourceOverridesSub')}
              </div>

              {sources.length === 0 ? (
                <div style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  {i18n.t('settings:livetv.logos.noSources')}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sources.map((src) => {
                    const currentOverride: string = sourceLogoDisplayOverrides[src.id] || 'default';
                    return (
                      <div
                        key={src.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '8px 12px',
                          background: 'rgba(255,255,255,0.04)',
                          borderRadius: 6,
                          border: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        <div>
                          <span style={{ fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                            {src.name}
                          </span>
                          <span style={{ marginLeft: 8, fontSize: '0.72rem', color: 'var(--text-secondary)', opacity: 0.7 }}>
                            ({src.type || 'M3U'})
                          </span>
                        </div>

                        <div className="card-segmented-control" style={{ width: 240, margin: 0 }}>
                          <button
                            type="button"
                            className={`segmented-btn ${currentOverride === 'default' ? 'active' : ''}`}
                            onClick={() => onSetSourceLogoDisplayOverride(src.id, 'default')}
                          >
                            {i18n.t('common:default')}
                          </button>
                          <button
                            type="button"
                            className={`segmented-btn ${currentOverride === 'square' ? 'active' : ''}`}
                            onClick={() => onSetSourceLogoDisplayOverride(src.id, 'square')}
                          >
                            {i18n.t('common:square')}
                          </button>
                          <button
                            type="button"
                            className={`segmented-btn ${currentOverride === 'rectangle' ? 'active' : ''}`}
                            onClick={() => onSetSourceLogoDisplayOverride(src.id, 'rectangle')}
                          >
                            {i18n.t('common:rectangle')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Channel Logo Caching ── */}
      <div className="settings-section" style={{ marginTop: '24px' }}>
        <div className="section-header">
          <h3>{i18n.t('settings:livetv.logos.logoCaching')}</h3>
        </div>
        <p className="section-description">
          {i18n.t('settings:livetv.logos.logoCachingSub')}
        </p>

        <div className="timeshift-settings">
          {/* Enable toggle */}
          <div className="timeshift-toggle-row">
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:livetv.logos.enableCaching')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.logos.enableCachingSub')}</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={logoCacheEnabled}
                onChange={(e) => onLogoCacheEnabledChange(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          {logoCacheEnabled && (
            <>
              {/* Maximum Cache Size Presets */}
              <div style={{ marginTop: '20px' }}>
                <div className="timeshift-presets-label">{i18n.t('settings:livetv.logos.maxCacheSize')}</div>
                <div className="timeshift-presets" style={{ marginTop: '8px' }}>
                  {SIZE_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      className={`timeshift-preset-btn ${logoCacheMaxMb === preset.value ? 'active' : ''}`}
                      onClick={() => onLogoCacheMaxMbChange(preset.value)}
                    >
                      {i18n.t(preset.labelKey, { defaultValue: preset.labelKey })}
                    </button>
                  ))}
                </div>
              </div>

              {/* Cache Expiration Presets */}
              <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--surface-border)' }}>
                <div className="timeshift-presets-label">{i18n.t('settings:livetv.logos.cacheExpiration')}</div>
                <div className="timeshift-presets" style={{ marginTop: '8px' }}>
                  {TTL_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      className={`timeshift-preset-btn ${logoCacheTtlDays === preset.value ? 'active' : ''}`}
                      onClick={() => onLogoCacheTtlDaysChange(preset.value)}
                    >
                      {preset.count ? i18n.t(preset.labelKey, { count: preset.count, defaultValue: preset.labelKey }) : i18n.t(preset.labelKey, { defaultValue: preset.labelKey })}
                    </button>
                  ))}
                </div>
              </div>

              {/* Cache Usage Stats & Controls */}
              <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--surface-border)' }}>
                <div className="timeshift-presets-label" style={{ marginBottom: '8px' }}>
                  {i18n.t('settings:livetv.logos.cacheUsageStats')}
                </div>

                <div
                  style={{
                    background: 'var(--bg-tertiary, #1e1e24)',
                    padding: '16px',
                    borderRadius: '8px',
                    border: '1px solid var(--surface-border, rgba(255,255,255,0.08))',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {stats ? i18n.t('settings:livetv.logos.cachedLogos', { count: stats.total_files }) : i18n.t('settings:livetv.logos.loadingStats')}
                    </span>
                    <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                      {formatBytes(usedBytes)} {logoCacheMaxMb > 0 ? `/ ${logoCacheMaxMb} MB` : ''}
                    </span>
                  </div>

                  {logoCacheMaxMb > 0 && (
                    <div
                      style={{
                        width: '100%',
                        height: '8px',
                        background: 'rgba(255,255,255,0.1)',
                        borderRadius: '4px',
                        overflow: 'hidden',
                        marginBottom: '16px',
                      }}
                    >
                      <div
                        style={{
                          width: `${usagePercent}%`,
                          height: '100%',
                          background: usagePercent > 90 ? '#e05252' : 'var(--accent-color, #3b82f6)',
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '12px' }}>
                    <button
                      className="sync-btn"
                      onClick={handleClearCache}
                      disabled={isClearing}
                      style={{
                        maxWidth: '200px',
                        background: 'rgba(224, 82, 82, 0.15)',
                        color: '#ff6b6b',
                        borderColor: 'rgba(224, 82, 82, 0.3)',
                      }}
                    >
                      {isClearing ? i18n.t('common:clearing') : i18n.t('settings:livetv.logos.clearLogoCache')}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
