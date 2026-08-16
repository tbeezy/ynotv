import { useEffect, useRef } from 'react';
import i18n from '../i18n';
import { syncSource, syncVodForSource, isEpgStale, isVodStale, syncAllStaleGlobalEpgLinks } from '../db/sync';
import { bulkOps } from '../services/bulk-ops';
import { getCachedSettings } from '../services/settings-cache';
import { useToastStore } from '../stores/toastStore';
import {
    useSetChannelSyncing,
    useSetVodSyncing,
    useSetChannelSortOrder,
    useSetCategorySortOrder,
    useSetSyncStatusMessage,
} from '../stores/uiStore';

interface AutoSyncSettings {
    onShortcutsLoaded?: (shortcuts: Record<string, string>) => void;
    onThemeLoaded?: (theme: string) => void;
    onFontSizeLoaded?: (channelSize?: number, categorySize?: number) => void;
}

// Check interval: 10 minutes
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

let hasInitialSyncTriggered = false;

/**
 * Runs the startup sync check once on mount:
 *   - Reads user settings (shortcuts, theme, font sizes)
 *   - Syncs stale channel/EPG sources in batches
 *   - Syncs stale VOD sources (Xtream & Stalker)
 *   - Periodically checks (every 10 min) if sources need refreshing based on Data Refresh settings
 *
 * Extracted from App.tsx lines ~1015-1157.
 */
