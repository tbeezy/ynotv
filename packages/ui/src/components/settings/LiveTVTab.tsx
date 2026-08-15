import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { ChannelsTab } from './ChannelsTab';
import { LiveViewTab } from './LiveViewTab';
import { WidgetsTab } from './WidgetsTab';
import { LogosTab } from './LogosTab';
import './PlaybackTab.css'; // Reuse existing tab styles

export type LiveTVSubTabId = 'epg' | 'logos' | 'font-size' | 'sort-order' | 'search' | 'live-view' | 'widgets' | 'favorites';

interface LiveTVTabProps {
  initialSubTab?: LiveTVSubTabId;
  // Logo Cache props
  logoCacheEnabled: boolean;
  onLogoCacheEnabledChange: (enabled: boolean) => void;
  logoCacheMaxMb: number;
  onLogoCacheMaxMbChange: (maxMb: number) => void;
  logoCacheTtlDays: number;
  onLogoCacheTtlDaysChange: (days: number) => void;
  logoCachePrefetch: boolean;
  onLogoCachePrefetchChange: (prefetch: boolean) => void;
  // EPG props
  epgDarkenCurrent: boolean;
  onEpgDarkenCurrentChange: (enabled: boolean) => void;
  epgHighlightBorderCurrent: boolean;
  onEpgHighlightBorderCurrentChange: (enabled: boolean) => void;
  epgVisibleHours: 'auto' | number;
  onEpgVisibleHoursChange: (hours: 'auto' | number) => void;
  epgClockFormat: '12h' | '24h';
  onEpgClockFormatChange: (format: '12h' | '24h') => void;
  epgShowDate?: boolean;
  onEpgShowDateChange?: (enabled: boolean) => void;
  epgBoldChannelNames: boolean;
  onEpgBoldChannelNamesChange: (enabled: boolean) => void;
  epgBoldTopCategories: boolean;
  onEpgBoldTopCategoriesChange: (enabled: boolean) => void;
  epgBoldSourceCategories: boolean;
  onEpgBoldSourceCategoriesChange: (enabled: boolean) => void;
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
  epgMetadataBadgeResolution: boolean;
  onEpgMetadataBadgeResolutionChange: (enabled: boolean) => void;
  epgMetadataBadgeFps: boolean;
  onEpgMetadataBadgeFpsChange: (enabled: boolean) => void;
  epgMetadataBadgeFpsSuffix: boolean;
  onEpgMetadataBadgeFpsSuffixChange: (enabled: boolean) => void;
  epgMetadataBadgeSound: boolean;
  onEpgMetadataBadgeSoundChange: (enabled: boolean) => void;
  epgView: 'traditional' | 'alternate';
  onEpgViewChange: (view: 'traditional' | 'alternate') => void;
  epgTitleFontSize: number;
  onEpgTitleFontSizeChange: (size: number) => void;
  epgBodyFontSize: number;
  onEpgBodyFontSizeChange: (size: number) => void;
  // Font Size props
  channelFontSize: number;
  onChannelFontSizeChange: (size: number) => void;
  categoryFontSize: number;
  onCategoryFontSizeChange: (size: number) => void;
  sourceFontSize: number;
  onSourceFontSizeChange: (size: number) => void;
  // Sort Order props (from ChannelsTab)
  channelSortOrder: 'alphabetical' | 'number' | 'provider';
  onChannelSortOrderChange: (order: 'alphabetical' | 'number' | 'provider') => void;
  categorySortOrder: 'default' | 'alphabetical';
  onCategorySortOrderChange: (order: 'default' | 'alphabetical') => void;
  includeSourceInSearch: boolean;
  onIncludeSourceInSearchChange: (enabled: boolean) => void;
  includeSourceInVodSearch: boolean;
  onIncludeSourceInVodSearchChange: (enabled: boolean) => void;
  maxSearchResults: number;
  onMaxSearchResultsChange: (limit: number) => void;
  searchResultsOrder: 'default' | 'alphabetical';
  onSearchResultsOrderChange: (order: 'default' | 'alphabetical') => void;
  includeAllChannelsToPlaylist: boolean;
  onIncludeAllChannelsToPlaylistChange: (enabled: boolean) => void;
  // Channel Overlay props
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
  channelInfoOverlayPosition: 'left' | 'right';
  onChannelInfoOverlayPositionChange: (pos: 'left' | 'right') => void;
  channelInfoOverlayLogoShape: 'square' | 'horizontal';
  onChannelInfoOverlayLogoShapeChange: (shape: 'square' | 'horizontal') => void;
  failoverGroupShowSource: boolean;
  onFailoverGroupShowSourceChange: (enabled: boolean) => void;
  // Widgets props
  widgetScale: number;
  onWidgetScaleChange: (scale: number) => void;
  widgetBgOpacity: number;
  onWidgetBgOpacityChange: (opacity: number) => void;
  sportsScale: number;
  onSportsScaleChange: (scale: number) => void;
  sportsBgOpacity: number;
  onSportsBgOpacityChange: (opacity: number) => void;
  // Transparent guide overlay props
  transparentGuideHeight: number;
  onTransparentGuideHeightChange: (height: number) => void;
  transparentGuideHideHeader: boolean;
  onTransparentGuideHideHeaderChange: (hide: boolean) => void;
  transparentGuideOnZap: boolean;
  onTransparentGuideOnZapChange: (enabled: boolean) => void;
  transparentGuideOverlayOpacity: number;
  onTransparentGuideOverlayOpacityChange: (opacity: number) => void;
  transparentGuideSidebarOpacity: number;
  onTransparentGuideSidebarOpacityChange: (opacity: number) => void;
  favoritesMode: 'global' | 'perSource' | 'both';
  onFavoritesModeChange: (mode: 'global' | 'perSource' | 'both') => void;
  modernUiEnabled?: boolean | string;
}

