import { useState, useEffect, useMemo, useRef, useCallback, memo } from 'react';
import { useSourceVersion } from '../contexts/SourceVersionContext';
import { Virtuoso } from 'react-virtuoso';
import { useChannels, useCategories, useAllPrograms } from '../hooks/useChannels';
import { useTimeGrid } from '../hooks/useTimeGrid';
import { useActiveRecordings } from '../hooks/useActiveRecordings';
import { ChannelRow } from './ChannelRow';
import { SearchResultRow } from './SearchResultRow';
import { WatchlistRow } from './WatchlistRow';
import { ChannelManager } from './settings/ChannelManager';
import { FavoriteManager } from './settings/FavoriteManager';
import { CustomGroupManager } from './CustomGroupManager';

import { useChannelSortOrder } from '../stores/uiStore';
import type { StoredChannel, StoredProgram, WatchlistItem } from '../db';
import { db } from '../db';
import { VideoErrorOverlay } from './VideoErrorOverlay';
import { Bridge } from '../services/tauri-bridge';
import { MetadataBadge } from './MetadataBadge';
import './ChannelPanel.css';


// Width of the channel info column (20% bigger than original 220)
const CHANNEL_COLUMN_WIDTH = 264;

// Memoized Virtuoso row component to prevent unnecessary re-renders
// This must be defined OUTSIDE the ChannelPanel component
interface ChannelRowData {
  channelSortOrder: 'alphabetical' | 'number';
  programs: Map<string, StoredProgram[]>;
  windowStart: Date;
  windowEnd: Date;
  pixelsPerHour: number;
  visibleHours: number;
  handleChannelClick: (channel: StoredChannel) => void;
  onPlayCatchup?: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number) => void;
  handleFavoriteToggle: () => void;
  categoryId: string | null;
  activeRecordings: import('../hooks/useActiveRecordings').RecordingInfo[];
  currentLayout?: string;
  onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null) => void;
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
      onPlay={() => data.handleChannelClick(channel)}
      onPlayCatchup={data.onPlayCatchup}
      onFavoriteToggle={data.handleFavoriteToggle}
      categoryId={data.categoryId}
      activeRecordings={data.activeRecordings}
      currentLayout={data.currentLayout}
      onSendToSlot={data.onSendToSlot}
    />
  );
});

interface ChannelPanelProps {
  categoryId: string | null;
  visible: boolean;
  categoryStripOpen: boolean;
  sidebarExpanded: boolean;
  showSidebar?: boolean;
  onPlayChannel: (channel: StoredChannel) => void;
  onPlayCatchup?: (channel: StoredChannel, programTitle: string, startTimeMs: number, durationMinutes: number) => void;
  onClose: () => void;
  error?: string | null;
  isSearchMode?: boolean;
  searchQuery?: string;
  searchChannels?: StoredChannel[];
  searchPrograms?: StoredProgram[];
  isWatchlistMode?: boolean;
  watchlistItems?: WatchlistItem[];
  onWatchlistRefresh?: () => void;
  // Multiview props
  currentLayout?: string;
  onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null) => void;
  // Search display props
  includeSourceInSearch?: boolean;
  // Current playing channel for syncing preview
  currentChannel?: StoredChannel | null;
}

