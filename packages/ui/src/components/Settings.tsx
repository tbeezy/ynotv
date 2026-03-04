import { useState, useEffect, useCallback } from 'react';
import type { Source } from '@ynotv/core';
import { SettingsSidebar, type SettingsTabId } from './settings/SettingsSidebar';
import { SourcesTab } from './settings/SourcesTab';
import { TmdbTab } from './settings/TmdbTab';
import { DataRefreshTab } from './settings/DataRefreshTab';
import { ChannelsTab } from './settings/ChannelsTab';
import { MoviesTab } from './settings/MoviesTab';
import { SeriesTab } from './settings/SeriesTab';
import { PosterDbTab } from './settings/PosterDbTab';
import { SecurityTab } from './settings/SecurityTab';
import { DebugTab } from './settings/DebugTab';
import { ShortcutsTab } from './settings/ShortcutsTab';
import { ImportExportTab } from './settings/ImportExportTab';
import { UITab } from './settings/UITab';
import { ThemeTab } from './settings/ThemeTab';
import { DvrTab } from './settings/DvrTab';
import { StartupTab, type SavedLayoutState } from './settings/StartupTab';
import { TVCalendarTab } from './settings/TVCalendarTab';
import { PlaybackTab } from './settings/PlaybackTab';
import { CacheTab } from './settings/CacheTab';
import { AboutTab } from './settings/AboutTab';
import { LiveTVTab } from './settings/LiveTVTab';
import type { ShortcutsMap, ThemeId } from '../types/app';
import './Settings.css';

interface SettingsProps {
  onClose: () => void;
  onShortcutsChange?: (shortcuts: ShortcutsMap) => void;
  theme?: ThemeId;
  onThemeChange?: (theme: ThemeId) => void;
  initialTab?: SettingsTabId;
  editSourceId?: string | null;
}

