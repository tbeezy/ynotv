import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSourceVersion } from '../contexts/SourceVersionContext';
import { VirtualList, type VirtualListHandle } from './common/VirtualList';
import { useChannels, useCategories, useAllPrograms, useProgramsInRange, useChannelCount, parseCategoryIds } from '../hooks/useChannels';
import { useSettingsStore } from '../stores/settingsStore';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { useTimeGrid } from '../hooks/useTimeGrid';
import { useVirtuosoListHeight } from '../hooks/useVirtuosoListHeight';
import { useGuideRowHeight } from '../hooks/useGuideRowHeight';
import { useActiveRecordings } from '../hooks/useActiveRecordings';
import { ChannelRow } from './ChannelRow';
import { ProgramContextMenu } from './ProgramContextMenu';
import { SearchResultRow } from './SearchResultRow';
import { WatchlistRow } from './WatchlistRow';
import { ChannelManager } from './settings/ChannelManager';
import { FavoriteManager } from './settings/FavoriteManager';
import { CustomGroupManager } from './CustomGroupManager';
import { FailoverGroupListModal } from './FailoverGroupListModal';
import { ViewAllProgramsModal } from './ViewAllProgramsModal';
import { PlaylistListModal } from './PlaylistListModal';
import { EpgEditorModal } from './EpgEditorModal';

import { useChannelSortOrder, useEpgView, useEpgVisibleHours, useEpgClockFormat, useEpgShowDate, useUIStore, useEpgThreeColumn } from '../stores/uiStore';
import { NowPlayingBar } from './NowPlayingBar';
import { AudioVisualizer, type VisualizerMode } from './AudioVisualizer';
import { FailoverChannelOverlay } from './FailoverChannelOverlay';
import type { StoredChannel, StoredProgram, WatchlistItem } from '../db';
import { db } from '../db';
import { matchesSearch } from '../utils/searchNormalization';
import { decompressEpgDescription } from '../utils/compression';
import { formatTime, formatDate } from '../utils/dateTime';
import { pickCurrentProgram, EPG_WINDOW_BACK_MS, EPG_WINDOW_FWD_MS } from '../utils/epgTime';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

function formatSeekTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const ALPHABET_LETTERS = ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

const RESOLUTION_FILTER_OPTIONS: QualityFilter[] = ['all', '4k', 'fhd', 'hd', 'sd'];
const RESOLUTION_FILTER_LABELS: Record<Exclude<QualityFilter, 'all'>, string> = {
  '4k': '4K',
  'fhd': 'FHD',
  'hd': 'HD',
  'sd': 'SD',
};

function getChannelFirstLetter(name: string): string {
  if (!name) return '#';
  const normalized = name.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!normalized) return '#';
  const char = normalized.charAt(0).toUpperCase();
  if (/^[A-Z]$/.test(char)) return char;
  return '#';
}

import { syncSource, applyGlobalEpgToSource, type SyncResult } from '../db/sync';
import { VideoErrorOverlay } from './VideoErrorOverlay';
import { StreamRetryOverlay, type RetryState } from './StreamRetryOverlay';
import { FailoverOverlay } from './FailoverOverlay';
import { ChannelLoadingOverlay } from './ChannelLoadingOverlay';
import type { FailoverState } from '../hooks/usePlayback';
import { Bridge, type AspectRatioMode, getAspectRatioLabel } from '../services/tauri-bridge';
import { getChannelMetadataBySource, qualityLabelMatchesFilter, type QualityFilter } from '../services/video-metadata';
import { MetadataBadge } from './MetadataBadge';
import { EpgShiftModal } from './EpgShiftModal';
import { dbEvents } from '../db/sqlite-adapter';
import { primaryRect } from '../hooks/useMultiview';
import type { LayoutMode, ViewerSlot, MultiviewEngineMode } from '../hooks/useMultiview';
import './ChannelPanel.css';
import { formatChannelFullPath, formatChannelDisplayPath } from '../utils/channelPath';


// Default width of the channel info column (20% bigger than original 220)
const DEFAULT_CHANNEL_COLUMN_WIDTH = 264;

// Memoized Virtuoso row component to prevent unnecessary re-renders
// This must be defined OUTSIDE the ChannelPanel component
interface ChannelRowData {
  channelSortOrder: 'alphabetical' | 'number' | 'provider';
  programs: Map<string, StoredProgram[]>;
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  visibleHours: number;
  handleChannelClick: (channel: StoredChannel) => void;
  onPlayCatchup?: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, programDesc?: string) => void;
  handleFavoriteToggle: () => void;
  categoryId: string | null;
  activeRecordings: import('../hooks/useActiveRecordings').RecordingInfo[];
  currentLayout?: string;
  onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null) => void;
  onPlayInPopout?: (channel: StoredChannel) => void;
  onPlayInExternal?: (channel: StoredChannel) => void;
  currentChannel?: StoredChannel | null;
  highlightChannel?: StoredChannel | null;
  showPlaylistName: boolean;
  sourceNames: Map<string, string>;
  epgMetadataBadgeResolution: boolean;
  epgMetadataBadgeFps: boolean;
  epgMetadataBadgeSound: boolean;
  epgMetadataBadgeBitrate: boolean;
  epgMetadataBadgeAudioBitrate: boolean;
  threeColumn: boolean;
  currentTime?: Date;
}

const ChannelRowVirtuoso = memo(function ChannelRowVirtuoso({
  index,
  channel,
  data,
}: {
  index: number;
  channel: StoredChannel;
  data: ChannelRowData;
}) {
  const isCurrentlyPlaying = (data.highlightChannel ?? data.currentChannel)?.stream_id === channel.stream_id;
  const handlePlay = useCallback(() => {
    data.handleChannelClick(channel);
  }, [channel, data.handleChannelClick]);

  return (
    <ChannelRow
      channel={channel}
      index={index}
      sortOrder={data.channelSortOrder}
      programs={data.programs.get(channel.stream_id) ?? []}
      windowStart={data.windowStart}
      windowEnd={data.windowEnd}
      pixelsPerHour={data.pixelsPerHour}
      visibleHours={data.visibleHours}
      onPlay={handlePlay}
      onPlayCatchup={data.onPlayCatchup}
      onFavoriteToggle={data.handleFavoriteToggle}
      categoryId={data.categoryId}
      activeRecordings={data.activeRecordings}
      currentLayout={data.currentLayout}
      onSendToSlot={data.onSendToSlot}
      onPlayInPopout={data.onPlayInPopout}
      onPlayInExternal={data.onPlayInExternal}
      isCurrentlyPlaying={isCurrentlyPlaying}
      showPlaylistName={data.showPlaylistName}
      sourceNames={data.sourceNames}
      epgMetadataBadgeResolution={data.epgMetadataBadgeResolution}
      epgMetadataBadgeFps={data.epgMetadataBadgeFps}
      epgMetadataBadgeSound={data.epgMetadataBadgeSound}
      epgMetadataBadgeBitrate={data.epgMetadataBadgeBitrate}
      epgMetadataBadgeAudioBitrate={data.epgMetadataBadgeAudioBitrate}
      altView={data.threeColumn}
      currentTime={data.currentTime}
    />
  );
}, (prevProps, nextProps) => {
  const prevData = prevProps.data;
  const nextData = nextProps.data;

  // Reference comparison for programs map query result array
  const prevProgs = prevData.programs.get(prevProps.channel.stream_id);
  const nextProgs = nextData.programs.get(nextProps.channel.stream_id);
  const programsChanged = prevProgs !== nextProgs;

  // Check if recording state changed for this channel
  const prevRecs = prevData.activeRecordings ?? [];
  const nextRecs = nextData.activeRecordings ?? [];
  const prevChannelRec = prevRecs.some(r => r.channelId === prevProps.channel.stream_id);
  const nextChannelRec = nextRecs.some(r => r.channelId === nextProps.channel.stream_id);
  const recordingsChanged = prevChannelRec !== nextChannelRec;

  // When 3-column view is active, the row renders current program info and a progress bar,
  // which depends on currentTime. In traditional grid view, current time is rendered as an
  // overlay line across the whole grid, so rows don't need to re-render on time ticks.
  const timeChanged = nextData.threeColumn && prevData.currentTime?.getTime() !== nextData.currentTime?.getTime();
  const threeColumnChanged = prevData.threeColumn !== nextData.threeColumn;

  return prevProps.index === nextProps.index &&
         prevProps.channel.stream_id === nextProps.channel.stream_id &&
         prevProps.channel.is_favorite === nextProps.channel.is_favorite &&
         prevProps.channel.name === nextProps.channel.name &&
         prevProps.channel.stream_icon === nextProps.channel.stream_icon &&
         prevProps.channel.channel_num === nextProps.channel.channel_num &&
         prevProps.channel.alias === nextProps.channel.alias &&
         prevProps.channel.tv_archive === nextProps.channel.tv_archive &&
         prevProps.channel.is_adult === nextProps.channel.is_adult &&
         prevProps.channel.source_id === nextProps.channel.source_id &&
         !threeColumnChanged &&
         prevData.channelSortOrder === nextData.channelSortOrder &&
         prevData.currentChannel?.stream_id === nextData.currentChannel?.stream_id &&
         prevData.highlightChannel?.stream_id === nextData.highlightChannel?.stream_id &&
         prevData.windowStart.getTime() === nextData.windowStart.getTime() &&
         prevData.windowEnd.getTime() === nextData.windowEnd.getTime() &&
         prevData.pixelsPerHour === nextData.pixelsPerHour &&
         prevData.visibleHours === nextData.visibleHours &&
         prevData.categoryId === nextData.categoryId &&
         prevData.currentLayout === nextData.currentLayout &&
         prevData.showPlaylistName === nextData.showPlaylistName &&
         prevData.epgMetadataBadgeResolution === nextData.epgMetadataBadgeResolution &&
         prevData.epgMetadataBadgeFps === nextData.epgMetadataBadgeFps &&
         prevData.epgMetadataBadgeSound === nextData.epgMetadataBadgeSound &&
         prevData.epgMetadataBadgeBitrate === nextData.epgMetadataBadgeBitrate &&
         prevData.epgMetadataBadgeAudioBitrate === nextData.epgMetadataBadgeAudioBitrate &&
         !recordingsChanged &&
         !programsChanged &&
         !timeChanged;
});

// Shared context for the virtualized EPG tabs (Live Now / Upcoming) of search results
interface SearchProgramRowData {
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  visibleHours: number;
  handleSearchChannelClick: (channel: StoredChannel) => void;
  refreshSearchResults: () => void;
  activeRecordings: import('../hooks/useActiveRecordings').RecordingInfo[];
  currentLayout?: string;
  onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null) => void;
  onPlayInPopout?: (channel: StoredChannel) => void;
  onPlayInExternal?: (channel: StoredChannel) => void;
  includeSourceInSearch?: boolean;
  currentChannel?: StoredChannel | null;
  highlightChannel?: StoredChannel | null;
}

// Memoized Virtuoso row for Live Now / Upcoming EPG search tabs
const SearchResultRowVirtuoso = memo(function SearchResultRowVirtuoso({
  index,
  entry,
  data,
}: {
  index: number;
  entry: { channel: StoredChannel; programs: StoredProgram[] };
  data: SearchProgramRowData;
}) {
  const handlePlay = useCallback(() => {
    data.handleSearchChannelClick(entry.channel);
  }, [entry.channel, data.handleSearchChannelClick]);

  return (
    <SearchResultRow
      channel={entry.channel}
      programs={entry.programs}
      windowStart={data.windowStart}
      windowEnd={data.windowEnd}
      pixelsPerHour={data.pixelsPerHour}
      visibleHours={data.visibleHours}
      onPlay={handlePlay}
      onFavoriteToggle={data.refreshSearchResults}
      activeRecordings={data.activeRecordings}
      currentLayout={data.currentLayout}
      onSendToSlot={data.onSendToSlot}
      onPlayInPopout={data.onPlayInPopout}
      onPlayInExternal={data.onPlayInExternal}
      includeSourceInSearch={data.includeSourceInSearch}
      currentChannel={data.highlightChannel ?? data.currentChannel}
    />
  );
}, (prevProps, nextProps) => {
  const prevData = prevProps.data;
  const nextData = nextProps.data;
  const prevProgs = prevProps.entry.programs;
  const nextProgs = nextProps.entry.programs;

  const prevRecs = prevData.activeRecordings ?? [];
  const nextRecs = nextData.activeRecordings ?? [];
  const prevChannelRec = prevRecs.some(r => r.channelId === prevProps.entry.channel.stream_id);
  const nextChannelRec = nextRecs.some(r => r.channelId === nextProps.entry.channel.stream_id);
  const recordingsChanged = prevChannelRec !== nextChannelRec;

  return prevProps.index === nextProps.index &&
         prevProps.entry.channel.stream_id === nextProps.entry.channel.stream_id &&
         prevProps.entry.channel.is_favorite === nextProps.entry.channel.is_favorite &&
         prevProps.entry.channel.name === nextProps.entry.channel.name &&
         prevProps.entry.channel.stream_icon === nextProps.entry.channel.stream_icon &&
         prevProps.entry.channel.alias === nextProps.entry.channel.alias &&
         prevProps.entry.channel.source_id === nextProps.entry.channel.source_id &&
         prevProps.entry.channel.tv_archive === nextProps.entry.channel.tv_archive &&
         prevData.windowStart.getTime() === nextData.windowStart.getTime() &&
         prevData.windowEnd.getTime() === nextData.windowEnd.getTime() &&
         prevData.pixelsPerHour === nextData.pixelsPerHour &&
         prevData.visibleHours === nextData.visibleHours &&
         prevData.currentLayout === nextData.currentLayout &&
         prevData.includeSourceInSearch === nextData.includeSourceInSearch &&
         prevData.currentChannel?.stream_id === nextData.currentChannel?.stream_id &&
         prevData.highlightChannel?.stream_id === nextData.highlightChannel?.stream_id &&
         prevProgs === nextProgs &&
         !recordingsChanged;
});

// Overscan passed to the guide's VirtualList. The auto-scroll follow logic
// subtracts this from the reported rendered range so the "keep 2 channels
// above/below" padding math uses the VISIBLE bounds instead of the
// overscan-inflated ones (otherwise the list only scrolls after the channel
// has already left the viewport).
const CHANNEL_LIST_OVERS = 5;
// Above this many total channels, the "All Channels" view stops materializing
// the full list (multi-second transfer + parse for big libraries) and shows a
// notice instead. Categories/search remain the paths for huge libraries.
const ALL_CHANNELS_SOFT_CAP = 10000;

interface ChannelPanelProps {
  categoryId: string | null;
  visible: boolean;
  categoryStripOpen: boolean;
  onPlayChannel: (channel: StoredChannel) => void;
  onPlayCatchup?: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, programDesc?: string) => void;
  onClose: () => void;
  error?: string | null;
  isSearchMode?: boolean;
  searchQuery?: string;
  searchChannels?: StoredChannel[];
  searchPrograms?: StoredProgram[];
  searchScope?: 'channels' | 'epg' | 'both';
  isWatchlistMode?: boolean;
  watchlistItems?: WatchlistItem[];
  onWatchlistRefresh?: () => void;
  // Multiview props
  currentLayout?: string;
  multiviewEngineMode?: MultiviewEngineMode;
  onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null) => void;
  multiviewSlots?: ViewerSlot[];
  onSwapWithMain?: (slotId: 2 | 3 | 4) => void;
  onStopSlot?: (slotId: 2 | 3 | 4) => void;
  onReloadSlot?: (slotId: 2 | 3 | 4) => void;
  showSettingsPopup?: boolean;
  // Search display props
  includeSourceInSearch?: boolean;
  searchResultsOrder?: 'default' | 'alphabetical';
  // Metadata badge visibility on channel rows
  epgMetadataBadgeResolution?: boolean;
  epgMetadataBadgeFps?: boolean;
  epgMetadataBadgeSound?: boolean;
  epgMetadataBadgeBitrate?: boolean;
  epgMetadataBadgeAudioBitrate?: boolean;
  // Current playing channel for syncing preview
  currentChannel?: StoredChannel | null;
  // Channel the guide grid should highlight/scroll to (the keep-view anchor
  // when failover redirects tuning to a group primary; falls back to
  // currentChannel when unset or identical).
  highlightChannel?: StoredChannel | null;
  onTogglePlay?: () => void;
  isPlaying?: boolean;
  onChannelUp?: () => void;
  onChannelDown?: () => void;

  onPreviewVideoRectChange?: (rect: { left: number; top: number; width: number; height: number } | null) => void;

  // Playback state & controls for Alternate View NowPlayingBar overlay
  mpvReady?: boolean;
  duration?: number;
  position?: number;
  muted?: boolean;
  volume?: number;
  isVod?: boolean;
  vodInfo?: import('../types/media').VodPlayInfo | null;
  isCatchup?: boolean;
  catchupInfo?: {
    channelId: string;
    programTitle: string;
    startTime: number;
    duration: number;
    programDesc?: string;
  } | null;
  onStop?: () => void;
  onToggleMute?: () => void;
  onVolumeChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSeek?: (seconds: number) => void;
  onCycleSubtitle?: () => void;
  onCycleAudio?: () => void;
  onToggleStats?: () => void;
  onToggleConnectionInfo?: () => void;
  connectionInfoShortcut?: string;
  onToggleFullscreen?: () => void;
  onShowSubtitleModal?: () => void;
  onShowAudioModal?: () => void;
  onCatchupSeek?: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number, seekSeconds: number, programDesc?: string) => void;
  timeshiftEnabled?: boolean;
  timeshiftState?: {
    cacheStart: number;
    cacheEnd: number;
    timePos: number;
    behindLive: number;
    cachedDuration: number;
  } | null;
  onTimeshiftCatchUp?: () => void;
  aspectRatio?: AspectRatioMode;
  onSetAspectRatio?: (mode: AspectRatioMode) => void;
  pipMode?: boolean;
  onTogglePip?: () => void;
  /** Retry state for Live TV — shown in preview pane */
  retryState?: RetryState | null;
  /** Failover state for Live TV — shown in preview pane */
  failoverState?: FailoverState | null;
  /** Loading state for Live TV — shown in preview pane */
  loadingState?: 'idle' | 'loading' | 'buffering' | 'unavailable';
  // Popout props: 'off' | 'popout' | 'external'
  popoutMode?: 'off' | 'popout' | 'external';
  onTogglePopoutMode?: () => void;
  onPlayInPopout?: (channel: StoredChannel) => void;
  onPlayInExternal?: (channel: StoredChannel) => void;
  popoutIsOpen?: boolean;
  // Transparent guide mode (Z key) — hides preview pane, shows EPG grid over full video
  guideTransparent?: boolean;
  playerControlDesign?: 'default' | 'clean';
  showVolumePercent?: boolean;
  onToggleTransparentGuide?: () => void;
  isAudioOnly?: boolean;
  audioVisualizerMode?: VisualizerMode;
  onSetAudioVisualizerMode?: (mode: VisualizerMode) => void;
}

