import { useEffect } from 'react';
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

/**
 * Runs the startup sync check once on mount:
 *   - Reads user settings (shortcuts, theme, font sizes)
 *   - Syncs stale channel/EPG sources in batches
 *   - Syncs stale VOD sources for Xtream sources
 *
 * Extracted from App.tsx lines ~1015-1157.
 */
export function useAutoSync(callbacks: AutoSyncSettings = {}) {
    const setChannelSyncing = useSetChannelSyncing();
    const setVodSyncing = useSetVodSyncing();
    const setChannelSortOrder = useSetChannelSortOrder();
    const setSyncStatusMessage = useSetSyncStatusMessage();

    useEffect(() => {
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
                const enabledSources = result.data.filter((s: any) => s.enabled);
                const staleSources: any[] = [];
                for (const source of enabledSources) {
                    if (await isEpgStale(source.id, epgRefreshHours)) staleSources.push(source);
                }

                if (staleSources.length > 0) {
                    setChannelSyncing(true);
                    const CONCURRENCY = 5;
                    const total = staleSources.length;
                    for (let i = 0; i < total; i += CONCURRENCY) {
                        const batch = staleSources.slice(i, i + CONCURRENCY);
                        const batchNum = Math.floor(i / CONCURRENCY) + 1;
                        const totalBatches = Math.ceil(total / CONCURRENCY);
                        setSyncStatusMessage(`Syncing batch ${batchNum}/${totalBatches}: ${batch.map((s: any) => s.name).join(', ')}`);
                        await Promise.all(
                            batch.map(async (source: any, idx: number) => {
                                const prefix = `[${i + idx + 1}/${total}] ${source.name}`;
                                await syncSource(source, (msg) => setSyncStatusMessage(`${prefix}: ${msg}`));
                            })
                        );
                    }
                    setSyncStatusMessage(null);
                }

                // ── VOD sync (Xtream only) ──────────────────────────────────────────
                const xtreamSources = result.data.filter((s: any) => s.type === 'xtream' && s.enabled);
                if (xtreamSources.length > 0) {
                    const staleVod: any[] = [];
                    for (const source of xtreamSources) {
                        if (await isVodStale(source.id, vodRefreshHours)) staleVod.push(source);
                    }
                    if (staleVod.length > 0) {
                        setVodSyncing(true);
                        const CONCURRENCY = 5;
                        const total = staleVod.length;
                        for (let i = 0; i < total; i += CONCURRENCY) {
                            const batch = staleVod.slice(i, i + CONCURRENCY);
                            const batchNum = Math.floor(i / CONCURRENCY) + 1;
                            const totalBatches = Math.ceil(total / CONCURRENCY);
                            setSyncStatusMessage(`Syncing VOD batch ${batchNum}/${totalBatches}: ${batch.map((s: any) => s.name).join(', ')}`);
                            await Promise.all(batch.map((source: any) => syncVodForSource(source)));
                        }
                        setSyncStatusMessage(null);
                    }
                }
            } catch (err) {
                console.error('[AutoSync] Initial sync failed:', err);
            } finally {
                setChannelSyncing(false);
                setVodSyncing(false);
            }
        };

        doInitialSync();
    }, [setChannelSyncing, setVodSyncing, setChannelSortOrder, setSyncStatusMessage]);
    // callbacks object not in deps — use latest via closure (they're stable setState/dispatch fns)
}