export function LiveTVTab({
  initialSubTab,
  logoCacheEnabled,
  onLogoCacheEnabledChange,
  logoCacheMaxMb,
  onLogoCacheMaxMbChange,
  logoCacheTtlDays,
  onLogoCacheTtlDaysChange,
  logoCachePrefetch,
  onLogoCachePrefetchChange,
  epgDarkenCurrent,
  onEpgDarkenCurrentChange,
  epgHighlightBorderCurrent,
  onEpgHighlightBorderCurrentChange,
  epgVisibleHours,
  onEpgVisibleHoursChange,
  epgClockFormat,
  onEpgClockFormatChange,
  epgShowDate = false,
  onEpgShowDateChange,
  epgBoldChannelNames,
  onEpgBoldChannelNamesChange,
  epgBoldTopCategories,
  onEpgBoldTopCategoriesChange,
  epgBoldSourceCategories,
  onEpgBoldSourceCategoriesChange,
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
  epgMetadataBadgeResolution,
  onEpgMetadataBadgeResolutionChange,
  epgMetadataBadgeFps,
  onEpgMetadataBadgeFpsChange,
  epgMetadataBadgeFpsSuffix,
  onEpgMetadataBadgeFpsSuffixChange,
  epgMetadataBadgeSound,
  onEpgMetadataBadgeSoundChange,
  epgView,
  onEpgViewChange,
  epgTitleFontSize,
  onEpgTitleFontSizeChange,
  epgBodyFontSize,
  onEpgBodyFontSizeChange,
  channelFontSize,
  onChannelFontSizeChange,
  categoryFontSize,
  onCategoryFontSizeChange,
  sourceFontSize,
  onSourceFontSizeChange,
  channelSortOrder,
  onChannelSortOrderChange,
  categorySortOrder,
  onCategorySortOrderChange,
  includeSourceInSearch,
  onIncludeSourceInSearchChange,
  includeSourceInVodSearch,
  onIncludeSourceInVodSearchChange,
  maxSearchResults,
  onMaxSearchResultsChange,
  searchResultsOrder,
  onSearchResultsOrderChange,
  includeAllChannelsToPlaylist,
  onIncludeAllChannelsToPlaylistChange,
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
  channelInfoOverlayPosition,
  onChannelInfoOverlayPositionChange,
  channelInfoOverlayLogoShape,
  onChannelInfoOverlayLogoShapeChange,
  failoverGroupShowSource,
  onFailoverGroupShowSourceChange,
  widgetScale,
  onWidgetScaleChange,
  widgetBgOpacity,
  onWidgetBgOpacityChange,
  sportsScale,
  onSportsScaleChange,
  sportsBgOpacity,
  onSportsBgOpacityChange,
  transparentGuideHeight,
  onTransparentGuideHeightChange,
  transparentGuideHideHeader,
  onTransparentGuideHideHeaderChange,
  transparentGuideOnZap,
  onTransparentGuideOnZapChange,
  transparentGuideOverlayOpacity,
  onTransparentGuideOverlayOpacityChange,
  transparentGuideSidebarOpacity,
  onTransparentGuideSidebarOpacityChange,
  favoritesMode,
  onFavoritesModeChange,
  modernUiEnabled,
}: LiveTVTabProps) {
  useTranslation();
  const [activeSubTab, setActiveSubTab] = useState<LiveTVSubTabId>('epg');

  useEffect(() => {
    if (initialSubTab) {
      setActiveSubTab(initialSubTab);
    }
  }, [initialSubTab]);

  return (
    <div className="playback-tab-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="settings-tabs" style={{ padding: '0 20px', flexShrink: 0 }}>
        <button
          className={`settings-tab ${activeSubTab === 'epg' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('epg')}
        >
          {i18n.t('settings:livetv.tabs.epg')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'logos' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('logos')}
        >
          {i18n.t('settings:livetv.tabs.logos')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'font-size' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('font-size')}
        >
          {i18n.t('settings:livetv.tabs.fontSize')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'sort-order' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('sort-order')}
        >
          {i18n.t('settings:livetv.tabs.sortOrder')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'search' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('search')}
        >
          {i18n.t('settings:livetv.tabs.search')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'live-view' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('live-view')}
        >
          {i18n.t('settings:livetv.tabs.liveView')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'widgets' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('widgets')}
        >
          {i18n.t('settings:livetv.tabs.widgets')}
        </button>
        <button
          className={`settings-tab ${activeSubTab === 'favorites' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('favorites')}
        >
          ⭐ {i18n.t('settings:livetv.favoritesTitle')}
        </button>
      </div>

      <div className="settings-tab-content">
        {activeSubTab === 'epg' && (
          <>
            <div className="settings-section">
              <div className="timeshift-settings" style={{ marginTop: 0 }}>
                {/* EPG Visible Hours */}
                <div className="timeshift-toggle-row">
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.epgVisibleHours')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.epgVisibleHoursSub')}</span>
                  </div>
                  <select
                    value={epgVisibleHours}
                    onChange={(e) => {
                      const val = e.target.value;
                      onEpgVisibleHoursChange(val === 'auto' ? 'auto' : parseInt(val, 10));
                    }}
                  >
                    <option value="auto">{i18n.t('settings:livetv.autoDefault')}</option>
                    <option value="2">{i18n.t('settings:livetv.hours', { count: 2 })}</option>
                    <option value="3">{i18n.t('settings:livetv.hours', { count: 3 })}</option>
                    <option value="4">{i18n.t('settings:livetv.hours', { count: 4 })}</option>
                    <option value="5">{i18n.t('settings:livetv.hours', { count: 5 })}</option>
                    <option value="6">{i18n.t('settings:livetv.hours', { count: 6 })}</option>
                  </select>
                </div>

                {/* EPG Clock Format */}
                <div className="timeshift-toggle-row">
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.epgClockFormat')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.epgClockFormatSub')}</span>
                  </div>
                  <select
                    value={epgClockFormat}
                    onChange={(e) => onEpgClockFormatChange(e.target.value as '12h' | '24h')}
                  >
                    <option value="12h">{i18n.t('settings:livetv.clock12')}</option>
                    <option value="24h">{i18n.t('settings:livetv.clock24')}</option>
                  </select>
                </div>

                {/* Show Date in EPG */}
                <div className="timeshift-toggle-row">
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.epgShowDate')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.epgShowDateSub')}</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={epgShowDate}
                      onChange={(e) => onEpgShowDateChange?.(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                {/* Enable darker current program block (v1 design only) */}
                {(modernUiEnabled === false || modernUiEnabled === 'v1') && (
                  <div className="timeshift-toggle-row">
                    <div className="timeshift-toggle-info">
                      <span className="timeshift-toggle-label">{i18n.t('settings:livetv.darkenCurrent')}</span>
                      <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.darkenCurrentSub')}</span>
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
                )}

                {/* Highlight border around current playing */}
                <div className="timeshift-toggle-row">
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.highlightCurrent')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.highlightCurrentSub')}</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={epgHighlightBorderCurrent}
                      onChange={(e) => onEpgHighlightBorderCurrentChange(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                {/* Preview example (v1 design only) */}
                {(modernUiEnabled === false || modernUiEnabled === 'v1') && (
                  <div style={{ marginTop: '24px', padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                    <h4 style={{ margin: '0 0 12px 0', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>{i18n.t('settings:livetv.preview')}</h4>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      {/* Regular program block */}
                      <div style={{
                        padding: '8px 12px',
                        background: 'var(--surface-color)',
                        borderRadius: '4px',
                        borderLeft: '2px solid transparent',
                        flex: 1,
                        fontSize: '0.8rem'
                      }}>
                        <span style={{ color: 'var(--text-secondary)' }}>{i18n.t('settings:livetv.otherProgram')}</span>
                      </div>
                      {/* Current program block */}
                      <div style={{
                        padding: '8px 12px',
                        background: epgDarkenCurrent
                          ? 'color-mix(in srgb, var(--accent-primary, #00d4ff) 25%, var(--bg-tertiary))'
                          : 'color-mix(in srgb, var(--accent-primary, #00d4ff) 8%, transparent)',
                        borderRadius: '4px',
                        borderLeft: '3px solid var(--accent-primary, #00d4ff)',
                        flex: 1,
                        fontSize: '0.8rem'
                      }}>
                        <span style={{ color: 'var(--text-primary)' }}>{i18n.t('settings:livetv.currentProgram')}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Metadata Badges Settings */}
            <div className="settings-section">
              <div className="section-header">
                <h3 style={{ color: 'var(--text-primary, #ffffff)', fontSize: '1rem', fontWeight: 600, textTransform: 'none', letterSpacing: 'normal' }}>
                  {i18n.t('settings:livetv.metadataBadgesTitle')}
                </h3>
              </div>
              <p className="section-description">
                {i18n.t('settings:livetv.metadataBadgesDescription')}
              </p>

              <div style={{ marginTop: '16px', overflowX: 'auto' }}>
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.9rem',
                  background: 'var(--bg-tertiary)',
                  borderRadius: '8px',
                  overflow: 'hidden'
                }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-color)', borderBottom: '1px solid var(--surface-border)' }}>
                      <th style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem' }}>{i18n.t('settings:livetv.resolution')}</th>
                      <th style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem' }}>{i18n.t('settings:livetv.fps')}</th>
                      <th style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem' }}>{i18n.t('settings:livetv.sound')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ padding: '16px', textAlign: 'center', borderRight: '1px solid var(--surface-border)' }}>
                        <label className="toggle-switch" style={{ margin: '0 auto' }}>
                          <input
                            type="checkbox"
                            checked={epgMetadataBadgeResolution}
                            onChange={(e) => onEpgMetadataBadgeResolutionChange(e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </td>
                      <td style={{ padding: '16px', textAlign: 'center', borderRight: '1px solid var(--surface-border)' }}>
                        <label className="toggle-switch" style={{ margin: '0 auto' }}>
                          <input
                            type="checkbox"
                            checked={epgMetadataBadgeFps}
                            onChange={(e) => onEpgMetadataBadgeFpsChange(e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </td>
                      <td style={{ padding: '16px', textAlign: 'center' }}>
                        <label className="toggle-switch" style={{ margin: '0 auto' }}>
                          <input
                            type="checkbox"
                            checked={epgMetadataBadgeSound}
                            onChange={(e) => onEpgMetadataBadgeSoundChange(e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:livetv.fpsSuffix')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.fpsSuffixSub')}</span>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={epgMetadataBadgeFpsSuffix}
                    onChange={(e) => onEpgMetadataBadgeFpsSuffixChange(e.target.checked)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>

            {/* Bold Typography Settings - hidden for v3 design */}
            {modernUiEnabled !== 'v3' && <div className="settings-section">
              <div className="section-header">
                <h3 style={{ color: 'var(--text-primary, #ffffff)', fontSize: '1rem', fontWeight: 600, textTransform: 'none', letterSpacing: 'normal' }}>
                  {i18n.t('settings:livetv.boldTypography')}
                </h3>
              </div>
              <p className="section-description">
                {i18n.t('settings:livetv.boldTypographySub')}
              </p>

              <div style={{ marginTop: '16px', overflowX: 'auto' }}>
                <table style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.9rem',
                  background: 'var(--bg-tertiary)',
                  borderRadius: '8px',
                  overflow: 'hidden'
                }}>
                  <thead>
                    <tr style={{ background: 'var(--surface-color)', borderBottom: '1px solid var(--surface-border)' }}>
                      <th style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem' }}>{i18n.t('settings:livetv.channelNames')}</th>
                      <th style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem' }}>{i18n.t('settings:livetv.topCategories')}</th>
                      <th style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontWeight: 600, fontSize: '0.85rem' }}>{i18n.t('settings:livetv.sourceCategories')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ padding: '16px', textAlign: 'center', borderRight: '1px solid var(--surface-border)' }}>
                        <label className="toggle-switch" style={{ margin: '0 auto' }}>
                          <input
                            type="checkbox"
                            checked={epgBoldChannelNames}
                            onChange={(e) => onEpgBoldChannelNamesChange(e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </td>
                      <td style={{ padding: '16px', textAlign: 'center', borderRight: '1px solid var(--surface-border)' }}>
                        <label className="toggle-switch" style={{ margin: '0 auto' }}>
                          <input
                            type="checkbox"
                            checked={epgBoldTopCategories}
                            onChange={(e) => onEpgBoldTopCategoriesChange(e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </td>
                      <td style={{ padding: '16px', textAlign: 'center' }}>
                        <label className="toggle-switch" style={{ margin: '0 auto' }}>
                          <input
                            type="checkbox"
                            checked={epgBoldSourceCategories}
                            onChange={(e) => onEpgBoldSourceCategoriesChange(e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>}

            {/* EPG Font Size Settings */}
            <div className="settings-section">
              <div className="section-header">
                <h3 style={{ color: 'var(--text-primary, #ffffff)', fontSize: '1rem', fontWeight: 600, textTransform: 'none', letterSpacing: 'normal' }}>
                  {i18n.t('settings:livetv.epgPreviewFontSizes')}
                </h3>
              </div>
              <p className="section-description">
                {i18n.t('settings:livetv.epgPreviewFontSizesSub')}
              </p>

              <div className="timeshift-settings">
                {/* EPG Title Font Size */}
                <div className="form-group" style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:livetv.titleFontSize')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <input
                      type="range"
                      min="16"
                      max="64"
                      value={epgTitleFontSize}
                      onChange={(e) => onEpgTitleFontSizeChange(parseInt(e.target.value))}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {epgTitleFontSize}px
                    </span>
                  </div>
                  <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                    {i18n.t('settings:livetv.previewLabel')}: <span style={{ fontSize: `${epgTitleFontSize}px`, color: '#00d4ff' }}>{i18n.t('settings:livetv.programTitleExample')}</span>
                  </p>
                </div>

                {/* EPG Body Font Size */}
                <div className="form-group" style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:livetv.bodyTextFontSize')}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <input
                      type="range"
                      min="10"
                      max="32"
                      value={epgBodyFontSize}
                      onChange={(e) => onEpgBodyFontSizeChange(parseInt(e.target.value))}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                      {epgBodyFontSize}px
                    </span>
                  </div>
                  <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                    {i18n.t('settings:livetv.previewLabel')}: <span style={{ fontSize: `${epgBodyFontSize}px`, color: '#00d4ff' }}>{i18n.t('settings:livetv.programDescExample')}</span>
                  </p>
                </div>

                {/* Reset Button */}
                <div style={{ marginTop: '16px' }}>
                  <button
                    className="sync-btn"
                    onClick={() => {
                      onEpgTitleFontSizeChange(32);
                      onEpgBodyFontSizeChange(16);
                    }}
                    style={{ maxWidth: '200px' }}
                  >
                    {i18n.t('common:resetToDefault')}
                  </button>
                </div>
              </div>
            </div>

            {/* Preview Panel Settings */}
            <div className="settings-section">
              <div className="section-header">
                <h3 style={{ color: 'var(--text-primary, #ffffff)', fontSize: '1rem', fontWeight: 600, textTransform: 'none', letterSpacing: 'normal' }}>
                  {i18n.t('settings:livetv.previewPanel')}
                </h3>
              </div>
              <p className="section-description">
                {i18n.t('settings:livetv.previewPanelSub')}
              </p>

              <div className="timeshift-settings">
                {/* EPG View Dropdown */}
                <div className="timeshift-toggle-row">
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.epgViewLayout')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.epgViewLayoutSub')}</span>
                  </div>
                  <select
                    value={epgView}
                    onChange={(e) => onEpgViewChange(e.target.value as 'traditional' | 'alternate')}
                  >
                    <option value="traditional">{i18n.t('settings:livetv.traditionalView')}</option>
                    <option value="alternate">{i18n.t('settings:livetv.alternateView')}</option>
                  </select>
                </div>

              </div>
            </div>

            {/* Transparent EPG Overlay Settings */}
            <div className="settings-section">
              <div className="section-header">
                <h3 style={{ color: 'var(--text-primary, #ffffff)', fontSize: '1rem', fontWeight: 600, textTransform: 'none', letterSpacing: 'normal' }}>
                  {i18n.t('settings:livetv.transparentOverlay')}
                </h3>
              </div>
              <p className="section-description">
                {i18n.t('settings:livetv.transparentOverlaySub')}
              </p>

              <div className="timeshift-settings">
                <div className="timeshift-toggle-row">
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.overlayHeight')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.overlayHeightSub')}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      min="25"
                      max="100"
                      value={transparentGuideHeight}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (!isNaN(val)) onTransparentGuideHeightChange(val);
                      }}
                      style={{ width: '70px', padding: '4px 8px', textAlign: 'center' }}
                    />
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>%</span>
                    <input
                      type="range"
                      min="25"
                      max="100"
                      value={transparentGuideHeight}
                      onChange={(e) => onTransparentGuideHeightChange(parseInt(e.target.value))}
                      style={{ width: '120px' }}
                    />
                  </div>
                </div>

                <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.hideTopRow')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.hideTopRowSub')}</span>
                  </div>
                  <label className="toggle-switch" style={{ position: 'relative', display: 'inline-block', width: '44px', height: '24px', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={transparentGuideHideHeader}
                      onChange={(e) => onTransparentGuideHideHeaderChange(e.target.checked)}
                      style={{ opacity: 0, width: 0, height: 0 }}
                    />
                    <span style={{
                      position: 'absolute', cursor: 'pointer', inset: 0,
                      backgroundColor: transparentGuideHideHeader ? 'var(--accent-primary, #00d4ff)' : 'var(--surface-color)',
                      borderRadius: '24px',
                      transition: 'background-color 0.2s',
                    }}>
                      <span style={{
                        position: 'absolute', top: '2px',
                        left: transparentGuideHideHeader ? '22px' : '2px',
                        width: '20px', height: '20px', borderRadius: '50%',
                        backgroundColor: 'var(--text-primary)', transition: 'left 0.2s',
                      }} />
                    </span>
                  </label>
                </div>

                <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.displayOnZap')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.displayOnZapSub')}</span>
                  </div>
                  <label className="toggle-switch" style={{ position: 'relative', display: 'inline-block', width: '44px', height: '24px', flexShrink: 0 }}>
                    <input
                      type="checkbox"
                      checked={transparentGuideOnZap}
                      onChange={(e) => onTransparentGuideOnZapChange(e.target.checked)}
                      style={{ opacity: 0, width: 0, height: 0 }}
                    />
                    <span style={{
                      position: 'absolute', cursor: 'pointer', inset: 0,
                      backgroundColor: transparentGuideOnZap ? 'var(--accent-primary, #00d4ff)' : 'var(--surface-color)',
                      borderRadius: '24px',
                      transition: 'background-color 0.2s',
                    }}>
                      <span style={{
                        position: 'absolute', top: '2px',
                        left: transparentGuideOnZap ? '22px' : '2px',
                        width: '20px', height: '20px', borderRadius: '50%',
                        backgroundColor: 'var(--text-primary)', transition: 'left 0.2s',
                      }} />
                    </span>
                  </label>
                </div>

                <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.epgOverlayOpacity')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.epgOverlayOpacitySub')}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={transparentGuideOverlayOpacity}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (!isNaN(val)) onTransparentGuideOverlayOpacityChange(val);
                      }}
                      style={{ width: '70px', padding: '4px 8px', textAlign: 'center' }}
                    />
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>%</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={transparentGuideOverlayOpacity}
                      onChange={(e) => onTransparentGuideOverlayOpacityChange(parseInt(e.target.value))}
                      style={{ width: '120px' }}
                    />
                  </div>
                </div>

                <div className="timeshift-toggle-row" style={{ marginTop: '12px' }}>
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label">{i18n.t('settings:livetv.sidebarOpacity')}</span>
                    <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.sidebarOpacitySub')}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={transparentGuideSidebarOpacity}
                      onChange={(e) => {
                        const val = parseInt(e.target.value);
                        if (!isNaN(val)) onTransparentGuideSidebarOpacityChange(val);
                      }}
                      style={{ width: '70px', padding: '4px 8px', textAlign: 'center' }}
                    />
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>%</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={transparentGuideSidebarOpacity}
                      onChange={(e) => onTransparentGuideSidebarOpacityChange(parseInt(e.target.value))}
                      style={{ width: '120px' }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {activeSubTab === 'font-size' && (
          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('settings:livetv.fontSizeTitle')}</h3>
            </div>

            <p className="section-description" style={{ marginBottom: '12px' }}>
              {i18n.t('settings:livetv.fontSizeSub')}
            </p>

            {/* Channel Font Size */}
            <div className="form-group" style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:livetv.channelFontSize')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <input
                  type="range"
                  min="10"
                  max="24"
                  value={channelFontSize}
                  onChange={(e) => onChannelFontSizeChange(parseInt(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                  {channelFontSize}px
                </span>
              </div>
              <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                {i18n.t('settings:livetv.previewLabel')}: <span style={{ fontSize: `${channelFontSize}px`, color: '#00d4ff' }}>{i18n.t('settings:livetv.channelNameExample')}</span>
              </p>
            </div>

            {/* Category Font Size */}
            <div className="form-group" style={{ marginBottom: '12px' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:livetv.categoryFontSize')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <input
                  type="range"
                  min="10"
                  max="24"
                  value={categoryFontSize}
                  onChange={(e) => onCategoryFontSizeChange(parseInt(e.target.value))}
                  style={{ flex: 1 }}
                />
                <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                  {categoryFontSize}px
                </span>
              </div>
              <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                {i18n.t('settings:livetv.previewLabel')}: <span style={{ fontSize: `${categoryFontSize}px`, color: '#00d4ff' }}>{i18n.t('settings:livetv.categoryNameExample')}</span>
              </p>
            </div>

            {/* Source Font Size */}
            {modernUiEnabled === 'v3' && (
              <div className="form-group" style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>{i18n.t('settings:livetv.sourceFontSize')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <input
                    type="range"
                    min="10"
                    max="24"
                    value={sourceFontSize}
                    onChange={(e) => onSourceFontSizeChange(parseInt(e.target.value))}
                    style={{ flex: 1 }}
                  />
                  <span style={{ minWidth: '3rem', textAlign: 'right', color: 'var(--text-primary)' }}>
                    {sourceFontSize}px
                  </span>
                </div>
                <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                  {i18n.t('settings:livetv.previewLabel')}: <span style={{ fontSize: `${sourceFontSize}px`, color: '#00d4ff', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{i18n.t('settings:livetv.sourceNameExample')}</span>
                </p>
              </div>
            )}

            {/* Reset Button */}
            <div style={{ marginTop: '16px' }}>
              <button
                className="sync-btn"
                onClick={() => {
                  if (modernUiEnabled === 'v3') {
                    onChannelFontSizeChange(12);
                    onCategoryFontSizeChange(13);
                    onSourceFontSizeChange(12);
                  } else {
                    onChannelFontSizeChange(14);
                    onCategoryFontSizeChange(14);
                  }
                }}
                style={{ maxWidth: '200px' }}
              >
                {i18n.t('common:resetToDefault')}
              </button>
            </div>
          </div>
        )}

        {(activeSubTab === 'sort-order' || activeSubTab === 'search') && (
          <ChannelsTab
            channelSortOrder={channelSortOrder}
            onChannelSortOrderChange={onChannelSortOrderChange}
            categorySortOrder={categorySortOrder}
            onCategorySortOrderChange={onCategorySortOrderChange}
            includeSourceInSearch={includeSourceInSearch}
            onIncludeSourceInSearchChange={onIncludeSourceInSearchChange}
            includeSourceInVodSearch={includeSourceInVodSearch}
            onIncludeSourceInVodSearchChange={onIncludeSourceInVodSearchChange}
            maxSearchResults={maxSearchResults}
            onMaxSearchResultsChange={onMaxSearchResultsChange}
            searchResultsOrder={searchResultsOrder}
            onSearchResultsOrderChange={onSearchResultsOrderChange}
            includeAllChannelsToPlaylist={includeAllChannelsToPlaylist}
            onIncludeAllChannelsToPlaylistChange={onIncludeAllChannelsToPlaylistChange}
            showMode={activeSubTab === 'sort-order' ? 'sort-order' : 'search'}
          />
        )}

        {activeSubTab === 'logos' && (
          <LogosTab
            epgPreferEpgLogos={epgPreferEpgLogos}
            onEpgPreferEpgLogosChange={onEpgPreferEpgLogosChange}
            epgLogoDisplay={epgLogoDisplay}
            onEpgLogoDisplayChange={onEpgLogoDisplayChange}
            channelLogoSize={channelLogoSize}
            onChannelLogoSizeChange={onChannelLogoSizeChange}
            channelLogoRoundEdges={channelLogoRoundEdges}
            onChannelLogoRoundEdgesChange={onChannelLogoRoundEdgesChange}
            channelLogoPadding={channelLogoPadding}
            onChannelLogoPaddingChange={onChannelLogoPaddingChange}
            logoSmartTrim={logoSmartTrim}
            onLogoSmartTrimChange={onLogoSmartTrimChange}
            logoLightBackgroundDetection={logoLightBackgroundDetection}
            onLogoLightBackgroundDetectionChange={onLogoLightBackgroundDetectionChange}
            sourceLogoDisplayOverrides={sourceLogoDisplayOverrides}
            onSetSourceLogoDisplayOverride={onSetSourceLogoDisplayOverride}
            logoCacheEnabled={logoCacheEnabled}
            onLogoCacheEnabledChange={onLogoCacheEnabledChange}
            logoCacheMaxMb={logoCacheMaxMb}
            onLogoCacheMaxMbChange={onLogoCacheMaxMbChange}
            logoCacheTtlDays={logoCacheTtlDays}
            onLogoCacheTtlDaysChange={onLogoCacheTtlDaysChange}
          />
        )}

        {activeSubTab === 'live-view' && (
          <LiveViewTab
            channelInfoOverlayEnabled={channelInfoOverlayEnabled}
            onChannelInfoOverlayChange={onChannelInfoOverlayChange}
            channelInfoOverlayFontSize={channelInfoOverlayFontSize}
            onChannelInfoOverlayFontSizeChange={onChannelInfoOverlayFontSizeChange}
            channelInfoOverlayLogoSize={channelInfoOverlayLogoSize}
            onChannelInfoOverlayLogoSizeChange={onChannelInfoOverlayLogoSizeChange}
            channelInfoOverlayBoxWidth={channelInfoOverlayBoxWidth}
            onChannelInfoOverlayBoxWidthChange={onChannelInfoOverlayBoxWidthChange}
            channelInfoOverlayOpacity={channelInfoOverlayOpacity}
            onChannelInfoOverlayOpacityChange={onChannelInfoOverlayOpacityChange}
            channelInfoOverlayHideDescription={channelInfoOverlayHideDescription}
            onChannelInfoOverlayHideDescriptionChange={onChannelInfoOverlayHideDescriptionChange}
            channelInfoOverlayHideMetaBadge={channelInfoOverlayHideMetaBadge}
            onChannelInfoOverlayHideMetaBadgeChange={onChannelInfoOverlayHideMetaBadgeChange}
            channelInfoOverlayHideLogo={channelInfoOverlayHideLogo}
            onChannelInfoOverlayHideLogoChange={onChannelInfoOverlayHideLogoChange}
            channelInfoOverlayHideTimer={channelInfoOverlayHideTimer}
            onChannelInfoOverlayHideTimerChange={onChannelInfoOverlayHideTimerChange}
            channelInfoOverlayPosition={channelInfoOverlayPosition}
            onChannelInfoOverlayPositionChange={onChannelInfoOverlayPositionChange}
            channelInfoOverlayLogoShape={channelInfoOverlayLogoShape}
            onChannelInfoOverlayLogoShapeChange={onChannelInfoOverlayLogoShapeChange}
            failoverGroupShowSource={failoverGroupShowSource}
            onFailoverGroupShowSourceChange={onFailoverGroupShowSourceChange}
          />
        )}

        {activeSubTab === 'widgets' && (
          <WidgetsTab
            widgetScale={widgetScale}
            onWidgetScaleChange={onWidgetScaleChange}
            widgetBgOpacity={widgetBgOpacity}
            onWidgetBgOpacityChange={onWidgetBgOpacityChange}
            sportsScale={sportsScale}
            onSportsScaleChange={onSportsScaleChange}
            sportsBgOpacity={sportsBgOpacity}
            onSportsBgOpacityChange={onSportsBgOpacityChange}
          />
        )}

        {activeSubTab === 'favorites' && (
          <div className="settings-section">
            <div className="section-header">
              <h3>{i18n.t('settings:livetv.favoritesTitle')}</h3>
            </div>
            <p className="section-description">
              {i18n.t('settings:livetv.favoritesSub')}
            </p>

            <div className="timeshift-settings" style={{ marginTop: '12px' }}>
              <div className="timeshift-toggle-row">
                <div className="timeshift-toggle-info">
                  <span className="timeshift-toggle-label">{i18n.t('settings:livetv.favoritesMode')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:livetv.favoritesModeSub')}</span>
                </div>
                <select
                  value={favoritesMode}
                  onChange={(e) => onFavoritesModeChange(e.target.value as 'global' | 'perSource' | 'both')}
                >
                  <option value="global">{i18n.t('settings:livetv.favoritesModeGlobal')}</option>
                  <option value="perSource">{i18n.t('settings:livetv.favoritesModePerSource')}</option>
                  <option value="both">{i18n.t('settings:livetv.favoritesModeBoth')}</option>
                </select>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