export function ChannelPanel({
  categoryId,
  visible,
  categoryStripOpen,
  onPlayChannel,
  onPlayCatchup,
  onClose,
  error,
  isSearchMode,
  searchQuery,
  searchChannels,
  searchPrograms,
  searchScope = 'both',
  isWatchlistMode,
  watchlistItems,
  onWatchlistRefresh,
  currentLayout,
  multiviewEngineMode = 'hls',
  onSendToSlot,
  multiviewSlots = [],
  onSwapWithMain,
  onStopSlot,
  onReloadSlot,
  showSettingsPopup = false,
  includeSourceInSearch,
  searchResultsOrder,
  epgMetadataBadgeResolution = true,
  epgMetadataBadgeFps = true,
  epgMetadataBadgeSound = true,
  epgMetadataBadgeBitrate = false,
  epgMetadataBadgeAudioBitrate = false,
  currentChannel,
  highlightChannel,
  onTogglePlay,
  isPlaying,
  onChannelUp,
  onChannelDown,
  mpvReady = false,
  duration = 0,
  position = 0,
  muted = false,
  volume = 100,
  isVod = false,
  vodInfo = null,
  isCatchup = false,
  catchupInfo = null,
  loadingState,
  onStop,
  onToggleMute,
  onVolumeChange,
  onSeek,
  onCycleSubtitle,
  onCycleAudio,
  onToggleStats,
  onToggleConnectionInfo,
  connectionInfoShortcut,
  onToggleFullscreen,
  onShowSubtitleModal,
  onShowAudioModal,
  onCatchupSeek,
  timeshiftEnabled = false,
  timeshiftState = null,
  onTimeshiftCatchUp,
  aspectRatio = 'fit',
  onSetAspectRatio,
  retryState = null,
  failoverState = null,
  popoutMode = 'off',
  onTogglePopoutMode,
  onPlayInPopout,
  onPlayInExternal,
  popoutIsOpen = false,
  guideTransparent = false,
  onPreviewVideoRectChange,
  pipMode = false,
  onTogglePip,
  playerControlDesign = 'clean',
  showVolumePercent,
  onToggleTransparentGuide,
  isAudioOnly,
  audioVisualizerMode = 'spectrum',
  onSetAudioVisualizerMode,
}: ChannelPanelProps) {
  const { t } = useTranslation();
  const epgView = useEpgView();
  const epgThreeColumn = useEpgThreeColumn();
  // The preview pane is sized by *height* (dragged via the bottom-center
  // vertical resizer) in both the alternate layout and the 3-column view;
  // only the traditional side-by-side layout drags its width/flex. Using
  // `epgView === 'alternate'` alone here made 3-column mode (which keeps
  // epgView 'traditional') drag an invisible flex value, so the height
  // always snapped back to the default on release.
  const isAltPreviewLayout = epgThreeColumn || epgView === 'alternate';
  const epgVisibleHours = useEpgVisibleHours();
  const epgClockFormat = useEpgClockFormat();
  const epgShowDate = useEpgShowDate();
  const epgLazyLoadingEnabled = useSettingsStore((s) => s.epgLazyLoadingEnabled);
  const layoutSettingsLoaded = useSettingsStore((s) => s.layoutSettingsLoaded);
  const showFailoverLiveTvWidget = useSettingsStore((s) => s.showFailoverLiveTvWidget);
  const audioMaxVolume = useSettingsStore((s) => s.subtitleSettings?.audioMaxVolume || 100);
  const transparentGuideHideHeader = useSettingsStore((s) => s.transparentGuideHideHeader);

  useEffect(() => {
    if (error) console.log('[ChannelPanel] Received error prop:', error);
  }, [error]);

  const channelSortOrder = useChannelSortOrder();
  const epgHiddenButtons = useUIStore((s) => s.epgHiddenButtons);
  const epgResolutionFilterEnabled = useSettingsStore((s) => s.epgResolutionFilterEnabled);
  const epgShowFullChannelPath = useSettingsStore((s) => s.epgShowFullChannelPath);
  const epgCatchupFilterEnabled = useSettingsStore((s) => s.epgCatchupFilterEnabled);
  // Soft-cap the "All Channels" view: beyond this many channels the full list
  // is unusable (a multi-second block to transfer + parse every channel), so we
  // skip materializing it and show a notice pointing at categories/search
  // instead. Only applies to the true All-Channels view (categoryId === null).
  const totalChannelCount = useChannelCount();
  const allChannelsCapped = !categoryId && totalChannelCount > ALL_CHANNELS_SOFT_CAP;
  // Optimization: Skip loading the main channel grid when in Search or Watchlist mode, when the panel is hidden
  // This prevents loading 40k+ channels in the background which causes UI lag
  const shouldSkipGrid = !visible || isSearchMode || isWatchlistMode || allChannelsCapped;
  const channels = useChannels(categoryId, channelSortOrder, { skip: shouldSkipGrid });

  // Distinct non-empty source ids in the current category. Used to decide
  // whether the show-source toggle is worth offering (multi-source categories
  // only) and to show a small count hint on the button. Computed synchronously
  // from the already-loaded channel list — no extra query, so deciding whether
  // the button is needed adds no delay.
  const categorySourceCount = useMemo(() => {
    const seen = new Set<string>();
    for (const ch of channels) {
      if (ch.source_id) seen.add(ch.source_id);
    }
    return seen.size;
  }, [channels]);
  const categorySpansMultipleSources = categorySourceCount > 1;

  // Channel Search Filter
  const [channelSearchQuery, setChannelSearchQuery] = useState('');
  const [channelSearchFocused, setChannelSearchFocused] = useState(false);

  useEffect(() => {
    setChannelSearchQuery('');
  }, [categoryId]);

  // Resolution filter (Settings -> LiveTV -> Resolution filter)
  const [resolutionFilter, setResolutionFilter] = useState<QualityFilter>('all');
  const [showResolutionMenu, setShowResolutionMenu] = useState(false);
  const [resolutionMetaMap, setResolutionMetaMap] = useState<Map<string, string> | null>(null);

  // Catch-up only filter (Settings -> Navigation -> EPG)
  const [catchupOnly, setCatchupOnly] = useState(false);

  // Reset the active filters whenever their setting is turned off
  useEffect(() => {
    if (!epgResolutionFilterEnabled) setResolutionFilter('all');
  }, [epgResolutionFilterEnabled]);

  useEffect(() => {
    if (!epgCatchupFilterEnabled) setCatchupOnly(false);
  }, [epgCatchupFilterEnabled]);

  // Load quality labels for the current category's sources when a filter is active.
  // Uses the indexed source_id lookup so one query covers the whole category.
  const resolutionSourceIds = useMemo(
    () => Array.from(new Set(channels.map((ch) => ch.source_id))),
    [channels]
  );
  useEffect(() => {
    if (resolutionFilter === 'all') {
      setResolutionMetaMap(null);
      return;
    }
    let cancelled = false;
    getChannelMetadataBySource(resolutionSourceIds).then((map) => {
      if (cancelled) return;
      const labels = new Map<string, string>();
      for (const [streamId, meta] of map) labels.set(streamId, meta.quality_label);
      setResolutionMetaMap(labels);
    });
    return () => { cancelled = true; };
  }, [resolutionFilter, resolutionSourceIds]);

  const filteredChannels = useMemo(() => {
    let result = channels;
    if (channelSearchQuery.trim()) {
      result = result.filter((ch) =>
        matchesSearch(ch.name, channelSearchQuery) ||
        (ch.alias && matchesSearch(ch.alias, channelSearchQuery)) ||
        (ch.channel_num != null && matchesSearch(String(ch.channel_num), channelSearchQuery))
      );
    }
    if (resolutionFilter !== 'all' && resolutionMetaMap) {
      result = result.filter((ch) => {
        const label = resolutionMetaMap.get(ch.stream_id);
        return !!label && qualityLabelMatchesFilter(label, resolutionFilter);
      });
    }
    if (catchupOnly) {
      result = result.filter((ch) => Boolean(ch.tv_archive) || ch.tv_archive === 1);
    }
    return result;
  }, [channels, channelSearchQuery, resolutionFilter, resolutionMetaMap, catchupOnly]);

  // Alphabet A-Z Quick Jumper (for Alphabetical Sort Order)
  const [showAlphabetMenu, setShowAlphabetMenu] = useState(false);

  const availableAlphabetLetters = useMemo(() => {
    if (channelSortOrder !== 'alphabetical') return new Set<string>();
    const set = new Set<string>();
    for (const ch of filteredChannels) {
      const name = ch.alias || ch.name;
      set.add(getChannelFirstLetter(name));
    }
    return set;
  }, [filteredChannels, channelSortOrder]);

  const handleJumpToLetter = useCallback((letter: string) => {
    const index = filteredChannels.findIndex((ch) => {
      const name = ch.alias || ch.name;
      return getChannelFirstLetter(name) === letter;
    });

    if (index !== -1 && virtuosoRef.current) {
      blockAutoScrollRef.current = true;
      virtuosoRef.current.scrollToIndex({ index, align: 'start', behavior: 'auto' });
    }
  }, [filteredChannels]);

  const categories = useCategories();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [availableWidth, setAvailableWidth] = useState(800);

  // Resize persistence state
  const [previewWidthPct, setPreviewWidthPct] = useState(() => {
    const saved = localStorage.getItem('guidePreviewWidth');
    return saved ? parseFloat(saved) : 54;
  });

  const [previewHeightPx, setPreviewHeightPx] = useState(() => {
    const saved = localStorage.getItem('guidePreviewHeight');
    if (saved) return parseInt(saved);
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    return Math.min(360, Math.round(vh * 0.35));
  });

  // Channel column width state
  const [channelColumnWidth, setChannelColumnWidth] = useState(() => {
    const saved = localStorage.getItem('epgChannelColumnWidth');
    return saved ? parseInt(saved) : DEFAULT_CHANNEL_COLUMN_WIDTH;
  });
  const channelColumnWidthRef = useRef(channelColumnWidth);
  channelColumnWidthRef.current = channelColumnWidth;

  // Set CSS custom property for channel column width
  useEffect(() => {
    document.documentElement.style.setProperty('--epg-channel-column-width', `${channelColumnWidth}px`);
  }, [channelColumnWidth]);

  // Get active recordings for showing indicators
  const { recordings: activeRecordings } = useActiveRecordings(5000);

  // Alternate view overlay tracking
  const [alternateControlsVisible, setAlternateControlsVisible] = useState(false);
  const mouseMoveTimeoutRef = useRef<number | null>(null);

  // Mini media bar hover tracking
  const [miniBarHovered, setMiniBarHovered] = useState(false);
  const [previewHovered, setPreviewHovered] = useState(false);

  const handlePreviewMouseMove = useCallback(() => {
    if (epgView !== 'alternate') return;
    setAlternateControlsVisible(true);
    if (mouseMoveTimeoutRef.current) {
      window.clearTimeout(mouseMoveTimeoutRef.current);
    }
    mouseMoveTimeoutRef.current = window.setTimeout(() => {
      setAlternateControlsVisible(false);
    }, 3000);
  }, [epgView]);

  const handlePreviewMouseLeave = useCallback(() => {
    if (epgView !== 'alternate') return;
    if (mouseMoveTimeoutRef.current) {
      window.clearTimeout(mouseMoveTimeoutRef.current);
    }
    setAlternateControlsVisible(false);
  }, [epgView]);

  // Handle preview pane hover for mini media bar visibility
  const handlePreviewPaneMouseEnter = useCallback(() => {
    setPreviewHovered(true);
  }, []);

  const handlePreviewPaneMouseLeave = useCallback(() => {
    setPreviewHovered(false);
  }, []);

  useEffect(() => {
    return () => {
      if (mouseMoveTimeoutRef.current) {
        window.clearTimeout(mouseMoveTimeoutRef.current);
      }
    };
  }, []);

  // Cached source name map to avoid repeated Tauri calls
  const { version: sourceVersion } = useSourceVersion();
  const sourceNameMapRef = useRef<Map<string, string>>(new Map());
  const categoryNameMapRef = useRef<Map<string, string>>(new Map());
  const lastSourceVersionRef = useRef<number>(-1);

  // Fetch source names and category names only when version changes
  useEffect(() => {
    if (lastSourceVersionRef.current === sourceVersion) return;

    async function fetchSourceNames() {
      if (window.storage) {
        try {
          const result = await window.storage.getSources();
          if (result.data) {
            const map = new Map<string, string>();
            for (const source of result.data) {
              map.set(source.id, source.name);
            }
            sourceNameMapRef.current = map;
            lastSourceVersionRef.current = sourceVersion;
          }
        } catch (e) {
          console.warn('[ChannelPanel] Failed to fetch source names:', e);
        }
      }
      try {
        // Also load category names for source → category display and channel hierarchy path
        const allCategories = await db.categories.toArray();
        const catMap = new Map<string, string>();
        for (const cat of allCategories) {
          catMap.set(cat.category_id, cat.alias || cat.category_name);
        }
        const allLinks = await db.playlistCategoryLinks.toArray();
        for (const link of allLinks) {
          const cat = allCategories.find(c => c.category_id === link.category_id);
          const displayName = link.custom_name || cat?.alias || cat?.category_name || link.category_id;
          catMap.set(`link:${link.id}`, displayName);
          if (link.custom_name && link.category_id) {
            catMap.set(link.category_id, link.custom_name);
          }
        }
        categoryNameMapRef.current = catMap;
      } catch (e) {
        console.warn('[ChannelPanel] Failed to fetch playlist category links:', e);
      }
    }

    fetchSourceNames();
  }, [sourceVersion]);

  // State for search results programs
  const [searchChannelPrograms, setSearchChannelPrograms] = useState<Map<string, StoredProgram[]>>(new Map());
  const [searchProgramChannels, setSearchProgramChannels] = useState<Map<string, StoredChannel>>(new Map());

  // Pre-filter active programs for search results count and rendering
  const activePrograms = useMemo(() => {
    if (!isSearchMode || !searchPrograms) return [];
    const now = new Date();
    return searchPrograms.filter(p => {
      const endTime = p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime();
      return endTime > now.getTime();
    });
  }, [isSearchMode, searchPrograms]);

  // Active search-result tab (single-select: only one section renders at a time)
  const [searchTab, setSearchTab] = useState<'channels' | 'live' | 'upcoming'>('channels');

  // True while the batched program queries for the search results are running
  // (drives the "Searching…" indicator in the header)
  const [searchLoading, setSearchLoading] = useState(false);

  // Reset to the Channels tab whenever a new search starts (not on every
  // keystroke, so the user's tab choice survives query refinement)
  const prevSearchMode = useRef(isSearchMode);
  useEffect(() => {
    if (isSearchMode && !prevSearchMode.current) {
      setSearchTab('channels');
    }
    prevSearchMode.current = isSearchMode;
  }, [isSearchMode]);

  // Split EPG program matches into live / upcoming groups (by channel) for the tabs
  const { liveChannels, upcomingChannels } = useMemo(() => {
    const live: { channel: StoredChannel; programs: StoredProgram[] }[] = [];
    const upcoming: { channel: StoredChannel; programs: StoredProgram[] }[] = [];
    if (!isSearchMode || searchScope === 'channels' || activePrograms.length === 0) {
      return { liveChannels: live, upcomingChannels: upcoming };
    }
    const now = new Date();
    const channelProgramsMap = new Map<string, { channel: StoredChannel; programs: StoredProgram[] }>();
    for (const program of activePrograms) {
      const channel = searchProgramChannels.get(program.stream_id);
      if (!channel) continue;
      const entry = channelProgramsMap.get(channel.stream_id);
      if (entry) {
        entry.programs.push(program);
      } else {
        channelProgramsMap.set(channel.stream_id, { channel, programs: [program] });
      }
    }
    for (const entry of channelProgramsMap.values()) {
      const hasLiveProgram = entry.programs.some(p => {
        const start = p.start instanceof Date ? p.start.getTime() : new Date(p.start).getTime();
        const end = p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime();
        return start <= now.getTime() && end > now.getTime();
      });
      if (hasLiveProgram) live.push(entry);
      else upcoming.push(entry);
    }
    if (searchResultsOrder === 'alphabetical') {
      const sortByChannelName = (a: { channel: StoredChannel }, b: { channel: StoredChannel }) => {
        const aName = a.channel.alias || a.channel.name;
        const bName = b.channel.alias || b.channel.name;
        return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
      };
      live.sort(sortByChannelName);
      upcoming.sort(sortByChannelName);
    }
    return { liveChannels: live, upcomingChannels: upcoming };
  }, [isSearchMode, searchScope, activePrograms, searchProgramChannels, searchResultsOrder]);

  // Tabs available for the current search scope, and the effective active tab
  const availableSearchTabs: ('channels' | 'live' | 'upcoming')[] = [];
  if (searchScope !== 'epg') availableSearchTabs.push('channels');
  if (searchScope !== 'channels') {
    availableSearchTabs.push('live', 'upcoming');
  }
  const effectiveSearchTab = availableSearchTabs.includes(searchTab) ? searchTab : availableSearchTabs[0] ?? 'channels';

  // State for watchlist data
  const [watchlistPrograms, setWatchlistPrograms] = useState<Map<string, StoredProgram[]>>(new Map());
  const [watchlistChannels, setWatchlistChannels] = useState<Map<string, StoredChannel>>(new Map());
  const [watchlistRefreshTrigger, setWatchlistRefreshTrigger] = useState(0);

  // Key to force re-render when favorites change
  const [favoritesVersion, setFavoritesVersion] = useState(0);

  // State for channel manager modal
  const [managingCategory, setManagingCategory] = useState<{ id: string; name: string; sourceId: string } | null>(null);
  const [managingFavorites, setManagingFavorites] = useState(false);
  const [managingFavoritesSourceId, setManagingFavoritesSourceId] = useState<string | null>(null);

  const [showFavPlaylistName, setShowFavPlaylistName] = useState(() => {
    const saved = localStorage.getItem('showFavPlaylistName');
    return saved === 'true';
  });

  const [showRecentPlaylistName, setShowRecentPlaylistName] = useState(() => {
    const saved = localStorage.getItem('showRecentPlaylistName');
    return saved === 'true';
  });

  const [showWatchlistPlaylistName, setShowWatchlistPlaylistName] = useState(() => {
    const saved = localStorage.getItem('showWatchlistPlaylistName');
    return saved === 'true';
  });

  const [showCustomPlaylistName, setShowCustomPlaylistName] = useState(() => {
    const saved = localStorage.getItem('showCustomPlaylistName');
    return saved === 'true';
  });

  // Show-source toggle for ordinary categories (All Channels, or a regular
  // source category that mixes channels from several playlists, e.g. via the
  // playlist editor). Only surfaced when the category actually spans multiple
  // sources — see categorySpansMultipleSources below.
  const [showCategorySourceName, setShowCategorySourceName] = useState(() => {
    const saved = localStorage.getItem('showCategorySourceName');
    return saved === 'true';
  });

  const [sourceNames, setSourceNames] = useState<Map<string, string>>(new Map());
  const [shortEpgSourceIds, setShortEpgSourceIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    async function loadSourceNames() {
      const map = new Map<string, string>();
      const shortEpgIds = new Set<string>();

      if (window.storage) {
        try {
          const result = await window.storage.getSources();
          if (result.data) {
            for (const source of result.data) {
              map.set(source.id, source.name);
              if (source.type === 'stalker' && source.mac && !source.disable_short_epg) {
                shortEpgIds.add(source.id);
              }
            }
          }
        } catch (e) {
          console.error('Failed to load source names', e);
        }
      }

      try {
        const customPls = await db.customPlaylists.toArray();
        for (const pl of customPls) {
          map.set(`playlist:${pl.playlist_id}`, pl.name);
          map.set(pl.playlist_id, pl.name);
        }
      } catch (e) {
        console.error('Failed to load custom playlists for source names', e);
      }

      setSourceNames(map);
      setShortEpgSourceIds(shortEpgIds);
    }
    loadSourceNames();
  }, []);

  // Ref to track the current categoryId without triggering the on-demand EPG sync
  const categoryIdRef = useRef(categoryId);
  useEffect(() => {
    categoryIdRef.current = categoryId;
  }, [categoryId]);

  // State for custom group manager
  const [managingCustomGroup, setManagingCustomGroup] = useState<{ id: string; name: string } | null>(null);

  // State for source sync/refresh
  const [syncingSourceId, setSyncingSourceId] = useState<string | null>(null);
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(null);

  // State for EPG shift modal
  const [showEpgShiftModal, setShowEpgShiftModal] = useState(false);
  const [currentEpgOffset, setCurrentEpgOffset] = useState(0);

  // State for failover group list modal
  const [showFailoverGroupModal, setShowFailoverGroupModal] = useState(false);
  const [showPlaylistListModal, setShowPlaylistListModal] = useState(false);
  // Channels the EPG Editor was opened with. Snapshot at click time, so the modal
  // opens on the list the user was looking at and a re-render of the guide can't
  // swap its contents (or its identity) underneath it.
  const [epgEditorList, setEpgEditorList] = useState<{ channels: StoredChannel[]; name: string } | null>(null);

  // Volume/mute state for mini media bar
  const [previewVolume, setPreviewVolume] = useState(100);
  const [previewMuted, setPreviewMuted] = useState(false);

  // Seek bar state for mini media bar (timeshift / VOD)
  const [seekHover, setSeekHover] = useState(false);
  const [seekDrag, setSeekDrag] = useState(false);
  const [hoverPos, setHoverPos] = useState(0);
  const seekBarRef = useRef<HTMLDivElement>(null);

  const hasTimeshift = timeshiftState && timeshiftState.cachedDuration > 1;
  const showSeek = (timeshiftEnabled && !!hasTimeshift) && !!onSeek;

  const getSeekRatio = useCallback((clientX: number): number => {
    if (!seekBarRef.current) return 0;
    const rect = seekBarRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const ts = hasTimeshift ? timeshiftState! : null;
  const seekFillPct = ts ? ((ts.timePos - ts.cacheStart) / ts.cachedDuration) * 100 : 0;

  const handleSeekClick = useCallback((e: React.MouseEvent) => {
    if (!showSeek || !onSeek) return;
    const ratio = getSeekRatio(e.clientX);
    if (ts) {
      onSeek(ts.cacheStart + ratio * ts.cachedDuration);
    }
  }, [showSeek, onSeek, getSeekRatio, ts]);

  const handleSeekDragStart = useCallback((e: React.MouseEvent) => {
    if (!showSeek || !onSeek) return;
    e.preventDefault();
    setSeekDrag(true);
    const ratio = getSeekRatio(e.clientX);
    setHoverPos(ts ? ts.cacheStart + ratio * ts.cachedDuration : 0);
  }, [showSeek, onSeek, getSeekRatio, ts]);

  useEffect(() => {
    if (!seekDrag) return;
    const onMove = (e: MouseEvent) => {
      const ratio = getSeekRatio(e.clientX);
      setHoverPos(ts ? ts.cacheStart + ratio * ts.cachedDuration : 0);
    };
    const onUp = (e: MouseEvent) => {
      setSeekDrag(false);
      if (onSeek) {
        const ratio = getSeekRatio(e.clientX);
        if (ts) onSeek(ts.cacheStart + ratio * ts.cachedDuration);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [seekDrag, onSeek, getSeekRatio, ts]);

  // Aspect ratio menu state for mini media bar
  const [showAspectMenu, setShowAspectMenu] = useState(false);
  const aspectMenuRef = useRef<HTMLDivElement>(null);

  // Close aspect ratio menu on outside click
  useEffect(() => {
    if (!showAspectMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (aspectMenuRef.current && !aspectMenuRef.current.contains(e.target as Node)) {
        setShowAspectMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showAspectMenu]);

  // Ref for measuring the grid container width
  const gridContainerRef = useRef<HTMLDivElement>(null);


  // Track window width to differentiate window resize vs category toggle
  const lastWindowWidth = useRef(typeof window !== 'undefined' ? window.innerWidth : 0);

  // Measure available width - only recalculate on actual window resize
  // Category toggles just clip visually (CSS flex handles it)
  //
  // NOTE: getBoundingClientRect() returns post-zoom (visual) pixels, but CSS
  // `left`/`width` inside .app use pre-zoom (layout) pixels. We must divide by
  // --app-zoom so that availableWidth is always in layout pixels, matching how
  // program blocks and time-markers are positioned.
  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) return;

    const getZoom = () =>
      parseFloat(document.documentElement.style.getPropertyValue('--app-zoom')) || 1;

    const measureWidth = () => {
      if (!gridContainerRef.current) return;
      const zoom = getZoom();
      // getBoundingClientRect gives visual (post-zoom) px; divide by zoom to
      // convert back to layout px so it matches channelColumnWidth and the CSS
      // coordinate space used by program/time-marker positioning.
      const visualWidth = gridContainerRef.current.getBoundingClientRect().width;
      const width = (visualWidth / zoom) - channelColumnWidthRef.current;
      setAvailableWidth(Math.max(width, 200));
    };

    let rafId: number | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const currentWindowWidth = window.innerWidth;
      const isWindowResize = currentWindowWidth !== lastWindowWidth.current;

      if (isWindowResize) {
        // Actual window resize - recalculate program positions
        lastWindowWidth.current = currentWindowWidth;

        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            measureWidth();
            rafId = null;
          });
        }
      }
      // Category toggle: skip recalculation, CSS flex handles visual clipping
    });

    // Also listen for actual window resize
    const handleWindowResize = () => {
      lastWindowWidth.current = window.innerWidth;
      measureWidth();
    };

    // Set initial width
    measureWidth();

    observer.observe(container);
    window.addEventListener('resize', handleWindowResize);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  const parsedEpgVisibleHours = epgVisibleHours === 'auto' ? undefined : Number(epgVisibleHours);

  // Time grid state and actions
  const {
    isAtNow,
    visibleHours,
    pixelsPerHour,
    windowStart,
    windowEnd,
    loadStart,
    loadEnd,
    goBack,
    goForward,
    goToNow,
  } = useTimeGrid({
    availableWidth,
    minHours: parsedEpgVisibleHours,
    maxHours: parsedEpgVisibleHours,
  });

  // Programs will be fetched after selectedChannel is defined (see below)

  // Update current time to keep progress bars, current-time indicator, and schedule in sync.
  // Paused when the guide panel is not visible to eliminate background overhead.
  useEffect(() => {
    if (visible === false) return;
    setCurrentTime(new Date());
    const timer = setInterval(() => setCurrentTime(new Date()), 10000);
    return () => clearInterval(timer);
  }, [visible]);

  // Calculate current time indicator position
  const currentTimeIndicatorPosition = useMemo(() => {
    const hoursFromStart = (currentTime.getTime() - windowStart.getTime()) / (1000 * 60 * 60);
    const position = hoursFromStart * pixelsPerHour;
    // Only show if within visible window
    if (position < 0 || position > availableWidth) return null;
    return position;
  }, [currentTime, windowStart, pixelsPerHour, availableWidth]);

  // ── Current-time indicator height ─────────────────────────────────────────
  // The indicator line should stop at the last rendered row instead of spanning
  // the whole content area (e.g. when a category/search has only a few channels
  // that don't fill the panel). We measure the Virtuoso list element, whose
  // height equals the total height of all rows.
  const [guideScroller, setGuideScroller] = useState<HTMLElement | null>(null);
  const handleGuideScrollerRef = useCallback((node: HTMLElement | Window | null) => {
    if (node instanceof HTMLElement) setGuideScroller(node);
  }, []);
  const guideListHeight = useVirtuosoListHeight(guideScroller);

  // Same measurement for the virtualized Channels tab of search results
  const [searchScroller, setSearchScroller] = useState<HTMLElement | null>(null);
  const handleSearchScrollerRef = useCallback((node: HTMLElement | Window | null) => {
    if (node instanceof HTMLElement) setSearchScroller(node);
  }, []);
  const searchChannelsListHeight = useVirtuosoListHeight(searchScroller);

  // Scroll-to-top button (Nuvio-style) for the virtualized search results:
  // appears at the bottom-right once the active tab's scroller is scrolled down.
  const [showSearchScrollTop, setShowSearchScrollTop] = useState(false);
  const searchScrollRAFRef = useRef(0);

  useEffect(() => {
    if (!isSearchMode || !searchScroller) {
      setShowSearchScrollTop(false);
      return;
    }

    setShowSearchScrollTop(searchScroller.scrollTop > 400);

    const handleScroll = () => {
      if (searchScrollRAFRef.current) return;
      searchScrollRAFRef.current = requestAnimationFrame(() => {
        searchScrollRAFRef.current = 0;
        setShowSearchScrollTop(searchScroller.scrollTop > 400);
      });
    };

    searchScroller.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      searchScroller.removeEventListener('scroll', handleScroll);
      if (searchScrollRAFRef.current) cancelAnimationFrame(searchScrollRAFRef.current);
    };
  }, [isSearchMode, searchScroller]);

  // Keyboard navigation
  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goForward();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, goBack, goForward]);

  // Fetch programs for search results
  // Channel matches are batched into a handful of IN queries (instead of one
  // query per channel) and follow the navigated time window, so large result
  // sets load fast and back/forward on the Channels tab shows real programs.
  useEffect(() => {
    if (!isSearchMode) {
      setSearchChannelPrograms(new Map());
      setSearchProgramChannels(new Map());
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);

    async function fetchSearchData() {
      const channelProgramsMap = new Map<string, StoredProgram[]>();
      const programChannelsMap = new Map<string, StoredChannel>();

      // Fetch programs for channel search results (batched, window-aware)
      if (searchChannels && searchChannels.length > 0) {
        const startIso = loadStart.toISOString();
        const endIso = loadEnd.toISOString();
        const streamIds = searchChannels.map((ch) => ch.stream_id);
        for (const id of streamIds) channelProgramsMap.set(id, []);

        // Query programs_effective in chunks to respect SQLite variable limit
        const dbInstance = await (db as any).dbPromise;
        const allPrograms: StoredProgram[] = [];
        const CHUNK = 500;
        for (let i = 0; i < streamIds.length; i += CHUNK) {
          const chunk = streamIds.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => '?').join(',');
          const rows = await dbInstance.select(
            `SELECT * FROM programs_effective
             WHERE stream_id IN (${placeholders})
               AND start < ? AND end > ?
             ORDER BY start ASC`,
            [...chunk, endIso, startIso]
          ) as StoredProgram[];
          allPrograms.push(...rows);
        }

        for (const prog of allPrograms) {
          const list = channelProgramsMap.get(prog.stream_id);
          if (list) {
            list.push({
              ...prog,
              description: decompressEpgDescription(prog.description) ?? prog.description,
            });
          }
        }
      }

      // Fetch channels for program search results and organize programs by channel
      if (searchPrograms && searchPrograms.length > 0) {
        const uniqueStreamIds = new Set(searchPrograms.map(p => p.stream_id));
        for (const streamId of uniqueStreamIds) {
          const channel = await db.channels.get(streamId);
          if (channel) {
            // Add source_name and source_category_display if includeSourceInSearch is enabled (using cached maps)
            if (includeSourceInSearch) {
              const sourceName = sourceNameMapRef.current.get(channel.source_id);
              channel.source_name = sourceName || undefined;
              if (sourceName && categoryNameMapRef.current.size > 0) {
                const catIds = parseCategoryIds(channel.category_ids);
                const catName = catIds.length > 0 ? (categoryNameMapRef.current.get(catIds[0]) || catIds[0]) : '—';
                channel.source_category_display = `${sourceName} → ${catName}`;
              }
            }
            programChannelsMap.set(streamId, channel);

            // Get all matching programs for this channel
            const channelMatchingProgs = searchPrograms.filter(p => p.stream_id === streamId);
            channelProgramsMap.set(streamId, channelMatchingProgs);
          }
        }
      }

      if (cancelled) return;
      setSearchChannelPrograms(channelProgramsMap);
      setSearchProgramChannels(programChannelsMap);
      setSearchLoading(false);
    }

    fetchSearchData();
    return () => { cancelled = true; };
  }, [isSearchMode, searchChannels, searchPrograms, includeSourceInSearch, loadStart, loadEnd]);

  // Fetch data for watchlist
  useEffect(() => {
    if (!isWatchlistMode) {
      setWatchlistPrograms(new Map());
      setWatchlistChannels(new Map());
      return;
    }

    async function fetchWatchlistData() {
      const programsMap = new Map<string, StoredProgram[]>();
      const channelsMap = new Map<string, StoredChannel>();

      if (watchlistItems && watchlistItems.length > 0) {
        for (const item of watchlistItems) {
          // Get channel
          const channel = await db.channels.get(item.channel_id);
          if (channel) {
            channelsMap.set(item.channel_id, channel);
          }

          // Get the actual program from the database
          const program = await db.programs.get(item.program_id);
          if (program) {
            const existingProgs = programsMap.get(item.channel_id) || [];
            existingProgs.push(program);
            programsMap.set(item.channel_id, existingProgs);
          } else {
            // Create a program from watchlist data if not found in DB
            const watchlistProgram: StoredProgram = {
              id: item.program_id,
              stream_id: item.channel_id,
              title: item.program_title,
              description: item.description || '',
              start: new Date(item.start_time),
              end: new Date(item.end_time),
              source_id: item.source_id,
            };
            programsMap.set(item.channel_id, [watchlistProgram]);
          }
        }
      }

      setWatchlistPrograms(programsMap);
      setWatchlistChannels(channelsMap);
    }

    fetchWatchlistData();
  }, [isWatchlistMode, watchlistItems, watchlistRefreshTrigger]);

  // Get current category name
  const currentCategory = categoryId
    ? categories.find((c) => c.category_id === categoryId)
    : null;

  // Resolve custom/linked category if applicable
  const playlistCatLink = useLiveQuery(
    async () => {
      if (!categoryId || !categoryId.startsWith('__plcat_')) return null;
      const linkId = parseInt(categoryId.replace('__plcat_', ''), 10);
      if (isNaN(linkId)) return null;
      try {
        const link = await db.playlistCategoryLinks.get(linkId);
        if (!link) return null;
        
        let name = link.custom_name;
        if (!name) {
          const origCat = await db.categories.get(link.category_id);
          name = origCat?.alias || origCat?.category_name || link.category_id;
        }
        return {
          ...link,
          displayName: name
        };
      } catch (err) {
        console.warn('[ChannelPanel] Failed to fetch playlist category link:', err);
        return null;
      }
    },
    [categoryId],
    null,
    0,
    'playlist_category_links'
  );

  const categoryName = playlistCatLink
    ? (playlistCatLink.displayName ?? t('linkedCategory'))
    : ((currentCategory?.alias || currentCategory?.category_name) ?? i18n.t('live:allChannels'));

  // The EPG editor's list tab names the category it was handed. Left empty when
  // there is no real category (All Channels / Favorites), so the modal falls back
  // to its own label instead of producing "Filter All Channels channels…".
  const epgEditorListName = playlistCatLink
    ? (playlistCatLink.displayName ?? '')
    : ((currentCategory?.alias || currentCategory?.category_name) ?? '');

  // Get source ID from current category or playlist link
  const sourceId = playlistCatLink
    ? playlistCatLink.playlist_id
    : (currentCategory?.source_id ?? '');

  // Load current EPG offset and keep it in sync with Settings
  useEffect(() => {
    if (!sourceId) return;
    const loadOffset = async () => {
      try {
        const meta = await db.sourcesMeta.get(sourceId);
        setCurrentEpgOffset((meta as any)?.epg_timeshift_hours ?? 0);
      } catch (e) {
        console.warn('[ChannelPanel] Failed to load EPG offset:', e);
      }
    };
    loadOffset();
    const unsubscribe = dbEvents.subscribe('programs', () => {
      loadOffset();
    });
    return () => unsubscribe();
  }, [sourceId]);

  // Handle opening channel manager
  const handleManageChannels = useCallback(() => {
    if (categoryId && sourceId) {
      if (categoryId.startsWith('__plcat_')) {
        const linkId = categoryId.replace('__plcat_', '');
        setManagingCategory({ id: `link:${linkId}`, name: categoryName, sourceId });
      } else if (!categoryId.startsWith('__')) {
        setManagingCategory({ id: categoryId, name: categoryName, sourceId });
      }
    }
  }, [categoryId, categoryName, sourceId]);

  // Handle source sync/refresh
  const handleRefreshSource = useCallback(async () => {
    if (!sourceId || !window.storage) return;

    // Get full source data
    const result = await window.storage.getSources();
    const source = result.data?.find(s => s.id === sourceId);
    if (!source) return;

    setSyncingSourceId(sourceId);
    setSyncStatusMsg(i18n.t('common:starting'));

    try {
      const syncResult = await syncSource(source, setSyncStatusMsg);
      if (syncResult.success) {
        console.log(`[ChannelPanel] Source ${source.name} synced: ${syncResult.channelCount} channels`);
        try {
          setSyncStatusMsg(i18n.t('common:updatingEpg'));
          const channels = await db.channels.where('source_id').equals(sourceId).toArray() as any[];
          await applyGlobalEpgToSource(source, channels, setSyncStatusMsg);
        } catch (epgErr) {
          console.error(`[ChannelPanel] Source ${source.name} global EPG apply failed:`, epgErr);
        }
        // Force refresh by incrementing favorites version
        setFavoritesVersion(v => v + 1);
      } else {
        console.error(`[ChannelPanel] Source ${source.name} sync failed:`, syncResult.error);
      }
    } catch (err) {
      console.error('[ChannelPanel] Sync error:', err);
    } finally {
      setSyncingSourceId(null);
      setSyncStatusMsg(null);
    }
  }, [sourceId]);

  // Handle EPG time offset shift
  const handleEpgShiftChange = useCallback(async (newOffset: number) => {
    if (!sourceId || !window.storage) return;
    const result = await window.storage.getSources();
    const source = result.data?.find(s => s.id === sourceId);
    if (!source) return;
    const updatedSource = { ...source, epg_timeshift_hours: newOffset };
    const saveResult = await window.storage.saveSource(updatedSource);
    if (saveResult.error) {
      console.error('[ChannelPanel] Failed to save EPG shift:', saveResult.error);
      return;
    }
    try {
      const dbInstance = await (db as any).dbPromise;
      await dbInstance.execute(
        `UPDATE sourcesMeta SET epg_timeshift_hours = $1 WHERE source_id = $2`,
        [newOffset, sourceId]
      );
      dbEvents.notify('programs', 'update');
    } catch (e) {
      console.warn('[ChannelPanel] Could not update sourcesMeta epg_timeshift_hours:', e);
    }
  }, [sourceId]);

  // Handle channel manager close with refresh
  const handleChannelManagerClose = useCallback(() => {
    setManagingCategory(null);
    // Force refresh channels by incrementing favorites version
    setFavoritesVersion(v => v + 1);
  }, []);

  // Check if we can manage channels (not for virtual categories like favorites/recent)
  const isPlaylistCatLink = categoryId && categoryId.startsWith('__plcat_');
  const canManageChannels = categoryId && (!categoryId.startsWith('__') || isPlaylistCatLink) && sourceId;

  // Check if current category is a custom group and get its name using live query
  // This ensures the Manage button appears immediately when a custom group is created
  const customGroup = useLiveQuery(
    async () => {
      if (!categoryId) return null;
      const group = await db.customGroups.get(categoryId);
      return group;
    },
    [categoryId],
    null,
    0,
    'customGroups' // Watch customGroups table for changes
  );
  
  const isCustomGroup = !!customGroup;
  const customGroupName = customGroup?.name || 'Custom Group';
  const isCustomPlaylistCat = !!categoryId && (categoryId.startsWith('__plindiv_') || categoryId.startsWith('__allsrc_pl_') || categoryId.startsWith('playlist:'));
  const isPlaylistSource = !!sourceId && sourceId.startsWith('playlist:');
  const isCustomCategory = isCustomGroup || Boolean(isPlaylistCatLink) || isCustomPlaylistCat || isPlaylistSource;

  // Does the guide's channel strip render the source/playlist line on each row?
  // Drives both the row markup and the strip's row-height estimate, so it is
  // computed once here instead of inline in the row context.
  const guideShowPlaylistName = categoryId === '__recent__'
    ? showRecentPlaylistName
    : categoryId === '__favorites__'
      ? showFavPlaylistName
      : isCustomCategory
        ? showCustomPlaylistName
        : categorySpansMultipleSources
          ? showCategorySourceName
          : false;

  // Row heights for the two virtualized channel strips. The estimate the
  // virtualizer uses for rows it has never measured comes from the live design
  // tokens and is corrected by the height of a real row as soon as one renders
  // (see useGuideRowHeight) - a jump to a channel far down the list has to land
  // on the right row, not re-settle after the fact.
  const showBitrateBadge = Boolean(epgMetadataBadgeBitrate || epgMetadataBadgeAudioBitrate);
  const { rowHeight: guideRowHeight, onVirtualItemsChange: onGuideVirtualItemsChange } = useGuideRowHeight({
    playlistName: guideShowPlaylistName,
    bitrateBadge: showBitrateBadge,
  });
  const { rowHeight: searchChannelRowHeight, onVirtualItemsChange: onSearchChannelVirtualItemsChange } = useGuideRowHeight({
    playlistName: includeSourceInSearch ?? false,
    bitrateBadge: showBitrateBadge,
  });

  // Format time (and optional date if epgShowDate is enabled)
  const formatEpgTime = useCallback((date: Date) => {
    const timeStr = formatTime(date, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });
    if (epgShowDate) {
      const dateStr = formatDate(date, { month: 'numeric', day: 'numeric' });
      return `${dateStr} ${timeStr}`;
    }
    return timeStr;
  }, [epgClockFormat, epgShowDate]);

  // Generate time slots aligned to the grid
  const timeSlots = useMemo(() => {
    const slots: Date[] = [];
    // Start from the hour at or before windowStart
    const start = new Date(windowStart);
    start.setMinutes(0, 0, 0);

    // Generate slots for each hour in the visible window
    const hoursToShow = Math.ceil(visibleHours) + 1;
    for (let i = 0; i < hoursToShow; i++) {
      const slot = new Date(start.getTime() + i * 60 * 60 * 1000);
      // Only include if it falls within or slightly before the visible window
      if (slot.getTime() <= windowEnd.getTime()) {
        slots.push(slot);
      }
    }

    return slots;
  }, [windowStart, windowEnd, visibleHours]);

  // Calculate position of a time slot within the grid
  const getTimeSlotPosition = useCallback(
    (slotTime: Date) => {
      const offsetHours = (slotTime.getTime() - windowStart.getTime()) / 3600000;
      return offsetHours * pixelsPerHour;
    },
    [windowStart, pixelsPerHour]
  );

  // Selected channel for preview/info - stores the full channel object
  const [selectedChannel, setSelectedChannel] = useState<StoredChannel | null>(null);

  const selectedCategoryName = useMemo(() => {
    if (!selectedChannel) return undefined;
    const catId = parseCategoryIds(selectedChannel.category_ids)[0] || categoryId;
    const found = categories?.find(c => c.category_id === catId && (!selectedChannel.source_id || c.source_id === selectedChannel.source_id))
      || categories?.find(c => c.category_id === catId);
    return found?.alias || found?.category_name || (catId ? categoryNameMapRef.current.get(catId) : undefined);
  }, [selectedChannel, categoryId, categories]);

  const selectedChannelFullPath = useMemo(() => {
    return formatChannelFullPath({
      channel: selectedChannel,
      categoryId,
      currentCategory,
      linkedCategoryDisplayName: playlistCatLink?.displayName,
      categories,
      categoryNameMap: categoryNameMapRef.current,
      sourceNames,
      isWatchlistMode,
      isSearchMode,
      fallbackCategoryName: categoryName,
      translations: {
        favorites: i18n.t('live:favorites', { defaultValue: 'Favorites' }),
        watchlist: i18n.t('live:watchlist', { defaultValue: 'Watchlist' }),
        recentlyViewed: i18n.t('live:recentlyViewed', { defaultValue: 'Recently Viewed' }),
      },
    });
  }, [
    selectedChannel,
    categoryId,
    currentCategory,
    playlistCatLink?.displayName,
    categories,
    sourceNames,
    isWatchlistMode,
    isSearchMode,
    categoryName,
    i18n.language,
  ]);

  const displayCategoryOrPath = useMemo(() => {
    return formatChannelDisplayPath({
      channel: selectedChannel,
      categoryId,
      currentCategory,
      linkedCategoryDisplayName: playlistCatLink?.displayName,
      categories,
      categoryNameMap: categoryNameMapRef.current,
      sourceNames,
      isWatchlistMode,
      isSearchMode,
      showFullPath: epgShowFullChannelPath,
      fallbackCategoryName: categoryName,
      translations: {
        favorites: i18n.t('live:favorites', { defaultValue: 'Favorites' }),
        watchlist: i18n.t('live:watchlist', { defaultValue: 'Watchlist' }),
        recentlyViewed: i18n.t('live:recentlyViewed', { defaultValue: 'Recently Viewed' }),
      },
    });
  }, [
    selectedChannel,
    categoryId,
    currentCategory,
    playlistCatLink?.displayName,
    categories,
    sourceNames,
    isWatchlistMode,
    isSearchMode,
    epgShowFullChannelPath,
    categoryName,
    i18n.language,
  ]);

  // States for Stalker EPG lazy loading and progress tracking
  const [visibleIndices, setVisibleIndices] = useState({ startIndex: 0, endIndex: 35 });
  const [epgSyncStatus, setEpgSyncStatus] = useState<{ completed: number; total: number } | null>(null);

  const shouldFetchShortEpgForVisibleRange = useMemo(() => {
    if (isSearchMode || isWatchlistMode || shortEpgSourceIds.size === 0) return false;
    return filteredChannels.some((channel) => shortEpgSourceIds.has(channel.source_id));
  }, [filteredChannels, shortEpgSourceIds, isSearchMode, isWatchlistMode]);

  const shouldTrackVisibleRange = epgLazyLoadingEnabled || shouldFetchShortEpgForVisibleRange;

  // Get stream IDs for programs lookup
  // Include selectedChannel (from currentChannel prop) in case it's from a different category/source
  const streamIds = useMemo(() => {
    let activeChannels = filteredChannels;
    if (epgLazyLoadingEnabled && !isSearchMode && !isWatchlistMode) {
      const buffer = 15; // 15 channels buffer above/below for smooth scrolling
      const start = Math.max(0, visibleIndices.startIndex - buffer);
      const end = Math.min(filteredChannels.length, visibleIndices.endIndex + buffer);
      activeChannels = filteredChannels.slice(start, end);
    }

    const ids = activeChannels.map((ch) => ch.stream_id);
    if (selectedChannel?.stream_id && !ids.includes(selectedChannel.stream_id)) {
      ids.push(selectedChannel.stream_id);
    }
    return ids;
  }, [filteredChannels, selectedChannel?.stream_id, visibleIndices, epgLazyLoadingEnabled, isSearchMode, isWatchlistMode]);

  // Fetch programs (either ALL at once or lazy-loaded by time window)
  const rangePrograms = useProgramsInRange(streamIds, loadStart, loadEnd, { skip: !layoutSettingsLoaded || !epgLazyLoadingEnabled });
  const allPrograms = useAllPrograms(streamIds, { skip: !layoutSettingsLoaded || epgLazyLoadingEnabled });
  const programs = epgLazyLoadingEnabled ? rangePrograms : allPrograms;

  // Trigger on-demand short EPG fetch for visible Stalker channels
  useEffect(() => {
    if (!visible || !shouldFetchShortEpgForVisibleRange || !filteredChannels || filteredChannels.length === 0 || !window.storage) {
      setEpgSyncStatus(null);
      return;
    }

    let active = true;

    // We debounce the fetch to wait until the user stops scrolling for 300ms
    const timer = setTimeout(async () => {
      // Get the range of channels currently visible + buffer of 5 channels
      const start = Math.max(0, visibleIndices.startIndex - 5);
      const end = Math.min(filteredChannels.length, visibleIndices.endIndex + 5);
      const visibleChannels = filteredChannels.slice(start, end);

      if (visibleChannels.length === 0) return;

      // Group visible channels by source_id
      const channelsBySource = new Map<string, typeof channels>();
      for (const ch of visibleChannels) {
        const list = channelsBySource.get(ch.source_id) || [];
        list.push(ch);
        channelsBySource.set(ch.source_id, list);
      }

      try {
        const result = await window.storage.getSources();
        if (!result.data || !active) return;

        for (const [sourceId, sourceChannels] of channelsBySource.entries()) {
          const source = result.data.find(s => s.id === sourceId);
          if (source && source.type === 'stalker' && source.mac && !source.disable_short_epg) {
            const { syncStalkerShortEpg } = await import('../db/sync');
            
            await syncStalkerShortEpg(
              source,
              sourceChannels,
              categoryIdRef.current,
              (completed, total) => {
                if (active) {
                  setEpgSyncStatus({ completed, total });
                }
              }
            );
          }
        }
      } catch (err) {
        console.error('[ChannelPanel] Failed to fetch on-demand short EPG:', err);
      } finally {
        if (active) {
          // Keep the progress text visible for a short duration after completion
          setTimeout(() => {
            if (active) {
              setEpgSyncStatus(null);
            }
          }, 1000);
        }
      }
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
      setEpgSyncStatus(null);
    };
  }, [channels, visible, visibleIndices, categoryId, shouldFetchShortEpgForVisibleRange]);

  // Sync selectedChannel with the view channel when it changes externally
  // (watchlist notification, autoswitch, calendar, multiview swap). The view
  // channel is the keep-view anchor when failover redirects tuning to a group
  // primary, so the preview info bar (name/logo/program) matches the highlighted
  // grid row even though the primary is the stream playing.
  useEffect(() => {
    const syncChannel = highlightChannel ?? currentChannel;
    if (syncChannel?.stream_id) {
      setSelectedChannel((prev) => {
        if (prev?.stream_id !== syncChannel.stream_id) {
          return syncChannel;
        }
        return prev;
      });
    }
  }, [highlightChannel?.stream_id, currentChannel, visible]);

  // Track if we have a channel to show
  const hasSelectedChannel = selectedChannel !== null;

  // Compute mini bar visibility based on hover state (disabled in alternate EPG view which uses NowPlayingBar)
  const isMiniBarVisible = selectedChannel && (previewHovered || miniBarHovered) && epgView !== 'alternate';

  // Handle Channel Click: Preview vs Fullscreen
  const handleChannelClick = useCallback((channel: StoredChannel) => {
    blockAutoScrollRef.current = true;
    if (selectedChannel?.stream_id === channel.stream_id) {
      // Already selected/previewing -> check for double click to close guide
      const now = Date.now();
      const lastClick = lastChannelClickRef.current;
      if (lastClick && lastClick.streamId === channel.stream_id && (now - lastClick.timestamp) <= DOUBLE_CLICK_MS) {
        // Double-click detected -> Go Fullscreen (Close Guide)
        onClose();
      } else {
        // Single click -> Replay the stream without closing LiveTV
        lastChannelClickRef.current = { streamId: channel.stream_id, timestamp: now };
        onPlayChannel(channel);
      }
    } else {
      // Select for preview and play immediately
      lastChannelClickRef.current = { streamId: channel.stream_id, timestamp: Date.now() };
      setSelectedChannel(channel);
      // Also update last channel ref immediately for resize effect
      lastChannelIdRef.current = channel.stream_id;
      onPlayChannel(channel);
    }
  }, [selectedChannel?.stream_id, onClose, onPlayChannel]);

  // Handle favorite toggle - refresh channel data
  const handleFavoriteToggle = useCallback(async () => {
    // We no longer manually increment favoritesVersion here.
    // Toggling the favorite directly mutates the SQLite database.
    // The useChannels liveQuery will automatically detect the mutation
    // and provide a fresh array to Virtuoso without destroying scroll position!
  }, []);

  // Handle volume change for preview mini bar
  const handlePreviewVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseInt(e.target.value, 10);
    setPreviewVolume(newVol);
    Bridge.setProperty('volume', newVol).catch(console.error);
    if (newVol > 0 && previewMuted) {
      setPreviewMuted(false);
      Bridge.setProperty('mute', false).catch(console.error);
    }
  }, [previewMuted]);

  // Handle scroll wheel on the preview pane to adjust volume
  const handlePreviewWheelVolume = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const delta = e.deltaY < 0 ? 5 : -5;
    setPreviewVolume((prev) => {
      const newVol = Math.min(100, Math.max(0, prev + delta));
      Bridge.setProperty('volume', newVol).catch(console.error);
      if (newVol > 0) {
        setPreviewMuted(false);
        Bridge.setProperty('mute', false).catch(console.error);
      }
      return newVol;
    });
  }, []);

  // Handle mute toggle for preview mini bar
  const handlePreviewMuteToggle = useCallback(() => {
    const newMuted = !previewMuted;
    setPreviewMuted(newMuted);
    Bridge.setProperty('mute', newMuted).catch(console.error);
    if (newMuted && previewVolume === 0) {
      setPreviewVolume(100);
      Bridge.setProperty('volume', 100).catch(console.error);
    }
  }, [previewMuted, previewVolume]);

  // Handle search result click - same logic as regular channel click
  const handleSearchChannelClick = useCallback((channel: StoredChannel) => {
    blockAutoScrollRef.current = true;
    if (selectedChannel?.stream_id === channel.stream_id) {
      // Already selected/previewing -> check for double click to close guide
      const now = Date.now();
      const lastClick = lastChannelClickRef.current;
      if (lastClick && lastClick.streamId === channel.stream_id && (now - lastClick.timestamp) <= DOUBLE_CLICK_MS) {
        // Double-click detected -> Go Fullscreen (Close Guide)
        onClose();
      } else {
        // Single click -> Replay the stream without closing LiveTV
        lastChannelClickRef.current = { streamId: channel.stream_id, timestamp: now };
        onPlayChannel(channel);
      }
    } else {
      // Select for preview and play immediately
      lastChannelClickRef.current = { streamId: channel.stream_id, timestamp: Date.now() };
      setSelectedChannel(channel);
      // Also update last channel ref immediately for resize effect
      lastChannelIdRef.current = channel.stream_id;
      onPlayChannel(channel);
    }
  }, [selectedChannel?.stream_id, onClose, onPlayChannel]);

  // Handle search program click - find channel and use same logic
  const handleSearchProgramClick = async (program: StoredProgram) => {
    const channel = await db.channels.get(program.stream_id);
    if (channel) {
      blockAutoScrollRef.current = true;
      if (selectedChannel?.stream_id === channel.stream_id) {
        // Already selected/previewing -> check for double click to close guide
        const now = Date.now();
        const lastClick = lastChannelClickRef.current;
        if (lastClick && lastClick.streamId === channel.stream_id && (now - lastClick.timestamp) <= DOUBLE_CLICK_MS) {
          // Double-click detected -> Go Fullscreen (Close Guide)
          onClose();
        } else {
          // Single click -> Replay the stream without closing LiveTV
          lastChannelClickRef.current = { streamId: channel.stream_id, timestamp: now };
          onPlayChannel(channel);
        }
      } else {
        // Select for preview and play immediately
        lastChannelClickRef.current = { streamId: channel.stream_id, timestamp: Date.now() };
        setSelectedChannel(channel);
        // Also update last channel ref immediately for resize effect
        lastChannelIdRef.current = channel.stream_id;
        onPlayChannel(channel);
      }
    }
  };

  // Drag-to-resize logic for the video preview pane
  const isResizingRef = useRef(false);
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;

    const startX = e.clientX;
    const startY = e.clientY;
    
    let startPct = previewWidthPct;
    if (previewPaneRef.current && epgView === 'traditional' && !epgThreeColumn) {
      const match = previewPaneRef.current.style.flex.match(/0 0 ([\d.]+)%/);
      if (match && match[1]) {
        startPct = parseFloat(match[1]);
      }
    }

    let startHeightPx = previewHeightPx;
    if (previewPaneRef.current && isAltPreviewLayout) {
      const heightStr = previewPaneRef.current.style.height;
      if (heightStr && heightStr.endsWith('px')) {
         startHeightPx = parseInt(heightStr);
      }
    }

    const container = gridContainerRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const containerHeight = container.getBoundingClientRect().height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current || !previewPaneRef.current) return;
      
      if (isAltPreviewLayout) {
        const dy = moveEvent.clientY - startY;
        let newHeightPx = startHeightPx + dy;
        // Clamp height
        newHeightPx = Math.max(150, Math.min(newHeightPx, containerHeight - 150));
        previewPaneRef.current.style.height = `${newHeightPx}px`;
      } else {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        
        let dw = dx;
        if (Math.abs(dy * (16 / 9)) > Math.abs(dx)) {
          dw = dy * (16 / 9);
        }

        const deltaPct = (dw / containerWidth) * 100;
        let newPct = startPct + deltaPct;

        newPct = Math.max(20, Math.min(newPct, 80));

        previewPaneRef.current.style.flex = `0 0 ${newPct}%`;
        if (previewPaneRef.current.parentElement) {
          previewPaneRef.current.parentElement.style.setProperty('--preview-width', `${newPct}%`);
        }
      }
    };

    const handleMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      if (previewPaneRef.current) {
        if (isAltPreviewLayout) {
          const heightStr = previewPaneRef.current.style.height;
          if (heightStr && heightStr.endsWith('px')) {
            const finalHeight = parseInt(heightStr);
            setPreviewHeightPx(finalHeight);
            localStorage.setItem('guidePreviewHeight', String(finalHeight));
          }
        } else {
          const match = previewPaneRef.current.style.flex.match(/0 0 ([\d.]+)%/);
          if (match && match[1]) {
            const finalPct = parseFloat(match[1]);
            setPreviewWidthPct(finalPct);
            localStorage.setItem('guidePreviewWidth', String(finalPct));
          }
        }
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [previewWidthPct, previewHeightPx, epgView, epgThreeColumn, isAltPreviewLayout]);

  const handleResizeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isAltPreviewLayout) {
      setPreviewHeightPx(360);
      localStorage.setItem('guidePreviewHeight', '360');
      if (previewPaneRef.current) {
        previewPaneRef.current.style.height = `360px`;
      }
    } else {
      setPreviewWidthPct(54);
      localStorage.setItem('guidePreviewWidth', '54');
      if (previewPaneRef.current) {
        previewPaneRef.current.style.flex = `0 0 54%`;
        if (previewPaneRef.current.parentElement) {
          previewPaneRef.current.parentElement.style.setProperty('--preview-width', '54%');
        }
      }
    }
  }, [epgView, epgThreeColumn, isAltPreviewLayout]);

  // ── Drag-to-resize for EPG channel column ─────────────────────────────────
  const isResizingChannelCol = useRef(false);

  const handleChannelColResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingChannelCol.current = true;

    const startX = e.clientX;
    const startWidth = channelColumnWidthRef.current;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingChannelCol.current) return;
      const dx = moveEvent.clientX - startX;
      let newWidth = startWidth + dx;
      newWidth = Math.max(180, Math.min(newWidth, 500));
      document.documentElement.style.setProperty('--epg-channel-column-width', `${newWidth}px`);
    };

    const handleMouseUp = () => {
      if (!isResizingChannelCol.current) return;
      isResizingChannelCol.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      const finalWidthStr = getComputedStyle(document.documentElement).getPropertyValue('--epg-channel-column-width');
      const finalWidth = parseInt(finalWidthStr) || DEFAULT_CHANNEL_COLUMN_WIDTH;
      setChannelColumnWidth(finalWidth);
      localStorage.setItem('epgChannelColumnWidth', String(finalWidth));

      // Recalculate available width after resize
      const container = gridContainerRef.current;
      if (container) {
        const zoom = parseFloat(document.documentElement.style.getPropertyValue('--app-zoom')) || 1;
        const width = (container.getBoundingClientRect().width / zoom) - finalWidth;
        setAvailableWidth(Math.max(width, 200));
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleChannelColResizeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setChannelColumnWidth(DEFAULT_CHANNEL_COLUMN_WIDTH);
    localStorage.setItem('epgChannelColumnWidth', String(DEFAULT_CHANNEL_COLUMN_WIDTH));
    document.documentElement.style.setProperty('--epg-channel-column-width', `${DEFAULT_CHANNEL_COLUMN_WIDTH}px`);

    // Recalculate available width after reset
    const container = gridContainerRef.current;
    if (container) {
      const zoom = parseFloat(document.documentElement.style.getPropertyValue('--app-zoom')) || 1;
      const width = (container.getBoundingClientRect().width / zoom) - DEFAULT_CHANNEL_COLUMN_WIDTH;
      setAvailableWidth(Math.max(width, 200));
    }
  }, []);

  // ── Drag-to-resize for EPG Transparent Overlay ──────────────────────────────
  const isResizingTransparentGuide = useRef(false);

  const handleTransparentGuideResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingTransparentGuide.current = true;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingTransparentGuide.current) return;
      const windowHeight = window.innerHeight;
      const heightPx = windowHeight - moveEvent.clientY;
      let newPct = Math.round((heightPx / windowHeight) * 100);
      newPct = Math.max(25, Math.min(100, newPct));
      
      document.documentElement.style.setProperty('--transparent-guide-height', `${newPct}%`);
      
      window.dispatchEvent(new CustomEvent('ynotv:transparent-guide-height-changed', {
        detail: { height: newPct }
      }));
    };

    const handleMouseUp = async () => {
      if (!isResizingTransparentGuide.current) return;
      isResizingTransparentGuide.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      const finalPctStr = getComputedStyle(document.documentElement).getPropertyValue('--transparent-guide-height');
      const finalPct = parseInt(finalPctStr) || 40;
      
      if (window.storage) {
        await window.storage.updateSettings({ transparentGuideHeight: finalPct });
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleTransparentGuideResizeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    document.documentElement.style.setProperty('--transparent-guide-height', '40%');
    window.dispatchEvent(new CustomEvent('ynotv:transparent-guide-height-changed', {
      detail: { height: 40 }
    }));
    
    if (window.storage) {
      void window.storage.updateSettings({ transparentGuideHeight: 40 });
    }
  }, []);

  // Refresh search results when favorites change
  const refreshSearchResults = useCallback(async () => {
    if (!isSearchMode) return;

    // Refresh channel data for program results
    if (searchPrograms && searchPrograms.length > 0) {
      const updatedChannelsMap = new Map(searchProgramChannels);
      for (const [streamId, channel] of updatedChannelsMap) {
        const updatedChannel = await db.channels.get(streamId);
        if (updatedChannel) {
          updatedChannelsMap.set(streamId, updatedChannel);
        }
      }
      setSearchProgramChannels(updatedChannelsMap);
    }

    // Refresh channel data for channel results
    if (searchChannels && searchChannels.length > 0) {
      const updatedProgramsMap = new Map(searchChannelPrograms);
      for (const channel of searchChannels) {
        const updatedChannel = await db.channels.get(channel.stream_id);
        if (updatedChannel) {
          // Merge updated channel data into existing channel objects
          Object.assign(channel, updatedChannel);
        }
      }
      // Trigger re-render by creating new Map
      setSearchChannelPrograms(new Map(updatedProgramsMap));
    }
  }, [isSearchMode, searchPrograms, searchChannels, searchProgramChannels, searchChannelPrograms]);

  // Format program time
  const formatProgramTime = (date: Date | string) => {
    const d = date instanceof Date ? date : new Date(date);
    return formatTime(d, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });
  };

  // Check if program is currently airing
  const isProgramNow = (program: StoredProgram) => {
    const now = currentTime.getTime();
    const start = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
    const end = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();
    return now >= start && now < end;
  };

  // Get current program for the selected channel
  const selectedProgram = useMemo(() => {
    if (!selectedChannel) return null;
    const channelPrograms = programs.get(selectedChannel.stream_id) || [];
    
    // Check if we are playing catchup on the selected channel
    if (isCatchup && catchupInfo && catchupInfo.channelId === selectedChannel.stream_id) {
      const targetStartMs = catchupInfo.startTime;
      const found = channelPrograms.find((p: StoredProgram) => {
        const pStartMs = p.raw_start
          ? new Date(p.raw_start).getTime()
          : (p.start instanceof Date ? p.start.getTime() : new Date(p.start).getTime());
        return Math.abs(pStartMs - targetStartMs) < 60000;
      });
      if (found) return found;

      // Fallback: construct a mock program matching catchupInfo
      const start = new Date(catchupInfo.startTime);
      const end = new Date(catchupInfo.startTime + catchupInfo.duration * 60000);
      return {
        id: 'mock_catchup',
        channel_id: selectedChannel.stream_id,
        stream_id: selectedChannel.stream_id,
        source_id: selectedChannel.source_id,
        title: catchupInfo.programTitle,
        start,
        end,
        description: catchupInfo.programDesc || '',
      } as unknown as StoredProgram;
    }

    const now = currentTime.getTime();
    return channelPrograms.find((p: StoredProgram) => {
      const start = p.start instanceof Date ? p.start.getTime() : new Date(p.start).getTime();
      const end = p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime();
      return now >= start && now < end;
    });
  }, [selectedChannel, programs, currentTime, isCatchup, catchupInfo]);

  // Calculate progress for the progress bar
  const progressPercent = useMemo(() => {
    if (!selectedProgram) return 0;
    
    // Check if we are playing catchup on the selected channel
    if (isCatchup && catchupInfo && catchupInfo.channelId === selectedChannel?.stream_id) {
      if (duration <= 0) return 0;
      return Math.min(100, Math.max(0, (position / duration) * 100));
    }

    const now = currentTime.getTime();
    const start = selectedProgram.start instanceof Date ? selectedProgram.start.getTime() : new Date(selectedProgram.start).getTime();
    const end = selectedProgram.end instanceof Date ? selectedProgram.end.getTime() : new Date(selectedProgram.end).getTime();
    const total = end - start;
    if (total <= 0) return 0;
    return Math.min(100, Math.max(0, ((now - start) / total) * 100));
  }, [selectedProgram, currentTime, isCatchup, catchupInfo, selectedChannel, position, duration]);

  // "View All Programs" modal for the 3-column toolbar — shows every program
  // the DB has for the selected channel across per-day tabs.
  const [viewAllProgramsOpen, setViewAllProgramsOpen] = useState(false);
  // How many total rows the schedule can render. The list is virtualized, so
  // hundreds of rows only mount a visible window and stay smooth.
  const ALT_SCHEDULE_MAX_ROWS = 1000;

  // Short date label for schedule rows so entries spanning multiple
  // days are easy to identify.
  const formatScheduleDate = useCallback((date: Date) => {
    const d = new Date(date);
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(currentTime) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return i18n.t('time:today', { defaultValue: 'Today' });
    if (diffDays === 1) return i18n.t('time:yesterday', { defaultValue: 'Yesterday' });
    return formatDate(d, { month: 'short', day: 'numeric' });
  }, [currentTime]);

  // The currently-airing program fetched straight from the DB when it falls
  // outside the lazy-loaded EPG window (e.g. a long movie/event that started
  // before loadStart). The schedule memo uses it as the anchor row so the
  // running show is always at the top no matter when it started.
  const [altScheduleRunning, setAltScheduleRunning] = useState<StoredProgram | null>(null);
  useEffect(() => {
    if (!selectedChannel) {
      setAltScheduleRunning(null);
      return;
    }
    const channelPrograms = programs.get(selectedChannel.stream_id) || [];
    const nowMs = Date.now();
    const hasRunning = channelPrograms.some((p) => {
      const s = p.start instanceof Date ? p.start.getTime() : new Date(p.start).getTime();
      const e = p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime();
      return s <= nowMs && e > nowMs;
    });
    // The loaded window already covers the running program — no extra query.
    if (hasRunning) {
      setAltScheduleRunning(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const dbInstance = await (db as any).dbPromise;
        // Stored EPG timestamps mix "Z" and offset formats, so string
        // comparisons against an ISO "now" are unreliable (see utils/epgTime.ts).
        // Follow the app-wide pattern: fetch a generous window and pick the
        // running program in JS with pickCurrentProgram.
        const fromIso = new Date(nowMs - EPG_WINDOW_BACK_MS).toISOString();
        const toIso = new Date(nowMs + EPG_WINDOW_FWD_MS).toISOString();
        const rows = await dbInstance.select(
          `SELECT * FROM programs_effective
           WHERE stream_id = ? AND start < ? AND end > ?`,
          [selectedChannel.stream_id, toIso, fromIso]
        ) as StoredProgram[];
        if (cancelled) return;
        const p = pickCurrentProgram(rows, nowMs);
        setAltScheduleRunning(
          p ? { ...p, description: decompressEpgDescription(p.description) ?? p.description } : null
        );
      } catch (err) {
        // Best-effort: if the direct fetch fails the list just starts at the
        // first upcoming program, same as before.
        if (!cancelled) setAltScheduleRunning(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedChannel?.stream_id, programs]);

  // Alternate view: the schedule for the selected channel (current + upcoming
  // programs within the EPG window), used by the 3-column info pane.
  const altSchedulePrograms = useMemo(() => {
    if (!selectedChannel) return [];
    const channelPrograms = programs.get(selectedChannel.stream_id) || [];
    const now = currentTime.getTime();
    const toEntry = (p: StoredProgram) => ({
      program: p,
      startMs: p.start instanceof Date ? p.start.getTime() : new Date(p.start).getTime(),
      endMs: p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime(),
    });
    const entries = channelPrograms
      .map(toEntry)
      .filter((x) => Number.isFinite(x.startMs) && Number.isFinite(x.endMs));

    // Anchor the schedule on the currently airing program: the running show is
    // the first row and upcoming programs follow chronologically.
    // Prefer the running program from the loaded window; fall back to the one
    // fetched directly from the DB when it isn't inside the lazy-loaded window
    // (e.g. a long movie that started before loadStart). Only honored while it
    // is still airing — once it ends it drops out and the list resumes with the
    // upcoming programs.
    const current =
      entries.find((x) => x.startMs <= now && x.endMs > now) ??
      (altScheduleRunning
        ? (() => {
            const direct = toEntry(altScheduleRunning);
            return direct.endMs > now ? direct : null;
          })()
        : null);
    const upcoming = entries
      .filter((x) => x.startMs > now)
      .sort((a, b) => a.startMs - b.startMs);
    return [
      ...(current ? [current] : []),
      ...upcoming,
    ].slice(0, ALT_SCHEDULE_MAX_ROWS);
  }, [selectedChannel, programs, currentTime, altScheduleRunning]);

  type AltScheduleRowEntry = {
    program: StoredProgram;
    startMs: number;
    endMs: number;
    isCurrent: boolean;
    isPast: boolean;
    clickable: boolean;
  };
  type AltScheduleDisplayItem =
    | { kind: 'header'; dateLabel: string; key: string }
    | { kind: 'row'; row: AltScheduleRowEntry; key: string };

  // Flattened display list for the virtualized schedule: a per-day date
  // header before each group of programs (Today / Yesterday / short date),
  // followed by the program rows for that day.
  const altScheduleDisplay = useMemo<AltScheduleDisplayItem[]>(() => {
    const items: AltScheduleDisplayItem[] = [];
    let lastDayKey: string | null = null;
    const now = currentTime.getTime();
    const catchupAvailable = Boolean(selectedChannel?.tv_archive) || selectedChannel?.tv_archive === 1;
    for (const entry of altSchedulePrograms) {
      const d = new Date(entry.startMs);
      const dayKey = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime().toString();
      if (dayKey !== lastDayKey) {
        items.push({ kind: 'header', dateLabel: formatScheduleDate(d), key: `day-${dayKey}` });
        lastDayKey = dayKey;
      }
      const isCurrent = now >= entry.startMs && now < entry.endMs;
      const isPast = entry.endMs <= now;
      const clickable = (isPast || isCurrent) && catchupAvailable && !!onPlayCatchup;
      items.push({
        kind: 'row',
        row: { program: entry.program, startMs: entry.startMs, endMs: entry.endMs, isCurrent, isPast, clickable },
        key: `prog-${entry.program.id}`,
      });
    }
    return items;
  }, [altSchedulePrograms, currentTime, selectedChannel, onPlayCatchup, formatScheduleDate]);

  // Right-click context menu (same ProgramContextMenu as the timeline grid)
  // for the 3-column schedule rows.
  const [scheduleContextMenu, setScheduleContextMenu] = useState<{ program: StoredProgram; x: number; y: number } | null>(null);
  const handleScheduleContextMenu = useCallback((e: React.MouseEvent, program: StoredProgram) => {
    e.preventDefault();
    setScheduleContextMenu({ program, x: e.clientX, y: e.clientY });
  }, []);

  // Scroll container for the 3-column schedule list (virtualized) and the
  // VirtualList handle used to keep the current program in view.
  const altScheduleRef = useRef<HTMLDivElement>(null);
  const altScheduleListRef = useRef<VirtualListHandle>(null);

  // Auto-scroll the 3-column schedule so the current (running) program stays
  // visible when the selected channel changes or catch-up history loads in.
  // Deliberately NOT keyed on altScheduleDisplay: that memo rebuilds every 60s
  // (currentTime tick), so depending on it yanked the list back to the current
  // program every minute and made it impossible to scroll away. A ref keeps the
  // latest display available to the retry loop (programs load async) without
  // re-triggering the effect on time-driven rebuilds.
  const altScheduleDisplayRef = useRef(altScheduleDisplay);
  altScheduleDisplayRef.current = altScheduleDisplay;
  useEffect(() => {
    if (!selectedChannel) return;
    let cancelled = false;
    let retries = 20;
    const tryScroll = () => {
      if (cancelled) return;
      const now = Date.now();
      const idx = altScheduleDisplayRef.current.findIndex(
        (it) => it.kind === 'row' && now >= it.row.startMs && now < it.row.endMs
      );
      if (idx >= 0) {
        // The current program is the anchor row (index 0), so align it to the
        // top of the list — the running show should be the first thing visible.
        altScheduleListRef.current?.scrollToIndex({ index: idx, align: 'start' });
        return;
      }
      if (retries-- > 0) setTimeout(tryScroll, 150);
    };
    tryScroll();
  }, [selectedChannel?.stream_id]);

  // Ref for the video preview container (now points to video sub-container)
  const previewRef = useRef<HTMLDivElement>(null);
  // Ref for the outer preview pane (used for mini bar layout)
  const previewPaneRef = useRef<HTMLDivElement>(null);
  // Track last channel ID to maintain resize when channel data is loading
  const lastChannelIdRef = useRef<string | null>(null);

  // VirtualList scrolling refs
  const virtuosoRef = useRef<VirtualListHandle>(null);
  const visibleRangeRef = useRef({ startIndex: 0, endIndex: 0 });
  const blockAutoScrollRef = useRef(false);
  // Track last channel click for double-click detection to close LiveTV
  const lastChannelClickRef = useRef<{ streamId: string; timestamp: number } | null>(null);
  const DOUBLE_CLICK_MS = 500;

  // The channel list is virtualized. Remote navigation requests a data index
  // when its next row is outside the current DOM window; Virtuoso is the only
  // reliable owner of that scroll position.
  useEffect(() => {
    const handleSpatialIndexRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ surface?: string; index?: number }>).detail;
      if (detail?.surface !== 'channel-list' || !Number.isInteger(detail.index) || detail.index! < 0) return;
      blockAutoScrollRef.current = true;
      virtuosoRef.current?.scrollToIndex({ index: detail.index!, align: 'center', behavior: 'auto' });
    };

    window.addEventListener('ynotv:spatial-scroll-to-index', handleSpatialIndexRequest);
    return () => window.removeEventListener('ynotv:spatial-scroll-to-index', handleSpatialIndexRequest);
  }, []);

  // Controller buttons can be mapped to "EPG < 1 hour"/"EPG > 1 hour". Those fire
  // a ynotv:gamepad-epg-shift event; apply the delta to the current offset here,
  // clamped to the same [-12, 12] bounds the EpgShiftModal enforces. No-op outside
  // the guide (this component isn't mounted elsewhere).
  useEffect(() => {
    const handleEpgShift = (event: Event) => {
      const delta = (event as CustomEvent<{ delta?: number }>).detail?.delta;
      if (!delta) return;
      const next = Math.max(-12, Math.min(12, currentEpgOffset + delta));
      if (next !== currentEpgOffset) {
        // Keep the local offset in sync so the toolbar label and repeated
        // presses reflect the shift (handleEpgShiftChange only persists it).
        setCurrentEpgOffset(next);
        handleEpgShiftChange(next);
      }
    };
    window.addEventListener('ynotv:gamepad-epg-shift', handleEpgShift);
    return () => window.removeEventListener('ynotv:gamepad-epg-shift', handleEpgShift);
  }, [currentEpgOffset, handleEpgShiftChange]);

  // When the view layout changes (time-grid ↔ 3-column), the VirtualList
  // remounts (different key) and starts at scroll 0 while visibleRangeRef still
  // holds the previous view's rendered window. Reset the range (and drop any
  // stale spatial-scroll suppression) so the follow effect below re-centers the
  // selected channel in the freshly mounted list instead of trusting the old
  // window.
  useEffect(() => {
    visibleRangeRef.current = { startIndex: 0, endIndex: 0 };
    blockAutoScrollRef.current = false;
  }, [epgThreeColumn]);

  // Handle auto-scrolling to keep the selected channel near the middle/visible.
  // The highlight channel (keep-view anchor) takes priority so the row the user
  // picked stays in view even when failover plays the group primary instead.
  useEffect(() => {
    if (!visible) return;
    if (!selectedChannel || !filteredChannels.length || !virtuosoRef.current) return;
    if (isSearchMode || isWatchlistMode) return;

    if (blockAutoScrollRef.current) {
      blockAutoScrollRef.current = false;
      return;
    }

    const scrollChannel = highlightChannel ?? selectedChannel;
    const index = filteredChannels.findIndex((c) => c.stream_id === scrollChannel.stream_id);
    if (index === -1) return;

    const { startIndex, endIndex } = visibleRangeRef.current;

    // If list hasn't rendered yet (endIndex is 0), or item is completely out of view, center it.
    if (endIndex === 0 || index < startIndex || index > endIndex) {
      virtuosoRef.current.scrollToIndex({ index, align: 'center', behavior: 'auto' });
      return;
    }

    // The reported range includes the virtualizer's overscan rows (rendered
    // but not visible). Shrink to the actual visible bounds so the follow
    // scroll starts as the channel approaches the edge — keeping at least
    // PADDING channels above/below — instead of waiting until the channel
    // has already scrolled out of view.
    //
    // The overscan must always be subtracted/added: it is present on both
    // sides of the rendered range regardless of whether that range touches the
    // list's first/last row (a boundary only truncates it, never removes it).
    // Guarding the subtraction on `endIndex < len-1` meant that once overscan
    // reached the final row, `visibleEnd` was overestimated by the full
    // overscan, so no scroll fired until the selection had fallen most of the
    // way into the invisible overscan region and only 'caught up' at the very
    // last (or first) row.
    const visibleStart = Math.min(
      filteredChannels.length - 1,
      startIndex + CHANNEL_LIST_OVERS
    );
    const visibleEnd = Math.max(0, endIndex - CHANNEL_LIST_OVERS);

    const PADDING = 2; // Keep at least 2 items below/above

    if (index >= visibleEnd - PADDING) {
      virtuosoRef.current.scrollToIndex({
        index: Math.min(filteredChannels.length - 1, index + PADDING),
        align: 'end',
        behavior: 'smooth',
      });
    } else if (index <= visibleStart + PADDING) {
      virtuosoRef.current.scrollToIndex({
        index: Math.max(0, index - PADDING),
        align: 'start',
        behavior: 'smooth',
      });
    }
  }, [selectedChannel?.stream_id, highlightChannel?.stream_id, filteredChannels.length, isSearchMode, isWatchlistMode, visible, epgThreeColumn]);

  // Update last channel ID when selected channel changes
  useEffect(() => {
    if (selectedChannel?.stream_id) {
      lastChannelIdRef.current = selectedChannel.stream_id;
    }
  }, [selectedChannel?.stream_id]);

  const isMultiview = currentLayout && currentLayout !== 'main';
  const isHls = multiviewEngineMode === 'hls';
  const showMultiviewGrid = isMultiview && (currentLayout === '2x2' || currentLayout === 'bigbottom');
  const showMultiviewSplit = isMultiview && (currentLayout === 'pip' || currentLayout === 'sbs');

  // Handle Video Resizing for Preview Mode via ResizeObserver
  // This ensures we exactly match the CSS dimensions regardless of resolution or layout state
  useEffect(() => {
    if (!visible) return;
    // if (!window.mpv) return; // Bridge handles this
    let rafId: number | null = null;
    let lastMainGeometry = '';
    let forceNextUpdate = false;
    let isDragging = false;
    let dragSettleTimer: ReturnType<typeof setTimeout> | null = null;

    const updateVideoPosition = () => {
      if (!previewRef.current) {
        if (onPreviewVideoRectChange) {
          onPreviewVideoRectChange(null);
        }
        return;
      }

      const clientRect = previewRef.current.getBoundingClientRect();
      const rect = {
        left: clientRect.left,
        top: clientRect.top,
        right: clientRect.right,
        bottom: clientRect.bottom,
        width: clientRect.width,
        height: clientRect.height,
      };

      // Safety check for zero dimensions — can happen transiently during React layout
      // transitions (e.g. switching multiview grid layouts) before the browser has painted.
      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      if (onPreviewVideoRectChange) {
        onPreviewVideoRectChange({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        });
      }

      const force = forceNextUpdate;
      forceNextUpdate = false;

      // Physically resize the main MPV window to match the preview container's screen coordinates
      const d = window.devicePixelRatio || 1;
      const sx = Math.round(rect.left * d);
      const sy = Math.round(rect.top * d);
      const sw = Math.round(rect.width * d);
      const sh = Math.round(rect.height * d);
      const nextMainGeometry = `${sx}:${sy}:${sw}:${sh}`;

      // Suppress geometry updates while the window is being dragged to avoid choppy
      // mid-drag resizing. The drag-settle handler fires one forced update when movement stops.
      if (!isDragging && (force || nextMainGeometry !== lastMainGeometry)) {
        lastMainGeometry = nextMainGeometry;
        invoke('mpv_set_geometry', { x: sx, y: sy, width: sw, height: sh }).catch(() => {});
      }
    };

    const scheduleVideoPositionUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateVideoPosition();
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleVideoPositionUpdate();
    });

    if (previewRef.current) {
      observer.observe(previewRef.current);
      // The native video window is repositioned whenever the preview's SIZE
      // changes (the RO on the video above fires). But in 3-column/alternate
      // view the preview keeps a fixed 16:9 size and only MOVES when the
      // channel strip is resized (it stays centered in the right column), so
      // the video's RO never fires and the native window falls out of sync
      // with the CSS overlay. Also watch the column container, which resizes
      // during strip drags, so position-only shifts realign the video too.
      const colContainer = previewRef.current.parentElement?.parentElement;
      if (colContainer && colContainer !== previewRef.current) {
        observer.observe(colContainer);
      }
      updateVideoPosition();
    }

    // Listen for window resize events to keep the MPV window aligned when layout shifts
    const handleWindowResize = () => {
      scheduleVideoPositionUpdate();
    };
    window.addEventListener('resize', handleWindowResize);

    // Listen for window move events to keep the MPV window aligned during dragging
    let unlistenMove: (() => void) | null = null;
    // On Windows, mpv's embedded window follows the parent via a
    // WM_WINDOWPOSCHANGED hook and re-fits itself to the FULL parent on
    // activation (clicking another program, then clicking back). That leaves
    // the video full-screen with the CSS preview showing only a cutout. Re-
    // assert the preview rect whenever the window regains focus.
    let unlistenFocus: (() => void) | null = null;
    let disposed = false;
    const triggerPositionReassertion = () => {
      forceNextUpdate = true;
      lastMainGeometry = ''; // reset cache so the geometry call is never skipped
      scheduleVideoPositionUpdate();
    };

    const runStaggeredReassertion = () => {
      triggerPositionReassertion();
      const delays = [50, 150, 300, 600, 1000];
      delays.forEach((delay) => {
        setTimeout(() => {
          if (disposed) return;
          triggerPositionReassertion();
        }, delay);
      });
    };

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      appWindow.onMoved(() => {
        // Mark drag in progress — suppresses mpv_set_geometry during movement
        isDragging = true;
        // Debounce: once onMoved stops firing for 100ms the window has settled.
        // Clear any pending settle timer and restart it.
        if (dragSettleTimer !== null) clearTimeout(dragSettleTimer);
        dragSettleTimer = setTimeout(() => {
          dragSettleTimer = null;
          isDragging = false;
          // Bypass geometry cache and reposition MPV exactly once after the drag ends.
          triggerPositionReassertion();
        }, 100);
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenMove = unlisten;
      }).catch(() => {});

      appWindow.onFocusChanged(({ payload: focused }) => {
        // Re-assert preview geometry on BOTH focus gain and focus loss.
        // On Windows, when ynoTV loses focus (e.g. user clicks another window or
        // launches a full-screen game on another monitor), MPV's embedded window
        // receives WM_ACTIVATE / WM_KILLFOCUS and re-fits itself to the full parent
        // window in the background. Re-asserting geometry on focus loss keeps the video
        // bounded to the preview box.
        runStaggeredReassertion();
      }).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenFocus = unlisten;
      }).catch(() => {});
    }).catch(() => {});

    // Listen for browser focus/blur/visibilitychange to catch external mode switches
    const handleFocusOrBlur = () => {
      runStaggeredReassertion();
    };
    window.addEventListener('blur', handleFocusOrBlur);
    window.addEventListener('focus', handleFocusOrBlur);
    document.addEventListener('visibilitychange', handleFocusOrBlur);

    // Background watchdog: while the app window is unfocused (e.g. user is
    // playing a full-screen game or using another app on another monitor),
    // external DirectX mode switches, resolution changes, or GPU device resets
    // can trigger an async mpv re-fit without firing any DOM or Tauri window event.
    // Periodically re-assert geometry only while unfocused (0 IPC overhead when focused).
    const unfocusedWatchdogInterval = setInterval(() => {
      if (disposed) return;
      if (!document.hasFocus() || document.hidden) {
        triggerPositionReassertion();
      }
    }, 1000);

    // Settle loop for CSS transitions (sidebar/category strip opening/closing).
    // Runs on rAF while the preview geometry is still changing (plus a short
    // stable grace window), then stops — replaces the old perpetual 100ms
    // interval that fired mpv_set_geometry ~10x/sec while the Guide sat open.
    // The ResizeObserver above covers element size changes; this loop catches
    // position-only shifts (translateX slides) for the duration of the move.
    let animationFrameId: number;
    let stableFrames = 0;
    let lastLoopGeometry = '';
    const startTime = performance.now();
    const MAX_LOOP_DURATION = 2000; // watchdog: never run longer than any CSS transition
    const MAX_STABLE_FRAMES = 3; // frames with no geometry change => settled, stop

    const animate = () => {
      forceNextUpdate = true;
      updateVideoPosition();
      const rect = previewRef.current?.getBoundingClientRect();
      const geom = rect
        ? `${rect.left}:${rect.top}:${rect.width}:${rect.height}`
        : '';
      stableFrames = geom === lastLoopGeometry ? stableFrames + 1 : 0;
      lastLoopGeometry = geom;
      if (
        performance.now() - startTime < MAX_LOOP_DURATION &&
        stableFrames < MAX_STABLE_FRAMES
      ) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };

    animate();

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('blur', handleFocusOrBlur);
      window.removeEventListener('focus', handleFocusOrBlur);
      document.removeEventListener('visibilitychange', handleFocusOrBlur);
      clearInterval(unfocusedWatchdogInterval);
      if (unlistenMove) unlistenMove();
      if (unlistenFocus) unlistenFocus();
      if (dragSettleTimer !== null) clearTimeout(dragSettleTimer);
      if (rafId !== null) cancelAnimationFrame(rafId);
      cancelAnimationFrame(animationFrameId);
    };
    // Re-run when layout changes (sidebar/category visibility) or when visibility/selection changes
    // Include selectedChannelId to trigger resize when returning to view with a selection
    // Include isWatchlistMode and categoryId to handle special view modes
  }, [
    visible,
    categoryStripOpen,
    selectedChannel?.stream_id,
    isWatchlistMode,
    categoryId,
    epgView,
    currentLayout,
    multiviewEngineMode,
    showMultiviewGrid,
    showMultiviewSplit,
    currentChannel?.stream_id,
    multiviewSlots,
    showSettingsPopup,
    showEpgShiftModal,
    showFailoverGroupModal,
    showPlaylistListModal,
    managingCustomGroup,
    managingFavorites
  ]);

  // Dedicated effect: null out previewVideoRect only when the panel truly closes.
  // This is intentionally separate from the positioning effect so that layout transitions
  // (which re-run the positioning effect while visible=true) do NOT trigger a rect reset
  // that would cause App.tsx to reset video-zoom to 0 mid-transition.
  useEffect(() => {
    if (!visible) {
      if (onPreviewVideoRectChange) {
        onPreviewVideoRectChange(null);
      }
      // While the Guide is open the MPV child window is physically pinned to
      // the preview pane (see the positioning effect above). If the panel
      // closes without restoring it — e.g. the user switches to the Jellyfin
      // tab — the stream stays confined to the old preview rect and a later
      // playback handoff can start out cut off until a resize event re-asserts
      // it. Restore the full window the moment the panel closes (skipping
      // multiview layouts, whose cell geometry the multiview layer owns via
      // syncMpvGeometry).
      if (currentLayout === 'main') {
        invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 }).catch(() => { });
      }
    } else {
      Bridge.setProperties({
        'video-zoom': 0,
        'video-align-x': 0,
        'video-align-y': 0,
        'keepaspect': true,
      }).catch(() => { });
    }
  }, [visible, onPreviewVideoRectChange, currentLayout]);


  // ── Virtualized search result row contexts ────────────────────────────────
  // Memoized so Virtuoso only re-renders rows when their actual inputs change.
  const searchChannelRowContext = useMemo<ChannelRowData>(() => ({
    channelSortOrder,
    programs: searchChannelPrograms,
    windowStart,
    windowEnd,
    pixelsPerHour,
    visibleHours,
    handleChannelClick: handleSearchChannelClick,
    onPlayCatchup,
    handleFavoriteToggle: refreshSearchResults,
    categoryId,
    activeRecordings,
    currentLayout,
    onSendToSlot,
    onPlayInPopout,
    onPlayInExternal,
    currentChannel,
    highlightChannel,
    showPlaylistName: includeSourceInSearch ?? false,
    sourceNames,
    epgMetadataBadgeResolution,
    epgMetadataBadgeFps,
    epgMetadataBadgeSound,
    epgMetadataBadgeBitrate,
    epgMetadataBadgeAudioBitrate,
    // Search results always render the traditional timeline cells, even when
    // the 3-column strip view is active.
    threeColumn: false,
  }), [
    channelSortOrder, searchChannelPrograms, windowStart, windowEnd, pixelsPerHour, visibleHours,
    handleSearchChannelClick, onPlayCatchup, refreshSearchResults, categoryId, activeRecordings,
    currentLayout, onSendToSlot, onPlayInPopout, onPlayInExternal, currentChannel, highlightChannel,
    includeSourceInSearch, sourceNames, epgMetadataBadgeResolution, epgMetadataBadgeFps, epgMetadataBadgeSound, epgMetadataBadgeBitrate, epgMetadataBadgeAudioBitrate,
  ]);

  const searchProgramRowContext = useMemo<SearchProgramRowData>(() => ({
    windowStart,
    windowEnd,
    pixelsPerHour,
    visibleHours,
    handleSearchChannelClick,
    refreshSearchResults,
    activeRecordings,
    currentLayout,
    onSendToSlot,
    onPlayInPopout,
    onPlayInExternal,
    includeSourceInSearch,
    currentChannel,
  }), [
    windowStart, windowEnd, pixelsPerHour, visibleHours, handleSearchChannelClick, refreshSearchResults,
    activeRecordings, currentLayout, onSendToSlot, onPlayInPopout, onPlayInExternal,
    includeSourceInSearch, currentChannel,
  ]);

  // The guide's management buttons (Manage Channels, Refresh Source, EPG
  // shift, Playlist editor, Failover group, Probe) plus the EPG sync status.
  // Rendered in the header for the time-grid views and in the right schedule
  // pane's toolbar (.guide-alt-toolbar) below the preview for the 3-column
  // view, which keeps the strip header minimal.
  // The embedded/popout/external mode toggle. Rendered in the strip header
  // for the timeline views, and moved into the 3-column toolbar (left of the
  // close button) so the strip header stays minimal.
  const renderPopoutToggle = () => (
    <button
      className={`guide-epg-shift-btn guide-alt-popout ${popoutMode !== 'off' ? 'active' : ''}`}
      onClick={onTogglePopoutMode}
      title={
        popoutMode === 'off'
          ? i18n.t('player:embeddedModeHint')
          : popoutMode === 'popout'
            ? i18n.t('player:popoutModeHint')
            : i18n.t('player:externalModeHint')
      }
      style={{ color: popoutMode === 'off' ? undefined : 'var(--accent)' }}
    >
      {popoutMode === 'external' ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      )}
      <span className="btn-label">
        {popoutMode === 'off' ? i18n.t('player:embedded') : popoutMode === 'popout' ? i18n.t('player:popout') : i18n.t('player:external')}
      </span>
    </button>
  );

  const renderGuideManageButtons = () => {
    // The playlist editor, failover group manager, and channel probe are
    // universal tools (not scoped to a single source), so they are offered in
    // every channel category — including virtual ones such as Favorites and
    // Custom Groups, which skip the source-scoped actions below.
    const isFavoritesCategory =
      categoryId === '__favorites__' || (!!categoryId && categoryId.startsWith('__favsrc_'));
    const showGuideTools = canManageChannels || isCustomGroup || isFavoritesCategory;
    if (!showGuideTools) return null;

    // Aggregate/virtual categories (Favorites, Custom Groups) have no single
    // source or category to scope the probe to, so probe the channels that are
    // currently shown in the guide instead.
    const openChannelProbeForView = () => {
      if (typeof (window as any).openChannelProbe !== 'function') return;
      if (canManageChannels && !isCustomGroup) {
        (window as any).openChannelProbe(sourceId, categoryId);
      } else {
        (window as any).openChannelProbe(null, categoryId, channels);
      }
    };

    return (
      <>
                    {canManageChannels && !epgHiddenButtons.includes('manage-channels') && (
                      <button
                        className="guide-manage-channels-btn"
                        onClick={isCustomGroup ? () => setManagingCustomGroup({ id: categoryId!, name: customGroupName }) : handleManageChannels}
                        title={isCustomGroup ? t('manageCustomGroup') : t('manageChannels')}
                      >
                        {isCustomGroup ? (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                            </svg>
                            <span className="btn-label">{t('manageCustomGroup')}</span>
                          </>
                        ) : (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                              <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                              <polyline points="17 2 12 7 7 2" />
                            </svg>
                            <span className="btn-label">{t('manageChannels')}</span>
                          </>
                        )}
                      </button>
                    )}
                    {canManageChannels && !isCustomGroup && (
                      <>
                        {!isCustomCategory && !sourceId?.startsWith('playlist:') && !epgHiddenButtons.includes('refresh-source') && (
                          <button
                            className="guide-refresh-source-btn"
                            onClick={handleRefreshSource}
                            disabled={syncingSourceId === sourceId}
                            title={t('refreshSource')}
                          >
                            {syncingSourceId === sourceId ? (
                              <>
                                <span className="sync-spinner">⟳</span>
                                <span className="btn-label">{syncStatusMsg || t('refreshing')}</span>
                              </>
                            ) : (
                              <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                                  <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                                </svg>
                                <span className="btn-label">{t('refreshSource')}</span>
                              </>
                            )}
                          </button>
                        )}
                        {!sourceId?.startsWith('playlist:') && !epgHiddenButtons.includes('epg-shift') && (
                          <button
                            className="guide-epg-shift-btn"
                            onClick={() => setShowEpgShiftModal(true)}
                            title={t('epgShift')}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                              <circle cx="12" cy="12" r="10"/>
                              <polyline points="12 6 12 12 16 14"/>
                            </svg>
                            <span className="btn-label">{currentEpgOffset === 0 ? t('epgShift') : t('shiftHours', { hours: `${currentEpgOffset > 0 ? '+' : ''}${currentEpgOffset}` })}</span>
                          </button>
                        )}
                      </>
                    )}

                    {/* EPG Editor for the list on screen: opens on this category's
                        channels, and a click goes straight into that channel's
                        editor — the same view as right-click → Edit EPG. Hidden in
                        Search/Watchlist mode, where the guide's rows are not a
                        category's channels. */}
                    {!epgHiddenButtons.includes('epg-editor') && !isSearchMode && !isWatchlistMode && channels.length > 0 && (
                      <button
                        className="guide-epg-shift-btn"
                        onClick={() => setEpgEditorList({ channels, name: epgEditorListName })}
                        title={t('epgEditor')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                        <span className="btn-label">{t('epgEditor')}</span>
                      </button>
                    )}
                    {!epgHiddenButtons.includes('playlist-editor') && (
                      <button
                        className="guide-epg-shift-btn"
                        onClick={() => setShowPlaylistListModal(true)}
                        title={t('playlistEditor')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                          <line x1="8" y1="6" x2="21" y2="6"></line>
                          <line x1="8" y1="12" x2="21" y2="12"></line>
                          <line x1="8" y1="18" x2="21" y2="18"></line>
                          <line x1="3" y1="6" x2="3.01" y2="6"></line>
                          <line x1="3" y1="12" x2="3.01" y2="12"></line>
                          <line x1="3" y1="18" x2="3.01" y2="18"></line>
                        </svg>
                        <span className="btn-label">{t('playlistEditor')}</span>
                      </button>
                    )}
                    {!epgHiddenButtons.includes('failover-group') && (
                      <button
                        className="guide-epg-shift-btn"
                        onClick={() => setShowFailoverGroupModal(true)}
                        title={t('failoverGroup')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                          <path d="M2 17l10 5 10-5"/>
                          <path d="M2 12l10 5 10-5"/>
                        </svg>
                        <span className="btn-label">{t('failoverGroup')}</span>
                      </button>
                    )}
                    {!epgHiddenButtons.includes('channel-probe') && (
                      <button
                        className="guide-epg-shift-btn"
                        onClick={openChannelProbeForView}
                        title={i18n.t('probe:guideButtonTitle')}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                          <circle cx="12" cy="12" r="2" />
                          <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
                        </svg>
                        <span className="btn-label">{i18n.t('probe:guideButtonLabel')}</span>
                      </button>
                    )}
                    {canManageChannels && !isCustomGroup && epgSyncStatus && epgSyncStatus.total > 0 && (
                      <span className="guide-epg-sync-status">
                        <span className="sync-spinner">⟳</span>
                        <span>{t('epgCompleted', { completed: epgSyncStatus.completed, total: epgSyncStatus.total })}</span>
                      </span>
                    )}
      </>
    );
  };

  const renderPreviewPane = () => (
    <div
      className="guide-preview-pane"
      ref={previewPaneRef}
      style={
        showMultiviewGrid
          ? { width: '100%', height: '100%', flex: 'none', borderRight: 'none' }
          : epgThreeColumn || epgView === 'alternate'
          ? { height: `${previewHeightPx}px`, width: 'auto', aspectRatio: '16 / 9', maxWidth: '100%', flex: 'none' }
          : { flex: `0 0 ${previewWidthPct}%` }
      }
      onMouseMove={handlePreviewMouseMove}
      onMouseLeave={(e) => {
        handlePreviewMouseLeave();
        handlePreviewPaneMouseLeave();
      }}
      onMouseEnter={handlePreviewPaneMouseEnter}
      onWheel={handlePreviewWheelVolume}
    >
      {/* Resizer Handle */}
      {!showMultiviewGrid && (
        <div 
          className={`guide-preview-resizer ${isAltPreviewLayout ? 'vertical' : 'horizontal'}`}
          onMouseDown={handleResizeMouseDown}
          onContextMenu={handleResizeContextMenu}
          title={t('dragResizePreview')}
        >
          <div className="resizer-dot"></div>
        </div>
      )}

      {/* Video container - holds the MPV video and overlays */}
      <div
        className="guide-preview-video"
        ref={previewRef}
        onDoubleClick={() => {
          // Double-click to close the guide panel (fullscreen video)
          onClose();
        }}
      >
        {/* Glass border overlay */}
        <div className="video-glass-border" />

        {/* Audio Visualizer Overlay for Audio-Only Channels in EPG Preview Pane - ONLY when playing audio-only stream */}
        {isPlaying && currentChannel && (currentChannel.stream_id === selectedChannel?.stream_id) && isAudioOnly && (
          <AudioVisualizer
            mode={audioVisualizerMode}
            channel={selectedChannel}
            playing={!!isPlaying}
            compact={true}
            programTitle={selectedProgram?.title}
            categoryName={selectedCategoryName}
            onModeChange={onSetAudioVisualizerMode}
          />
        )}

        {/* The actual video is rendered by MPV "under" this transparent div */}
        {/* Only show placeholder when truly no channel is selected (not in watchlist/favorites mode with a selection) */}
        {!selectedChannel && !isWatchlistMode && categoryId !== '__favorites__' && categoryId !== '__recent__' && (
          <div className="guide-preview-placeholder">{t('selectAChannel')}</div>
        )}
        {/* Show Error Overlay if there is an error */}
        {error && (
          <VideoErrorOverlay error={error} isSmall />
        )}
        {/* Show Stream Retry Overlay if a retry is in progress */}
        {retryState?.isRetrying && (
          <StreamRetryOverlay retryState={retryState} isSmall />
        )}
        {/* Show Failover Overlay if a failover is in progress */}
        {failoverState?.isFailingOver && (
          <FailoverOverlay state={failoverState} isSmall />
        )}
        {/* Show Channel Loading Overlay if loading and not retrying/failing over */}
        {loadingState && loadingState !== 'idle' && !retryState?.isRetrying && !failoverState?.isFailingOver && (
          <ChannelLoadingOverlay
            channelName={currentChannel?.name || t('channel')}
            loadingState={loadingState}
            isSmall
          />
        )}
      </div>
      {/* Mini Media Bar for EPG Preview - floating buttons overlay */}
      {isMiniBarVisible && (
        <div
          className="guide-preview-minibar"
          onDoubleClick={(e) => e.stopPropagation()}
          onMouseEnter={() => setMiniBarHovered(true)}
          onMouseLeave={() => setMiniBarHovered(false)}
        >
          {/* Seek bar row (timeshift) */}
          {showSeek && (
            <div className="guide-minibar-seek-row">
              <span className="guide-minibar-seek-time">
                {formatSeekTime(ts ? ts.timePos - ts.cacheStart : (isVod ? 0 : 0))}
              </span>
              <div
                ref={seekBarRef}
                className={`guide-minibar-seek-bar ${seekHover || seekDrag ? 'active' : ''} ${seekDrag ? 'dragging' : ''}`}
                onClick={handleSeekClick}
                onMouseEnter={() => setSeekHover(true)}
                onMouseLeave={() => setSeekHover(false)}
                onMouseDown={handleSeekDragStart}
              >
                <div className="guide-minibar-seek-fill" style={{ width: `${seekFillPct}%` }} />
                {seekHover && !seekDrag && (
                  <div className="guide-minibar-seek-tip" style={{ left: `${((hoverPos - (ts ? ts.cacheStart : 0)) / (ts ? ts.cachedDuration : 1)) * 100}%` }}>
                    {formatSeekTime(hoverPos)}
                  </div>
                )}
              </div>
              <span className="guide-minibar-seek-time">
                {ts ? `-${formatSeekTime(ts.behindLive)}` : ''}
              </span>
            </div>
          )}
          {/* Buttons row — three groups: left (ch up/down), center (play/stop), right (volume/PiP) */}
          <div className="guide-minibar-buttons">
            {/* Left group: channel up/down */}
            <div className="guide-minibar-group guide-minibar-group-left">
              {onChannelUp && (
                <button
                  className="guide-minibar-btn"
                  onClick={onChannelUp}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={i18n.t('player:previousChannelUp')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 15l-6-6-6 6" />
                  </svg>
                </button>
              )}
              {onChannelDown && (
                <button
                  className="guide-minibar-btn"
                  onClick={onChannelDown}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={i18n.t('player:nextChannelDown')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
              )}
            </div>

            {/* Center group: playback controls */}
            <div className="guide-minibar-group guide-minibar-group-center">
              <button
                className="guide-minibar-btn guide-minibar-btn-primary"
                onClick={onTogglePlay}
                onDoubleClick={(e) => e.stopPropagation()}
                title={isPlaying ? i18n.t('player:pause') : i18n.t('player:play')}
              >
                {isPlaying ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
              {onStop && (
                <button
                  className="guide-minibar-btn"
                  onClick={onStop}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={i18n.t('player:stop')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                </button>
              )}
            </div>

            {/* Right group: volume, PiP */}
            <div className="guide-minibar-group guide-minibar-group-right">
              <div className="guide-minibar-volume" onDoubleClick={(e) => e.stopPropagation()}>
                <button
                  className="guide-minibar-btn"
                  onClick={handlePreviewMuteToggle}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={previewMuted ? i18n.t('player:unmute') : i18n.t('player:mute')}
                >
                  {previewMuted || previewVolume === 0 ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                  )}
                </button>
                <input
                  type="range"
                  min="0"
                  max={audioMaxVolume}
                  value={previewMuted ? 0 : previewVolume}
                  onChange={handlePreviewVolumeChange}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="guide-minibar-volume-slider"
                  title={i18n.t('player:volume')}
                />
              </div>
              {onTogglePip && (
                <button
                  className="guide-minibar-btn"
                  onClick={onTogglePip}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={pipMode ? i18n.t('player:exitPip') : i18n.t('player:pip')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="18" rx="2" />
                    <rect x="10" y="10" width="10" height="8" rx="1" fill={pipMode ? 'currentColor' : 'none'} />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* NowPlayingBar Overlay for Alternate View */}
      {epgView === 'alternate' && (
        <NowPlayingBar
          visible={alternateControlsVisible}
          channel={selectedChannel}
          playing={!!isPlaying}
          muted={muted}
          volume={volume}
          mpvReady={mpvReady}
          position={position}
          duration={duration}
          isVod={isVod}
          vodInfo={vodInfo}
          isCatchup={isCatchup}
          catchupInfo={catchupInfo}
          onTogglePlay={onTogglePlay || (() => {})}
          onStop={onStop || (() => {})}
          onToggleMute={onToggleMute || (() => {})}
          onVolumeChange={onVolumeChange || (() => {})}
          onSeek={onSeek}
          onCycleSubtitle={onCycleSubtitle || (() => {})}
          onCycleAudio={onCycleAudio || (() => {})}
          onToggleStats={onToggleStats || (() => {})}
          onToggleConnectionInfo={onToggleConnectionInfo}
          connectionInfoShortcut={connectionInfoShortcut}
          onToggleFullscreen={onToggleFullscreen || (() => {})}
          onShowSubtitleModal={onShowSubtitleModal || (() => {})}
          onShowAudioModal={onShowAudioModal || (() => {})}
          onCatchupSeek={onCatchupSeek}
          onGoToLive={() => {
            if (selectedChannel) onPlayChannel(selectedChannel);
          }}
          timeshiftEnabled={timeshiftEnabled}
          timeshiftState={timeshiftState}
          onTimeshiftCatchUp={onTimeshiftCatchUp}
          onChannelUp={onChannelUp}
          onChannelDown={onChannelDown}
          onReplayStream={selectedChannel ? () => onPlayChannel(selectedChannel) : undefined}
          pipMode={pipMode}
          onTogglePip={onTogglePip}
          playerControlDesign={playerControlDesign}
          showVolumePercent={showVolumePercent}
          isAudioOnly={isAudioOnly}
          audioVisualizerMode={audioVisualizerMode}
          onSetAudioVisualizerMode={onSetAudioVisualizerMode}
          onToggleTransparentGuide={onToggleTransparentGuide}
          guideTransparent={guideTransparent}
        />
      )}
    </div>
  );

  // The 3-column right pane: toolbar + live header + schedule list. Shared by
  // the plain 3-column view and the multiview-in-3-column layout (where the
  // video grid renders above this pane).
  const renderAltRightPane = () => (
    <div className="guide-alt-right-pane">
      {/* 3-column toolbar below the preview: the management
          buttons (when available) plus the close button at the
          end, which moved out of the strip header. */}
      <div className="guide-alt-toolbar">
        {renderGuideManageButtons()}
        {/* Manage Favorites (3-column home of the action, moved out of the
            strip header): reorder/remove the favorites for this source. */}
        {(categoryId === '__favorites__' || categoryId?.startsWith('__favsrc_')) && (
          <button
            className="guide-manage-channels-btn"
            onClick={() => {
              const srcId = categoryId?.startsWith('__favsrc_')
                ? categoryId.replace('__favsrc_', '')
                : null;
              setManagingFavoritesSourceId(srcId);
              setManagingFavorites(true);
            }}
            title={t('manageFavoritesOrder')}
          >
            <span style={{ flexShrink: 0 }}>⭐</span>
            <span className="btn-label">{t('manageFavorites')}</span>
          </button>
        )}
        {/* View All Programs: opens the per-day modal showing every program the
            DB has for this channel (past for catch-up, future for recording). */}
        {selectedChannel && (
          <button
            className="guide-alt-schedule-toggle"
            onClick={() => setViewAllProgramsOpen(true)}
            title={i18n.t('live:viewAllPrograms', { defaultValue: 'View All Programs' })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span className="btn-label">
              {i18n.t('live:viewAllPrograms', { defaultValue: 'View All Programs' })}
            </span>
          </button>
        )}
        {/* Embedded/popout/external mode + close, grouped at the right edge of
            the toolbar so they stay together even when the row wraps. */}
        <div className="guide-alt-toolbar-right">
          {onTogglePopoutMode && renderPopoutToggle()}
          <button
            className="guide-epg-shift-btn guide-alt-close"
            onClick={onClose}
            title={t('close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
            <span className="btn-label">{t('close')}</span>
          </button>
        </div>
      </div>
      {selectedChannel ? (
        <>
          {/* 3-column live info header */}
          <div
            className="guide-alt-live-header"
            title={selectedProgram ? `${selectedProgram.title}${selectedProgram.subtitle ? `\n${selectedProgram.subtitle}` : ''}\n${formatEpgTime(new Date(selectedProgram.start))} - ${formatEpgTime(new Date(selectedProgram.end))}${selectedProgram.description ? `\n\n${selectedProgram.description}` : ''}${(Boolean(selectedChannel.tv_archive) || selectedChannel.tv_archive === 1) ? `\n\n${i18n.t('epg:clickPlayCatchup')}` : ''}` : undefined}
          >
            <span className="guide-alt-live-badge">● {i18n.t('common:live', { defaultValue: 'LIVE' })}</span>
            {!epgShowFullChannelPath && (
              <span
                className="guide-alt-live-channel"
                title={selectedChannel.alias || selectedChannel.name}
              >
                {selectedChannel.alias || selectedChannel.name}
              </span>
            )}
            <span className="guide-alt-live-program" title={selectedProgram?.title}>
              {selectedProgram?.title || i18n.t('common:noProgramInfo', { defaultValue: 'No Program Information' })}
            </span>
            <span className="guide-alt-live-times">
              {selectedProgram ? `${formatEpgTime(new Date(selectedProgram.start))} - ${formatEpgTime(new Date(selectedProgram.end))}` : ''}
            </span>
            {epgShowFullChannelPath && (
              <span
                className="guide-alt-live-channel full-path"
                title={selectedChannelFullPath || (selectedChannel.alias || selectedChannel.name)}
              >
                {selectedChannelFullPath || (selectedChannel.alias || selectedChannel.name)}
              </span>
            )}
            {selectedProgram?.description && (
              <span className="guide-alt-live-desc" title={selectedProgram.description}>
                {selectedProgram.description}
              </span>
            )}
            {selectedProgram && (
              <div className="guide-alt-live-progress">
                <div className="guide-alt-live-progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>
            )}
          </div>
          {/* 3-column schedule list (current + upcoming), virtualized so
              Catch-up Programs mode with hundreds of history rows stays
              smooth. Per-day date headers group the rows. */}
          <div ref={altScheduleRef} className="guide-alt-schedule">
            <VirtualList
              ref={altScheduleListRef}
              items={altScheduleDisplay}
              scrollRef={altScheduleRef}
              estimateItemHeight={(index) => {
                const item = altScheduleDisplay[index];
                // Every schedule row is exactly 3 lines (time / title / one-line
                // description slot), so all boxes are the same height even when
                // a program has no description.
                return item?.kind === 'header' ? 30 : 78;
              }}
              overscan={6}
              getKey={(item) => item.key}
              renderItem={(item) => {
                if (item.kind === 'header') {
                  return <div className="guide-alt-schedule-day">{item.dateLabel}</div>;
                }
                const { program, startMs, endMs, isCurrent, clickable } = item.row;
                // Same hover tooltip as the timeline grid (ProgramBlock): program
                // name, subtitle, start–end time, && description — plus the catch-up
                // hint when the program is playable.
                const scheduleTooltip = `${program.title}${program.subtitle ? `\n${program.subtitle}` : ''}\n${formatEpgTime(new Date(startMs))} - ${formatEpgTime(new Date(endMs))}${program.description ? `\n\n${program.description}` : ''}${clickable ? `\n\n${i18n.t('epg:clickPlayCatchup')}` : ''}`;
                return (
                  <button
                    className={`guide-alt-schedule-row ${isCurrent ? 'running' : ''} ${clickable ? 'clickable' : ''}`}
                    title={scheduleTooltip}
                    onClick={() => {
                      if (!clickable) return;
                      const durationMins = Math.max(1, Math.round((endMs - startMs) / 60000));
                      const rawStartMs = program.raw_start ? new Date(program.raw_start).getTime() : startMs;
                      onPlayCatchup!(selectedChannel, program.title, rawStartMs, durationMins, program.description);
                    }}
                    onContextMenu={(e) => handleScheduleContextMenu(e, program)}
                  >
                    <div className="guide-alt-schedule-meta">
                      <span className="guide-alt-schedule-time">
                        {formatEpgTime(new Date(startMs))} - {formatEpgTime(new Date(endMs))}
                      </span>
                    </div>
                    <span className="guide-alt-schedule-title">
                      {program.title}
                      {isCurrent && <span className="guide-alt-schedule-running">{i18n.t('common:running', { defaultValue: 'Running' })}</span>}
                    </span>
                    {/* Description always rendered so the description slot is
                        reserved — every program box keeps the same height even
                        when a program has no/short description. */}
                    <span className="guide-alt-schedule-desc">{program.description}</span>
                  </button>
                );
              }}
            />
            {altScheduleDisplay.length === 0 && (
              <div className="guide-alt-schedule-empty">
                {i18n.t('common:noProgramInfo', { defaultValue: 'No Program Information' })}
              </div>
            )}
          </div>
          {/* Right-click context menu (same ProgramContextMenu as the timeline grid) */}
          {scheduleContextMenu && selectedChannel && (
            <ProgramContextMenu
              program={scheduleContextMenu.program}
              sourceId={selectedChannel.source_id}
              channelId={selectedChannel.stream_id}
              channelName={selectedChannel.name}
              position={{ x: scheduleContextMenu.x, y: scheduleContextMenu.y }}
              onClose={() => setScheduleContextMenu(null)}
              isCatchupAvailable={Boolean(selectedChannel.tv_archive) || selectedChannel.tv_archive === 1}
            />
          )}
        </>
      ) : (
        <div className="guide-alt-empty">
          <div className="guide-program-title">{t('selectAChannel')}</div>
        </div>
      )}
    </div>
  );

  return (
    <div
      ref={gridContainerRef}
      className={`guide-panel ${visible ? 'visible' : 'hidden'} ${categoryStripOpen ? 'with-categories' : ''} ${guideTransparent ? 'guide-transparent-mode' : ''} ${epgThreeColumn ? 'alt-view-active' : ''}`}
    >
      {/* Top Section: Preview & Info — hidden in transparent guide mode */}
      {!guideTransparent && (
      <div 
        className={`guide-top-section ${epgThreeColumn || epgView === 'alternate' ? 'alternate-view' : ''} ${showMultiviewGrid && !epgThreeColumn ? 'multiview-grid-active' : ''}`}
        style={epgView !== 'alternate' && !showMultiviewGrid ? { '--preview-width': `${previewWidthPct}%` } as React.CSSProperties : undefined}
      >
        {(showMultiviewGrid || showMultiviewSplit) && epgThreeColumn ? (
          <>
            {/* Multiview in the 3-column view: the video grid renders above
                the schedule pane (renderAltRightPane), which stays visible. */}
            <div className={`guide-multiview-3col ${showMultiviewGrid ? 'four-up' : 'two-up'}`}>
              {/* Cell 1: Main MPV player */}
              <div id="epg-slot-container-1" className="guide-preview-grid-cell">
                {renderPreviewPane()}
              </div>
              {/* Cell 2: Viewer 2 */}
              <div id="epg-slot-container-2" className="guide-preview-grid-cell" />
              {showMultiviewGrid && (
                <>
                  {/* Cell 3: Viewer 3 */}
                  <div id="epg-slot-container-3" className="guide-preview-grid-cell" />
                  {/* Cell 4: Viewer 4 */}
                  <div id="epg-slot-container-4" className="guide-preview-grid-cell" />
                </>
              )}
            </div>
            <div className="guide-info-pane alt-mode">
              {renderAltRightPane()}
            </div>
          </>
        ) : showMultiviewGrid ? (
          <div className="guide-preview-line-1x4">
            {/* Cell 1: Main MPV player */}
            <div id="epg-slot-container-1" className="guide-preview-grid-cell">
              {renderPreviewPane()}
            </div>
            {/* Cell 2: Viewer 2 */}
            <div id="epg-slot-container-2" className="guide-preview-grid-cell" />
            {/* Cell 3: Viewer 3 */}
            <div id="epg-slot-container-3" className="guide-preview-grid-cell" />
            {/* Cell 4: Viewer 4 */}
            <div id="epg-slot-container-4" className="guide-preview-grid-cell" />
          </div>
        ) : (
          <>
            {renderPreviewPane()}
            {(epgThreeColumn || epgView !== 'alternate') && (
              <div className={`guide-info-pane ${showMultiviewSplit ? 'multiview-split-active' : ''} ${epgThreeColumn ? 'alt-mode' : ''}`}>
                {epgThreeColumn ? (
                  renderAltRightPane()
                ) : showMultiviewSplit ? (
                  <div id="epg-slot-container-2" className="guide-preview-split-cell" />
                ) : selectedChannel ? (
                  <>
                    <div className="guide-program-title">
                      {selectedProgram ? selectedProgram.title : (selectedChannel.alias || selectedChannel.name || i18n.t('common:noProgramName'))}
                    </div>
                    {selectedProgram?.subtitle && (
                      <div className="guide-program-subtitle">{selectedProgram.subtitle}</div>
                    )}
                    {selectedProgram && (
                      <div className="guide-program-meta">
                        <span>{`${formatEpgTime(new Date(selectedProgram.start))} - ${formatEpgTime(new Date(selectedProgram.end))}`}</span>
                        <div className="guide-program-progress-bar">
                          <div className="guide-program-progress-fill" style={{ width: `${progressPercent}%` }} />
                        </div>
                      </div>
                    )}
                    {displayCategoryOrPath && (
                      <div className="guide-program-category" title={displayCategoryOrPath}>
                        {displayCategoryOrPath}
                      </div>
                    )}
                    <div className="guide-program-description">
                      {selectedProgram?.description || i18n.t('common:noDescription')}
                    </div>
                    {selectedChannel && (
                      <>
                        <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <MetadataBadge
                            streamId={selectedChannel.stream_id}
                            variant="detailed"
                            showResolution={epgMetadataBadgeResolution}
                            showFps={epgMetadataBadgeFps}
                            showSound={epgMetadataBadgeSound}
                            showBitrate={epgMetadataBadgeBitrate}
                            showAudioBitrate={epgMetadataBadgeAudioBitrate}
                          />
                        </div>
                        {showFailoverLiveTvWidget !== false && (
                          <div className="guide-info-failover-corner">
                            <FailoverChannelOverlay
                              currentChannel={selectedChannel}
                              onChannelClick={handleChannelClick}
                              isCleanDesign={true}
                              showLabel={true}
                              placement="bottom-right"
                              onOpenGroupList={() => setShowFailoverGroupModal(true)}
                            />
                          </div>
                        )}
                      </>
                    )}


                  </>
                ) : (
                  <div className="guide-program-title">{t('selectAChannel')}</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
      )}

      {/* Bottom Section: EPG Grid */}
      <div className="guide-grid-section">
        {/* 3-column transparent overlay close — the header ✕ (restored for
            transparent 3-column) lives in the header row, which the
            transparent-guide-hide-header setting removes; the time-bar close
            lives in the time header, which alt-view hides. Without this the
            overlay could only be closed via the shortcut key. */}
        {guideTransparent && epgThreeColumn && transparentGuideHideHeader && (
          <button
            className="guide-transparent-close-btn guide-alt-float-close"
            onClick={onClose}
            title={t('closeTransparentGuide')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
        {/* Transparent Guide Resizer Handle */}
        {guideTransparent && (
          <div
            className="guide-transparent-resizer"
            onMouseDown={handleTransparentGuideResizeMouseDown}
            onContextMenu={handleTransparentGuideResizeContextMenu}
            title={t('dragResizeOverlay')}
          />
        )}
        {/* Channel Column Resizer */}
        {!isSearchMode && !isWatchlistMode && (
          <div
            className="epg-channel-resizer"
            onMouseDown={handleChannelColResizeMouseDown}
            onContextMenu={handleChannelColResizeContextMenu}
            title={t('dragResizeColumn')}
          />
        )}
        {/* Navigation / Header Bar */}
        <div className="guide-header">
          <div className="guide-header-left">
            {isWatchlistMode ? (
              <>
                <span className="guide-search-title">📋 {t('watchlist')}</span>
                <span className="guide-channel-count">
                  {t('programsCount', { count: watchlistItems?.length || 0 })}
                </span>
                <button
                  className={`guide-manage-channels-btn ${showWatchlistPlaylistName ? 'active-toggle' : ''}`}
                  onClick={() => {
                    const newVal = !showWatchlistPlaylistName;
                    setShowWatchlistPlaylistName(newVal);
                    localStorage.setItem('showWatchlistPlaylistName', String(newVal));
                  }}
                  title={t('showPlaylistName')}
                >
                  <span style={{ flexShrink: 0 }}>{showWatchlistPlaylistName ? '📋' : '📄'}</span>
                  <span className="btn-label">{t('showSource')}</span>
                </button>
              </>
            ) : isSearchMode ? (
              <>
                <span className="guide-search-title">🔍 {t('searchResults')}</span>
                <span className="guide-search-query">"{searchQuery}"</span>
                <span className="guide-channel-count">
                  {(() => {
                    const channelCount = searchScope !== 'epg' ? (searchChannels?.length || 0) : 0;
                    const programCount = searchScope !== 'channels' ? activePrograms.length : 0;
                    return t('resultsCount', { count: channelCount + programCount });
                  })()}
                </span>
                {/* "Searching…" indicator while the batched program queries run */}
                {searchLoading && (
                  <span className="guide-search-status">
                    <span className="sync-spinner">⟳</span>
                    {t('searching')}
                  </span>
                )}
                {/* Search result tabs - single-select; only the picked tab renders
                    below. Channels is the default. Shown when more than one tab. */}
                {availableSearchTabs.length > 1 && (
                  <div className="guide-search-tabs">
                    {availableSearchTabs.map((tab) => {
                      const count = tab === 'channels'
                        ? (searchChannels?.length || 0)
                        : tab === 'live'
                          ? liveChannels.length
                          : upcomingChannels.length;
                      const label = tab === 'channels'
                        ? t('searchTabChannels')
                        : tab === 'live'
                          ? t('searchTabLive')
                          : t('searchTabUpcoming');
                      return (
                        <button
                          key={tab}
                          className={`search-tab ${effectiveSearchTab === tab ? 'active' : ''}`}
                          onClick={() => setSearchTab(tab)}
                        >
                          {tab === 'channels' && <span className="search-tab-icon">📺</span>}
                          {tab === 'live' && <span className="live-dot"></span>}
                          <span>{label}</span>
                          <span className="search-tab-count">({count})</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <>
                <span className="guide-current-time">{formatEpgTime(currentTime)}</span>
                {/* In the 3-column view the Manage Favorites action lives in the
                    right pane toolbar (renderAltRightPane) so the strip header
                    keeps just the Show Source toggle — a single icon button
                    that can never hit the hover-wrap oscillation. */}
                {(categoryId === '__favorites__' || categoryId?.startsWith('__favsrc_')) && !epgThreeColumn && (
                  <button
                    className="guide-manage-channels-btn"
                    onClick={() => {
                      const srcId = categoryId?.startsWith('__favsrc_')
                        ? categoryId.replace('__favsrc_', '')
                        : null;
                      setManagingFavoritesSourceId(srcId);
                      setManagingFavorites(true);
                    }}
                    title={t('manageFavoritesOrder')}
                  >
                    <span style={{ flexShrink: 0 }}>⭐</span>
                    <span className="btn-label">{t('manageFavorites')}</span>
                  </button>
                )}
                {categoryId === '__favorites__' && (
                  <button
                    className={`guide-manage-channels-btn ${showFavPlaylistName ? 'active-toggle' : ''}`}
                    onClick={() => {
                      const newVal = !showFavPlaylistName;
                      setShowFavPlaylistName(newVal);
                      localStorage.setItem('showFavPlaylistName', String(newVal));
                    }}
                    title={t('showPlaylistName')}
                  >
                    <span style={{ flexShrink: 0 }}>{showFavPlaylistName ? '📋' : '📄'}</span>
                    <span className="btn-label">{t('showSource')}</span>
                  </button>
                )}
                {categoryId === '__recent__' && (
                  <button
                    className={`guide-manage-channels-btn ${showRecentPlaylistName ? 'active-toggle' : ''}`}
                    onClick={() => {
                      const newVal = !showRecentPlaylistName;
                      setShowRecentPlaylistName(newVal);
                      localStorage.setItem('showRecentPlaylistName', String(newVal));
                    }}
                    title={t('showPlaylistName')}
                  >
                    <span style={{ flexShrink: 0 }}>{showRecentPlaylistName ? '📋' : '📄'}</span>
                    <span className="btn-label">{t('showSource')}</span>
                  </button>
                )}
                {isCustomCategory && categoryId !== '__favorites__' && categoryId !== '__recent__' && (
                  <button
                    className={`guide-manage-channels-btn ${showCustomPlaylistName ? 'active-toggle' : ''}`}
                    onClick={() => {
                      const newVal = !showCustomPlaylistName;
                      setShowCustomPlaylistName(newVal);
                      localStorage.setItem('showCustomPlaylistName', String(newVal));
                    }}
                    title={t('showPlaylistName')}
                  >
                    <span style={{ flexShrink: 0 }}>{showCustomPlaylistName ? '📋' : '📄'}</span>
                    <span className="btn-label">{t('showSource')}</span>
                  </button>
                )}
                {/* Ordinary categories (e.g. All Channels, or a regular source
                    category with channels added from other playlists via the
                    playlist editor): offer the show-source toggle only when the
                    category's channels span more than one source — a single-source
                    category would just show the same name on every channel. */}
                {categoryId !== '__favorites__' && categoryId !== '__recent__' && !isCustomCategory && categorySpansMultipleSources && (
                  <button
                    className={`guide-manage-channels-btn ${showCategorySourceName ? 'active-toggle' : ''}`}
                    onClick={() => {
                      const newVal = !showCategorySourceName;
                      setShowCategorySourceName(newVal);
                      localStorage.setItem('showCategorySourceName', String(newVal));
                    }}
                    title={`${t('showPlaylistName')} — ${i18n.t('common:sourcesCount', { count: categorySourceCount })}`}
                  >
                    <span style={{ flexShrink: 0 }}>{showCategorySourceName ? '📋' : '📄'}</span>
                    <span className="btn-label">{t('showSource')}</span>
                    {/* Why this button is offered: the category mixes channels
                        from several playlists. */}
                    <span className="guide-source-count-hint">
                      {i18n.t('common:sourcesCount', { count: categorySourceCount })}
                    </span>
                  </button>
                )}
                {!epgThreeColumn && renderGuideManageButtons()}
              </>
            )}
          </div>
          <div className="guide-header-right">
            {/* Catch-up only filter toggle (Settings -> Navigation -> EPG) */}
            {epgCatchupFilterEnabled && !isSearchMode && !isWatchlistMode && (
              <button
                className={`guide-nav-btn guide-catchup-filter-btn ${catchupOnly ? 'active' : ''}`}
                onClick={() => setCatchupOnly((prev) => !prev)}
                title={t('catchupFilterOnly')}
                aria-pressed={catchupOnly}
                style={{
                  padding: '0 8px',
                  width: 'auto',
                  marginRight: '8px',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="9"/>
                  <path d="M12 7v5l3 2"/>
                </svg>
              </button>
            )}
            {/* Resolution Filter Menu (Settings -> LiveTV -> Resolution filter) */}
            {epgResolutionFilterEnabled && !isSearchMode && !isWatchlistMode && (
              <div
                className="epg-resolution-dropdown-container"
                onMouseEnter={() => setShowResolutionMenu(true)}
                onMouseLeave={() => setShowResolutionMenu(false)}
              >
                <button
                  className={`guide-nav-btn ${showResolutionMenu || resolutionFilter !== 'all' ? 'active' : ''}`}
                  onClick={() => setShowResolutionMenu((prev) => !prev)}
                  title={t('resolutionFilter')}
                  style={{
                    padding: '0 8px',
                    width: 'auto',
                    marginRight: '8px',
                  }}
                >
                  {resolutionFilter === 'all' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/>
                    </svg>
                  ) : (
                    <span className="epg-resolution-label">{RESOLUTION_FILTER_LABELS[resolutionFilter]}</span>
                  )}
                </button>
                {showResolutionMenu && (
                  <div className="epg-resolution-menu">
                    {RESOLUTION_FILTER_OPTIONS.map((opt) => (
                      <button
                        key={opt}
                        className={`epg-resolution-item ${resolutionFilter === opt ? 'active' : ''}`}
                        onClick={() => {
                          setResolutionFilter(opt);
                          setShowResolutionMenu(false);
                        }}
                      >
                        {opt === 'all' ? t('all') : RESOLUTION_FILTER_LABELS[opt]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* A-Z Alphabet Jumper Menu (shown only when channelSortOrder === 'alphabetical') */}
            {channelSortOrder === 'alphabetical' && !isSearchMode && !isWatchlistMode && !epgHiddenButtons.includes('alphabet-jumper') && (
              <div
                className="epg-alphabet-dropdown-container"
                onMouseEnter={() => setShowAlphabetMenu(true)}
                onMouseLeave={() => setShowAlphabetMenu(false)}
              >
                <button
                  className={`guide-nav-btn ${showAlphabetMenu ? 'active' : ''}`}
                  onClick={() => setShowAlphabetMenu((prev) => !prev)}
                  title={t('jumpToLetter')}
                  style={{
                    padding: '0 8px',
                    width: 'auto',
                    marginRight: '8px',
                  }}
                >
                  <span style={{ fontSize: '11px', fontWeight: 600 }}>A-Z</span>
                </button>
                {showAlphabetMenu && (
                  <div className="epg-alphabet-menu">
                    {ALPHABET_LETTERS.map((letter) => {
                      const isAvailable = availableAlphabetLetters.has(letter);
                      return (
                        <button
                          key={letter}
                          className={`epg-alphabet-item ${!isAvailable ? 'disabled' : ''}`}
                          onClick={() => {
                            if (isAvailable) {
                              handleJumpToLetter(letter);
                              setShowAlphabetMenu(false);
                            }
                          }}
                          disabled={!isAvailable}
                          title={isAvailable ? i18n.t('live:jumpToLetterName', { letter }) : i18n.t('live:noChannelsStartingWith', { letter })}
                        >
                          {letter}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {/* Popout/External mode toggle: cycles off → popout → external. In
                3-column view this moves into the right-pane toolbar. */}
            {!epgThreeColumn && onTogglePopoutMode && (
              <button
                className={`guide-nav-btn ${popoutMode !== 'off' ? 'active' : ''}`}
                onClick={onTogglePopoutMode}
                title={
                  popoutMode === 'off'
                    ? i18n.t('player:embeddedModeHint')
                    : popoutMode === 'popout'
                      ? i18n.t('player:popoutModeHint')
                      : i18n.t('player:externalModeHint')
                }
                style={{
                  padding: '0 6px',
                  width: 'auto',
                  color: popoutMode === 'off' ? 'inherit' : 'var(--accent)',
                  marginRight: '8px',
                }}
              >
                {popoutMode === 'external' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                    <line x1="8" y1="21" x2="16" y2="21"/>
                    <line x1="12" y1="17" x2="12" y2="21"/>
                  </svg>
                )}
                <span style={{ marginLeft: '4px', fontSize: '11px' }}>
                  {popoutMode === 'off' ? i18n.t('player:embedded') : popoutMode === 'popout' ? i18n.t('player:popout') : i18n.t('player:external')}
                </span>
              </button>
            )}
            {(!isSearchMode || (effectiveSearchTab === 'channels' && searchScope !== 'epg')) && (
              <div className="guide-nav">
                <button className="guide-nav-btn" onClick={goBack} title={t('previousHour')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <button className="guide-now-btn" onClick={goToNow} disabled={isAtNow}>{t('now')}</button>
                <button className="guide-nav-btn" onClick={goForward} title={t('nextHour')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
            )}
            <button className="guide-close" onClick={onClose}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
          </div>
        </div>

        {/* Channel search — in 3-column view the time header (which hosts the
            search on the timeline views) is hidden, so render it here above the
            channel list. */}
        {epgThreeColumn && !isSearchMode && !isWatchlistMode && !allChannelsCapped && !epgHiddenButtons.includes('channel-search') && (
          <div className="guide-alt-channel-search">
            <div className={`channel-search-input-wrapper ${channelSearchFocused ? 'focused' : ''}`}>
              <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <input
                type="text"
                className="channel-search-input"
                placeholder={t('searchChannelsPlaceholder')}
                value={channelSearchQuery}
                onChange={(e) => setChannelSearchQuery(e.target.value)}
                onFocus={() => setChannelSearchFocused(true)}
                onBlur={() => setChannelSearchFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setChannelSearchQuery('');
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              {channelSearchQuery && (
                <button className="search-clear-btn" onClick={() => setChannelSearchQuery('')} title={t('clearSearch')}>
                  ✕
                </button>
              )}
            </div>
          </div>
        )}

        {/* Time Scale - hidden in watchlist mode; in search mode only shown when the
            Channels tab is active and channel matches are present (EPG program
            results have no timeline) */}
        {!isWatchlistMode && (!isSearchMode || (effectiveSearchTab === 'channels' && searchScope !== 'epg' && searchChannels && searchChannels.length > 0)) && (
          <div className="guide-time-header">
            <div className="guide-time-header-spacer" style={{ width: 'var(--epg-channel-column-width, 264px)' }}>
              {!isSearchMode && !allChannelsCapped && !epgHiddenButtons.includes('channel-search') && (
                <div className="channel-search-container">
                  <div className={`channel-search-input-wrapper ${channelSearchFocused ? 'focused' : ''}`}>
                    <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8"></circle>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <input
                      type="text"
                      className="channel-search-input"
                      placeholder={t('searchChannelsPlaceholder')}
                      value={channelSearchQuery}
                      onChange={(e) => setChannelSearchQuery(e.target.value)}
                      onFocus={() => setChannelSearchFocused(true)}
                      onBlur={() => setChannelSearchFocused(false)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setChannelSearchQuery('');
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                    />
                    {channelSearchQuery && (
                      <button className="search-clear-btn" onClick={() => setChannelSearchQuery('')} title={t('clearSearch')}>
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="guide-time-header-grid">
              {timeSlots.map((slot, i) => {
                const position = getTimeSlotPosition(slot);
                if (position < 0 || position > availableWidth) return null;
                return (
                  <span key={i} className="guide-time-marker" style={{ left: position }}>
                    {formatEpgTime(slot)}
                  </span>
                );
              })}
              {/* Current time indicator */}
              {currentTimeIndicatorPosition !== null && (
                <div
                  className="guide-current-time-indicator"
                  style={{ left: currentTimeIndicatorPosition }}
                />
              )}
            </div>
            {guideTransparent && (
              <button
                className="guide-transparent-close-btn"
                onClick={onClose}
                title={t('closeTransparentGuide')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Content Grid / Search Results / Watchlist */}
        <div className="guide-content" style={{ position: 'relative' }}>
          {isWatchlistMode ? (
            /* Watchlist View - Shows watchlist items with edit/delete buttons */
            <div className="guide-search-results guide-channels">
              {watchlistItems && watchlistItems.length > 0 ? (
                (() => {
                  const now = new Date();

                  // Get live and upcoming items (with valid channels)
                  const liveItems: { item: WatchlistItem; channel: StoredChannel }[] = [];
                  const upcomingItems: { item: WatchlistItem; channel: StoredChannel }[] = [];

                  for (const item of watchlistItems) {
                    const channel = watchlistChannels.get(item.channel_id);
                    if (!channel) continue; // Skip if channel not found

                    const isLive = now.getTime() >= item.start_time && now.getTime() < item.end_time;
                    if (isLive) {
                      liveItems.push({ item, channel });
                    } else if (item.end_time > now.getTime()) {
                      upcomingItems.push({ item, channel });
                    }
                  }

                  // Sort by start time
                  liveItems.sort((a, b) => a.item.start_time - b.item.start_time);
                  upcomingItems.sort((a, b) => a.item.start_time - b.item.start_time);

                  return (
                    <>
                      {/* Live Now Section */}
                      {liveItems.length > 0 && (
                        <div className="search-section">
                          <div className="search-section-subtitle">
                            <span className="live-dot"></span> Live Now ({liveItems.length})
                          </div>
                          {liveItems.map(({ item, channel }) => (
                            <WatchlistRow
                              key={`watchlist-live-${item.id}`}
                              item={item}
                              channel={channel}
                              programs={watchlistPrograms.get(item.channel_id) || []}
                              windowStart={windowStart}
                              windowEnd={windowEnd}
                              pixelsPerHour={pixelsPerHour}
                              visibleHours={visibleHours}
                              onPlay={() => handleSearchChannelClick(channel)}
                              onRefresh={() => {
                                setWatchlistRefreshTrigger(v => v + 1);
                                onWatchlistRefresh?.();
                              }}
                              showPlaylistName={showWatchlistPlaylistName}
                              sourceNames={sourceNames}
                            />
                          ))}
                        </div>
                      )}

                      {/* Upcoming Programs Section */}
                      {upcomingItems.length > 0 && (
                        <div className="search-section">
                          {liveItems.length > 0 && (
                            <div className="search-section-subtitle">Upcoming ({upcomingItems.length})</div>
                          )}
                          {upcomingItems.map(({ item, channel }) => (
                            <WatchlistRow
                              key={`watchlist-upcoming-${item.id}`}
                              item={item}
                              channel={channel}
                              programs={watchlistPrograms.get(item.channel_id) || []}
                              windowStart={windowStart}
                              windowEnd={windowEnd}
                              pixelsPerHour={pixelsPerHour}
                              visibleHours={visibleHours}
                              onPlay={() => handleSearchChannelClick(channel)}
                              onRefresh={() => {
                                setWatchlistRefreshTrigger(v => v + 1);
                                onWatchlistRefresh?.();
                              }}
                              showPlaylistName={showWatchlistPlaylistName}
                              sourceNames={sourceNames}
                            />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()
              ) : (
                <div className="guide-empty">
                  <h3>{t('watchlistEmpty')}</h3>
                  <p>{t('watchlistEmptyHint')}</p>
                </div>
              )}
            </div>
          ) : isSearchMode ? (
            /* Search Results View - tabbed: Channels (EPG timeline), Live Now EPG,
                Upcoming EPG. Only the picked tab renders (Channels is the default). */
            <div className="guide-search-results guide-channels">
              {/* Channels tab - rendered like the regular EPG grid with a timeline
                  and the current-time indicator line. Virtualized so searches with
                  hundreds of matches stay smooth. */}
              {effectiveSearchTab === 'channels' && searchScope !== 'epg' && (
                searchChannels && searchChannels.length > 0 ? (
                  <div className="search-section search-channels-section">
                    <div className="search-channels-timeline">
                      <div ref={handleSearchScrollerRef} className="search-virtuoso overflow-y-auto max-h-full">
                        <VirtualList
                          key="search-channels"
                          items={searchChannels}
                          estimateItemHeight={searchChannelRowHeight}
                          onVirtualItemsChange={onSearchChannelVirtualItemsChange}
                          renderItem={(channel, index) => (
                            <ChannelRowVirtuoso
                              index={index}
                              channel={channel}
                              data={searchChannelRowContext}
                            />
                          )}
                          overscan={4}
                        />
                      </div>
                      {/* Current time indicator - spans the channel rows only */}
                      {currentTimeIndicatorPosition !== null && (
                        <div
                          className="guide-current-time-indicator"
                          style={{
                            left: `calc(${currentTimeIndicatorPosition}px + var(--epg-channel-column-width, 264px))`,
                            ...(searchChannelsListHeight > 0 ? { height: `${searchChannelsListHeight}px` } : {}),
                          }}
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="guide-empty">
                    <h3>{t('noResultsFound')}</h3>
                    <p>{t('tryDifferentTerm')}</p>
                  </div>
                )
              )}

              {/* Live Now EPG tab - virtualized card rows, no timeline */}
              {effectiveSearchTab === 'live' && searchScope !== 'channels' && (
                liveChannels.length > 0 ? (
                  <div className="search-section search-programs-section">
                    <div ref={handleSearchScrollerRef} className="search-virtuoso overflow-y-auto max-h-full">
                      <VirtualList
                        key="search-live"
                        items={liveChannels}
                        estimateItemHeight={80}
                        renderItem={(entry, index) => (
                          <SearchResultRowVirtuoso
                            index={index}
                            entry={entry}
                            data={searchProgramRowContext}
                          />
                        )}
                        overscan={4}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="guide-empty">
                    <h3>{t('noLivePrograms')}</h3>
                    <p>{t('tryDifferentTerm')}</p>
                  </div>
                )
              )}

              {/* Upcoming EPG tab - virtualized card rows, no timeline */}
              {effectiveSearchTab === 'upcoming' && searchScope !== 'channels' && (
                upcomingChannels.length > 0 ? (
                  <div className="search-section search-programs-section">
                    <div ref={handleSearchScrollerRef} className="search-virtuoso overflow-y-auto max-h-full">
                      <VirtualList
                        key="search-upcoming"
                        items={upcomingChannels}
                        estimateItemHeight={80}
                        renderItem={(entry, index) => (
                          <SearchResultRowVirtuoso
                            index={index}
                            entry={entry}
                            data={searchProgramRowContext}
                          />
                        )}
                        overscan={4}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="guide-empty">
                    <h3>{t('noUpcomingPrograms')}</h3>
                    <p>{t('tryDifferentTerm')}</p>
                  </div>
                )
              )}
            </div>
          ) : (
            /* Normal EPG Grid View */
            filteredChannels.length === 0 ? (
              <div ref={handleGuideScrollerRef} className="guide-channels overflow-y-auto flex-1 min-h-0">
                <div className="guide-empty">
                  {allChannelsCapped ? (
                    <>
                      <h3>{t('allChannelsTooMany')}</h3>
                      <p>{t('allChannelsTooManyHint')}</p>
                    </>
                  ) : (
                    <h3>{channelSearchQuery ? t('noChannelsFound') : t('noChannels')}</h3>
                  )}
                </div>
              </div>
            ) : (
              <div
                ref={handleGuideScrollerRef}
                className="guide-channels overflow-y-auto flex-1 min-h-0"
              >
                <VirtualList
                  key={`channel-list-${categoryId ?? 'all'}-${favoritesVersion}-${channelSearchQuery}-${epgThreeColumn ? '3col' : 'grid'}`}
                  ref={virtuosoRef}
                  items={filteredChannels}
                  estimateItemHeight={guideRowHeight}
                  onVirtualItemsChange={onGuideVirtualItemsChange}
                  overscan={CHANNEL_LIST_OVERS}
                  onRangeChange={(range) => {
                    visibleRangeRef.current = range;
                    if (!shouldTrackVisibleRange) return;
                    setVisibleIndices((prev) =>
                      prev.startIndex === range.startIndex && prev.endIndex === range.endIndex
                        ? prev
                        : range
                    );
                  }}
                  renderItem={(channel, index) => (
                    <ChannelRowVirtuoso
                      index={index}
                      channel={channel}
                      data={{
                        channelSortOrder,
                        programs,
                        windowStart,
                        windowEnd,
                        pixelsPerHour,
                        visibleHours,
                        handleChannelClick,
                        onPlayCatchup,
                        handleFavoriteToggle,
                        categoryId,
                        activeRecordings,
                        currentLayout,
                        onSendToSlot,
                        onPlayInPopout,
                        onPlayInExternal,
                        currentChannel,
                        highlightChannel,
                        showPlaylistName: guideShowPlaylistName,
                        sourceNames,
                        epgMetadataBadgeResolution,
                        epgMetadataBadgeFps,
                        epgMetadataBadgeSound,
                        epgMetadataBadgeBitrate,
                        epgMetadataBadgeAudioBitrate,
                        threeColumn: epgThreeColumn,
                        currentTime,
                      }}
                    />
                  )}
                />
              </div>
            )
          )}
          {/* Current time indicator - spans through all channel rows, but stops
              at the last rendered row instead of the bottom of the panel */}
          {!isSearchMode && !isWatchlistMode && currentTimeIndicatorPosition !== null && (
            <div
              className="guide-current-time-indicator"
              style={{
                left: `calc(${currentTimeIndicatorPosition}px + var(--epg-channel-column-width, 264px))`,
                ...(guideListHeight > 0 ? { height: `${guideListHeight}px` } : {}),
              }}
            />
          )}
          {/* Scroll to Top button (Nuvio-style) for virtualized search results */}
          {isSearchMode && (
            <button
              className={`guide-scroll-top ${showSearchScrollTop ? 'visible' : ''}`}
              onClick={() => searchScroller?.scrollTo({ top: 0, behavior: 'smooth' })}
              aria-label={t('scrollToTop')}
              title={t('scrollToTop')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 15l-6-6-6 6" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Channel Manager Modal */}
      {managingCategory && (
        <ChannelManager
          categoryId={managingCategory.id}
          categoryName={managingCategory.name}
          sourceId={managingCategory.sourceId}
          onClose={handleChannelManagerClose}
          onChange={() => setFavoritesVersion(v => v + 1)}
          sortOrder={channelSortOrder}
        />
      )}

      {managingFavorites && (
        <FavoriteManager
          sourceId={managingFavoritesSourceId}
          onClose={() => {
            setManagingFavorites(false);
            setManagingFavoritesSourceId(null);
          }}
          onChange={() => setFavoritesVersion(v => v + 1)}
        />
      )}

      {/* Custom Group Manager Modal */}
      {managingCustomGroup && (
        <CustomGroupManager
          groupId={managingCustomGroup.id}
          groupName={managingCustomGroup.name}
          onClose={() => setManagingCustomGroup(null)}
        />
      )}

      {/* EPG Shift Modal */}
      <EpgShiftModal
        isOpen={showEpgShiftModal}
        currentOffset={currentEpgOffset}
        onClose={() => setShowEpgShiftModal(false)}
        onChange={handleEpgShiftChange}
      />

      {/* View All Programs Modal (3-column toolbar) */}
      <ViewAllProgramsModal
        isOpen={viewAllProgramsOpen}
        channel={selectedChannel}
        onClose={() => setViewAllProgramsOpen(false)}
        onPlayCatchup={onPlayCatchup}
      />

      {/* Failover Group List Modal */}
      {showFailoverGroupModal && (
        <FailoverGroupListModal
          onClose={() => setShowFailoverGroupModal(false)}
        />
      )}

      {/* EPG Editor Modal — opened for the current category's channels */}
      {epgEditorList && (
        <EpgEditorModal
          channelList={epgEditorList.channels}
          channelListName={epgEditorList.name}
          sourceId={sourceId || undefined}
          sourceName={categoryName}
          onClose={() => setEpgEditorList(null)}
        />
      )}

      {/* Playlist List Modal */}
      {showPlaylistListModal && (
        <PlaylistListModal
          onClose={() => setShowPlaylistListModal(false)}
        />
      )}
    </div>
  );
}
