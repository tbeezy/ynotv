import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { db, type StoredChannel, type StoredCategory } from '../db';
import {
  startChannelProbe,
  probeSingleStream,
  checkProbeFfmpegStatus,
  saveProbedMetadataToDb,
  computeProbeHealthScore,
  type ProbeChannelInput,
  type ProbeChannelResult,
  type ProbeProgress,
  type ProbeSummary,
  type ProbeSessionController,
  type FfmpegStatus,
} from '../services/stream-probe';
import { resolvePlayUrl } from '../services/stream-resolver';
import { useSettingsStore } from '../stores/settingsStore';
import type { Source } from '@ynotv/core';
import { useTranslation } from 'react-i18next';
import './ChannelProbeModal.css';

export interface ChannelProbeModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialSourceId?: string | null;
  initialCategoryId?: string | null;
  initialChannels?: StoredChannel[];
  onPlayChannel?: (channel: StoredChannel) => void;
}

type TabFilter = 'all' | 'alive' | 'dead' | 'geoblocked' | 'drm' | '4k' | '1080p' | '720p' | 'sd';
type ScopeFilter = 'enabled' | 'missing-badges' | 'dead-only' | 'all-including-dead';
type SortColumn = 'status' | 'name' | 'quality' | 'fps' | 'video_codec' | 'audio_channels' | 'latency_ms';
type SortDirection = 'asc' | 'desc';

