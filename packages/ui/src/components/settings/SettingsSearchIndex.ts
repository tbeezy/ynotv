import type { SettingsTabId } from './SettingsSidebar';
import type enJson from '../../i18n/locales/en.json';

type ScalarStringKeys<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T];

/** i18n keys (settings namespace) that back a search result label at display time. */
export type SettingsSearchLabelKey = ScalarStringKeys<typeof enJson.settings>;

export interface SettingsSearchResult {
  id: string;
  label: string;
  description?: string;
  tabId: SettingsTabId;
  tabLabel: string;
  subTabId?: string;
  section?: string;
  /** Optional i18n key (settings namespace) used to render the label at display time (English `label` remains the search token). */
  labelKey?: SettingsSearchLabelKey;
}

export type LiveTVSubTabId = 'epg' | 'logos' | 'font-size' | 'sort-order' | 'search' | 'live-view' | 'widgets' | 'favorites';

const TAB_LABELS: Record<SettingsTabId, string> = {
  sources: 'Sources',
  livetv: 'LiveTV',
  playback: 'Playback',
  metadata: 'Metadata',
  subtitles: 'Subtitles & Audio',
  strem: 'Strem',
  nuvio: 'Nuvio',
  discord: 'Discord Rich Presence',
  theme: 'Theme',
  ui: 'UI',
  optimization: 'Optimization',
  navigation: 'Navigation',
  startup: 'Startup',
  scrobbling: 'Trakt',
  simkl: 'Simkl',
  cache: 'Cache',
  security: 'Security',
  proxy: 'Proxy',
  debug: 'Debug',
  shortcuts: 'Shortcuts',
  'export-import': 'Export / Import',
  about: 'About',
};