export function ChannelPanel({
  categoryId,
  visible,
  categoryStripOpen,
  sidebarExpanded,
  showSidebar = true,
  onPlayChannel,
  onPlayCatchup,
  onClose,
  error,
  isSearchMode,
  searchQuery,
  searchChannels,
  searchPrograms,
  isWatchlistMode,
  watchlistItems,
  onWatchlistRefresh,
  currentLayout,
  onSendToSlot,
  includeSourceInSearch,
  currentChannel,
}: ChannelPanelProps) {
  useEffect(() => {
    if (error) console.log('[ChannelPanel] Received error prop:', error);
  }, [error]);

  const channelSortOrder = useChannelSortOrder();
  // Optimization: Skip loading the main channel grid when in Search or Watchlist mode
  // This prevents loading 40k+ channels in the background which causes UI lag
  const shouldSkipGrid = isSearchMode || isWatchlistMode;
  const channels = useChannels(categoryId, channelSortOrder, { skip: shouldSkipGrid });
  const categories = useCategories();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [availableWidth, setAvailableWidth] = useState(800);

  // Get active recordings for showing indicators
  const { recordings: activeRecordings } = useActiveRecordings(5000);

  // Cached source name map to avoid repeated Tauri calls
  const { version: sourceVersion } = useSourceVersion();
  const sourceNameMapRef = useRef<Map<string, string>>(new Map());
  const lastSourceVersionRef = useRef<number>(-1);

  // Fetch source names only when version changes
  useEffect(() => {
    if (lastSourceVersionRef.current === sourceVersion) return;
    if (!includeSourceInSearch || !window.storage) return;

    async function fetchSourceNames() {
      const result = await window.storage.getSources();
      if (result.data) {
        const map = new Map<string, string>();
        for (const source of result.data) {
          map.set(source.id, source.name);
        }
        sourceNameMapRef.current = map;
        lastSourceVersionRef.current = sourceVersion;
      }
    }

    fetchSourceNames();
  }, [sourceVersion, includeSourceInSearch]);

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

  // State for watchlist data
  const [watchlistPrograms, setWatchlistPrograms] = useState<Map<string, StoredProgram[]>>(new Map());
  const [watchlistChannels, setWatchlistChannels] = useState<Map<string, StoredChannel>>(new Map());
  const [watchlistRefreshTrigger, setWatchlistRefreshTrigger] = useState(0);

  // Key to force re-render when favorites change
  const [favoritesVersion, setFavoritesVersion] = useState(0);

  // State for channel manager modal
  const [managingCategory, setManagingCategory] = useState<{ id: string; name: string; sourceId: string } | null>(null);
  const [managingFavorites, setManagingFavorites] = useState(false);

  // State for custom group manager
  const [managingCustomGroup, setManagingCustomGroup] = useState<{ id: string; name: string } | null>(null);

  // Ref for measuring the grid container width
  const gridContainerRef = useRef<HTMLDivElement>(null);


  // Track window width to differentiate window resize vs category toggle
  const lastWindowWidth = useRef(typeof window !== 'undefined' ? window.innerWidth : 0);

  // Measure available width - only recalculate on actual window resize
  // Category toggles just clip visually (CSS flex handles it)
  useEffect(() => {
    const container = gridContainerRef.current;
    if (!container) return;

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
            const width = entry.contentRect.width - CHANNEL_COLUMN_WIDTH;
            setAvailableWidth(Math.max(width, 200));
            rafId = null;
          });
        }
      }
      // Category toggle: skip recalculation, CSS flex handles visual clipping
    });

    // Also listen for actual window resize
    const handleWindowResize = () => {
      const container = gridContainerRef.current;
      if (!container) return;

      lastWindowWidth.current = window.innerWidth;
      const width = container.getBoundingClientRect().width - CHANNEL_COLUMN_WIDTH;
      setAvailableWidth(Math.max(width, 200));
    };

    // Set initial width
    const initialWidth = container.getBoundingClientRect().width - CHANNEL_COLUMN_WIDTH;
    setAvailableWidth(Math.max(initialWidth, 200));

    observer.observe(container);
    window.addEventListener('resize', handleWindowResize);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

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
  } = useTimeGrid({ availableWidth });

  // Programs will be fetched after selectedChannel is defined (see below)

  // Update current time every minute
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Calculate current time indicator position
  const currentTimeIndicatorPosition = useMemo(() => {
    const hoursFromStart = (currentTime.getTime() - windowStart.getTime()) / (1000 * 60 * 60);
    const position = hoursFromStart * pixelsPerHour;
    // Only show if within visible window
    if (position < 0 || position > availableWidth) return null;
    return position;
  }, [currentTime, windowStart, pixelsPerHour, availableWidth]);

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
  useEffect(() => {
    if (!isSearchMode) {
      setSearchChannelPrograms(new Map());
      setSearchProgramChannels(new Map());
      return;
    }

    async function fetchSearchData() {
      const channelProgramsMap = new Map<string, StoredProgram[]>();
      const programChannelsMap = new Map<string, StoredChannel>();

      // Fetch programs for channel search results
      if (searchChannels && searchChannels.length > 0) {
        const now = new Date();
        const windowStart = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
        const windowEnd = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6 hours ahead

        for (const channel of searchChannels) {
          const channelProgs = await db.programs
            .where('stream_id')
            .equals(channel.stream_id)
            .filter((p) => {
              const start = p.start instanceof Date ? p.start : new Date(p.start);
              const end = p.end instanceof Date ? p.end : new Date(p.end);
              return start < windowEnd && end > windowStart;
            })
            .toArray();

          // Sort by start time
          channelProgs.sort((a, b) => {
            const aStart = a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
            const bStart = b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
            return aStart - bStart;
          });

          channelProgramsMap.set(channel.stream_id, channelProgs);
        }
      }

      // Fetch channels for program search results and organize programs by channel
      if (searchPrograms && searchPrograms.length > 0) {
        const uniqueStreamIds = new Set(searchPrograms.map(p => p.stream_id));
        for (const streamId of uniqueStreamIds) {
          const channel = await db.channels.get(streamId);
          if (channel) {
            // Add source_name if includeSourceInSearch is enabled (using cached map)
            if (includeSourceInSearch) {
              channel.source_name = sourceNameMapRef.current.get(channel.source_id) || undefined;
            }
            programChannelsMap.set(streamId, channel);

            // Get all matching programs for this channel
            const channelMatchingProgs = searchPrograms.filter(p => p.stream_id === streamId);
            channelProgramsMap.set(streamId, channelMatchingProgs);
          }
        }
      }

      setSearchChannelPrograms(channelProgramsMap);
      setSearchProgramChannels(programChannelsMap);
    }

    fetchSearchData();
  }, [isSearchMode, searchChannels, searchPrograms, includeSourceInSearch]);

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
  const categoryName = currentCategory?.category_name ?? 'All Channels';

  // Get source ID from current category
  const sourceId = currentCategory?.source_id ?? '';

  // Handle opening channel manager
  const handleManageChannels = useCallback(() => {
    if (categoryId && sourceId && !categoryId.startsWith('__')) {
      setManagingCategory({ id: categoryId, name: categoryName, sourceId });
    }
  }, [categoryId, categoryName, sourceId]);

  // Handle channel manager close with refresh
  const handleChannelManagerClose = useCallback(() => {
    setManagingCategory(null);
    // Force refresh channels by incrementing favorites version
    setFavoritesVersion(v => v + 1);
  }, []);

  // Check if we can manage channels (not for virtual categories like favorites/recent)
  const canManageChannels = categoryId && !categoryId.startsWith('__') && sourceId;

  // Check if current category is a custom group and get its name
  const [isCustomGroup, setIsCustomGroup] = useState(false);
  const [customGroupName, setCustomGroupName] = useState('Custom Group');
  useEffect(() => {
    async function checkCustomGroup() {
      if (!categoryId) {
        setIsCustomGroup(false);
        setCustomGroupName('Custom Group');
        return;
      }
      const group = await db.customGroups.get(categoryId);
      setIsCustomGroup(!!group);
      if (group) {
        setCustomGroupName(group.name);
      } else {
        setCustomGroupName('Custom Group');
      }
    }
    checkCustomGroup();
  }, [categoryId]);

  // Format time
  const formatTime = useCallback((date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, []);

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

  // Get stream IDs for programs lookup
  // Include selectedChannel (from currentChannel prop) in case it's from a different category/source
  const streamIds = useMemo(() => {
    const ids = channels.map((ch) => ch.stream_id);
    if (selectedChannel?.stream_id && !ids.includes(selectedChannel.stream_id)) {
      ids.push(selectedChannel.stream_id);
    }
    return ids;
  }, [channels, selectedChannel?.stream_id]);

  // Fetch ALL programs at once (no lazy loading by time window)
  const programs = useAllPrograms(streamIds);

  // Sync selectedChannel with currentChannel when it changes externally
  // (watchlist notification, autoswitch, calendar, multiview swap)
  // Also re-sync when becoming visible to ensure preview matches current channel
  useEffect(() => {
    if (currentChannel?.stream_id) {
      // Update selectedChannel to match currentChannel
      if (currentChannel.stream_id !== selectedChannel?.stream_id) {
        setSelectedChannel(currentChannel);
      }
    }
  }, [currentChannel, selectedChannel?.stream_id, visible]);

  // Track if we have a channel to show
  const hasSelectedChannel = selectedChannel !== null;

  // Handle Channel Click: Preview vs Fullscreen
  const handleChannelClick = useCallback((channel: StoredChannel) => {
    if (selectedChannel?.stream_id === channel.stream_id) {
      // Already selected/previewing -> Go Fullscreen (Close Guide)
      onClose();
    } else {
      // Select for preview and play immediately
      setSelectedChannel(channel);
      // Also update last channel ref immediately for resize effect
      lastChannelIdRef.current = channel.stream_id;
      onPlayChannel(channel);
    }
  }, [selectedChannel?.stream_id, onClose, onPlayChannel]);

  // Handle favorite toggle - refresh channel data
  const handleFavoriteToggle = useCallback(async () => {
    // Small delay to allow database to update
    await new Promise(resolve => setTimeout(resolve, 100));
    // Force re-render by incrementing version
    setFavoritesVersion(v => v + 1);
  }, []);

  // Handle search result click - same logic as regular channel click
  const handleSearchChannelClick = (channel: StoredChannel) => {
    if (selectedChannel?.stream_id === channel.stream_id) {
      // Already selected/previewing -> Go Fullscreen (Close Guide)
      onClose();
    } else {
      // Select for preview and play immediately
      setSelectedChannel(channel);
      // Also update last channel ref immediately for resize effect
      lastChannelIdRef.current = channel.stream_id;
      onPlayChannel(channel);
    }
  };

  // Handle search program click - find channel and use same logic
  const handleSearchProgramClick = async (program: StoredProgram) => {
    const channel = await db.channels.get(program.stream_id);
    if (channel) {
      if (selectedChannel?.stream_id === channel.stream_id) {
        // Already selected/previewing -> Go Fullscreen (Close Guide)
        onClose();
      } else {
        // Select for preview and play immediately
        setSelectedChannel(channel);
        // Also update last channel ref immediately for resize effect
        lastChannelIdRef.current = channel.stream_id;
        onPlayChannel(channel);
      }
    }
  };

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
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    const now = currentTime.getTime();
    return channelPrograms.find((p: StoredProgram) => {
      const start = p.start instanceof Date ? p.start.getTime() : new Date(p.start).getTime();
      const end = p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime();
      return now >= start && now < end;
    });
  }, [selectedChannel, programs, currentTime]);

  // Calculate progress for the progress bar
  const progressPercent = useMemo(() => {
    if (!selectedProgram) return 0;
    const now = currentTime.getTime();
    const start = selectedProgram.start instanceof Date ? selectedProgram.start.getTime() : new Date(selectedProgram.start).getTime();
    const end = selectedProgram.end instanceof Date ? selectedProgram.end.getTime() : new Date(selectedProgram.end).getTime();
    const total = end - start;
    if (total <= 0) return 0;
    return Math.min(100, Math.max(0, ((now - start) / total) * 100));
  }, [selectedProgram, currentTime]);

  // Ref for the video preview container
  const previewRef = useRef<HTMLDivElement>(null);
  // Track last channel ID to maintain resize when channel data is loading
  const lastChannelIdRef = useRef<string | null>(null);

  // Update last channel ID when selected channel changes
  useEffect(() => {
    if (selectedChannel?.stream_id) {
      lastChannelIdRef.current = selectedChannel.stream_id;
    }
  }, [selectedChannel?.stream_id]);

  // Handle Video Resizing for Preview Mode via ResizeObserver
  // This ensures we exactly match the CSS dimensions regardless of resolution or layout state
  useEffect(() => {
    // if (!window.mpv) return; // Bridge handles this

    const updateVideoPosition = () => {
      // Use last known channel ID if current selection is null but we have one cached
      const effectiveChannelId = selectedChannel?.stream_id || lastChannelIdRef.current;

      if (!previewRef.current || !effectiveChannelId || !visible) {
        return;
      }

      const rect = previewRef.current.getBoundingClientRect();

      // Safety check for zero dimensions (e.g. hidden)
      if (rect.width === 0 || rect.height === 0) return;

      const windowW = window.innerWidth;
      const windowH = window.innerHeight;

      // Calculate Scale Factor
      const scale = rect.width / windowW;
      const zoom = Math.log2(scale);

      // Calculate Alignment X
      const targetCenterX = rect.left + (rect.width / 2);
      const shiftX = targetCenterX - (windowW / 2);
      const availSpaceX = windowW - rect.width;
      const alignX = Math.abs(availSpaceX) < 1 ? 0 : (2 * shiftX) / availSpaceX;

      // Calculate Alignment Y
      const topOffset = rect.top;
      const availSpaceY = windowH - rect.height;
      const alignY = Math.abs(availSpaceY) < 1 ? 0 : (2 * topOffset) / availSpaceY - 1;

      Bridge.setProperty('video-zoom', zoom);
      Bridge.setProperty('video-align-x', alignX);
      Bridge.setProperty('video-align-y', alignY);
    };

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(updateVideoPosition);
    });

    if (previewRef.current) {
      observer.observe(previewRef.current);
      updateVideoPosition();
    }

    window.addEventListener('resize', updateVideoPosition);

    // Animation loop for CSS transitions (sidebar/category strip opening/closing)
    let animationFrameId: number;
    const startTime = performance.now();
    const DURATION = 500; // ms - covers CSS transition time

    const animate = () => {
      updateVideoPosition();
      if (performance.now() - startTime < DURATION) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };

    animate();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateVideoPosition);
      cancelAnimationFrame(animationFrameId);
    };
    // Re-run when layout changes (sidebar/category visibility) or when visibility/selection changes
    // Include selectedChannelId to trigger resize when returning to view with a selection
    // Include isWatchlistMode and categoryId to handle special view modes
  }, [visible, categoryStripOpen, sidebarExpanded, selectedChannel?.stream_id, isWatchlistMode, categoryId]);

  return (
    <div
      ref={gridContainerRef}
      className={`guide-panel ${visible ? 'visible' : 'hidden'} ${categoryStripOpen ? 'with-categories' : ''} ${sidebarExpanded ? 'sidebar-expanded' : ''} ${showSidebar ? 'with-sidebar' : 'no-sidebar'}`}
    >
      {/* Top Section: Preview & Info */}
      <div className="guide-top-section">
        <div className="guide-preview-pane" ref={previewRef}>
          {/* The actual video is rendered by MPV "under" this transparent div */}
          {/* Only show placeholder when truly no channel is selected (not in watchlist/favorites mode with a selection) */}
          {!selectedChannel && !isWatchlistMode && categoryId !== '__favorites__' && categoryId !== '__recent__' && (
            <div className="guide-preview-placeholder">Select a channel</div>
          )}
          {/* Show Error Overlay if there is an error */}
          {error && (
            <VideoErrorOverlay error={error} isSmall />
          )}
        </div>
        <div className="guide-info-pane">
          {selectedChannel ? (
            <>
              <div className="guide-program-title">
                {selectedProgram ? selectedProgram.title : (selectedChannel.name || 'No Program Name')}
              </div>
              <div className="guide-program-meta">
                <span>{selectedProgram ? `${formatTime(new Date(selectedProgram.start))} - ${formatTime(new Date(selectedProgram.end))}` : ''}</span>
                {selectedProgram && (
                  <div className="guide-program-progress-bar">
                    <div className="guide-program-progress-fill" style={{ width: `${progressPercent}%` }} />
                  </div>
                )}
                <span>{categoryName}</span>
              </div>
              <div className="guide-program-description">
                {selectedProgram?.description || 'No description available.'}
              </div>
              {selectedChannel && (
                <div style={{ marginTop: '8px' }}>
                  <MetadataBadge streamId={selectedChannel.stream_id} variant="detailed" />
                </div>
              )}
            </>
          ) : (
            <div className="guide-program-title">Select a channel</div>
          )}
        </div>
      </div>

      {/* Bottom Section: EPG Grid */}
      <div className="guide-grid-section">
        {/* Navigation / Header Bar */}
        <div className="guide-header">
          <div className="guide-header-left">
            {isWatchlistMode ? (
              <>
                <span className="guide-search-title">📋 Watchlist</span>
                <span className="guide-channel-count">
                  {watchlistItems?.length || 0} programs
                </span>
              </>
            ) : isSearchMode ? (
              <>
                <span className="guide-search-title">🔍 Search Results</span>
                <span className="guide-search-query">"{searchQuery}"</span>
                <span className="guide-channel-count">
                  {(searchChannels?.length || 0) + activePrograms.length} results
                </span>
              </>
            ) : (
              <>
                <span className="guide-current-time">{formatTime(currentTime)}</span>
                <span className="guide-channel-count">{channels.length} channels</span>
                {categoryId === '__favorites__' && (
                  <button
                    className="guide-manage-channels-btn"
                    onClick={() => setManagingFavorites(true)}
                    title="Manage favorites order"
                  >
                    ⭐ Manage Favorites
                  </button>
                )}
                {canManageChannels && (
                  <button
                    className="guide-manage-channels-btn"
                    onClick={isCustomGroup ? () => setManagingCustomGroup({ id: categoryId!, name: customGroupName }) : handleManageChannels}
                    title={isCustomGroup ? "Manage custom group" : "Manage channels in this category"}
                  >
                    {isCustomGroup ? '📂 Manage Custom Group' : '📺 Manage Channels'}
                  </button>
                )}
              </>
            )}
          </div>
          <div className="guide-header-right">
            {!isSearchMode && (
              <div className="guide-nav">
                <button className="guide-nav-btn" onClick={goBack} title="Previous hour">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <button className="guide-now-btn" onClick={goToNow} disabled={isAtNow}>Now</button>
                <button className="guide-nav-btn" onClick={goForward} title="Next hour">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
            )}
            <button className="guide-close" onClick={onClose}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
          </div>
        </div>

        {/* Time Scale - Hide in search mode and watchlist mode */}
        {!isSearchMode && !isWatchlistMode && (
          <div className="guide-time-header">
            <div className="guide-time-header-spacer" style={{ width: CHANNEL_COLUMN_WIDTH }} />
            <div className="guide-time-header-grid">
              {timeSlots.map((slot, i) => {
                const position = getTimeSlotPosition(slot);
                if (position < 0 || position > availableWidth) return null;
                return (
                  <span key={i} className="guide-time-marker" style={{ left: position }}>
                    {formatTime(slot)}
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
                            />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()
              ) : (
                <div className="guide-empty">
                  <h3>Your watchlist is empty</h3>
                  <p>Right-click on any program in the guide to add it to your watchlist</p>
                </div>
              )}
            </div>
          ) : isSearchMode ? (
            /* Search Results View - Like Regular Guide */
            <div className="guide-search-results guide-channels">
              {/* Channel Results */}
              {searchChannels && searchChannels.length > 0 && (
                <div className="search-section">
                  <h3 className="search-section-title">📺 Channels ({searchChannels.length})</h3>
                  {searchChannels.map((channel) => (
                    <SearchResultRow
                      key={channel.stream_id}
                      channel={channel}
                      programs={searchChannelPrograms.get(channel.stream_id) ?? []}
                      windowStart={windowStart}
                      windowEnd={windowEnd}
                      pixelsPerHour={pixelsPerHour}
                      visibleHours={visibleHours}
                      onPlay={() => handleSearchChannelClick(channel)}
                      onFavoriteToggle={refreshSearchResults}
                      activeRecordings={activeRecordings}
                      currentLayout={currentLayout}
                      onSendToSlot={onSendToSlot}
                      includeSourceInSearch={includeSourceInSearch}
                    />
                  ))}
                </div>
              )}

              {/* Program Results - Grouped by Channel */}
              {(() => {
                const now = new Date();

                if (activePrograms.length === 0) return null;

                return (
                  <div className="search-section">
                    <h3 className="search-section-title">📅 EPG Programs ({activePrograms.length})</h3>
                    {(() => {
                      // Group programs by channel
                      const channelProgramsMap = new Map<string, { channel: typeof searchProgramChannels extends Map<string, infer V> ? V : never; programs: typeof activePrograms }>();

                      for (const program of activePrograms) {
                        const channel = searchProgramChannels.get(program.stream_id);
                        if (!channel) continue;

                        if (!channelProgramsMap.has(channel.stream_id)) {
                          channelProgramsMap.set(channel.stream_id, { channel, programs: [] });
                        }
                        channelProgramsMap.get(channel.stream_id)!.programs.push(program);
                      }

                      // Separate into live and upcoming
                      const liveChannels: typeof channelProgramsMap extends Map<string, infer V> ? V[] : never = [];
                      const upcomingChannels: typeof channelProgramsMap extends Map<string, infer V> ? V[] : never = [];

                      for (const entry of channelProgramsMap.values()) {
                        const hasLiveProgram = entry.programs.some(p => {
                          const start = p.start instanceof Date ? p.start.getTime() : new Date(p.start).getTime();
                          const end = p.end instanceof Date ? p.end.getTime() : new Date(p.end).getTime();
                          return start <= now.getTime() && end > now.getTime();
                        });

                        if (hasLiveProgram) {
                          liveChannels.push(entry);
                        } else {
                          upcomingChannels.push(entry);
                        }
                      }

                      return (
                        <>
                          {/* Live Now Section */}
                          {liveChannels.length > 0 && (
                            <div className="search-live-section">
                              <div className="search-section-subtitle">
                                <span className="live-dot"></span> Live Now ({liveChannels.length})
                              </div>
                              {liveChannels.map(({ channel, programs }) => (
                                <SearchResultRow
                                  key={`live-${channel.stream_id}`}
                                  channel={channel}
                                  programs={programs}
                                  windowStart={windowStart}
                                  windowEnd={windowEnd}
                                  pixelsPerHour={pixelsPerHour}
                                  visibleHours={visibleHours}
                                  onPlay={() => handleSearchChannelClick(channel)}
                                  onFavoriteToggle={refreshSearchResults}
                                  activeRecordings={activeRecordings}
                                  includeSourceInSearch={includeSourceInSearch}
                                />
                              ))}
                            </div>
                          )}

                          {/* Upcoming Programs Section */}
                          {upcomingChannels.length > 0 && (
                            <div className="search-other-section">
                              {liveChannels.length > 0 && (
                                <div className="search-section-subtitle">Upcoming ({upcomingChannels.length})</div>
                              )}
                              {upcomingChannels.map(({ channel, programs }) => (
                                <SearchResultRow
                                  key={`upcoming-${channel.stream_id}`}
                                  channel={channel}
                                  programs={programs}
                                  windowStart={windowStart}
                                  windowEnd={windowEnd}
                                  pixelsPerHour={pixelsPerHour}
                                  visibleHours={visibleHours}
                                  onPlay={() => handleSearchChannelClick(channel)}
                                  onFavoriteToggle={refreshSearchResults}
                                  activeRecordings={activeRecordings}
                                  includeSourceInSearch={includeSourceInSearch}
                                />
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                );
              })()}

              {/* No Results */}
              {(!searchChannels || searchChannels.length === 0) && activePrograms.length === 0 && (
                <div className="guide-empty">
                  <h3>No results found</h3>
                  <p>Try a different search term</p>
                </div>
              )}
            </div>
          ) : (
            /* Normal EPG Grid View */
            <Virtuoso
              key={`channel-list-${categoryId ?? 'all'}-${favoritesVersion}`}
              data={channels}
              className="guide-channels"
              itemContent={(index, channel, context) => (
                <ChannelRowVirtuoso
                  index={index}
                  channel={channel}
                  data={context}
                />
              )}
              context={{
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
              }}
              components={{
                EmptyPlaceholder: () => (
                  <div className="guide-empty">
                    <h3>No Channels</h3>
                  </div>
                ),
              }}
            />
          )}
          {/* Current time indicator - spans through all channel rows */}
          {!isSearchMode && !isWatchlistMode && currentTimeIndicatorPosition !== null && (
            <div
              className="guide-current-time-indicator"
              style={{ left: currentTimeIndicatorPosition + CHANNEL_COLUMN_WIDTH }}
            />
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
          onClose={() => setManagingFavorites(false)}
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
    </div>
  );
}