function SortIcon({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return (
      <svg className="cpm-sort-icon cpm-sort-icon-inactive" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />
      </svg>
    );
  }
  return direction === 'asc' ? (
    <svg className="cpm-sort-icon cpm-sort-icon-active" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  ) : (
    <svg className="cpm-sort-icon cpm-sort-icon-active" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function ChannelProbeModal({
  isOpen,
  onClose,
  initialSourceId,
  initialCategoryId,
  initialChannels,
  onPlayChannel,
}: ChannelProbeModalProps) {
  const { t } = useTranslation('probe');

  // Data state
  const [sources, setSources] = useState<Source[]>([]);
  const [categories, setCategories] = useState<StoredCategory[]>([]);
  const [channels, setChannels] = useState<StoredChannel[]>([]);

  // Selection state (multi-select: empty array = all enabled)
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('enabled');

  // Popover state
  const [isSourcePopoverOpen, setIsSourcePopoverOpen] = useState<boolean>(false);
  const [isCategoryPopoverOpen, setIsCategoryPopoverOpen] = useState<boolean>(false);
  const [sourceSearch, setSourceSearch] = useState<string>('');
  const [categorySearch, setCategorySearch] = useState<string>('');

  // Probe Settings (default 1 concurrent, max 5)
  const [concurrency, setConcurrency] = useState<number>(1);
  const [timeoutSecs, setTimeoutSecs] = useState<number>(8);
  const [maxRetries, setMaxRetries] = useState<number>(3);
  const [autoSaveBadges, setAutoSaveBadges] = useState<boolean>(true);
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus | null>(null);

  // Scan state
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [progress, setProgress] = useState<ProbeProgress | null>(null);
  const [summary, setSummary] = useState<ProbeSummary | null>(null);
  const [results, setResults] = useState<ProbeChannelResult[]>([]);
  const activeSessionRef = useRef<ProbeSessionController | null>(null);

  // Results table UI & sort state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeTab, setActiveTab] = useState<TabFilter>('all');
  const [reprobingStreamId, setReprobingStreamId] = useState<string | null>(null);
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  // Dialog state
  interface ProbeDialogState {
    type: 'confirm' | 'info' | 'success' | 'warning';
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    middleText?: string;
    onConfirm?: () => void | Promise<void>;
    onMiddle?: () => void | Promise<void>;
    danger?: boolean;
  }
  const [dialog, setDialog] = useState<ProbeDialogState | null>(null);

  // Close popovers on click outside
  useEffect(() => {
    if (!isSourcePopoverOpen && !isCategoryPopoverOpen) return;
    const handleDocumentClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.cpm-popover-anchor')) {
        setIsSourcePopoverOpen(false);
        setIsCategoryPopoverOpen(false);
      }
    };
    document.addEventListener('click', handleDocumentClick);
    return () => document.removeEventListener('click', handleDocumentClick);
  }, [isSourcePopoverOpen, isCategoryPopoverOpen]);

  // Load sources and FFmpeg status on open
  useEffect(() => {
    if (!isOpen) return;

    checkProbeFfmpegStatus().then(setFfmpegStatus);

    if (window.storage) {
      window.storage.getSources().then((res) => {
        if (res.data) {
          const enabledOnly = (res.data as Source[]).filter((s) => s.enabled !== false);
          setSources(enabledOnly);
          if (initialSourceId && enabledOnly.some((s: Source) => s.id === initialSourceId)) {
            setSelectedSourceIds([initialSourceId]);
          } else {
            setSelectedSourceIds([]);
          }
        }
      });
    }
    if (initialCategoryId) {
      setSelectedCategoryIds([initialCategoryId]);
    } else {
      setSelectedCategoryIds([]);
    }
  }, [isOpen, initialSourceId, initialCategoryId]);

  // Load categories when source selection changes (filter enabled only)
  useEffect(() => {
    if (!isOpen) return;

    const filterEnabledCats = (cats: StoredCategory[]) =>
      cats.filter((c) => c.enabled !== false && (c.enabled as any) !== 0);

    if (selectedSourceIds.length === 0) {
      db.categories.toArray().then((allCats) => setCategories(filterEnabledCats(allCats)));
    } else if (selectedSourceIds.length === 1) {
      db.categories
        .where('source_id')
        .equals(selectedSourceIds[0])
        .toArray()
        .then((sourceCats) => setCategories(filterEnabledCats(sourceCats)));
    } else {
      db.categories
        .where('source_id')
        .anyOf(selectedSourceIds)
        .toArray()
        .then((sourceCats) => setCategories(filterEnabledCats(sourceCats)));
    }
  }, [isOpen, selectedSourceIds]);

  // Load candidate channels based on source, category, and scope
  useEffect(() => {
    if (!isOpen) return;

    if (initialChannels && initialChannels.length > 0) {
      let filteredInitial = initialChannels;
      if (scopeFilter === 'enabled' || scopeFilter === 'missing-badges') {
        filteredInitial = filteredInitial.filter((c) => c.enabled !== false && (c.enabled as any) !== 0);
      } else if (scopeFilter === 'dead-only') {
        filteredInitial = filteredInitial.filter((c) => c.enabled === false || (c.enabled as any) === 0);
      }
      setChannels(filteredInitial);
      return;
    }

    let isMounted = true;

    async function loadChannels() {
      let query = db.channels.toCollection();

      if (selectedSourceIds.length === 1) {
        query = db.channels.where('source_id').equals(selectedSourceIds[0]);
      } else if (selectedSourceIds.length > 1) {
        query = db.channels.where('source_id').anyOf(selectedSourceIds);
      }

      let chList = await query.toArray();

      // If viewing all sources, only include channels from enabled sources
      if (selectedSourceIds.length === 0 && sources.length > 0) {
        const enabledSourceIds = new Set(sources.map((s) => s.id));
        chList = chList.filter((c) => enabledSourceIds.has(c.source_id));
      }

      if (selectedCategoryIds.length > 0) {
        const catSet = new Set(selectedCategoryIds);
        chList = chList.filter((c) => c.category_ids && c.category_ids.some((id) => catSet.has(id)));
      }

      // Filter by Scope
      if (scopeFilter === 'enabled') {
        chList = chList.filter((c) => c.enabled !== false && (c.enabled as any) !== 0);
      } else if (scopeFilter === 'dead-only') {
        chList = chList.filter((c) => c.enabled === false || (c.enabled as any) === 0);
      } else if (scopeFilter === 'missing-badges') {
        chList = chList.filter((c) => c.enabled !== false && (c.enabled as any) !== 0);
        const metadataItems = await db.channelMetadata.toArray();
        const existingIds = new Set(metadataItems.map((m) => m.stream_id));
        chList = chList.filter((c) => !existingIds.has(c.stream_id));
      }
      // 'all-including-dead' includes both enabled and disabled channels

      if (isMounted) {
        setChannels(chList);
      }
    }

    loadChannels();

    return () => {
      isMounted = false;
    };
  }, [isOpen, selectedSourceIds, selectedCategoryIds, scopeFilter, initialChannels, sources]);

  // Compute live health score
  const healthMetrics = useMemo(() => {
    return computeProbeHealthScore(results);
  }, [results]);

  // Start Probe
  const handleStartProbe = useCallback(async () => {
    if (channels.length === 0 || isScanning) return;

    setIsScanning(true);
    setIsPaused(false);
    setProgress(null);
    setSummary(null);
    setResults([]);

    // Clean up any previous session's listeners before starting a new probe
    if (activeSessionRef.current) {
      activeSessionRef.current.cleanup();
      activeSessionRef.current = null;
    }

    const sourcesMap = new Map<string, Source>(sources.map((s) => [s.id, s]));
    const globalUa = useSettingsStore.getState().globalLiveTvUserAgent;

    // Prepare inputs, resolving Stalker / relative Xtream URLs if needed
    const inputs: ProbeChannelInput[] = [];
    for (const c of channels) {
      const source = sourcesMap.get(c.source_id);
      let streamUrl = c.direct_url || '';
      const userAgent = source?.user_agent || globalUa || 'VLC/3.0.18 LibVLC/3.0.18';

      // Build Xtream live stream URL if direct_url is missing or not a full URL
      if (
        (!streamUrl || !streamUrl.startsWith('http')) &&
        source?.type === 'xtream' &&
        source.url &&
        source.username &&
        source.password
      ) {
        const baseUrl = source.url.replace(/\/+$/, '');
        const rawStreamId = c.stream_id.replace(`${c.source_id}_`, '');
        streamUrl = `${baseUrl}/live/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${rawStreamId}.ts`;
      }

      inputs.push({
        stream_id: c.stream_id,
        source_id: c.source_id,
        name: c.alias || c.name,
        url: streamUrl,
        category_id: c.category_ids?.[0],
        category_name: c.source_category_display,
        user_agent: userAgent,
      });
    }

    // Pre-resolve any Stalker channels in parallel
    const stalkerInputs = inputs.filter((inp) => {
      const src = sourcesMap.get(inp.source_id);
      return src?.type === 'stalker' || inp.url.startsWith('stalker_') || inp.url.startsWith('/media/');
    });

    if (stalkerInputs.length > 0) {
      await Promise.all(
        stalkerInputs.map(async (inp) => {
          try {
            const resolved = await resolvePlayUrl(inp.source_id, inp.url);
            inp.url = resolved.url;
            if (resolved.userAgent) inp.user_agent = resolved.userAgent;
          } catch (e) {
            console.warn('[ChannelProbeModal] Failed to pre-resolve Stalker URL for', inp.name, e);
          }
        })
      );
    }

    try {
      const controller = await startChannelProbe(
        inputs,
        {
          concurrency,
          timeout_secs: timeoutSecs,
          max_retries: maxRetries,
          auto_save_badges: autoSaveBadges,
        },
        {
          onProgress: (prog) => {
            setProgress(prog);
          },
          onBatch: (batch) => {
            setResults((prev) => {
              const updated = [...prev];
              for (const item of batch) {
                const idx = updated.findIndex((r) => r.stream_id === item.stream_id);
                if (idx >= 0) {
                  updated[idx] = item;
                } else {
                  updated.push(item);
                }
              }
              return updated;
            });
          },
          onFinished: (sum) => {
            setSummary(sum);
            setIsScanning(false);
            setIsPaused(false);
          },
          onError: (err) => {
            console.error('[ChannelProbeModal] Probe error:', err);
            setIsScanning(false);
          },
        }
      );

      activeSessionRef.current = controller;
    } catch (err) {
      console.error('[ChannelProbeModal] Failed to launch probe:', err);
      setIsScanning(false);
    }
  }, [channels, isScanning, sources, concurrency, timeoutSecs, maxRetries, autoSaveBadges]);

  // Re-run probe on only dead/failing streams from the current scan
  const handleRerunDeadStreams = useCallback(async () => {
    const deadResults = results.filter((r) => r.status === 'dead' || r.status === 'geoblocked' || r.status === 'drm');
    if (deadResults.length === 0 || isScanning) return;

    const deadStreamIds = new Set(deadResults.map((r) => r.stream_id));
    const deadCandidates = channels.filter((c) => deadStreamIds.has(c.stream_id));
    if (deadCandidates.length === 0) return;

    setIsScanning(true);
    setIsPaused(false);

    // Clean up any previous session's listeners before starting a new probe
    if (activeSessionRef.current) {
      activeSessionRef.current.cleanup();
      activeSessionRef.current = null;
    }

    const sourcesMap = new Map<string, Source>(sources.map((s) => [s.id, s]));
    const globalUa = useSettingsStore.getState().globalLiveTvUserAgent;

    const inputs: ProbeChannelInput[] = [];
    for (const c of deadCandidates) {
      const source = sourcesMap.get(c.source_id);
      let streamUrl = c.direct_url || '';
      const userAgent = source?.user_agent || globalUa || 'VLC/3.0.18 LibVLC/3.0.18';

      if (
        (!streamUrl || !streamUrl.startsWith('http')) &&
        source?.type === 'xtream' &&
        source.url &&
        source.username &&
        source.password
      ) {
        const baseUrl = source.url.replace(/\/+$/, '');
        const rawStreamId = c.stream_id.replace(`${c.source_id}_`, '');
        streamUrl = `${baseUrl}/live/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}/${rawStreamId}.ts`;
      }

      inputs.push({
        stream_id: c.stream_id,
        source_id: c.source_id,
        name: c.alias || c.name,
        url: streamUrl,
        category_id: c.category_ids?.[0],
        category_name: c.source_category_display,
        user_agent: userAgent,
      });
    }

    const stalkerInputs = inputs.filter((inp) => {
      const src = sourcesMap.get(inp.source_id);
      return src?.type === 'stalker' || inp.url.startsWith('stalker_') || inp.url.startsWith('/media/');
    });

    if (stalkerInputs.length > 0) {
      await Promise.all(
        stalkerInputs.map(async (inp) => {
          try {
            const resolved = await resolvePlayUrl(inp.source_id, inp.url);
            inp.url = resolved.url;
            if (resolved.userAgent) inp.user_agent = resolved.userAgent;
          } catch (e) {
            console.warn('[ChannelProbeModal] Failed to pre-resolve Stalker URL for', inp.name, e);
          }
        })
      );
    }

    try {
      const controller = await startChannelProbe(
        inputs,
        {
          concurrency,
          timeout_secs: timeoutSecs,
          max_retries: maxRetries,
          auto_save_badges: autoSaveBadges,
        },
        {
          onProgress: (prog) => {
            setProgress(prog);
          },
          onBatch: (batch) => {
            setResults((prev) => {
              const updated = [...prev];
              for (const item of batch) {
                const idx = updated.findIndex((r) => r.stream_id === item.stream_id);
                if (idx >= 0) {
                  updated[idx] = item;
                } else {
                  updated.push(item);
                }
              }
              return updated;
            });
          },
          onFinished: (sum) => {
            setSummary(sum);
            setIsScanning(false);
            setIsPaused(false);
          },
          onError: (err) => {
            console.error('[ChannelProbeModal] Rerun dead scan error:', err);
            setIsScanning(false);
          },
        }
      );

      activeSessionRef.current = controller;
    } catch (err) {
      console.error('[ChannelProbeModal] Failed to launch dead rerun:', err);
      setIsScanning(false);
    }
  }, [results, channels, isScanning, sources, concurrency, timeoutSecs, maxRetries, autoSaveBadges]);

  // Pause / Resume / Stop
  const handleTogglePause = useCallback(async () => {
    if (!activeSessionRef.current) return;
    if (isPaused) {
      await activeSessionRef.current.resume();
      setIsPaused(false);
    } else {
      await activeSessionRef.current.pause();
      setIsPaused(true);
    }
  }, [isPaused]);

  const handleCancelScan = useCallback(async () => {
    if (activeSessionRef.current) {
      await activeSessionRef.current.cancel();
      activeSessionRef.current = null;
    }
    setIsScanning(false);
    setIsPaused(false);
  }, []);

  // Close the modal; if a scan is running, ask whether to cancel it or run it in the background
  const handleRequestClose = useCallback(() => {
    if (isScanning) {
      setDialog({
        type: 'warning',
        title: t('probeInProgressTitle'),
        message: t('probeInProgressMsg'),
        cancelText: t('keepScanning'),
        middleText: t('runInBackground'),
        onMiddle: () => {
          setDialog(null);
          onClose();
        },
        confirmText: t('cancelProbeAndClose'),
        danger: true,
        onConfirm: async () => {
          await handleCancelScan();
          setDialog(null);
          onClose();
        },
      });
    } else {
      setDialog(null);
      onClose();
    }
  }, [isScanning, onClose, handleCancelScan, t]);

  // Cleanup on unmount or close
  useEffect(() => {
    return () => {
      if (activeSessionRef.current) {
        activeSessionRef.current.cancel();
        activeSessionRef.current = null;
      }
    };
  }, []);

  // Re-probe individual channel
  const handleReprobeChannel = useCallback(
    async (result: ProbeChannelResult) => {
      setReprobingStreamId(result.stream_id);
      try {
        const source = sources.find((s) => s.id === result.source_id);
        let streamUrl = result.url;
        let userAgent =
          source?.user_agent ||
          useSettingsStore.getState().globalLiveTvUserAgent ||
          'VLC/3.0.18 LibVLC/3.0.18';

        if (source?.type === 'stalker' || streamUrl.startsWith('stalker_') || streamUrl.startsWith('/media/')) {
          try {
            const resolved = await resolvePlayUrl(result.source_id, streamUrl);
            streamUrl = resolved.url;
            if (resolved.userAgent) userAgent = resolved.userAgent;
          } catch (e) {
            console.warn('[ChannelProbeModal] Failed to resolve play URL:', e);
          }
        }

        const probed = await probeSingleStream(streamUrl, userAgent, timeoutSecs);
        const updated: ProbeChannelResult = {
          ...result,
          ...probed,
          stream_id: result.stream_id,
          source_id: result.source_id,
          name: result.name,
          url: streamUrl,
          category_id: result.category_id,
          category_name: result.category_name,
        };

        setResults((prev) => prev.map((r) => (r.stream_id === result.stream_id ? updated : r)));

        if (autoSaveBadges && updated.status === 'alive') {
          await saveProbedMetadataToDb([updated]);
        }
      } catch (err) {
        console.error('[ChannelProbeModal] Single probe failed:', err);
      } finally {
        setReprobingStreamId(null);
      }
    },
    [sources, timeoutSecs, autoSaveBadges]
  );


  // Bulk disable dead channels
  const handleDisableDeadChannels = useCallback(() => {
    const deadStreamIds = results.filter((r) => r.status === 'dead').map((r) => r.stream_id);
    if (deadStreamIds.length === 0) {
      setDialog({
        type: 'info',
        title: t('noDeadChannels'),
        message: t('noDeadChannelsMsg'),
        confirmText: t('ok'),
      });
      return;
    }

    setDialog({
      type: 'warning',
      title: t('disableDeadTitle'),
      message: t('disableDeadMsg', { count: deadStreamIds.length }),
      confirmText: t('disableCount', { count: deadStreamIds.length }),
      cancelText: t('cancel'),
      danger: true,
      onConfirm: async () => {
        for (const id of deadStreamIds) {
          await db.channels.update(id, { enabled: false });
        }
        setDialog({
          type: 'success',
          title: t('channelsDisabled'),
          message: t('channelsDisabledMsg', { count: deadStreamIds.length }),
          confirmText: t('done'),
        });
      },
    });
  }, [results, t]);

  // Bulk re-enable alive channels
  const handleEnableAliveChannels = useCallback(() => {
    const aliveStreamIds = results.filter((r) => r.status === 'alive').map((r) => r.stream_id);
    if (aliveStreamIds.length === 0) {
      setDialog({
        type: 'info',
        title: t('noAliveChannels'),
        message: t('noAliveChannelsMsg'),
        confirmText: t('ok'),
      });
      return;
    }

    setDialog({
      type: 'confirm',
      title: t('reEnableTitle'),
      message: t('reEnableMsg', { count: aliveStreamIds.length }),
      confirmText: t('enableCount', { count: aliveStreamIds.length }),
      cancelText: t('cancel'),
      onConfirm: async () => {
        for (const id of aliveStreamIds) {
          await db.channels.update(id, { enabled: true });
        }
        setDialog({
          type: 'success',
          title: t('channelsReEnabled'),
          message: t('channelsReEnabledMsg', { count: aliveStreamIds.length }),
          confirmText: t('done'),
        });
      },
    });
  }, [results, t]);

  const [showExportModal, setShowExportModal] = useState<boolean>(false);

  // Export report with native Tauri dialog support and browser download fallback
  const executeExport = useCallback(
    async (format: 'json' | 'csv' | 'm3u') => {
      if (results.length === 0) return;

      const dateStr = new Date().toISOString().slice(0, 10);
      const defaultName = `channel_health_report_${dateStr}`;
      let content = '';

      if (format === 'json') {
        content = JSON.stringify({ summary, health: healthMetrics, channels: results }, null, 2);
        if (window.storage?.saveJsonFile) {
          const res = await window.storage.saveJsonFile(content, defaultName);
          if (res?.success && res.data?.filePath) {
            setDialog({
              type: 'success',
              title: t('reportExported'),
              message: t('reportSavedJson', { path: res.data.filePath }),
              confirmText: t('done'),
            });
            return;
          }
          if (res?.canceled) return;
        }
      } else if (format === 'csv') {
        const headers = ['Name', 'Status', 'Resolution', 'FPS', 'Video Codec', 'Audio Layout', 'Latency (ms)', 'Error', 'URL'];
        const rows = results.map((r) => [
          `"${(r.name || '').replace(/"/g, '""')}"`,
          r.status,
          r.quality_label || r.resolution || '',
          r.fps || '',
          r.video_codec || '',
          r.audio_channels || '',
          r.latency_ms ?? '',
          `"${(r.error_reason || '').replace(/"/g, '""')}"`,
          `"${(r.url || '').replace(/"/g, '""')}"`,
        ]);
        content = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
        if (window.storage?.saveCsvFile) {
          const res = await window.storage.saveCsvFile(content, defaultName);
          if (res?.success && res.data?.filePath) {
            setDialog({
              type: 'success',
              title: t('reportExported'),
              message: t('reportSavedCsv', { path: res.data.filePath }),
              confirmText: t('done'),
            });
            return;
          }
          if (res?.canceled) return;
        }
      } else if (format === 'm3u') {
        const aliveResults = results.filter((r) => r.status === 'alive');
        if (aliveResults.length === 0) {
          setDialog({
            type: 'info',
            title: t('noAliveChannels'),
            message: t('noAliveToExport'),
            confirmText: t('ok'),
          });
          return;
        }

        // Fetch full stored channels to ensure complete metadata
        const streamIds = aliveResults.map((r) => r.stream_id);
        const storedChannels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
        const storedMap = new Map(storedChannels.map((c) => [c.stream_id, c]));
        const categoryMap = new Map(categories.map((cat) => [cat.category_id, cat.category_name]));
        const sourcesMap = new Map(sources.map((s) => [s.id, s]));

        // Check if there is an EPG URL to attach to header
        let headerTvgUrl = '';
        if (selectedSourceIds.length === 1) {
          const src = sourcesMap.get(selectedSourceIds[0]);
          if (src?.epg_url) {
            headerTvgUrl = src.epg_url;
          } else if (src?.type === 'xtream' && src.username && src.password && src.url) {
            const baseUrl = src.url.replace(/\/$/, '');
            headerTvgUrl = `${baseUrl}/xmltv.php?username=${encodeURIComponent(src.username)}&password=${encodeURIComponent(src.password)}`;
          }
        }

        const lines: string[] = [];
        if (headerTvgUrl) {
          lines.push(`#EXTM3U x-tvg-url="${headerTvgUrl}" url-tvg="${headerTvgUrl}"`);
        } else {
          lines.push('#EXTM3U');
        }

        for (const res of aliveResults) {
          const stored = storedMap.get(res.stream_id);
          const channelName = (stored?.alias || stored?.name || res.name || 'Unnamed Channel').replace(/,/g, '');
          const tvgId = stored?.epg_channel_id || stored?.xmltv_id || '';
          const tvgLogo = stored?.stream_icon || '';
          const groupTitle =
            res.category_name ||
            (stored?.category_ids?.[0] ? categoryMap.get(stored.category_ids[0]) : '') ||
            stored?.source_category_display ||
            '';

          // Build EXTINF tag with all original and enriched metadata attributes
          let extinf = `#EXTINF:-1`;
          if (tvgId) extinf += ` tvg-id="${tvgId.replace(/"/g, "'")}"`;
          if (channelName) extinf += ` tvg-name="${channelName.replace(/"/g, "'")}"`;
          if (tvgLogo) extinf += ` tvg-logo="${tvgLogo.replace(/"/g, "'")}"`;
          if (stored?.channel_num !== undefined && stored.channel_num !== null) {
            extinf += ` tvg-chno="${stored.channel_num}"`;
          }
          if (groupTitle) extinf += ` group-title="${groupTitle.replace(/"/g, "'")}"`;

          // Catchup / Archive metadata
          if (stored?.catchup_type) {
            extinf += ` catchup="${stored.catchup_type}"`;
          } else if (stored?.tv_archive) {
            extinf += ` catchup="default"`;
          }

          if (stored?.catchup_days) {
            extinf += ` catchup-days="${stored.catchup_days}"`;
          } else if (stored?.tv_archive_duration) {
            extinf += ` catchup-days="${Math.round(stored.tv_archive_duration / 24)}"`;
          }

          if (stored?.catchup_source) {
            extinf += ` catchup-source="${stored.catchup_source}"`;
          }

          extinf += `,${stored?.alias || stored?.name || res.name}`;
          lines.push(extinf);

          // Provider User-Agent if needed
          const source = sourcesMap.get(stored?.source_id || res.source_id);
          if (source?.user_agent) {
            lines.push(`#EXTVLCOPT:http-user-agent=${source.user_agent}`);
          }

          // Direct playable stream URL
          lines.push(res.url || stored?.direct_url || '');
        }

        content = lines.join('\n');
        if (window.storage?.saveM3UFile) {
          const res = await window.storage.saveM3UFile(content, defaultName);
          if (res?.success && res.data?.filePath) {
            setDialog({
              type: 'success',
              title: t('reportExported'),
              message: t('reportSavedM3u', { count: aliveResults.length, path: res.data.filePath }),
              confirmText: t('done'),
            });
            return;
          }
          if (res?.canceled) return;
        }
      }

      // Browser download fallback
      try {
        const mimeType = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain';
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `${defaultName}.${format}`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 300);

        setDialog({
          type: 'success',
          title: t('reportDownloaded'),
          message: t('reportDownloadedMsg', { format: format.toUpperCase() }),
          confirmText: t('done'),
        });
      } catch (e) {
        console.error('[ChannelProbeModal] Failed to download report:', e);
      }
    },
    [results, summary, healthMetrics, t]
  );

  // Play preview
  const handlePlayPreview = useCallback(
    async (result: ProbeChannelResult) => {
      if (onPlayChannel) {
        const found = channels.find((c) => c.stream_id === result.stream_id);
        if (found) {
          onPlayChannel(found);
          onClose();
          return;
        }
      }

      // Default stream resolve & fallback
      try {
        const resolved = await resolvePlayUrl(result.source_id, result.url);
        window.open(resolved.url, '_blank');
      } catch (err) {
        console.error('[ChannelProbeModal] Failed to preview channel:', err);
      }
    },
    [channels, onPlayChannel, onClose]
  );

  // Filtered results
  const filteredResults = useMemo(() => {
    return results.filter((r) => {
      // Tab filter
      if (activeTab === 'alive' && r.status !== 'alive') return false;
      if (activeTab === 'dead' && r.status !== 'dead') return false;
      if (activeTab === 'geoblocked' && r.status !== 'geoblocked') return false;
      if (activeTab === 'drm' && r.status !== 'drm') return false;
      if (activeTab === '4k' && r.quality_label !== '4K') return false;
      if (activeTab === '1080p' && r.quality_label !== '1080p') return false;
      if (activeTab === '720p' && r.quality_label !== '720p') return false;
      if (activeTab === 'sd' && r.quality_label !== 'SD') return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = r.name.toLowerCase().includes(q);
        const matchCat = (r.category_name || '').toLowerCase().includes(q);
        const matchRes = (r.quality_label || r.resolution || '').toLowerCase().includes(q);
        const matchCodec = (r.video_codec || '').toLowerCase().includes(q);
        if (!matchName && !matchCat && !matchRes && !matchCodec) return false;
      }

      return true;
    });
  }, [results, activeTab, searchQuery]);

  // Column Sort Handler
  const handleSort = useCallback((col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(col);
      setSortDirection('asc');
    }
  }, [sortColumn]);

  // Sorted Results
  const sortedResults = useMemo(() => {
    if (!sortColumn) return filteredResults;

    const qualityRank: Record<string, number> = {
      '4K': 4,
      '1080p': 3,
      '720p': 2,
      SD: 1,
    };

    const statusRank: Record<string, number> = {
      alive: 1,
      geoblocked: 2,
      drm: 3,
      dead: 4,
    };

    return [...filteredResults].sort((a, b) => {
      let valA: any;
      let valB: any;

      switch (sortColumn) {
        case 'status':
          valA = statusRank[a.status] || 99;
          valB = statusRank[b.status] || 99;
          break;
        case 'name':
          valA = (a.name || '').toLowerCase();
          valB = (b.name || '').toLowerCase();
          break;
        case 'quality':
          valA = qualityRank[a.quality_label || ''] || 0;
          valB = qualityRank[b.quality_label || ''] || 0;
          break;
        case 'fps':
          valA = a.fps ?? -1;
          valB = b.fps ?? -1;
          break;
        case 'video_codec':
          valA = (a.video_codec || '').toLowerCase();
          valB = (b.video_codec || '').toLowerCase();
          break;
        case 'audio_channels':
          valA = (a.audio_channels || '').toLowerCase();
          valB = (b.audio_channels || '').toLowerCase();
          break;
        case 'latency_ms':
          valA = a.latency_ms ?? 999999;
          valB = b.latency_ms ?? 999999;
          break;
        default:
          return 0;
      }

      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredResults, sortColumn, sortDirection]);

  if (!isOpen) return null;

  const totalScanned = results.length;
  const aliveCount = results.filter((r) => r.status === 'alive').length;
  const deadCount = results.filter((r) => r.status === 'dead').length;
  const geoCount = results.filter((r) => r.status === 'geoblocked').length;
  const drmCount = results.filter((r) => r.status === 'drm').length;
  const uhdCount = results.filter((r) => r.quality_label === '4K').length;
  const fhdCount = results.filter((r) => r.quality_label === '1080p').length;
  const hdCount = results.filter((r) => r.quality_label === '720p').length;
  const sdCount = results.filter((r) => r.quality_label === 'SD').length;

  const progressPercent = progress ? Math.min(100, Math.round((progress.current / Math.max(1, progress.total)) * 100)) : 0;

  return (
    <div className="cpm-overlay" onClick={handleRequestClose}>
      <div className="cpm-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="cpm-header">
          <div className="cpm-header-left">
            <div className="cpm-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <circle cx="12" cy="12" r="2" />
                <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
              </svg>
            </div>
            <div className="cpm-title-wrap">
              <h2>
                {t('title')}
                {ffmpegStatus?.available && (
                  <span className="cpm-channels-count-badge" style={{ backgroundColor: 'rgba(34, 197, 94, 0.12)', color: '#4ade80', borderColor: 'rgba(34, 197, 94, 0.3)' }}>
                    {t('ffmpegActive')}
                  </span>
                )}
              </h2>
              <p className="cpm-subtitle">{t('subtitle')}</p>
            </div>
          </div>
          <button className="cpm-close-btn" onClick={handleRequestClose} title={t('close')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Controls Bar */}
        <div className="cpm-controls-bar">
          <div className="cpm-selectors-row">
            {/* Source Multi-Select */}
            <div className="cpm-select-group cpm-popover-anchor">
              <label>{t('sourcePlaylists')}</label>
              <button
                type="button"
                className="cpm-multi-select-btn"
                disabled={isScanning}
                onClick={() => {
                  setIsSourcePopoverOpen((prev) => !prev);
                  setIsCategoryPopoverOpen(false);
                }}
              >
                <span className="cpm-multi-select-label">
                  {selectedSourceIds.length === 0
                    ? t('allPlaylists', { count: sources.length })
                    : selectedSourceIds.length === 1
                    ? sources.find((s) => s.id === selectedSourceIds[0])?.name || t('onePlaylist')
                    : t('manyPlaylists', { count: selectedSourceIds.length })}
                </span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {isSourcePopoverOpen && (
                <div className="cpm-multi-popover">
                  <div className="cpm-popover-search">
                    <input
                      type="text"
                      placeholder={t('searchPlaylists')}
                      value={sourceSearch}
                      onChange={(e) => setSourceSearch(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="cpm-popover-actions">
                    <button
                      type="button"
                      className="cpm-popover-action-btn"
                      onClick={() => setSelectedSourceIds([])}
                    >
                      {t('all')}
                    </button>
                    <button
                      type="button"
                      className="cpm-popover-action-btn"
                      onClick={() => setSelectedSourceIds(sources.map((s) => s.id))}
                    >
                      {t('selectAll')}
                    </button>
                    <button
                      type="button"
                      className="cpm-popover-action-btn"
                      onClick={() => setSelectedSourceIds([])}
                    >
                      {t('clear')}
                    </button>
                  </div>
                  <div className="cpm-popover-list">
                    {sources
                      .filter((s) => s.name.toLowerCase().includes(sourceSearch.toLowerCase()))
                      .map((s) => {
                        const isChecked = selectedSourceIds.includes(s.id);
                        return (
                          <label key={s.id} className="cpm-popover-item">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {
                                if (isChecked) {
                                  setSelectedSourceIds(selectedSourceIds.filter((id) => id !== s.id));
                                } else {
                                  setSelectedSourceIds([...selectedSourceIds, s.id]);
                                }
                              }}
                            />
                            <span>{s.name}</span>
                          </label>
                        );
                      })}
                  </div>
                  <div className="cpm-popover-footer">
                    <button
                      type="button"
                      className="cpm-btn cpm-btn-primary"
                      style={{ width: '100%', padding: '6px 12px' }}
                      onClick={() => setIsSourcePopoverOpen(false)}
                    >
                      {t('done')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Category Multi-Select */}
            <div className="cpm-select-group cpm-popover-anchor">
              <label>{t('categories')}</label>
              <button
                type="button"
                className="cpm-multi-select-btn"
                disabled={isScanning}
                onClick={() => {
                  setIsCategoryPopoverOpen((prev) => !prev);
                  setIsSourcePopoverOpen(false);
                }}
              >
                <span className="cpm-multi-select-label">
                  {selectedCategoryIds.length === 0
                    ? t('allCategories', { count: categories.length })
                    : selectedCategoryIds.length === 1
                    ? categories.find((c) => c.category_id === selectedCategoryIds[0])?.category_name || t('oneCategory')
                    : t('manyCategories', { count: selectedCategoryIds.length })}
                </span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {isCategoryPopoverOpen && (
                <div className="cpm-multi-popover">
                  <div className="cpm-popover-search">
                    <input
                      type="text"
                      placeholder={t('searchCategories')}
                      value={categorySearch}
                      onChange={(e) => setCategorySearch(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="cpm-popover-actions">
                    <button
                      type="button"
                      className="cpm-popover-action-btn"
                      onClick={() => setSelectedCategoryIds([])}
                    >
                      {t('all')}
                    </button>
                    <button
                      type="button"
                      className="cpm-popover-action-btn"
                      onClick={() => setSelectedCategoryIds(categories.map((c) => c.category_id))}
                    >
                      {t('selectAll')}
                    </button>
                    <button
                      type="button"
                      className="cpm-popover-action-btn"
                      onClick={() => setSelectedCategoryIds([])}
                    >
                      {t('clear')}
                    </button>
                  </div>
                  <div className="cpm-popover-list">
                    {categories
                      .filter((c) => c.category_name.toLowerCase().includes(categorySearch.toLowerCase()))
                      .map((c) => {
                        const isChecked = selectedCategoryIds.includes(c.category_id);
                        return (
                          <label key={c.category_id} className="cpm-popover-item">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {
                                if (isChecked) {
                                  setSelectedCategoryIds(selectedCategoryIds.filter((id) => id !== c.category_id));
                                } else {
                                  setSelectedCategoryIds([...selectedCategoryIds, c.category_id]);
                                }
                              }}
                            />
                            <span>{c.category_name}</span>
                            {c.channel_count !== undefined && (
                              <span className="cpm-popover-count">({c.channel_count})</span>
                            )}
                          </label>
                        );
                      })}
                  </div>
                  <div className="cpm-popover-footer">
                    <button
                      type="button"
                      className="cpm-btn cpm-btn-primary"
                      style={{ width: '100%', padding: '6px 12px' }}
                      onClick={() => setIsCategoryPopoverOpen(false)}
                    >
                      {t('done')}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Scope Filter */}
            <div className="cpm-select-group">
              <label>{t('targetChannels')}</label>
              <select
                className="cpm-select"
                value={scopeFilter}
                disabled={isScanning}
                onChange={(e) => setScopeFilter(e.target.value as ScopeFilter)}
              >
                <option value="enabled">{t('scopeEnabled')}</option>
                <option value="missing-badges">{t('scopeMissingBadges')}</option>
                <option value="dead-only">{t('scopeDeadOnly')}</option>
                <option value="all-including-dead">{t('scopeAll')}</option>
              </select>
            </div>

            {/* Actions button group */}
            <div className="cpm-actions-group">
              <span className="cpm-channels-count-badge">{t('channelsCount', { count: channels.length })}</span>
              {!isScanning ? (
                <>
                  <button
                    className="cpm-btn cpm-btn-primary"
                    disabled={channels.length === 0}
                    onClick={handleStartProbe}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    {t('startProbe')}
                  </button>
                  {deadCount > 0 && results.length > 0 && (
                    <button
                      className="cpm-btn cpm-btn-secondary"
                      onClick={handleRerunDeadStreams}
                      title={t('rerunDeadTitle')}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19" />
                      </svg>
                      {t('rerunDead', { count: deadCount })}
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button className="cpm-btn cpm-btn-secondary" onClick={handleTogglePause}>
                    {isPaused ? (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        {t('resume')}
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" />
                          <rect x="14" y="4" width="4" height="16" />
                        </svg>
                        {t('pause')}
                      </>
                    )}
                  </button>
                  <button className="cpm-btn cpm-btn-danger" onClick={handleCancelScan}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="2" />
                    </svg>
                    {t('stop')}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Config options row */}
          <div className="cpm-options-row">
            <div className="cpm-options-left">
              <label className="cpm-option-item">
                <input
                  type="checkbox"
                  checked={autoSaveBadges}
                  onChange={(e) => setAutoSaveBadges(e.target.checked)}
                />
                {t('autoSaveBadges')}
              </label>

              <div
                className="cpm-slider-item"
                title={concurrency > 1 ? t('concurrencyWarning') : t('concurrencySafe')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>{t('concurrencyLabel', { count: concurrency })}</span>
                  {concurrency > 1 && (
                    <span className="cpm-warning-badge" title={t('concurrencyWarning')}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                      {t('concurrencySlots', { count: concurrency })}
                    </span>
                  )}
                </div>
                <input
                  type="range"
                  min="1"
                  max="5"
                  disabled={isScanning}
                  value={concurrency}
                  onChange={(e) => setConcurrency(parseInt(e.target.value, 10))}
                />
              </div>

              <div className="cpm-slider-item">
                <span>{t('timeoutLabel', { count: timeoutSecs })}</span>
                <input
                  type="range"
                  min="3"
                  max="15"
                  disabled={isScanning}
                  value={timeoutSecs}
                  onChange={(e) => setTimeoutSecs(parseInt(e.target.value, 10))}
                />
              </div>

              <div className="cpm-slider-item">
                <span>{maxRetries === 0 ? t('maxRetriesOff') : t('maxRetriesOn', { count: maxRetries })}</span>
                <input
                  type="range"
                  min="0"
                  max="5"
                  disabled={isScanning}
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(parseInt(e.target.value, 10))}
                  title={t('retryTitle')}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Dashboard: Progress & Scoreboard */}
        <div className="cpm-dashboard">
          {/* Progress Bar (visible during or after scan) */}
          {(isScanning || progress || summary) && (
            <div className="cpm-progress-container">
              <div className="cpm-progress-meta">
                <div className="cpm-progress-status">
                  <span>{isScanning ? (isPaused ? t('probePaused') : t('probing')) : t('probeCompleted')}</span>
                  {progress?.active_stream_name && isScanning && (
                    <span className="cpm-active-stream-chip" title={progress.active_stream_name}>
                      {progress.active_stream_name}
                    </span>
                  )}
                </div>
                <div className="cpm-progress-stats">
                  {t('progressCount', { current: progress?.current ?? totalScanned, total: progress?.total ?? channels.length, percent: progressPercent })}
                  {' • '}
                  {t('chPerSec', { count: progress?.channels_per_sec ?? 0 })}
                  {progress?.eta_secs != null && ` • ${t('eta', { count: progress.eta_secs })}`}
                </div>
              </div>
              <div className="cpm-progress-track">
                <div className="cpm-progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {/* Metrics & Health Score Row */}
          <div className="cpm-metrics-row">
            {/* Scorecard */}
            <div className="cpm-score-card">
              <div
                className="cpm-score-circle"
                style={{
                  borderColor:
                    healthMetrics.overall >= 8
                      ? '#4ade80'
                      : healthMetrics.overall >= 5
                      ? '#facc15'
                      : '#f87171',
                }}
              >
                <span className="cpm-score-num">{healthMetrics.overall}</span>
                <span className="cpm-score-denom">/10</span>
              </div>
              <div className="cpm-score-details">
                <span className="cpm-score-label">{t('healthScore')}</span>
                <span className="cpm-score-grade">{healthMetrics.statusLabel}</span>
              </div>
            </div>

            {/* Status Grid */}
            <div className="cpm-status-grid">
              <div className="cpm-status-card alive">
                <span className="cpm-status-card-header">{t('alive')}</span>
                <span className="cpm-status-card-val">{aliveCount}</span>
              </div>
              <div className="cpm-status-card dead">
                <span className="cpm-status-card-header">{t('dead')}</span>
                <span className="cpm-status-card-val">{deadCount}</span>
              </div>
              <div className="cpm-status-card geoblocked">
                <span className="cpm-status-card-header">{t('geoblocked')}</span>
                <span className="cpm-status-card-val">{geoCount}</span>
              </div>
              <div className="cpm-status-card drm">
                <span className="cpm-status-card-header">{t('drm')}</span>
                <span className="cpm-status-card-val">{drmCount}</span>
              </div>
            </div>

            {/* Quality Breakdown */}
            <div className="cpm-quality-grid">
              <div className="cpm-quality-card">
                <span className="cpm-quality-card-header">{t('quality4k')}</span>
                <span className="cpm-quality-card-val">{uhdCount}</span>
              </div>
              <div className="cpm-quality-card">
                <span className="cpm-quality-card-header">{t('quality1080p')}</span>
                <span className="cpm-quality-card-val">{fhdCount}</span>
              </div>
              <div className="cpm-quality-card">
                <span className="cpm-quality-card-header">{t('quality720p')}</span>
                <span className="cpm-quality-card-val">{hdCount}</span>
              </div>
              <div className="cpm-quality-card">
                <span className="cpm-quality-card-header">{t('qualitySd')}</span>
                <span className="cpm-quality-card-val">{sdCount}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Results Area */}
        <div className="cpm-table-area">
          <div className="cpm-table-filter-bar">
            <div className="cpm-tabs-list">
              <button
                className={`cpm-tab-btn ${activeTab === 'all' ? 'active' : ''}`}
                onClick={() => setActiveTab('all')}
              >
                {t('tabAll', { count: results.length })}
              </button>
              <button
                className={`cpm-tab-btn ${activeTab === 'alive' ? 'active' : ''}`}
                onClick={() => setActiveTab('alive')}
              >
                {t('tabAlive', { count: aliveCount })}
              </button>
              <button
                className={`cpm-tab-btn ${activeTab === 'dead' ? 'active' : ''}`}
                onClick={() => setActiveTab('dead')}
              >
                {t('tabDead', { count: deadCount })}
              </button>
              <button
                className={`cpm-tab-btn ${activeTab === 'geoblocked' ? 'active' : ''}`}
                onClick={() => setActiveTab('geoblocked')}
              >
                {t('tabGeoblocked', { count: geoCount })}
              </button>
              <button
                className={`cpm-tab-btn ${activeTab === 'drm' ? 'active' : ''}`}
                onClick={() => setActiveTab('drm')}
              >
                {t('tabDrm', { count: drmCount })}
              </button>
              <button
                className={`cpm-tab-btn ${activeTab === '4k' ? 'active' : ''}`}
                onClick={() => setActiveTab('4k')}
              >
                {t('tab4k', { count: uhdCount })}
              </button>
              <button
                className={`cpm-tab-btn ${activeTab === '1080p' ? 'active' : ''}`}
                onClick={() => setActiveTab('1080p')}
              >
                {t('tab1080p', { count: fhdCount })}
              </button>
              <button
                className={`cpm-tab-btn ${activeTab === '720p' ? 'active' : ''}`}
                onClick={() => setActiveTab('720p')}
              >
                {t('tab720p', { count: hdCount })}
              </button>
              <button
                className={`cpm-tab-btn ${activeTab === 'sd' ? 'active' : ''}`}
                onClick={() => setActiveTab('sd')}
              >
                {t('tabSd', { count: sdCount })}
              </button>
            </div>

            <div className="cpm-search-input-wrap">
              <svg className="cpm-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                className="cpm-search-input"
                placeholder={t('searchResults')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="cpm-table-scroll">
            {sortedResults.length > 0 ? (
              <table className="cpm-table">
                <thead>
                  <tr>
                    <th className="cpm-th-sortable" onClick={() => handleSort('status')} style={{ width: '110px' }}>
                      <div className="cpm-th-content">
                        <span>{t('colStatus')}</span>
                        <SortIcon active={sortColumn === 'status'} direction={sortDirection} />
                      </div>
                    </th>
                    <th className="cpm-th-sortable" onClick={() => handleSort('name')}>
                      <div className="cpm-th-content">
                        <span>{t('colChannel')}</span>
                        <SortIcon active={sortColumn === 'name'} direction={sortDirection} />
                      </div>
                    </th>
                    <th className="cpm-th-sortable" onClick={() => handleSort('quality')} style={{ width: '90px' }}>
                      <div className="cpm-th-content">
                        <span>{t('colQuality')}</span>
                        <SortIcon active={sortColumn === 'quality'} direction={sortDirection} />
                      </div>
                    </th>
                    <th className="cpm-th-sortable" onClick={() => handleSort('fps')} style={{ width: '75px' }}>
                      <div className="cpm-th-content">
                        <span>{t('colFps')}</span>
                        <SortIcon active={sortColumn === 'fps'} direction={sortDirection} />
                      </div>
                    </th>
                    <th className="cpm-th-sortable" onClick={() => handleSort('video_codec')} style={{ width: '90px' }}>
                      <div className="cpm-th-content">
                        <span>{t('colVideo')}</span>
                        <SortIcon active={sortColumn === 'video_codec'} direction={sortDirection} />
                      </div>
                    </th>
                    <th className="cpm-th-sortable" onClick={() => handleSort('audio_channels')} style={{ width: '85px' }}>
                      <div className="cpm-th-content">
                        <span>{t('colAudio')}</span>
                        <SortIcon active={sortColumn === 'audio_channels'} direction={sortDirection} />
                      </div>
                    </th>
                    <th className="cpm-th-sortable" onClick={() => handleSort('latency_ms')} style={{ width: '85px' }}>
                      <div className="cpm-th-content">
                        <span>{t('colLatency')}</span>
                        <SortIcon active={sortColumn === 'latency_ms'} direction={sortDirection} />
                      </div>
                    </th>
                    <th style={{ width: '130px' }}>{t('colDiagnostic')}</th>
                    <th style={{ width: '110px', textAlign: 'right' }}>{t('colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.map((res) => {
                    const quality = res.quality_label || res.resolution;
                    return (
                      <tr key={res.stream_id}>
                        <td>
                          <span className={`cpm-status-pill ${res.status}`}>
                            <span className="cpm-status-dot" />
                            {res.status}
                          </span>
                        </td>
                        <td>
                          <div className="cpm-channel-cell">
                            <span className="cpm-channel-name">{res.name}</span>
                            {res.category_name && (
                              <span className="cpm-channel-category">{res.category_name}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          {quality ? (
                            <span
                              className={`cpm-quality-badge ${
                                quality === '4K'
                                  ? 'uhd4k'
                                  : quality === '1080p'
                                  ? 'fhd1080'
                                  : quality === '720p'
                                  ? 'hd720'
                                  : 'sd'
                              }`}
                            >
                              {quality}
                            </span>
                          ) : (
                            <span className="cpm-badge-muted">-</span>
                          )}
                        </td>
                        <td>
                          {res.fps ? (
                            <span>{t('fpsValue', { count: Math.round(res.fps) })}</span>
                          ) : (
                            <span className="cpm-badge-muted">-</span>
                          )}
                        </td>
                        <td>
                          {res.video_codec ? (
                            <span>{res.video_codec}</span>
                          ) : (
                            <span className="cpm-badge-muted">-</span>
                          )}
                        </td>
                        <td>
                          {res.audio_channels ? (
                            <span>{res.audio_channels}</span>
                          ) : (
                            <span className="cpm-badge-muted">-</span>
                          )}
                        </td>
                        <td>
                          {res.latency_ms != null ? (
                            <span>{t('msValue', { count: res.latency_ms })}</span>
                          ) : (
                            <span className="cpm-badge-muted">-</span>
                          )}
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: '0.72rem',
                              color: res.error_reason ? '#f87171' : '#94a3b8',
                              maxWidth: '180px',
                              display: 'inline-block',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                            title={res.error_reason || 'OK'}
                          >
                            {res.error_reason || t('ok')}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <div className="cpm-row-actions" style={{ justifyContent: 'flex-end' }}>
                            <button
                              className="cpm-row-btn"
                              onClick={() => handlePlayPreview(res)}
                              title={t('playPreview')}
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                                <polygon points="5 3 19 12 5 21 5 3" />
                              </svg>
                            </button>
                            <button
                              className="cpm-row-btn"
                              disabled={reprobingStreamId === res.stream_id}
                              onClick={() => handleReprobeChannel(res)}
                              title={t('reprobeChannel')}
                            >
                              {reprobingStreamId === res.stream_id ? (
                                '...'
                              ) : (
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19" />
                                </svg>
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="cpm-empty-state">
                <svg className="cpm-empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>
                  {results.length === 0
                    ? t('emptyStartProbe')
                    : t('emptyNoResults')}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Footer Toolbar */}
        <div className="cpm-footer">
          <div className="cpm-footer-left">
            <span>
              {results.length > 0
                ? t('footerAliveDead', { alive: aliveCount, percent: Math.round((aliveCount / Math.max(1, results.length)) * 100), dead: deadCount })
                : t('footerReady', { count: channels.length })}
            </span>
          </div>

          <div className="cpm-footer-right">
            {results.length > 0 && (
              <>
                {aliveCount > 0 && (scopeFilter === 'dead-only' || scopeFilter === 'all-including-dead') && (
                  <button className="cpm-btn cpm-btn-secondary" onClick={handleEnableAliveChannels}>
                    {t('reEnableAlive', { count: aliveCount })}
                  </button>
                )}
                {deadCount > 0 && (
                  <button className="cpm-btn cpm-btn-secondary" onClick={handleRerunDeadStreams}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19" />
                    </svg>
                    {t('rerunDead', { count: deadCount })}
                  </button>
                )}
                {deadCount > 0 && (
                  <button className="cpm-btn cpm-btn-secondary" onClick={handleDisableDeadChannels}>
                    {t('disableDead', { count: deadCount })}
                  </button>
                )}
                <button className="cpm-btn cpm-btn-secondary" onClick={() => setShowExportModal(true)}>
                  {t('exportReport')}
                </button>
              </>
            )}
            <button className="cpm-btn cpm-btn-primary" onClick={handleRequestClose}>
              {t('done')}
            </button>
          </div>
        </div>

        {/* Export Report Format Dialog */}
        {showExportModal && (
          <div className="cpm-dialog-overlay" onClick={() => setShowExportModal(false)}>
            <div className="cpm-dialog-card" onClick={(e) => e.stopPropagation()}>
              <div className="cpm-dialog-header">
                <div className="cpm-dialog-icon info">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
                <h3 className="cpm-dialog-title">{t('exportTitle')}</h3>
              </div>
              <p className="cpm-dialog-message">
                {t('exportMessage')}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', margin: '8px 0' }}>
                <button
                  className="cpm-btn cpm-btn-secondary"
                  style={{ justifyContent: 'flex-start', padding: '10px 14px', textAlign: 'left' }}
                  onClick={() => {
                    setShowExportModal(false);
                    executeExport('csv');
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" strokeWidth="2" style={{ flexShrink: 0 }}>
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="8" y1="13" x2="16" y2="13" />
                      <line x1="8" y1="17" x2="16" y2="17" />
                      <line x1="10" y1="9" x2="8" y2="9" />
                    </svg>
                    <div>
                      <strong>{t('exportCsv')}</strong>
                      <div style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: '2px' }}>
                        {t('exportCsvSub')}
                      </div>
                    </div>
                  </div>
                </button>
                <button
                  className="cpm-btn cpm-btn-secondary"
                  style={{ justifyContent: 'flex-start', padding: '10px 14px', textAlign: 'left' }}
                  onClick={() => {
                    setShowExportModal(false);
                    executeExport('json');
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" style={{ flexShrink: 0 }}>
                      <polyline points="16 18 22 12 16 6" />
                      <polyline points="8 6 2 12 8 18" />
                    </svg>
                    <div>
                      <strong>{t('exportJson')}</strong>
                      <div style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: '2px' }}>
                        {t('exportJsonSub')}
                      </div>
                    </div>
                  </div>
                </button>
                <button
                  className="cpm-btn cpm-btn-secondary"
                  style={{ justifyContent: 'flex-start', padding: '10px 14px', textAlign: 'left' }}
                  onClick={() => {
                    setShowExportModal(false);
                    executeExport('m3u');
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" style={{ flexShrink: 0 }}>
                      <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                      <polyline points="17 2 12 7 7 2" />
                    </svg>
                    <div>
                      <strong>{t('exportM3u')}</strong>
                      <div style={{ fontSize: '0.74rem', color: '#94a3b8', marginTop: '2px' }}>
                        {t('exportM3uSub')}
                      </div>
                    </div>
                  </div>
                </button>
              </div>
              <div className="cpm-dialog-actions">
                <button className="cpm-btn cpm-btn-secondary" onClick={() => setShowExportModal(false)}>
                  {t('cancel')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* In-Modal Confirmation / Info Dialog */}
        {dialog && (
          <div className="cpm-dialog-overlay" onClick={() => setDialog(null)}>
            <div className="cpm-dialog-card" onClick={(e) => e.stopPropagation()}>
              <div className="cpm-dialog-header">
                <div className={`cpm-dialog-icon ${dialog.type}`}>
                  {dialog.type === 'success' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  {dialog.type === 'warning' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  )}
                  {dialog.type === 'info' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  )}
                  {dialog.type === 'confirm' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                    </svg>
                  )}
                </div>
                <h3 className="cpm-dialog-title">{dialog.title}</h3>
              </div>
              <p className="cpm-dialog-message">{dialog.message}</p>
              <div className="cpm-dialog-actions">
                {dialog.cancelText && (
                  <button
                    className="cpm-btn cpm-btn-secondary"
                    onClick={() => setDialog(null)}
                  >
                    {dialog.cancelText}
                  </button>
                )}
                {dialog.middleText && dialog.onMiddle && (
                  <button
                    className="cpm-btn cpm-btn-secondary"
                    onClick={async () => {
                      await dialog.onMiddle?.();
                    }}
                  >
                    {dialog.middleText}
                  </button>
                )}
                <button
                  className={`cpm-btn ${dialog.danger ? 'cpm-btn-danger' : 'cpm-btn-primary'}`}
                  onClick={async () => {
                    if (dialog.onConfirm) {
                      await dialog.onConfirm();
                    } else {
                      setDialog(null);
                    }
                  }}
                >
                  {dialog.confirmText || 'OK'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