export function useAutoSync(callbacks: AutoSyncSettings = {}) {
    const setChannelSyncing = useSetChannelSyncing();
    const setVodSyncing = useSetVodSyncing();
    const setChannelSortOrder = useSetChannelSortOrder();
    const setCategorySortOrder = useSetCategorySortOrder();
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

    // Keep category sort order setter in a separate ref since it's used in startup
    const categorySortRef = useRef(setCategorySortOrder);
    useEffect(() => {
        categorySortRef.current = setCategorySortOrder;
    }, [setCategorySortOrder]);

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

                const settingsResult = await getCachedSettings();
                const epgRefreshHours = settingsResult.data?.epgRefreshHours ?? 6;
                const vodRefreshHours = settingsResult.data?.vodRefreshHours ?? 24;

                const enabledSources = result.data.filter((s: any) => s.enabled && !s.vod_only);
                // VOD sources eligible for auto-sync (Xtream & Stalker, not Live-TV-only)
                const vodSources = result.data.filter((s: any) => (s.type === 'xtream' || s.type === 'stalker') && s.enabled && !s.live_tv_only);

                const hasCustomEpgRefresh = enabledSources.some((s: any) => s.custom_refresh_interval !== undefined && s.custom_refresh_interval !== null && s.custom_refresh_interval > 0);
                const hasCustomVodRefresh = vodSources.some((s: any) => s.custom_vod_refresh_interval !== undefined && s.custom_vod_refresh_interval !== null && s.custom_vod_refresh_interval > 0);

                const epgActive = epgRefreshHours > 0 || hasCustomEpgRefresh;
                const vodActive = vodRefreshHours > 0 || hasCustomVodRefresh;

                // Skip periodic check if no auto-refresh is active
                if (!epgActive && !vodActive) {
                    return;
                }

                let hasSynced = false;
                const syncedSourceIds: string[] = [];

                // ── Channel / EPG sync ──────────────────────────────────────────────
                if (epgActive) {
                    const staleSources: any[] = [];
                    for (const source of enabledSources) {
                        if (await isEpgStale(source.id, epgRefreshHours)) staleSources.push(source);
                    }

                    if (staleSources.length > 0) {
                        console.log(`[AutoSync] Periodic check: ${staleSources.length} stale EPG sources found`);
                        setSyncingState(true);
                        hasSynced = true;
                        // Concurrency must be 1 because native Rust handlers lock SQLite database for performance
                        const CONCURRENCY = 1;
                        const total = staleSources.length;
                        for (let i = 0; i < total; i += CONCURRENCY) {
                            const batch = staleSources.slice(i, i + CONCURRENCY);
                            const batchNum = Math.floor(i / CONCURRENCY) + 1;
                            const totalBatches = Math.ceil(total / CONCURRENCY);
                            settersRef.current.setSyncStatusMessage(i18n.t('common:autoSyncingBatch', { batch: batchNum, total: totalBatches, names: batch.map((s: any) => s.name).join(', ') }));
                            await Promise.all(
                                batch.map(async (source: any, idx: number) => {
                                    const prefix = `[${i + idx + 1}/${total}] ${source.name}`;
                                    const syncResult = await syncSource(source, (msg) => settersRef.current.setSyncStatusMessage(`${prefix}: ${msg}`));
                                    if (syncResult.success) {
                                        syncedSourceIds.push(source.id);
                                    } else {
                                        useToastStore.getState().addToast(i18n.t('common:autoSyncFailed', { name: source.name, error: syncResult.error }), 'error');
                                    }
                                })
                            );
                        }
                        settersRef.current.setSyncStatusMessage(null);
                    }
                }

                // ── VOD sync (Xtream & Stalker) ─────────────────────────────────────
                if (vodActive) {
                    if (vodSources.length > 0) {
                        const staleVod: any[] = [];
                        for (const source of vodSources) {
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
                                settersRef.current.setSyncStatusMessage(i18n.t('common:autoSyncingVodBatch', { batch: batchNum, total: totalBatches, names: batch.map((s: any) => s.name).join(', ') }));
                                await Promise.all(batch.map((source: any) => syncVodForSource(source)));
                            }
                            settersRef.current.setSyncStatusMessage(null);
                        }
                    }
                }

                // Post-sync: apply stale global EPG links
                if (syncedSourceIds.length > 0) {
                    try {
                        settersRef.current.setSyncStatusMessage(i18n.t('common:updatingGlobalEpgLinks'));
                        await syncAllStaleGlobalEpgLinks((msg) => settersRef.current.setSyncStatusMessage(msg), syncedSourceIds);
                    } catch (err) {
                        console.error('[AutoSync] Post-sync global EPG failed:', err);
                    }
                }

                if (hasSynced) {
                    console.log('[AutoSync] Periodic sync completed');
                }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : i18n.t('common:autoSyncPeriodicFailed');
                    console.error('[AutoSync] Periodic check failed:', err);
                    useToastStore.getState().addToast(msg, 'error');
                } finally {
                setSyncingState(false);
                settersRef.current.setVodSyncing(false);
            }
        };

        const doInitialSync = async () => {
            if (hasInitialSyncTriggered) {
                console.log('[AutoSync] Initial sync already triggered, skipping duplicate execution');
                return;
            }
            hasInitialSyncTriggered = true;

            if (!window.storage) return;

            // Delay startup sync so the app finishes its initial render first.
            // This keeps the JS thread free during the critical first-paint window
            // and avoids racing with the settings store / the channel live-query.
            await new Promise<void>(resolve => setTimeout(resolve, 2000));

            // Health check — ensure backend bulk-ops plugin is ready
            const healthy = await bulkOps.healthCheck();
            if (!healthy) {
                console.error('[AutoSync] Backend health check failed — sync may not work');
            }

            try {
                const result = await window.storage.getSources();
                if (!result.data || result.data.length === 0) return;

                const settingsResult = await getCachedSettings();
                const epgRefreshHours = settingsResult.data?.epgRefreshHours ?? 6;
                const vodRefreshHours = settingsResult.data?.vodRefreshHours ?? 24;
                const syncedSourceIds: string[] = [];

                // Apply stored settings via callbacks
                if (settingsResult.data?.channelSortOrder) {
                    setChannelSortOrder(settingsResult.data.channelSortOrder as 'alphabetical' | 'number' | 'provider');
                }
                if (settingsResult.data?.categorySortOrder) {
                    categorySortRef.current(settingsResult.data.categorySortOrder as 'default' | 'alphabetical');
                }
                if (settingsResult.data?.shortcuts) {
                    callbacks.onShortcutsLoaded?.(settingsResult.data.shortcuts);
                }
                if (settingsResult.data?.theme) {
                    callbacks.onThemeLoaded?.(settingsResult.data.theme);
                }
                if (settingsResult.data?.channelFontSize || settingsResult.data?.categoryFontSize) {
                    callbacks.onFontSizeLoaded?.(
                        settingsResult.data.channelFontSize,
                        settingsResult.data.categoryFontSize
                    );
                }

                // Filter out VOD-only sources from channel sync
                const enabledSources = result.data.filter((s: any) => s.enabled && !s.vod_only);
                // VOD sources eligible for auto-sync (Xtream & Stalker, not Live-TV-only)
                const vodSources = result.data.filter((s: any) => (s.type === 'xtream' || s.type === 'stalker') && s.enabled && !s.live_tv_only);

                const hasCustomEpgRefresh = enabledSources.some((s: any) => s.custom_refresh_interval !== undefined && s.custom_refresh_interval !== null && s.custom_refresh_interval > 0);
                const hasCustomVodRefresh = vodSources.some((s: any) => s.custom_vod_refresh_interval !== undefined && s.custom_vod_refresh_interval !== null && s.custom_vod_refresh_interval > 0);

                const epgActive = epgRefreshHours > 0 || hasCustomEpgRefresh;
                const vodActive = vodRefreshHours > 0 || hasCustomVodRefresh;

                // ── Channel / EPG sync ──────────────────────────────────────────────
                if (epgActive) {
                    const staleSources: any[] = [];
                    for (const source of enabledSources) {
                        if (await isEpgStale(source.id, epgRefreshHours)) staleSources.push(source);
                    }

                    if (staleSources.length > 0) {
                        setSyncingState(true);
                        // Concurrency must be 1 to prevent SQLite locks during native bulk inserts
                        const CONCURRENCY = 1;
                        const total = staleSources.length;
                        for (let i = 0; i < total; i += CONCURRENCY) {
                            const batch = staleSources.slice(i, i + CONCURRENCY);
                            const batchNum = Math.floor(i / CONCURRENCY) + 1;
                            const totalBatches = Math.ceil(total / CONCURRENCY);
                            settersRef.current.setSyncStatusMessage(i18n.t('common:syncingBatch', { batch: batchNum, total: totalBatches, names: batch.map((s: any) => s.name).join(', ') }));
                            await Promise.all(
                                batch.map(async (source: any, idx: number) => {
                                    const prefix = `[${i + idx + 1}/${total}] ${source.name}`;
                                    const syncResult = await syncSource(source, (msg) => settersRef.current.setSyncStatusMessage(`${prefix}: ${msg}`));
                                    if (syncResult.success) {
                                        syncedSourceIds.push(source.id);
                                    } else {
                                        useToastStore.getState().addToast(i18n.t('common:autoSyncFailed', { name: source.name, error: syncResult.error }), 'error');
                                    }
                                })
                            );
                        }
                        settersRef.current.setSyncStatusMessage(null);
                    }
                }

                // ── VOD sync (Xtream & Stalker) ─────────────────────────────────────
                if (vodActive) {
                    if (vodSources.length > 0) {
                        const staleVod: any[] = [];
                        for (const source of vodSources) {
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
                                settersRef.current.setSyncStatusMessage(i18n.t('common:syncingVodBatch', { batch: batchNum, total: totalBatches, names: batch.map((s: any) => s.name).join(', ') }));
                                await Promise.all(batch.map((source: any) => syncVodForSource(source)));
                            }
                            settersRef.current.setSyncStatusMessage(null);
                        }
                    }
                }

                // Post-sync: apply stale global EPG links
                if (syncedSourceIds.length > 0) {
                    try {
                        settersRef.current.setSyncStatusMessage(i18n.t('common:updatingGlobalEpgLinks'));
                        await syncAllStaleGlobalEpgLinks((msg) => settersRef.current.setSyncStatusMessage(msg), syncedSourceIds);
                    } catch (err) {
                        console.error('[AutoSync] Initial post-sync global EPG failed:', err);
                    }
                }

                // ── Start periodic checking ─────────────────────────────────────────
                // Only start interval if at least one refresh setting is active
                if (epgActive || vodActive) {
                    console.log(`[AutoSync] Starting periodic check every ${CHECK_INTERVAL_MS / 60000} minutes`);
                    intervalRef.current = setInterval(() => {
                        checkAndSyncStaleSources();
                    }, CHECK_INTERVAL_MS);
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : i18n.t('common:autoSyncInitialFailed');
                console.error('[AutoSync] Initial sync failed:', err);
                useToastStore.getState().addToast(msg, 'error');
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
