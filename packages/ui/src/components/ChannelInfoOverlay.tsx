import { useEffect, useState, useMemo } from 'react';
import type { StoredChannel } from '../db';
import { db } from '../db';
import { useCurrentProgram, useSourceNameMap } from '../hooks/useChannels';
import { useEpgClockFormat } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { formatChannelFullPath, parseCategoryIds } from '../utils/channelPath';
import { MetadataBadge } from './MetadataBadge';
import { formatTime } from '../utils/dateTime';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import './ChannelInfoOverlay.css';

interface ChannelInfoOverlayProps {
  channel: StoredChannel | null;
  visible: boolean;
  hideDescription?: boolean;
  hideMetaBadge?: boolean;
  hideLogo?: boolean;
  hideTimer?: boolean;
  overlayPosition?: 'left' | 'right';
  logoShape?: 'square' | 'horizontal';
  showFullPath?: boolean;
  categoryId?: string | null;
  isCatchup?: boolean;
  catchupInfo?: {
    channelId: string;
    programTitle: string;
    startTime: number;
    duration: number; // in minutes
    programDesc?: string;
  } | null;
  position?: number;
  duration?: number;
}

function formatEpgTime(date: Date, epgClockFormat: '12h' | '24h'): string {
  return formatTime(date, { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' });
}

export function ChannelInfoOverlay({
  channel,
  visible,
  hideDescription,
  hideMetaBadge = false,
  hideLogo = false,
  hideTimer = false,
  overlayPosition = 'left',
  logoShape = 'square',
  showFullPath,
  categoryId,
  isCatchup = false,
  catchupInfo = null,
  position = 0,
  duration = 0,
}: ChannelInfoOverlayProps) {
  useTranslation();
  const epgClockFormat = useEpgClockFormat();
  const channelInfoOverlayShowFullPath = useSettingsStore((s) => s.channelInfoOverlayShowFullPath);
  const effectiveShowFullPath = showFullPath ?? channelInfoOverlayShowFullPath;
  const sourceNames = useSourceNameMap();
  const [resolvedCategoryName, setResolvedCategoryName] = useState<string>('');

  useEffect(() => {
    if (!effectiveShowFullPath || !channel) {
      setResolvedCategoryName('');
      return;
    }
    let cancelled = false;
    // Clear immediately on channel or category change to prevent stale category flash
    setResolvedCategoryName('');

    async function loadCategory() {
      const catIds = parseCategoryIds(channel?.category_ids);
      const catId = (categoryId && !categoryId.startsWith('__')) ? categoryId : catIds[0];
      if (!catId) {
        if (!cancelled) setResolvedCategoryName('');
        return;
      }
      try {
        const found = await db.categories
          .where('category_id')
          .equals(catId)
          .toArray();
        if (cancelled) return;
        const match = (channel?.source_id ? found.find((c) => c.source_id === channel.source_id) : null) || found[0];
        let name = match ? (match.alias || match.category_name || '') : '';

        // Also check playlist category links for custom_name override
        try {
          const links = await db.playlistCategoryLinks.where('category_id').equals(catId).toArray();
          const customLink = links.find((l) => Boolean(l.custom_name));
          if (!cancelled && customLink?.custom_name) {
            name = customLink.custom_name;
          }
        } catch {
          // ignore playlist link error
        }

        if (!cancelled) {
          setResolvedCategoryName(name);
        }
      } catch (err) {
        console.error('[ChannelInfoOverlay] Failed to load category:', err);
        if (!cancelled) {
          setResolvedCategoryName('');
        }
      }
    }
    loadCategory();
    return () => {
      cancelled = true;
    };
  }, [effectiveShowFullPath, channel?.stream_id, channel?.source_id, channel?.category_ids, categoryId]);

  const channelDisplayTitle = useMemo(() => {
    if (!channel) return '';
    if (!effectiveShowFullPath) {
      return channel.alias || channel.name;
    }
    return formatChannelFullPath({
      channel,
      categoryId,
      sourceNames: sourceNames ?? undefined,
      fallbackCategoryName: resolvedCategoryName,
      translations: {
        favorites: i18n.t('live:favorites', { defaultValue: 'Favorites' }),
        watchlist: i18n.t('live:watchlist', { defaultValue: 'Watchlist' }),
        recentlyViewed: i18n.t('live:recentlyViewed', { defaultValue: 'Recently Viewed' }),
      },
    }) || channel.alias || channel.name;
  }, [channel, effectiveShowFullPath, categoryId, sourceNames, resolvedCategoryName, i18n.language]);

  const currentProgram = useCurrentProgram(isCatchup ? null : (channel?.stream_id ?? null));
  const [showDescription, setShowDescription] = useState(false);

  // Construct derived program details when playing catchup
  const activeProgram = isCatchup && catchupInfo ? {
    title: catchupInfo.programTitle,
    start: new Date(catchupInfo.startTime),
    end: new Date(catchupInfo.startTime + catchupInfo.duration * 60000),
    description: catchupInfo.programDesc,
  } : currentProgram;

  // Progress tracking for live TV - updates every second
  const [progress, setProgress] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState('');

  useEffect(() => {
    if (!visible) {
      setShowDescription(false);
      return;
    }
    const timer = setTimeout(() => setShowDescription(true), 300);
    return () => clearTimeout(timer);
  }, [visible, channel?.stream_id]);

  // Track program progress and time remaining
  useEffect(() => {
    if (isCatchup && catchupInfo) {
      const updateCatchupProgress = () => {
        const pct = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
        setProgress(pct);

        const remainingSecs = Math.max(0, duration - position);
        const remainingMins = Math.ceil(remainingSecs / 60);
        if (remainingMins >= 60) {
          const hrs = Math.floor(remainingMins / 60);
          const mins = remainingMins % 60;
          setTimeRemaining(`${hrs}h ${mins}m left`);
        } else {
          setTimeRemaining(`${remainingMins}m left`);
        }
      };
      updateCatchupProgress();
      return;
    }

    if (!currentProgram) {
      setProgress(0);
      setTimeRemaining('');
      return;
    }

    const updateProgress = () => {
      const now = new Date().getTime();
      const start = new Date(currentProgram.start).getTime();
      const end = new Date(currentProgram.end).getTime();
      const durationMs = end - start;
      const elapsed = now - start;

      const pct = Math.min(100, Math.max(0, (elapsed / durationMs) * 100));
      setProgress(pct);

      // Calculate time remaining
      const remainingMs = Math.max(0, end - now);
      const remainingMins = Math.ceil(remainingMs / 60000);
      if (remainingMins >= 60) {
        const hrs = Math.floor(remainingMins / 60);
        const mins = remainingMins % 60;
        setTimeRemaining(`${hrs}h ${mins}m left`);
      } else {
        setTimeRemaining(`${remainingMins}m left`);
      }
    };

    updateProgress();
    const interval = setInterval(updateProgress, 1000);
    return () => clearInterval(interval);
  }, [currentProgram, isCatchup, catchupInfo, position, duration]);

  if (!channel) return null;

  // Don't show for VOD or recordings
  const isVod = channel.stream_id === 'vod' || channel.stream_id?.startsWith('recording_');
  if (isVod) return null;

  return (
    <div
      className={`channel-info-overlay ${visible ? 'visible' : 'hidden'} ${overlayPosition === 'right' ? 'position-right' : 'position-left'}`}
    >
      <div className="cio-content">
        {/* Channel logo and name row */}
        <div className="cio-header">
          {!hideLogo && channel.stream_icon && (
            <img
              key={channel.stream_icon}
              src={channel.stream_icon}
              alt=""
              className={`cio-logo ${logoShape === 'horizontal' ? 'cio-logo-horizontal' : 'cio-logo-square'}`}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}
          <div className="cio-header-text">
            <span className="cio-channel-name" title={channelDisplayTitle}>
              {channelDisplayTitle}
            </span>
            {!hideMetaBadge && <MetadataBadge streamId={channel.stream_id} variant="detailed" location="overlay" />}
          </div>
        </div>

        {/* Program info */}
        {activeProgram && (
          <div className={`cio-program ${showDescription ? 'show' : ''}`}>
            {/* Program title */}
            <div className="cio-program-title" title={activeProgram.title}>
              {activeProgram.title}
            </div>

            {/* Subtitle */}
            {(activeProgram as any).subtitle && (
              <div className="cio-program-subtitle" title={(activeProgram as any).subtitle}>
                {(activeProgram as any).subtitle}
              </div>
            )}

            {/* Time row & progress bar */}
            {!hideTimer && (
              <>
                <div className="cio-time-row">
                  <span className="cio-time-range">
                    {formatEpgTime(new Date(activeProgram.start), epgClockFormat)} - {formatEpgTime(new Date(activeProgram.end), epgClockFormat)}
                  </span>
                  {timeRemaining && (
                    <span className="cio-time-remaining">{timeRemaining}</span>
                  )}
                </div>

                <div className="cio-progress-bar">
                  <div
                    className="cio-progress-fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </>
            )}

            {/* Description */}
            {!hideDescription && activeProgram.description && (
              <div className="cio-program-desc" title={activeProgram.description}>
                {activeProgram.description}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