export function Settings({ onClose, onShortcutsChange, theme, onThemeChange, initialTab = 'sources', editSourceId = null }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
  const [sources, setSources] = useState<Source[]>([]);
  const [isEncryptionAvailable, setIsEncryptionAvailable] = useState(true);

  // TMDB API key state
  const [tmdbApiKey, setTmdbApiKey] = useState('');
  const [tmdbKeyValid, setTmdbKeyValid] = useState<boolean | null>(null);
  const [tmdbMatchingEnabled, setTmdbMatchingEnabled] = useState(true);

  // Refresh settings state
  const [vodRefreshHours, setVodRefreshHours] = useState(24);
  const [epgRefreshHours, setEpgRefreshHours] = useState(6);

  // Genre settings state
  const [movieGenresEnabled, setMovieGenresEnabled] = useState<number[] | undefined>(undefined);
  const [seriesGenresEnabled, setSeriesGenresEnabled] = useState<number[] | undefined>(undefined);

  // PosterDB state
  const [posterDbApiKey, setPosterDbApiKey] = useState('');
  const [posterDbKeyValid, setPosterDbKeyValid] = useState<boolean | null>(null);
  const [rpdbBackdropsEnabled, setRpdbBackdropsEnabled] = useState(false);

  // Security state
  const [allowLanSources, setAllowLanSources] = useState(false);

  // Debug state
  const [debugLoggingEnabled, setDebugLoggingEnabled] = useState(false);

  // Channel display state
  const [channelSortOrder, setChannelSortOrder] = useState<'alphabetical' | 'number'>('alphabetical');
  const [includeSourceInSearch, setIncludeSourceInSearch] = useState(false);

  // Shortcuts state
  const [shortcuts, setShortcuts] = useState<ShortcutsMap>({});

  // UI state
  const [uiSettings, setUiSettings] = useState<{
    channelFontSize: number;
    categoryFontSize: number;
    showSidebar: boolean;
    startupWidth?: number;
    startupHeight?: number;
  }>({
    channelFontSize: 14,
    categoryFontSize: 14,
    showSidebar: false,
  });

  // Startup settings state
  const [rememberLastChannels, setRememberLastChannels] = useState(false);
  const [reopenLastOnStartup, setReopenLastOnStartup] = useState(false);
  const [savedLayoutState, setSavedLayoutState] = useState<SavedLayoutState | null>(null);

  // Playback settings state
  const [mpvParams, setMpvParams] = useState<string>('');
  const [timeshiftEnabled, setTimeshiftEnabled] = useState(false);
  const [timeshiftCacheBytes, setTimeshiftCacheBytes] = useState(1_073_741_824);
  const [liveBufferOffset, setLiveBufferOffset] = useState(0);

  // LiveTV settings state
  const [epgDarkenCurrent, setEpgDarkenCurrent] = useState(false);

  // Loading state for settings
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load sources and check encryption on mount
  useEffect(() => {
    loadSources();
    checkEncryption();
    loadSettings();
  }, []);

  async function loadSources() {
    // window.storage is the Tauri storage bridge - if missing, app is broken
    if (!window.storage) {
      console.error('[Settings] window.storage unavailable - Tauri storage bridge missing');
      return;
    }
    const result = await window.storage.getSources();
    if (result.data) {
      // Debug: Check for duplicated EPG URLs
      result.data.forEach((source: Source) => {
        if (source.epg_url && source.epg_url.length > 100) {
          console.log(`[Settings] Source ${source.name} has long epg_url (${source.epg_url.length} chars):`, source.epg_url.substring(0, 100) + '...');
        }
      });
      setSources(result.data);
    }
  }

  async function checkEncryption() {
    if (!window.storage) {
      console.error('[Settings] window.storage unavailable - Tauri storage bridge missing');
      return;
    }
    const result = await window.storage.isEncryptionAvailable();
    if (result.data !== undefined) {
      setIsEncryptionAvailable(result.data);
    }
  }

  async function loadSettings() {
    if (!window.storage) {
      console.error('[Settings] window.storage unavailable - Tauri storage bridge missing');
      return;
    }
    const result = await window.storage.getSettings();
    if (result.data) {
      const settings = result.data as {
        tmdbApiKey?: string;
        vodRefreshHours?: number;
        epgRefreshHours?: number;
        movieGenresEnabled?: number[];
        seriesGenresEnabled?: number[];
        posterDbApiKey?: string;
        rpdbBackdropsEnabled?: boolean;
        allowLanSources?: boolean;
        debugLoggingEnabled?: boolean;
        channelSortOrder?: 'alphabetical' | 'number';
        includeSourceInSearch?: boolean;
        tmdbMatchingEnabled?: boolean;
        shortcuts?: ShortcutsMap;
        channelFontSize?: number;
        categoryFontSize?: number;
        showSidebar?: boolean;
        startupWidth?: number;
        startupHeight?: number;
        rememberLastChannels?: boolean;
        reopenLastOnStartup?: boolean;
        savedLayoutState?: SavedLayoutState;
        mpvParams?: string;
        timeshiftEnabled?: boolean;
        timeshiftCacheBytes?: number;
        liveBufferOffset?: number;
        epgDarkenCurrent?: boolean;
      };

      // Load TMDB API key
      const key = settings.tmdbApiKey || '';
      setTmdbApiKey(key);
      if (key) {
        setTmdbKeyValid(true); // Assume valid if previously saved
      }
      setTmdbMatchingEnabled(settings.tmdbMatchingEnabled ?? true);

      // Load refresh settings
      if (settings.vodRefreshHours !== undefined) {
        setVodRefreshHours(settings.vodRefreshHours);
      }
      if (settings.epgRefreshHours !== undefined) {
        setEpgRefreshHours(settings.epgRefreshHours);
      }

      // Load genre settings
      setMovieGenresEnabled(settings.movieGenresEnabled);
      setSeriesGenresEnabled(settings.seriesGenresEnabled);

      // Load PosterDB key
      const rpdbKey = settings.posterDbApiKey || '';
      setPosterDbApiKey(rpdbKey);
      if (rpdbKey) {
        setPosterDbKeyValid(true); // Assume valid if previously saved
      }
      setRpdbBackdropsEnabled(settings.rpdbBackdropsEnabled ?? false);

      // Load security settings
      setAllowLanSources(settings.allowLanSources ?? false);

      // Load debug settings
      setDebugLoggingEnabled(settings.debugLoggingEnabled ?? false);

      // Load channel display settings
      setChannelSortOrder(settings.channelSortOrder ?? 'alphabetical');
      setIncludeSourceInSearch(settings.includeSourceInSearch ?? false);

      // Load shortcuts
      if (settings.shortcuts) {
        setShortcuts(settings.shortcuts);
      }

      // Load UI settings
      const loadedUiSettings = {
        channelFontSize: settings.channelFontSize ?? 14,
        categoryFontSize: settings.categoryFontSize ?? 14,
        showSidebar: settings.showSidebar ?? false,
        startupWidth: settings.startupWidth,
        startupHeight: settings.startupHeight,
      };
      setUiSettings(loadedUiSettings);

      // Apply UI settings immediately
      document.documentElement.style.setProperty('--channel-font-size', `${loadedUiSettings.channelFontSize}px`);
      document.documentElement.style.setProperty('--category-font-size', `${loadedUiSettings.categoryFontSize}px`);

      // Load startup settings
      setRememberLastChannels(settings.rememberLastChannels ?? false);
      setReopenLastOnStartup(settings.reopenLastOnStartup ?? false);
      setSavedLayoutState(settings.savedLayoutState ?? null);

      // Load playback settings
      setMpvParams(settings.mpvParams ?? '');
      setTimeshiftEnabled(settings.timeshiftEnabled ?? false);
      setTimeshiftCacheBytes(settings.timeshiftCacheBytes ?? 1_073_741_824);
      setLiveBufferOffset(settings.liveBufferOffset ?? 0);

      // Load LiveTV settings
      const darkenCurrent = settings.epgDarkenCurrent ?? false;
      setEpgDarkenCurrent(darkenCurrent);
      // Apply CSS class on load
      if (darkenCurrent) {
        document.documentElement.classList.add('epg-darken-current');
      }
    }
    setSettingsLoaded(true);
  }

  // Check if any VOD source exists (Xtream or Stalker) for showing Movies/Series tabs
  const hasVodSource = sources.some(s => s.type === 'xtream' || s.type === 'stalker');

  // Reset to sources tab if current tab becomes hidden
  useEffect(() => {
    const libraryTabs: SettingsTabId[] = ['movies', 'series'];
    if (libraryTabs.includes(activeTab) && !hasVodSource) {
      setActiveTab('sources');
    }
  }, [hasVodSource, activeTab]);

  // Memoized callbacks for genre changes
  const handleMovieGenresChange = useCallback((genres: number[]) => {
    setMovieGenresEnabled(genres);
  }, []);

  const handleSeriesGenresChange = useCallback((genres: number[]) => {
    setSeriesGenresEnabled(genres);
  }, []);

  const handleMpvParamsChange = async (params: string) => {
    setMpvParams(params);
    if (window.storage) {
      await window.storage.updateSettings({ mpvParams: params });
    }
  };

  const handleTimeshiftChange = async (enabled: boolean, cacheBytes: number, bufferOffset?: number) => {
    setTimeshiftEnabled(enabled);
    setTimeshiftCacheBytes(cacheBytes);
    if (bufferOffset !== undefined) {
      setLiveBufferOffset(bufferOffset);
    }
    if (window.storage) {
      const settings: { timeshiftEnabled: boolean; timeshiftCacheBytes: number; liveBufferOffset?: number } = {
        timeshiftEnabled: enabled,
        timeshiftCacheBytes: cacheBytes,
      };
      if (bufferOffset !== undefined) {
        settings.liveBufferOffset = bufferOffset;
      }
      await window.storage.updateSettings(settings);
    }
  };

  const handleEpgDarkenCurrentChange = async (enabled: boolean) => {
    setEpgDarkenCurrent(enabled);
    // Apply CSS class to document for ProgramBlock to use
    if (enabled) {
      document.documentElement.classList.add('epg-darken-current');
    } else {
      document.documentElement.classList.remove('epg-darken-current');
    }
    if (window.storage) {
      await window.storage.updateSettings({ epgDarkenCurrent: enabled });
    }
  };

  const handleShortcutsChange = async (newShortcuts: ShortcutsMap) => {
    setShortcuts(newShortcuts);
    if (onShortcutsChange) {
      onShortcutsChange(newShortcuts);
    }
    if (window.storage) {
      await window.storage.updateSettings({ shortcuts: newShortcuts });
    }
  };

  const handleUiSettingsChange = async (newSettings: {
    channelFontSize?: number;
    categoryFontSize?: number;
    showSidebar?: boolean;
    startupWidth?: number;
    startupHeight?: number;
  }) => {
    const updated = { ...uiSettings, ...newSettings };
    setUiSettings(updated);
    if (window.storage) {
      await window.storage.updateSettings(newSettings);

      // Also save to localStorage for App.tsx startup logic
      // We retrieve current settings from localStorage to merge, or just create new
      try {
        const existing = localStorage.getItem('app-settings');
        const parsed = existing ? JSON.parse(existing) : {};
        localStorage.setItem('app-settings', JSON.stringify({ ...parsed, ...newSettings }));
      } catch (e) {
        console.error('Failed to save settings to localStorage', e);
      }
    }
  };

  const handleRememberLastChannelsChange = async (value: boolean) => {
    setRememberLastChannels(value);

    // Automatically turn off Reopen when Remember is turned off
    let updatePayload: any = { rememberLastChannels: value };
    if (!value) {
      setReopenLastOnStartup(false);
      updatePayload.reopenLastOnStartup = false;
    }

    if (window.storage) {
      await window.storage.updateSettings(updatePayload);
    }
  };

  const handleReopenLastOnStartupChange = async (value: boolean) => {
    setReopenLastOnStartup(value);
    if (window.storage) {
      await window.storage.updateSettings({ reopenLastOnStartup: value });
    }
  };

  const handleIncludeSourceInSearchChange = async (value: boolean) => {
    setIncludeSourceInSearch(value);
    if (window.storage) {
      await window.storage.updateSettings({ includeSourceInSearch: value });
    }
  };

  function renderTabContent() {
    switch (activeTab) {
      case 'sources':
        return (
          <SourcesTab
            sources={sources}
            isEncryptionAvailable={isEncryptionAvailable}
            onSourcesChange={loadSources}
            editSourceId={editSourceId}
          />
        );
      case 'tmdb':
        return (
          <TmdbTab
            tmdbApiKey={tmdbApiKey}
            tmdbKeyValid={tmdbKeyValid}
            onApiKeyChange={setTmdbApiKey}
            onApiKeyValidChange={setTmdbKeyValid}
            tmdbMatchingEnabled={tmdbMatchingEnabled}
            onTmdbMatchingEnabledChange={setTmdbMatchingEnabled}
          />
        );
      case 'refresh':
        return (
          <DataRefreshTab
            vodRefreshHours={vodRefreshHours}
            epgRefreshHours={epgRefreshHours}
            onVodRefreshChange={setVodRefreshHours}
            onEpgRefreshChange={setEpgRefreshHours}
          />
        );
      case 'channels':
        return (
          <ChannelsTab
            channelSortOrder={channelSortOrder}
            onChannelSortOrderChange={setChannelSortOrder}
            includeSourceInSearch={includeSourceInSearch}
            onIncludeSourceInSearchChange={handleIncludeSourceInSearchChange}
          />
        );
      case 'movies':
        return (
          <MoviesTab
            tmdbApiKey={tmdbApiKey || null}
            enabledGenres={movieGenresEnabled}
            onEnabledGenresChange={handleMovieGenresChange}
            settingsLoaded={settingsLoaded}
          />
        );
      case 'series':
        return (
          <SeriesTab
            tmdbApiKey={tmdbApiKey || null}
            enabledGenres={seriesGenresEnabled}
            onEnabledGenresChange={handleSeriesGenresChange}
            settingsLoaded={settingsLoaded}
          />
        );
      case 'posterdb':
        return (
          <PosterDbTab
            apiKey={posterDbApiKey}
            apiKeyValid={posterDbKeyValid}
            onApiKeyChange={setPosterDbApiKey}
            onApiKeyValidChange={setPosterDbKeyValid}
            backdropsEnabled={rpdbBackdropsEnabled}
            onBackdropsEnabledChange={setRpdbBackdropsEnabled}
          />
        );
      case 'security':
        return (
          <SecurityTab
            allowLanSources={allowLanSources}
            onAllowLanSourcesChange={setAllowLanSources}
          />
        );
      case 'debug':
        return (
          <DebugTab
            debugLoggingEnabled={debugLoggingEnabled}
            onDebugLoggingChange={setDebugLoggingEnabled}
          />
        );
      case 'shortcuts':
        return (
          <ShortcutsTab
            shortcuts={shortcuts}
            onShortcutsChange={handleShortcutsChange}
          />
        );
      case 'export-import':
        return <ImportExportTab />;
      case 'ui':
        return (
          <UITab
            settings={uiSettings}
            onSettingsChange={handleUiSettingsChange}
          />
        );
      case 'theme':
        return (
          <ThemeTab
            theme={theme || 'glass-neon'}
            onThemeChange={onThemeChange || (() => { })}
          />
        );
      case 'dvr':
        return <DvrTab />;
      case 'startup':
        return (
          <StartupTab
            rememberLastChannels={rememberLastChannels}
            reopenLastOnStartup={reopenLastOnStartup}
            savedLayoutState={savedLayoutState}
            onRememberLastChannelsChange={handleRememberLastChannelsChange}
            onReopenLastOnStartupChange={handleReopenLastOnStartupChange}
          />
        );
      case 'tv-calendar':
        return <TVCalendarTab />;
      case 'playback':
        return (
          <PlaybackTab
            mpvParams={mpvParams}
            onMpvParamsChange={handleMpvParamsChange}
          />
        );
      case 'cache':
        return (
          <CacheTab
            timeshiftEnabled={timeshiftEnabled}
            timeshiftCacheBytes={timeshiftCacheBytes}
            liveBufferOffset={liveBufferOffset}
            onTimeshiftChange={handleTimeshiftChange}
          />
        );
      case 'livetv':
        return (
          <LiveTVTab
            epgDarkenCurrent={epgDarkenCurrent}
            onEpgDarkenCurrentChange={handleEpgDarkenCurrentChange}
          />
        );
      case 'about':
        return <AboutTab />;
      default:
        return null;
    }
  }

  return (
    <div className="settings-overlay">
      <div className="settings-panel settings-panel--sidebar">
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {/* Encryption Warning */}
        {!isEncryptionAvailable && (
          <div className="encryption-warning">
            <span className="warning-icon">Warning:</span>
            <span>
              Secure storage unavailable. Credentials will be stored without encryption.
              <br />
              <small>Install a keyring (gnome-keyring, kwallet) for secure storage.</small>
            </span>
          </div>
        )}

        <div className="settings-body">
          {/* Sidebar Navigation */}
          <SettingsSidebar
            activeTab={activeTab}
            onTabChange={setActiveTab}
            hasVodSource={hasVodSource}
          />

          {/* Tab Content */}
          <div className="settings-content">
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