const SETTINGS_SEARCH_INDEX: SettingsSearchResult[] = [
  // --- Sources ---
  { id: 'sources-tab', label: 'Sources', tabId: 'sources', tabLabel: 'Sources', subTabId: 'source', section: 'Sources' },
  { id: 'playlist', label: 'Playlist', description: 'Manage your IPTV sources.', tabId: 'sources', tabLabel: 'Sources', subTabId: 'source', section: 'Sources' },
  { id: 'global-epg-links', label: 'Global EPG Links', tabId: 'sources', tabLabel: 'Sources', subTabId: 'epg', section: 'EPG' },
  { id: 'add-source', label: 'Add Source', tabId: 'sources', tabLabel: 'Sources', subTabId: 'source', section: 'Sources' },
  { id: 'edit-source', label: 'Edit Source', tabId: 'sources', tabLabel: 'Sources', subTabId: 'source', section: 'Sources' },
  { id: 'vod-refresh-hours', label: 'VOD Refresh Hours', tabId: 'sources', tabLabel: 'Sources', subTabId: 'refresh', section: 'Data Refresh' },
  { id: 'epg-refresh-hours', label: 'EPG Refresh Hours', tabId: 'sources', tabLabel: 'Sources', subTabId: 'refresh', section: 'Data Refresh' },
  { id: 'epg-sync-concurrency', label: 'EPG Sync Concurrency', tabId: 'sources', tabLabel: 'Sources', subTabId: 'refresh', section: 'Data Refresh' },
  { id: 'data-refresh', label: 'Data Refresh', tabId: 'sources', tabLabel: 'Sources', subTabId: 'refresh', section: 'Data Refresh' },
  { id: 'tmdb-api-key', label: 'TMDB API Key', description: 'API key for The Movie Database integration.', tabId: 'metadata', tabLabel: 'Metadata', subTabId: 'tmdb', section: 'TMDB / RPDB' },
  { id: 'rpdb-api-key', label: 'RPDB API Key', description: 'API key for Poster DB integration.', tabId: 'metadata', tabLabel: 'Metadata', subTabId: 'rpdb', section: 'TMDB / RPDB' },
  { id: 'rpdb-backdrops', label: 'RPDB Backdrops', tabId: 'metadata', tabLabel: 'Metadata', subTabId: 'rpdb', section: 'TMDB / RPDB' },
  { id: 'tmdb-rpdb', label: 'TMDB / RPDB', tabId: 'metadata', tabLabel: 'Metadata', subTabId: 'tmdb', section: 'TMDB / RPDB' },

  // --- LiveTV ---
  { id: 'livetv-tab', label: 'LiveTV', tabId: 'livetv', tabLabel: 'LiveTV', section: 'LiveTV' },

  // LiveTV > EPG
  { id: 'epg-darken-current', label: 'Make EPG Current airing program blocks darker', description: 'When enabled, the currently airing program in the EPG will have a deeper/darker highlight.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'epg', section: 'EPG' },
  { id: 'epg-highlight-border-current', label: 'Highlight border around current playing', description: 'When enabled, a border with the accent color will outline the currently playing channel row in the EPG.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'epg', section: 'EPG' },
  { id: 'epg-bold-channels', label: 'Bold Channel Names', description: 'When enabled, it bolds the channel names in the EPG.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'epg', section: 'EPG' },
  { id: 'epg-bold-top-categories', label: 'Bold Top Categories', description: 'When enabled, it bolds the top categories in the sidebar (All Channels, Favorites, Watchlist, Recently Viewed, custom groups).', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'epg', section: 'EPG' },
  { id: 'epg-bold-source-categories', label: 'Bold Source Categories', description: 'When enabled, it bolds the nested categories listed under their media sources in the sidebar.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'epg', section: 'EPG' },
  { id: 'epg-metadata-badges', label: 'Metadata Badges (Resolution, FPS, Sound)', description: 'Enable or disable resolution, FPS, and sound metadata badges on channel rows in the EPG grid.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'epg', section: 'EPG' },
  // LiveTV > Logos
  { id: 'channel-logo-size', label: 'Channel Logo Size', description: 'Scale channel logos bigger or smaller across the guide and channel list.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logo Preferences' },
  { id: 'channel-logo-round-edges', label: 'Round Logo Edges', description: 'Enable rounded corners for channel logo tiles, or disable for sharp square edges.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logo Preferences' },
  { id: 'logo-light-bg-detection', label: 'Auto Light Background Detection', description: 'Automatically detect dark logos that require a light tile background for high contrast, or opt out.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logo Preferences' },
  { id: 'logo-smart-trim', label: 'Smart Trim Logos', description: 'Automatically crop baked-in transparent padding so logos fill the tile edge-to-edge without cutting off content.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logo Preferences' },
  { id: 'prefer-epg-logos', label: 'Prefer EPG logos globally', description: 'When enabled, channels with EPG data will display the matched EPG channel logo instead of the playlist logo.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logo Preferences' },
  { id: 'epg-logo-display', label: 'Display Icons', description: 'Display channel logos as square or rectangle (horizontal) format in the guide.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logo Preferences' },
  { id: 'logo-caching', label: 'Enable Local Logo Caching', description: 'Store channel logos locally on disk for instant load times and offline support.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logos' },
  { id: 'logo-max-size', label: 'Maximum Logo Cache Size', description: 'Configure max disk space allocated for cached logos.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logos' },
  { id: 'logo-cache-ttl', label: 'Logo Cache Expiration (TTL)', description: 'Configure auto-purging of cached logos older than the set timeframe.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logos' },
  { id: 'clear-logo-cache', label: 'Clear Logo Cache', description: 'Purge all cached logo images from disk and reset luminance cache.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'logos', section: 'Logos' },



  // LiveTV > Font Size
  { id: 'channel-font-size', label: 'Channel Font Size', description: 'Adjust the font size for channel names.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'font-size', section: 'Font Size' },
  { id: 'category-font-size', label: 'Category Font Size', description: 'Adjust the font size for category labels.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'font-size', section: 'Font Size' },
  { id: 'livetv-font-size', label: 'Font Size', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'font-size', section: 'Font Size' },

  // LiveTV > Sort Order (from ChannelsTab)
  { id: 'channel-sort-order', label: 'Channel Sort Order', description: 'Sort channels by provider order, alphabetical, or channel number.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'sort-order', section: 'Channel Display' },
  { id: 'category-sort-order', label: 'Category Sort Order', description: 'Sort categories by provider order or alphabetical.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'sort-order', section: 'Category Display' },
  { id: 'sort-order', label: 'Sort Order', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'sort-order', section: 'Sort Order' },

  // LiveTV > Search (from ChannelsTab)
  { id: 'include-source-in-search', label: 'Include Source name in search', description: 'When enabled, search will also match against source names.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'search', section: 'Search' },
  { id: 'max-search-results', label: 'Max search results', description: 'Maximum number of results to show in channel search.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'search', section: 'Search' },
  { id: 'search-results-order', label: 'Search results order', description: 'Choose how search results are sorted.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'search', section: 'Search' },

  // LiveTV > Channel Overlay (from LiveViewTab)
  { id: 'channel-info-overlay', label: 'Enable channel information overlay', description: 'Show channel info in a transparent box when switching channels.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'live-view', section: 'Channel Information Overlay' },
  { id: 'hide-program-summary', label: 'Hide Program Summary', description: 'Hide the program description text from the overlay.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'live-view', section: 'Channel Information Overlay' },
  { id: 'overlay-text-size', label: 'Overlay Text Size', description: 'Adjust the channel name and program text size.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'live-view', section: 'Overlay Appearance' },
  { id: 'overlay-logo-size', label: 'Overlay Logo Size', description: 'Adjust the channel logo dimensions.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'live-view', section: 'Overlay Appearance' },
  { id: 'overlay-box-width', label: 'Overlay Box Width', description: 'Adjust the maximum width of the overlay box.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'live-view', section: 'Overlay Appearance' },
  { id: 'overlay-background-opacity', label: 'Overlay Background Opacity', description: 'Lower values make the overlay more transparent.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'live-view', section: 'Overlay Appearance' },
  { id: 'channel-overlay', label: 'Channel Overlay', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'live-view', section: 'Channel Information Overlay' },

  // LiveTV > Widgets (from WidgetsTab)
  { id: 'widget-scale', label: 'Widget Scale', description: 'Scale the entire widget box and text.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'widgets', section: 'Overlay Widgets' },
  { id: 'widget-background-opacity', label: 'Widget Background Opacity', description: 'Controls how transparent the widget box background is.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'widgets', section: 'Overlay Widgets' },
  { id: 'sports-scale', label: 'Sports Scores Overlay Scale', description: 'Scale the height of the scores bar.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'widgets', section: 'Sports Scores Overlay' },
  { id: 'sports-background-opacity', label: 'Sports Scores Background Opacity', description: 'Controls how dark the gradient background of the scores bar is.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'widgets', section: 'Sports Scores Overlay' },
  { id: 'widgets', label: 'Widgets', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'widgets', section: 'Overlay Widgets' },

  // LiveTV > Favorites
  { id: 'livetv-favorites', label: 'Favorites', description: 'Choose where favorited channels appear in the Live TV sidebar.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'favorites', section: 'Favorites' },
  { id: 'favorites-placement', label: 'Favorites Placement', description: 'Global shows a single Favorites list at the top of the sidebar. Per Source nests a Favorites entry inside each provider/source section.', tabId: 'livetv', tabLabel: 'LiveTV', subTabId: 'favorites', section: 'Favorites' },


  // --- Playback ---
  { id: 'playback-tab', label: 'Playback', tabId: 'playback', tabLabel: 'Playback', subTabId: 'mpv', section: 'Playback' },
  { id: 'mpv-hwdec', label: 'Enable Hardware Video Acceleration (--hwdec=auto)', description: 'Automatically pass --hwdec=auto and --vo=gpu to MPV to offload video decoding to your GPU.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'mpv', section: 'MPV Parameters' },
  { id: 'mpv-parameters', label: 'MPV Parameters', description: 'Custom command-line flags passed to MPV on startup.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'mpv', section: 'MPV Parameters' },
  { id: 'event-based-reconnect', label: 'Event-Based Reconnect', description: 'React immediately to stream errors like EOF, HTTP errors, and MPV crashes.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'reconnect', section: 'Reconnect' },
  { id: 'stall-detection', label: 'Stall Detection (Watchdog)', description: 'Periodically poll MPV to detect stalled or frozen streams.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'reconnect', section: 'Reconnect' },
  { id: 'stall-detection-timeout', label: 'Stall Detection Timeout', description: 'Seconds of no position change before a stream is considered stalled.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'reconnect', section: 'Reconnect' },
  { id: 'max-retry-attempts', label: 'Max Retry Attempts', description: 'Maximum number of reconnection attempts before showing a permanent error.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'reconnect', section: 'Reconnect' },
  { id: 'reconnect', label: 'Reconnect', tabId: 'playback', tabLabel: 'Playback', subTabId: 'reconnect', section: 'Reconnect' },
  { id: 'enable-google-cast', label: 'Enable Google Cast Support', description: 'Allows scanning your local network for Chromecast devices.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'cast', section: 'Google Cast' },
  { id: 'rewrite-ts-to-m3u8', label: 'Rewrite TS to M3U8 for Cast', description: 'Automatically rewrite .ts stream URLs to HLS .m3u8 when casting.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'cast', section: 'Google Cast' },
  { id: 'google-cast', label: 'Google Cast', tabId: 'playback', tabLabel: 'Playback', subTabId: 'cast', section: 'Google Cast' },
  { id: 'external-player-path', label: 'Player Executable Path', description: 'Full path to your external player executable.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'popout', section: 'External Player' },
  { id: 'reuse-player-instance', label: 'Reuse same player instance', description: 'Close the previous player before opening a new one when switching channels.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'popout', section: 'External Player' },
  { id: 'external-player', label: 'External Player', tabId: 'playback', tabLabel: 'Playback', subTabId: 'popout', section: 'External Player' },
  { id: 'popout-stop-main', label: 'Stop main player when popout opens', description: 'Stop the embedded player when a popout is opened.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'popout', section: 'Popout Player' },
  { id: 'popout-always-on-top', label: 'Always on top', description: 'Keep the popout window above all other windows.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'popout', section: 'Popout Player' },
  { id: 'popout-hwdec', label: 'Enable Popout Hardware Video Acceleration (--hwdec=auto)', description: 'Automatically pass --hwdec=auto and --vo=gpu to the popout MPV player instance.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'popout', section: 'Popout Player' },
  { id: 'popout-mpv-params', label: 'Enable additional MPV parameters for popout', description: 'Pass custom command-line arguments to the popout MPV instance.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'popout', section: 'Popout Player' },
  { id: 'popout-player', label: 'Popout Player', tabId: 'playback', tabLabel: 'Playback', subTabId: 'popout', section: 'Popout Player' },
  { id: 'skip-intro-auto', label: 'Automatic Intro Skip', description: 'Skip the intro automatically without showing a button.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'skipintro', section: 'Skip Intro' },
  { id: 'skip-intro-duration', label: 'Skip Button Duration', description: 'How many seconds the skip button stays visible.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'skipintro', section: 'Skip Intro' },
  { id: 'skip-intro', label: 'Skip Intro', tabId: 'playback', tabLabel: 'Playback', subTabId: 'skipintro', section: 'Skip Intro' },

  // --- Catch-up ---
  { id: 'catchup-start-padding', label: 'Start Padding', description: 'Padding added to the beginning of catch-up playback.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'catchup', section: 'Catch-up' },
  { id: 'catchup-end-padding', label: 'End Padding', description: 'Padding added to the end of catch-up playback.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'catchup', section: 'Catch-up' },
  { id: 'catchup-continue-playing', label: 'Continue playing after end time', description: 'Keep playing past the scheduled end time on catch-up channels.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'catchup', section: 'Catch-up' },
  { id: 'catchup-settings', label: 'Catch-up', tabId: 'playback', tabLabel: 'Playback', subTabId: 'catchup', section: 'Catch-up' },
  { id: 'vod-autoplay-next-episode', label: 'VOD Auto-Play Next Episode', description: 'Automatically play the next episode of a VOD Series when the current episode ends.', tabId: 'playback', tabLabel: 'Playback', subTabId: 'vod', section: 'VOD Settings' },

  // --- Subtitles & Audio ---
  { id: 'subtitles-tab', label: 'Subtitles & Audio', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Subtitles & Audio' },
  { id: 'subsource-api-key', label: 'SubSource API Key', description: 'API key for SubSource subtitle integration.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'SubSource Integration' },
  { id: 'default-subtitle-language', label: 'Default Subtitle Language', description: 'Preferred subtitle language for auto-selection.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Default Appearance' },
  { id: 'default-subtitle-size', label: 'Default Subtitle Size', description: 'Base font size for subtitles.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Default Appearance' },
  { id: 'subtitle-text-color', label: 'Subtitle Text Color', description: 'Color of the subtitle text.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Default Appearance' },
  { id: 'subtitle-background', label: 'Subtitle Background', description: 'Show a colored box behind subtitle text.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Default Appearance' },
  { id: 'subtitle-background-color', label: 'Subtitle Background Color', description: 'Color of the background box behind subtitles.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Default Appearance' },
  { id: 'subtitle-background-opacity', label: 'Subtitle Background Opacity', description: 'Transparency of the background box.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Default Appearance' },
  { id: 'subtitle-outline-color', label: 'Subtitle Outline Color', description: 'Border/outline color around subtitle text.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Default Appearance' },
  { id: 'subtitle-preview', label: 'Subtitle Preview', description: 'Preview how subtitles will look with current settings.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'subtitles', section: 'Preview' },
  { id: 'default-audio-language', label: 'Default Audio Language', description: 'Preferred audio language for streams.', tabId: 'subtitles', tabLabel: 'Subtitles & Audio', subTabId: 'audio', section: 'Audio Language Settings' },

  // --- Strem ---
  { id: 'strem-tab', label: 'Strem', tabId: 'strem', tabLabel: 'Strem', section: 'Strem' },
  { id: 'stream-picker-mode', label: 'Stream Picker Mode', description: 'Show a picker modal to choose which stream to play, or auto-play the first direct stream.', tabId: 'strem', tabLabel: 'Strem', section: 'Strem Playback' },
  { id: 'stream-badges', label: 'Enable Stream Badges', description: 'Toggle stream badges on or off.', tabId: 'strem', tabLabel: 'Strem', section: 'Stream Badges' },
  { id: 'badge-scale', label: 'Badge Scale', description: 'Adjust the size of stream badges.', tabId: 'strem', tabLabel: 'Strem', section: 'Stream Badges' },
  { id: 'custom-badge-rules', label: 'Custom Badge Rules', tabId: 'strem', tabLabel: 'Strem', section: 'Stream Badges' },

  // --- Theme ---
  { id: 'theme-tab', label: 'Theme', tabId: 'theme', tabLabel: 'Theme', section: 'Theme' },

  // --- Optimization ---
  { id: 'optimization-tab', label: 'Optimization', tabId: 'optimization', tabLabel: 'Optimization', section: 'Optimization' },
  { id: 'opt-hw-accel', label: 'Enable GPU Hardware Acceleration', description: 'Offload UI compositing and rendering to GPU for lower CPU usage.', tabId: 'optimization', tabLabel: 'Optimization', section: 'Hardware Acceleration' },
  { id: 'opt-theme-blur', label: 'Disable Glass Backdrop Blur', description: 'Remove backdrop blur from UI components to reduce GPU usage.', tabId: 'optimization', tabLabel: 'Optimization', section: 'Theme Optimization' },
  { id: 'opt-epg-lazy-load', label: 'Enable EPG Lazy Loading', description: 'Only load EPG programs for the visible time window to reduce lag.', tabId: 'optimization', tabLabel: 'Optimization', section: 'EPG Optimization' },
  { id: 'opt-epg-transitions', label: 'Disable EPG Card Shadows & Transitions', description: 'Disable transition animations and drop shadows on guide cards to reduce GPU usage.', tabId: 'optimization', tabLabel: 'Optimization', section: 'EPG Optimization' },
  { id: 'opt-epg-rendering-work', label: 'Reduce EPG Scroll Rendering Work', description: 'Use paint and layout containment so scrolling repaints less of the EPG at once.', tabId: 'optimization', tabLabel: 'Optimization', section: 'EPG Optimization' },

  // --- UI ---
  { id: 'ui-tab', label: 'UI', tabId: 'ui', tabLabel: 'UI', section: 'UI' },
  { id: 'modern-ui-design', label: 'UI Design', description: 'Select the design layout: V1 (Classic), V2 (Modern), or V3.', tabId: 'ui', tabLabel: 'UI', section: 'UI' },
  { id: 'collapse-source-categories', label: 'Collapse Source Categories on Startup', description: 'Source categories will be collapsed by default when LiveTV and VOD Category views load.', tabId: 'ui', tabLabel: 'UI', section: 'UI' },
  { id: 'autohide-overlay-timer', label: 'Autohide Overlay Timer', description: 'How long to wait before hiding UI controls when inactive.', tabId: 'ui', tabLabel: 'UI', section: 'UI' },
  { id: 'window-width', label: 'Window Width', tabId: 'ui', tabLabel: 'UI', section: 'Window Settings' },
  { id: 'window-height', label: 'Window Height', tabId: 'ui', tabLabel: 'UI', section: 'Window Settings' },
  { id: 'window-size', label: 'Window Size', description: 'Custom window dimensions that override auto-saved size.', tabId: 'ui', tabLabel: 'UI', section: 'Window Settings' },
  { id: 'do-not-save-size', label: 'Do not save window size on close', tabId: 'ui', tabLabel: 'UI', section: 'Window Settings' },
  { id: 'language', label: 'Language', description: 'Select the language for the user interface.', tabId: 'ui', tabLabel: 'UI', section: 'Language', labelKey: 'languageLabel' },

  // --- Navigation ---
  { id: 'navigation-tab', label: 'Navigation', tabId: 'navigation', tabLabel: 'Navigation', section: 'Navigation' },
  { id: 'nav-movies', label: 'Show Movies in titlebar', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'titlebar', section: 'Titlebar Navigation' },
  { id: 'nav-series', label: 'Show Series in titlebar', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'titlebar', section: 'Titlebar Navigation' },
  { id: 'nav-dvr', label: 'Show DVR in titlebar', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'titlebar', section: 'Titlebar Navigation' },
  { id: 'nav-sports', label: 'Show Sports in titlebar', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'titlebar', section: 'Titlebar Navigation' },
  { id: 'nav-strem', label: 'Show Strem in titlebar', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'titlebar', section: 'Titlebar Navigation' },
  { id: 'titlebar-navigation', label: 'Titlebar Navigation', description: 'Show or hide navigation buttons in the titlebar.', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'titlebar', section: 'Titlebar Navigation' },

  // Navigation > Category
  { id: 'navigation-category-settings', label: 'Category Sidebar Settings', description: 'Enable/disable showing All Channels, Favorites, Watchlist, and Recently Viewed in categories sidebar.', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'category', section: 'Category' },
  { id: 'show-all-channels', label: 'Show All Channels', description: 'Show the "All Channels" group in the category sidebar.', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'category', section: 'Category' },
  { id: 'show-favorites', label: 'Show Favorites', description: 'Show the "Favorites" group in the category sidebar.', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'category', section: 'Category' },
  { id: 'show-watchlist', label: 'Show Watchlist', description: 'Show the "Watchlist" group in the category sidebar.', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'category', section: 'Category' },
  { id: 'show-recently-viewed', label: 'Show Recently Viewed', description: 'Show the "Recently Viewed" group in the category sidebar.', tabId: 'navigation', tabLabel: 'Navigation', subTabId: 'category', section: 'Category' },

  // --- Startup ---
  { id: 'startup-tab', label: 'Startup', tabId: 'startup', tabLabel: 'Startup', section: 'Startup' },
  { id: 'startup-view', label: 'Startup View', description: 'Choose which page opens when the app starts.', tabId: 'startup', tabLabel: 'Startup', section: 'Startup Behavior' },
  { id: 'remember-last-channels', label: 'Remember Last Viewed Channels', description: 'Save channels when switching layouts and restore on next startup.', tabId: 'startup', tabLabel: 'Startup', section: 'Startup Behavior' },
  { id: 'reopen-last-on-startup', label: 'Reopen Last on Startup', description: 'Automatically load and play remembered channels on startup.', tabId: 'startup', tabLabel: 'Startup', section: 'Startup Behavior' },
  { id: 'startup-behavior', label: 'Startup Behavior', tabId: 'startup', tabLabel: 'Startup', section: 'Startup Behavior' },

  // --- Trakt (Scrobbling) ---
  { id: 'scrobbling-tab', label: 'Trakt', tabId: 'scrobbling', tabLabel: 'Trakt', section: 'Trakt' },
  { id: 'trakt', label: 'Trakt Scrobbling', description: 'Track your viewing history with Trakt.', tabId: 'scrobbling', tabLabel: 'Trakt', section: 'Trakt' },

  // --- Cache ---
  { id: 'cache-tab', label: 'Cache', tabId: 'cache', tabLabel: 'Cache', section: 'Cache' },
  { id: 'enable-time-shift', label: 'Enable Time Shift', description: 'Allows rewinding live TV up to the cache window.', tabId: 'cache', tabLabel: 'Cache', section: 'Cache Time Shift' },
  { id: 'cache-size', label: 'Cache Size', description: 'Amount of storage allocated for live TV time shifting.', tabId: 'cache', tabLabel: 'Cache', section: 'Cache Time Shift' },
  { id: 'live-buffer-offset', label: 'Live Buffer Offset', description: 'Seconds behind live edge when pressing Go Live.', tabId: 'cache', tabLabel: 'Cache', section: 'Cache Time Shift' },
  { id: 'time-shift', label: 'Time Shift', tabId: 'cache', tabLabel: 'Cache', section: 'Cache Time Shift' },

  // --- Security ---
  { id: 'security-tab', label: 'Security', tabId: 'security', tabLabel: 'Security', section: 'Security' },
  { id: 'allow-lan-sources', label: 'Allow LAN sources', description: 'Enable if your IPTV provider runs on your local network.', tabId: 'security', tabLabel: 'Security', section: 'Network Security' },
  { id: 'network-security', label: 'Network Security', tabId: 'security', tabLabel: 'Security', section: 'Network Security' },

  // --- Proxy ---
  { id: 'proxy-tab', label: 'Proxy Settings', tabId: 'proxy', tabLabel: 'Proxy', section: 'Proxy' },
  { id: 'proxy-socks5-server', label: 'SOCKS5 Proxy Server', description: 'Configure a SOCKS5 proxy server to route network traffic through.', tabId: 'proxy', tabLabel: 'Proxy', section: 'SOCKS5 Proxy Settings' },
  { id: 'proxy-socks5-username', label: 'Proxy Username', description: 'Optional username for SOCKS5 proxy authentication.', tabId: 'proxy', tabLabel: 'Proxy', section: 'SOCKS5 Proxy Settings' },
  { id: 'proxy-socks5-password', label: 'Proxy Password', description: 'Optional password for SOCKS5 proxy authentication.', tabId: 'proxy', tabLabel: 'Proxy', section: 'SOCKS5 Proxy Settings' },

  // --- Discord Rich Presence ---
  { id: 'discord-tab', label: 'Discord Rich Presence', description: 'Display media activity and playback status on Discord profile.', tabId: 'discord', tabLabel: 'Discord Rich Presence', section: 'Discord Rich Presence' },
  { id: 'discord-show', label: 'Show on Discord', description: 'Enable Discord Rich Presence status updates.', tabId: 'discord', tabLabel: 'Discord Rich Presence', section: 'Discord Rich Presence' },
  { id: 'discord-hide-title', label: 'Hide Title', description: 'Show Watching Something instead of movie or show title.', tabId: 'discord', tabLabel: 'Discord Rich Presence', section: 'Discord Rich Presence' },
  { id: 'discord-show-paused', label: 'Show while paused', description: 'Keep presence visible when playback is paused.', tabId: 'discord', tabLabel: 'Discord Rich Presence', section: 'Discord Rich Presence' },
  { id: 'discord-show-browsing', label: 'Show while browsing', description: 'Display Browsing ynotv when nothing is playing.', tabId: 'discord', tabLabel: 'Discord Rich Presence', section: 'Discord Rich Presence' },
  { id: 'discord-show-poster', label: 'Show poster', description: 'Display movie or show poster artwork on Discord profile.', tabId: 'discord', tabLabel: 'Discord Rich Presence', section: 'Discord Rich Presence' },
  { id: 'discord-show-timestamp', label: 'Show elapsed time', description: 'Display live progress bar showing elapsed playback time.', tabId: 'discord', tabLabel: 'Discord Rich Presence', section: 'Discord Rich Presence' },

  // --- Debug ---
  { id: 'debug-tab', label: 'Debug', tabId: 'debug', tabLabel: 'Debug', section: 'Debug' },
  { id: 'enable-debug-logging', label: 'Enable debug logging', description: 'Detailed logs from mpv, renderer, and main process are written to a file.', tabId: 'debug', tabLabel: 'Debug', section: 'Debug Logging' },
  { id: 'log-retention', label: 'Log Retention', description: 'How long to keep debug log files before automatic cleanup.', tabId: 'debug', tabLabel: 'Debug', section: 'Debug Logging' },
  { id: 'debug-logging', label: 'Debug Logging', tabId: 'debug', tabLabel: 'Debug', section: 'Debug Logging' },

  // --- Shortcuts ---
  { id: 'shortcuts-tab', label: 'Keyboard Shortcuts', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Keyboard Shortcuts' },
  { id: 'shortcut-play-pause', label: 'Play / Pause', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-mute', label: 'Mute / Unmute', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-cycle-subs', label: 'Cycle Subtitles', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-cycle-audio', label: 'Cycle Audio Track', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-select-sub', label: 'Select Subtitle', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-select-audio', label: 'Select Audio Track', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-stats', label: 'Show / Hide Stats', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-fullscreen', label: 'Toggle Fullscreen', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-replay', label: 'Replay Last Stream', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-seek-forward', label: 'Seek Forward', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-seek-backward', label: 'Seek Backward', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Playback' },
  { id: 'shortcut-channel-up', label: 'Channel Up', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Navigation' },
  { id: 'shortcut-channel-down', label: 'Channel Down', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Navigation' },
  { id: 'shortcut-toggle-shortcuts-overlay', label: 'Toggle Shortcuts Overlay', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-livetv', label: 'Toggle Live TV', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-guide', label: 'Toggle Guide', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-categories', label: 'Toggle Categories', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-dvr', label: 'Toggle DVR', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-sports', label: 'Toggle Sports', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-calendar', label: 'Toggle TV Calendar', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-settings', label: 'Toggle Settings', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-stats', label: 'Toggle Stats', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-focus-search', label: 'Focus Search', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-toggle-epg-view', label: 'Toggle EPG View Layout', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-close', label: 'Close / Back', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-mouse-back-nav', label: 'Back Navigation (Mouse Button)', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Interface' },
  { id: 'shortcut-layout-main', label: 'Layout: Main View', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Layout' },
  { id: 'shortcut-layout-pip', label: 'Layout: Picture in Picture', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Layout' },
  { id: 'shortcut-layout-bottom', label: 'Layout: Big + Bottom Bar', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Layout' },
  { id: 'shortcut-layout-grid', label: 'Layout: 2x2 Grid', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Layout' },
  { id: 'keyboard-shortcuts', label: 'Keyboard Shortcuts', tabId: 'shortcuts', tabLabel: 'Shortcuts', section: 'Keyboard Shortcuts' },

  // --- Export / Import ---
  { id: 'export-import-tab', label: 'Export / Import', tabId: 'export-import', tabLabel: 'Export / Import', section: 'Export / Import' },
  { id: 'system-backup', label: 'System Backup & Restoration', description: 'Export configuration to a JSON file for backup or transfer.', tabId: 'export-import', tabLabel: 'Export / Import', section: 'System Backup & Restoration' },
  { id: 'export-config', label: 'Export Configuration', description: 'Save your current setup to a file.', tabId: 'export-import', tabLabel: 'Export / Import', section: 'Export Configuration' },
  { id: 'import-config', label: 'Import Configuration', description: 'Restore configuration from a previously exported file.', tabId: 'export-import', tabLabel: 'Export / Import', section: 'Import Configuration' },

  // --- About ---
  { id: 'about-tab', label: 'About ynoTV', tabId: 'about', tabLabel: 'About', section: 'About' },
  { id: 'about-version', label: 'Version', tabId: 'about', tabLabel: 'About', section: 'About ynoTV' },
  { id: 'about-updates', label: 'Updates', description: 'Check for new versions of ynoTV.', tabId: 'about', tabLabel: 'About', section: 'Updates' },
  { id: 'about-changelog', label: 'Changelog', tabId: 'about', tabLabel: 'About', section: 'Changelog' },
];

export function searchSettings(query: string): SettingsSearchResult[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  return SETTINGS_SEARCH_INDEX.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      (item.description != null && item.description.toLowerCase().includes(q))
  );
}
