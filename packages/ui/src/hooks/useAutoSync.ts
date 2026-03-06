import { useEffect, useRef } from 'react';
import { syncSource, syncVodForSource, isEpgStale, isVodStale } from '../db/sync';
import { bulkOps } from '../services/bulk-ops';
import {
    useSetChannelSyncing,
    useSetVodSyncing,
    useSetChannelSortOrder,
    useSetSyncStatusMessage,
} from '../stores/uiStore';

interface AutoSyncSettings {
    onShortcutsLoaded?: (shortcuts: Record<string, string>) => void;
    onThemeLoaded?: (theme: string) => void;
    onSidebarVisibilityLoaded?: (visible: boolean) => void;
    onFontSizeLoaded?: (channelSize?: number, categorySize?: number) => void;
}

// Check interval: 10 minutes
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Runs the startup sync check once on mount:
 *   - Reads user settings (shortcuts, theme, font sizes)
 *   - Syncs stale channel/EPG sources in batches
 *   - Syncs stale VOD sources for Xtream sources
 *   - Periodically checks (every 10 min) if sources need refreshing based on Data Refresh settings
 *
 * Extracted from App.tsx lines ~1015-1157.
 */
export function useAutoSync(callbacks: AutoSyncSettings = {}) {
    const setChannelSyncing = useSetChannelSyncing();
    const setVodSyncing = useSetVodSyncing();
    const setChannelSortOrder = useSetChannelSortOrder();
    const setSyncStatusMessage = useSetSyncStatusMessage();

    // Refs to track state across renders and intervals
    const isSyncingRef = useRef(false);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // Store latest setters in refs to avoid dependency issues
    const settersRef = useRef({
        setChannelSyncing,
        setVodSyncing,
        setSyncStatusMessage,
    });

    // Keep refs updated with latest setters
    useEffect(() => {
        settersRef.current = {
            setChannelSyncing,
            setVodSyncing,
            setSyncStatusMessage,
        };
    }, [setChannelSyncing, setVodSyncing, setSyncStatusMessage]);

    useEffect(() => {
        // Helper to set syncing state both in React and ref
        const setSyncingState = (syncing: boolean) => {
            isSyncingRef.current = syncing;
            settersRef.current.setChannelSyncing(syncing);
        };

        // Perform periodic check for stale sources
        const checkAndSyncStaleSources = async () => {
            // Skip if already syncing
            if (isSyncingRef.current) {
                console.log('[AutoSync] Periodic check skipped - sync already in progress');
                return;
            }

            if (!window.storage) return;

            try {
                const result = await window.storage.getSources();
                if (!result.data || result.data.length === 0) return;

                const settingsResult = await window.storage.getSettings();
                const epgRefreshHours = settingsResult.data?.epgRefreshHours ?? 6;
                const vodRefreshHours = settingsResult.data?.vodRefreshHours ?? 24;

                // Skip if both are manual-only (0 = manual only)
                if (epgRefreshHours === 0 && vodRefreshHours === 0) {
                    return;
                }

                let hasSynced = false;

                // ── Channel / EPG sync ──────────────────────────────────────────────
                if (epgRefreshHours > 0) {
                    const enabledSources = result.data.filter((s: any) => s.enabled && !s.vod_only);
                    const staleSources: any[] = [];
                    for (const source of enabledSources) {
                        if (await isEpgStale(source.id, epgRefreshHours)) staleSources.push(source);
                    }

                    if (staleSources.length > 0) {
                        console.log(`[AutoSync] Periodic check: ${staleSources.length} stale EPG sources found`);
                        setSyncingState(true);
                        hasSynced = true;
                        const CONCURRENCY = 10;
                        const total = staleSources.length;
                        for (let i = 0; i < total; i += CONCURRENCY) {
                            const batch = staleSources.slice(i, i + CONCURRENCY);
                            const batchNum = Math.floor(i / CONCURRENCY) + 1;
                            const totalBatches = Math.ceil(total / CONCURRENCY);
                            settersRef.current.setSyncStatusMessage(`Auto-syncing batch ${batchNum}/${totalBatches}: ${batch.map((s: any) => s.name).join(', ')}`);
                            await Promise.all(
                                batch.map(async (source: any, idx: number) => {
                                    const prefix = `[${i + idx + 1}/${total}] ${source.name}`;
                                    await syncSource(source, (msg) => settersRef.current.setSyncStatusMessage(`${prefix}: ${msg}`));
                                })
                            );
                        }
                        settersRef.current.setSyncStatusMessage(null);
                    }
                }

                // ── VOD sync (Xtream only) ──────────────────────────────────────────
                if (vodRefreshHours > 0) {
                    const xtreamSources = result.data.filter((s: any) => s.type === 'xtream' && s.enabled);
                    if (xtreamSources.length > 0) {
                        const staleVod: any[] = [];
                        for (const source of xtreamSources) {
                            if (await isVodStale(source.id, vodRefreshHours)) staleVod.push(source);
                        }
                        if (staleVod.length > 0) {
                            console.log(`[AutoSync] Periodic check: ${staleVod.length} stale VOD sources found`);
                            settersRef.current.setVodSyncing(true);
                            hasSynced = true;
                            const CONCURRENCY = 10;
                            const total = staleVod.length;
                            for (let i = 0; i < total; i += CONCURRENCY) {
                                const batch = staleVod.slice(i, i + CONCURRENCY);
                                const batchNum = Math.floor(i / CONCURRENCY) + 1;
                                const totalBatches = Math.ceil(total / CONCURRENCY);
                                settersRef.current.setSyncStatusMessage(`Auto-syncing VOD batch ${batchNum}/${totalBatches}: ${batch.map((s: any) => s.name).join(', ')}`);
                                await Promise.all(batch.map((source: any) => syncVodForSource(source)));
                            }
                            settersRef.current.setSyncStatusMessage(null);
                        }
                    }
                }

                if (hasSynced) {
                    console.log('[AutoSync] Periodic sync completed');
                }
            } catch (err) {
                console.error('[AutoSync] Periodic check failed:', err);
            } finally {
                setSyncingState(false);
                settersRef.current.setVodSyncing(false);
            }
        };

        const doInitialSync = async () => {
            if (!window.storage) return;

            // Health check — ensure backend bulk-ops plugin is ready
            const healthy = await bulkOps.healthCheck();
            if (!healthy) {
                console.error('[AutoSync] Backend health check failed — sync may not work');
            }

            try {
                const result = await window.storage.getSources();
                if (!result.data || result.data.length === 0) return;

                const settingsResult = await window.storage.getSettings();
                const epgRefreshHours = settingsResult.data?.epgRefreshHours ?? 6;
                const vodRefreshHours = settingsResult.data?.vodRefreshHours ?? 24;

                // Apply stored settings via callbacks
                if (settingsResult.data?.channelSortOrder) {
                    setChannelSortOrder(settingsResult.data.channelSortOrder as 'alphabetical' | 'number');
                }
                if (settingsResult.data?.shortcuts) {
                    callbacks.onShortcutsLoaded?.(settingsResult.data.shortcuts);
                }
                if (settingsResult.data?.theme) {
                    callbacks.onThemeLoaded?.(settingsResult.data.theme);
                }
                if (settingsResult.data?.showSidebar !== undefined) {
                    callbacks.onSidebarVisibilityLoaded?.(settingsResult.data.showSidebar);
                }
                if (settingsResult.data?.channelFontSize || settingsResult.data?.categoryFontSize) {
                    callbacks.onFontSizeLoaded?.(
                        settingsResult.data.channelFontSize,
                        settingsResult.data.categoryFontSize
                    );
                }

                // ── Channel / EPG sync ──────────────────────────────────────────────
                // Filter out VOD-only sources from channel sync
                const enabledSources = result.data.filter((s: any) => s.enabled && !s.vod_only);
                const staleSources: any[] = [];
                for (const source of enabledSources) {
                    if (await isEpgStale(source.id, epgRefreshHours)) staleSources.push(source);
                }

                if (staleSources.length > 0) {
                    setSyncingState(true);
                    const CONCURRENCY = 10;
                    const total = staleSources.length;
                    for (let i = 0; i < total; i += CONCURRENCY) {
                        const batch = staleSources.slice(i, i + CONCURRENCY);
                        const batchNum = Math.floor(i / CONCURRENCY) + 1;
                        const totalBatches = Math.ceil(total / CONCURRENCY);
                        settersRef.current.setSyncStatusMessage(`Syncing batch ${batchNum}/${totalBatches}: ${batch.map((s: any) => s.name).join(', ')}`);
                        await Promise.all(
                            batch.map(async (source: any, idx: number) => {
                                const prefix = `[${i + idx + 1}/${total}] ${source.name}`;
                                await syncSource(source, (msg) => settersRef.current.setSyncStatusMessage(`${prefix}: ${msg}`));
                            })
                        );
                    }
                    settersRef.current.setSyncStatusMessage(null);
                }

                // ── VOD sync (Xtream only) ──────────────────────────────────────────
                const xtreamSources = result.data.filter((s: any) => s.type === 'xtream' && s.enabled);
                if (xtreamSources.length > 0) {
                    const staleVod: any[] = [];
                    for (const source of xtreamSources) {
                        if (await isVodStale(source.id, vodRefreshHours)) staleVod.push(source);
                    }
                    if (staleVod.length > 0) {
                        settersRef.current.setVodSyncing(true);
                        const CONCURRENCY = 10;
                        const total = staleVod.length;
                        for (let i = 0; i < total; i += CONCURRENCY) {
                            const batch = staleVod.slice(i, i + CONCURRENCY);
                            const batchNum = Math.floor(i / CONCURRENCY) + 1;
                            const totalBatches = Math.ceil(total / CONCURRENCY);
                            settersRef.current.setSyncStatusMessage(`Syncing VOD batch ${batchNum}/${totalBatches}: ${batch.map((s: any) => s.name).join(', ')}`);
                            await Promise.all(batch.map((source: any) => syncVodForSource(source)));
                        }
                        settersRef.current.setSyncStatusMessage(null);
                    }
                }

                // ── Start periodic checking ─────────────────────────────────────────
                // Only start interval if at least one refresh setting is not manual-only
                if (epgRefreshHours > 0 || vodRefreshHours > 0) {
                    console.log(`[AutoSync] Starting periodic check every ${CHECK_INTERVAL_MS / 60000} minutes`);
                    intervalRef.current = setInterval(() => {
                        checkAndSyncStaleSources();
                    }, CHECK_INTERVAL_MS);
                }
            } catch (err) {
                console.error('[AutoSync] Initial sync failed:', err);
            } finally {
                setSyncingState(false);
                settersRef.current.setVodSyncing(false);
            }
        };

        doInitialSync();

        // Cleanup interval on unmount
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [setChannelSortOrder]);
    // callbacks object not in deps — use latest via closure (they're stable setState/dispatch fns)
}
