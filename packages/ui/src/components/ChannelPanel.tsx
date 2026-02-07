import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useChannels, useCategories, useProgramsInRange } from '../hooks/useChannels';
import { useTimeGrid } from '../hooks/useTimeGrid';
import { ChannelRow } from './ChannelRow';
import { useChannelSortOrder } from '../stores/uiStore';
import type { StoredChannel } from '../db';
import { VideoErrorOverlay } from './VideoErrorOverlay';
import './ChannelPanel.css';

// Width of the channel info column
const CHANNEL_COLUMN_WIDTH = 220;

interface ChannelPanelProps {
  categoryId: string | null;
  visible: boolean;
  categoryStripOpen: boolean;
  sidebarExpanded: boolean;
  onPlayChannel: (channel: StoredChannel) => void;
  onClose: () => void;
  error?: string | null;
}

export function ChannelPanel({
  categoryId,
  visible,
  categoryStripOpen,
  sidebarExpanded,
  onPlayChannel,
  onClose,
  error,
}: ChannelPanelProps) {
  const channelSortOrder = useChannelSortOrder();
  const channels = useChannels(categoryId, channelSortOrder);
  const categories = useCategories();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [availableWidth, setAvailableWidth] = useState(800);

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

  // Get stream IDs for programs lookup
  const streamIds = useMemo(() => channels.map((ch) => ch.stream_id), [channels]);

  // Fetch programs for the preload window
  const programs = useProgramsInRange(streamIds, loadStart, loadEnd);

  // Update current time every minute
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

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

  // Get current category name
  const currentCategory = categoryId
    ? categories.find((c) => c.category_id === categoryId)
    : null;
  const categoryName = currentCategory?.category_name ?? 'All Channels';

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

  // Selected channel for preview/info (defaults to first channel or current)
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);

  // Derive selected channel object
  const selectedChannel = useMemo(() =>
    channels.find(c => c.stream_id === selectedChannelId) || channels[0] || null,
    [channels, selectedChannelId]);

  // Update selected channel when category changes (reset)
  useEffect(() => {
    if (channels.length > 0 && !selectedChannelId) {
      setSelectedChannelId(channels[0].stream_id);
    }
  }, [channels, selectedChannelId, categoryId]);

  // Handle Channel Click: Preview vs Fullscreen
  const handleChannelClick = (channel: StoredChannel) => {
    if (selectedChannelId === channel.stream_id) {
      // Already selected/previewing -> Go Fullscreen (Close Guide)
      onClose();
    } else {
      // Select for preview and play immediately
      setSelectedChannelId(channel.stream_id);
      onPlayChannel(channel);
    }
  };

  // Get current program for the selected channel
  const selectedProgram = useMemo(() => {
    if (!selectedChannel) return null;
    const channelPrograms = programs.get(selectedChannel.stream_id) || [];
    const now = currentTime.getTime();
    return channelPrograms.find(p => {
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

  // Handle Video Resizing for Preview Mode via ResizeObserver
  // This ensures we exactly match the CSS dimensions regardless of resolution or layout state
  useEffect(() => {
    if (!window.mpv) return;

    const updateVideoPosition = () => {
      if (!previewRef.current || !selectedChannel || !visible) {
        if (!visible && window.mpv) {
          // Exit Preview Mode
          window.mpv.setProperty('video-zoom', 0);
          window.mpv.setProperty('video-align-x', 0);
          window.mpv.setProperty('video-align-y', 0);
        }
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
      // rect.left is the distance from left edge
      // Center of Preview Pane = rect.left + (rect.width / 2)
      const targetCenterX = rect.left + (rect.width / 2);

      // align_x formula: (2 * shift) / (W - V_w)
      // shift = targetCenterX - (W / 2)
      const shiftX = targetCenterX - (windowW / 2);
      // Denominator protects against divide by zero (though scale=1 implies full screen)
      const availSpaceX = windowW - rect.width;
      const alignX = Math.abs(availSpaceX) < 1 ? 0 : (2 * shiftX) / availSpaceX;

      // Calculate Alignment Y
      // y_align = (2 * topOffset / (H - V_h)) - 1
      const topOffset = rect.top;
      const availSpaceY = windowH - rect.height;
      const alignY = Math.abs(availSpaceY) < 1 ? 0 : (2 * topOffset) / availSpaceY - 1;

      window.mpv?.setProperty('video-zoom', zoom);
      window.mpv?.setProperty('video-align-x', alignX);
      window.mpv?.setProperty('video-align-y', alignY);
    };

    const observer = new ResizeObserver(() => {
      // Wrap in rAF to debounce and sync with paint
      requestAnimationFrame(updateVideoPosition);
    });

    if (previewRef.current) {
      observer.observe(previewRef.current);
      // Also update immediately
      updateVideoPosition();
    }

    // Also listen to window resize to handle global scaling
    window.addEventListener('resize', updateVideoPosition);

    // Force update loop during transitions (CSS transitions take ~300ms)
    // We run this for 500ms to be safe and ensure we catch every frame of the animation
    let animationFrameId: number;
    const startTime = performance.now();
    const DURATION = 500; // ms

    const animate = () => {
      updateVideoPosition();
      if (performance.now() - startTime < DURATION) {
        animationFrameId = requestAnimationFrame(animate);
      }
    };

    // Start the loop whenever state changes
    animate();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateVideoPosition);
      cancelAnimationFrame(animationFrameId);
    };
  }, [visible, categoryStripOpen, sidebarExpanded, selectedChannel]); // Re-run when layout state or channel changes

  return (
    <div
      ref={gridContainerRef}
      className={`guide-panel ${visible ? 'visible' : 'hidden'} ${categoryStripOpen ? 'with-categories' : ''} ${sidebarExpanded ? 'sidebar-expanded' : ''}`}
    >
      {/* Top Section: Preview & Info */}
      <div className="guide-top-section">
        <div className="guide-preview-pane" ref={previewRef}>
          {/* Transparent area for MPV video */}
          {!selectedChannel && <div className="guide-preview-placeholder">Select a channel</div>}
          {error && <VideoErrorOverlay error={error} isSmall />}
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
            <span className="guide-current-time">{formatTime(currentTime)}</span>
            <span className="guide-channel-count">{channels.length} channels</span>
          </div>
          <div className="guide-header-right">
            <div className="guide-nav">
              <button className="guide-nav-btn" onClick={goBack} title="Previous hour">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <button className="guide-now-btn" onClick={goToNow} disabled={isAtNow}>Now</button>
              <button className="guide-nav-btn" onClick={goForward} title="Next hour">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
            <button className="guide-close" onClick={onClose}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
          </div>
        </div>

        {/* Time Scale */}
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
          </div>
        </div>

        {/* Content Grid */}
        <div className="guide-content" style={{ position: 'relative' }}>
          <Virtuoso
            data={channels}
            className="guide-channels"
            itemContent={(index, channel) => (
              <ChannelRow
                channel={channel}
                index={index}
                sortOrder={channelSortOrder}
                programs={programs.get(channel.stream_id) ?? []}
                windowStart={windowStart}
                windowEnd={windowEnd}
                pixelsPerHour={pixelsPerHour}
                visibleHours={visibleHours}
                onPlay={() => handleChannelClick(channel)}
              />
            )}
            components={{
              EmptyPlaceholder: () => (
                <div className="guide-empty">
                  <h3>No Channels</h3>
                </div>
              ),
            }}
          />
        </div>
      </div>
    </div >
  );
}
