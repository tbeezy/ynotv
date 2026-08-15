import {
    db,
    type StoredChannel,
    type StoredCategory,
    type CustomGroup,
    type CustomGroupChannel,
    type CustomPlaylist,
    type PlaylistCategoryLink,
    type PlaylistIndividualChannel
} from '../db';
import i18n, { translateNativeError } from '../i18n';
import type { Source } from '@ynotv/core';
import type { AppSettings } from '../types/app';
import { Bridge } from '../services/tauri-bridge';
import { normalizeBoolean } from './db-helpers';
import type { FavoriteItem } from '../stores/vodFavoritesStore';
import type { Playlist } from '../stores/vodPlaylistStore';
import type { PlaylistItemProgressSnapshot } from '../stores/vodPlaylistProgressStore';
import { useStremioWatchStore, stremioWatchKvReady } from '../stores/stremioWatchStore';
import { useStremioLibraryStore, stremioLibraryKvReady } from '../stores/stremioLibraryStore';
import { writeAppKv } from '../services/appKv';

export interface ExportData {
    version: number;
    timestamp: string;
    sources: Source[];
    settings: AppSettings;
    favorites: Array<{ streamId: string; sourceId: string }>;
    categoryPreferences: Array<{
        categoryId: string;
        sourceId: string;
        enabled?: boolean;
        displayOrder?: number;
        filterWords?: string[];
        alias?: string;
        folderId?: string | null;
    }>;
    channelPreferences: Array<{
        streamId: string;
        sourceId: string;
        enabled?: boolean;
        alias?: string;
    }>;
    vodCategoryPreferences?: Array<{
        categoryId: string;
        sourceId: string;
        enabled?: boolean;
        displayOrder?: number;
    }>;
    customGroups: Array<{
        groupId: string;
        name: string;
        displayOrder: number;
        channels: string[]; // stream_ids in order
    }>;
    // v4 additions
    watchlist: Array<{
        id: number;
        programId: string;
        channelId: string;
        channelName: string;
        programTitle: string;
        description?: string;
        startTime: number;
        endTime: number;
        sourceId: string;
        addedAt: number;
        reminderEnabled: boolean;
        reminderMinutes: number;
        autoswitchEnabled: boolean;
        autoswitchSecondsBefore: number;
        reminderShown: boolean;
        autoswitchTriggered: boolean;
    }>;
    epgChannelOverrides: Array<{
        streamId: string;
        epgChannelId?: string;
        streamIcon?: string;
        timeshiftHours?: number;
    }>;
    epgProgramOverrides: Array<{
        id: string;
        streamId: string;
        title?: string;
        subtitle?: string;
        description?: string;
        start?: string;
        end?: string;
        isDeleted?: number;
        isCustom?: number;
    }>;
    dvrSchedules: Array<{
        id: number;
        sourceId: string;
        channelId: string;
        channelName: string;
        programTitle: string;
        scheduledStart: number;
        scheduledEnd: number;
        startPaddingSec: number;
        endPaddingSec: number;
        status: string;
        seriesMatchTitle?: string;
        recurrence?: string;
        createdAt: number;
        startedAt?: number;
        streamUrl?: string;
    }>;
    dvrRecordings: Array<{
        id: number;
        scheduleId?: number;
        filePath: string;
        filename: string;
        sizeBytes?: number;
        channelName: string;
        programTitle: string;
        scheduledStart?: number;
        scheduledEnd?: number;
        actualStart: number;
        actualEnd?: number;
        durationSec?: number;
        status: string;
        errorMessage?: string;
        keepUntil?: number;
        autoDeletePolicy: string;
        createdAt: number;
        thumbnailPath?: string;
        progressSeconds?: number;
        lastWatchedAt?: number;
    }>;
    dvrSettings: Array<{ key: string; value: string }>;
    failoverGroups: Array<{
        groupId: string;
        name: string;
        createdAt: number;
        members: Array<{
            id: number;
            streamId: string;
            priority: number;
        }>;
    }>;
    vodHistory: Array<{
        id: number;
        mediaId: string;
        mediaType: 'movie' | 'series';
        sourceId: string;
        title: string;
        watchedAt: number;
        progressSeconds?: number;
        totalDuration?: number;
        posterUrl?: string;
        seasonNum?: number;
        episodeNum?: number;
        episodeTitle?: string;
    }>;
    episodeHistory: Array<{
        id: number;
        episodeId: string;
        seriesId: string;
        sourceId: string;
        seasonNum: number;
        episodeNum: number;
        title?: string;
        watchedAt: number;
        progressSeconds?: number;
        totalDuration?: number;
        completed: number;
    }>;
    userPrefs: Array<{ key: string; value: string }>;
    stremioAddons?: any;
    stremioWatchHistory?: any;
    /** Stremio library (was not exported before; added alongside the SQLite migration). */
    stremioLibrary?: any;
    // v6 additions (Playlist Editor data)
    customPlaylists?: CustomPlaylist[];
    playlistCategoryLinks?: PlaylistCategoryLink[];
    playlistIndividualChannels?: PlaylistIndividualChannel[];
    // v7 additions (VOD Favorites)
    vodFavorites?: FavoriteItem[];
    // v10 additions (VOD Playlists)
    vodPlaylists?: Playlist[];
    // v10 additions (VOD Playlist progress snapshots)
    vodPlaylistsProgress?: Record<string, PlaylistItemProgressSnapshot>;
    // v8 additions (UI Layout and Widget Preferences)
    uiLayout?: Record<string, string>;
    // v9 additions (Category Folders)
    categoryFolders?: Array<{
        folderId: string;
        playlistId: string;
        name: string;
        displayOrder: number;
        createdAt: number;
    }>;
}

const EXPORT_VERSION = 11;

/**
 * Collect the full application data payload. Shared by the interactive export
 * (save dialog) and the automated backup scheduler.
 */
async function buildExportData(): Promise<ExportData> {
    try {
        if (!window.storage) throw new Error(i18n.t('common:storageApiUnavailable'));

        // 1. Get Sources and Settings
        const sourcesResult = await window.storage.getSources();
        const settingsResult = await window.storage.getSettings();

        if (sourcesResult.error) throw new Error(translateNativeError(sourcesResult.error) || sourcesResult.error);
        if (settingsResult.error) throw new Error(translateNativeError(settingsResult.error) || settingsResult.error);

        // 1b. Wait for the SQLite-backed Stremio stores to finish hydrating so
        // the export includes their authoritative state (they no longer live in
        // localStorage).
        await Promise.all([stremioWatchKvReady, stremioLibraryKvReady]);

        // 2. Get Favorites from DB
        const allChannels = await db.channels.toArray();
        const favorites = allChannels.filter(ch => normalizeBoolean(ch.is_favorite));
        const favoriteData = favorites.map(ch => ({
            streamId: ch.stream_id,
            sourceId: ch.source_id,
            name: ch.name
        }));

        // 3. Get Category Preferences (including filter words and alias)
        const allCategories = await db.categories.toArray();
        const categoryCallback = (cat: StoredCategory) => {
            // SQLite returns BOOLEAN as 0/1, handle both cases
            const enabled = cat.enabled as boolean | number | undefined;
            const isDisabled = enabled === false || enabled === 0;
            const hasFolder = cat.folder_id && cat.folder_id.trim().length > 0;
            const hasCustomSettings = isDisabled ||
                (cat.display_order !== undefined && cat.display_order !== 0) ||
                (cat.filter_words && cat.filter_words.length > 0) ||
                (cat.alias && cat.alias.trim().length > 0) ||
                hasFolder;
            return hasCustomSettings;
        };

        const categoryPreferences = allCategories
            .filter(categoryCallback)
            .map(cat => ({
                categoryId: cat.category_id,
                sourceId: cat.source_id,
                name: cat.category_name,
                enabled: cat.enabled,
                displayOrder: cat.display_order,
                filterWords: cat.filter_words,
                alias: cat.alias,
                folderId: cat.folder_id
            }));

        // 4. Get Channel Preferences (enabled/disabled status and alias)
        const channelCallback = (ch: StoredChannel) => {
            const enabled = ch.enabled as boolean | number | undefined;
            // Include if channel has been explicitly disabled or has an alias
            const isDisabled = enabled === false || enabled === 0;
            return isDisabled || (ch.alias && ch.alias.trim().length > 0);
        };

        const channelPreferences = allChannels
            .filter(channelCallback)
            .map(ch => ({
                streamId: ch.stream_id,
                sourceId: ch.source_id,
                name: ch.name,
                enabled: ch.enabled,
                alias: ch.alias
            }));

        // 4b. Get VOD Category Preferences (enabled/disabled status and display order)
        const allVodCategories = await db.vodCategories.toArray();
        const vodCategoryPreferences = allVodCategories
            .filter(cat => cat.enabled === false || (cat.display_order !== undefined && cat.display_order !== 0))
            .map(cat => ({
                categoryId: cat.category_id,
                sourceId: cat.source_id,
                name: cat.name,
                type: cat.type,
                enabled: cat.enabled,
                displayOrder: cat.display_order
            }));

        // 5. Get Custom Groups with their channels
        const allCustomGroups = await db.customGroups.toArray();
        const allGroupChannels = await db.customGroupChannels.toArray();

        const customGroups = allCustomGroups.map(group => {
            const groupChans = allGroupChannels
                .filter(gc => gc.group_id === group.group_id)
                .sort((a, b) => (a.display_order || 0) - (b.display_order || 0))
                .map(gc => gc.stream_id);

            return {
                groupId: group.group_id,
                name: group.name,
                displayOrder: group.display_order,
                channels: groupChans
            };
        });

        // 6. Get Watchlist
        const allWatchlist = await db.watchlist.toArray();
        const watchlist = allWatchlist.map(w => ({
            id: w.id!,
            programId: w.program_id,
            channelId: w.channel_id,
            channelName: w.channel_name,
            programTitle: w.program_title,
            description: w.description,
            startTime: w.start_time,
            endTime: w.end_time,
            sourceId: w.source_id,
            addedAt: w.added_at,
            reminderEnabled: w.reminder_enabled,
            reminderMinutes: w.reminder_minutes,
            autoswitchEnabled: w.autoswitch_enabled,
            autoswitchSecondsBefore: w.autoswitch_seconds_before,
            reminderShown: w.reminder_shown,
            autoswitchTriggered: w.autoswitch_triggered
        }));

        // 7. Get EPG Overrides
        const epgChannelOverrides = (await db.epgChannelOverrides.toArray()).map(o => ({
            streamId: o.stream_id,
            epgChannelId: o.epg_channel_id,
            streamIcon: o.stream_icon,
            logoBackground: o.logo_background,
            logoPadding: o.logo_padding,
            timeshiftHours: o.timeshift_hours
        }));

        const epgProgramOverrides = (await db.epgProgramOverrides.toArray()).map(o => ({
            id: o.id,
            streamId: o.stream_id,
            title: o.title,
            subtitle: o.subtitle,
            description: o.description,
            start: o.start,
            end: o.end,
            isDeleted: o.is_deleted,
            isCustom: o.is_custom
        }));

        // 8. Get DVR data
        const dvrSchedules = (await db.dvrSchedules.toArray()).map(s => ({
            id: s.id!,
            sourceId: s.source_id,
            channelId: s.channel_id,
            channelName: s.channel_name,
            programTitle: s.program_title,
            scheduledStart: s.scheduled_start,
            scheduledEnd: s.scheduled_end,
            startPaddingSec: s.start_padding_sec,
            endPaddingSec: s.end_padding_sec,
            status: s.status,
            seriesMatchTitle: s.series_match_title,
            recurrence: s.recurrence,
            createdAt: s.created_at,
            startedAt: s.started_at,
            streamUrl: s.stream_url
        }));

        const dvrRecordings = (await db.dvrRecordings.toArray()).map(r => ({
            id: r.id!,
            scheduleId: r.schedule_id,
            filePath: r.file_path,
            filename: r.filename,
            sizeBytes: r.size_bytes,
            channelName: r.channel_name,
            programTitle: r.program_title,
            scheduledStart: r.scheduled_start,
            scheduledEnd: r.scheduled_end,
            actualStart: r.actual_start,
            actualEnd: r.actual_end,
            durationSec: r.duration_sec,
            status: r.status,
            errorMessage: r.error_message,
            keepUntil: r.keep_until,
            autoDeletePolicy: r.auto_delete_policy,
            createdAt: r.created_at,
            thumbnailPath: r.thumbnail_path,
            progressSeconds: r.progress_seconds,
            lastWatchedAt: r.last_watched_at
        }));

        const dvrSettings = await db.dvrSettings.toArray();

        // 9. Get Failover Groups
        const allFailoverGroups = await db.failoverGroups.toArray();
        const allFailoverMembers = await db.failoverGroupMembers.toArray();
        const failoverGroups = allFailoverGroups.map(group => ({
            groupId: group.group_id,
            name: group.name,
            createdAt: group.created_at,
            members: allFailoverMembers
                .filter(m => m.group_id === group.group_id)
                .sort((a, b) => a.priority - b.priority)
                .map(m => ({
                    id: m.id!,
                    streamId: m.stream_id,
                    priority: m.priority
                }))
        }));

        // 10. Get VOD History
        const vodHistory = (await db.vodHistory.toArray()).map(h => ({
            id: h.id!,
            mediaId: h.media_id,
            mediaType: h.media_type,
            sourceId: h.source_id,
            title: h.title,
            watchedAt: h.watched_at,
            progressSeconds: h.progress_seconds,
            totalDuration: h.total_duration,
            posterUrl: h.poster_url,
            seasonNum: h.season_num,
            episodeNum: h.episode_num,
            episodeTitle: h.episode_title
        }));

        const episodeHistory = (await db.episodeHistory.toArray()).map(h => ({
            id: h.id!,
            episodeId: h.episode_id,
            seriesId: h.series_id,
            sourceId: h.source_id,
            seasonNum: h.season_num,
            episodeNum: h.episode_num,
            title: h.title,
            watchedAt: h.watched_at,
            progressSeconds: h.progress_seconds,
            totalDuration: h.total_duration,
            completed: h.completed
        }));

        // 11. Get User Prefs
        const userPrefs = await db.prefs.toArray();

        // 12. Get Stremio data from localStorage
        let stremioAddons = undefined;
        try {
            const addonsRaw = localStorage.getItem('stremio-addons');
            if (addonsRaw) {
                stremioAddons = JSON.parse(addonsRaw);
            }
        } catch (e) {
            console.warn('[Export] Failed to parse stremio-addons from localStorage:', e);
        }

        let stremioWatchHistory = undefined;
        try {
            const watchState = useStremioWatchStore.getState();
            stremioWatchHistory = {
                state: {
                    history: watchState.history,
                    episodeProgress: watchState.episodeProgress,
                },
                version: 0,
            };
        } catch (e) {
            console.warn('[Export] Failed to read stremio-watch-history from store:', e);
        }

        let stremioLibrary = undefined;
        try {
            stremioLibrary = {
                state: {
                    library: useStremioLibraryStore.getState().library,
                },
                version: 0,
            };
        } catch (e) {
            console.warn('[Export] Failed to read stremio-library from store:', e);
        }

        // 13. Get Playlist Editor data
        const customPlaylists = await db.customPlaylists.toArray();
        const playlistCategoryLinks = await db.playlistCategoryLinks.toArray();
        const playlistIndividualChannels = await db.playlistIndividualChannels.toArray();

        // 13b. Get Category Folders (source/playlist folder containers)
        const categoryFolders = (await db.categoryFolders.toArray()).map(f => ({
            folderId: f.folder_id,
            playlistId: f.playlist_id,
            name: f.name,
            displayOrder: f.display_order,
            createdAt: f.created_at
        }));

        // 14. Get VOD Favorites from localStorage
        let vodFavorites: FavoriteItem[] | undefined = undefined;
        try {
            const favoritesRaw = localStorage.getItem('vod-favorites');
            if (favoritesRaw) {
                const parsed = JSON.parse(favoritesRaw);
                if (parsed && parsed.state && Array.isArray(parsed.state.favorites)) {
                    vodFavorites = parsed.state.favorites;
                }
            }
        } catch (e) {
            console.warn('[Export] Failed to parse vod-favorites from localStorage:', e);
        }

        // 14b. Get VOD Playlists from localStorage
        let vodPlaylists: Playlist[] | undefined = undefined;
        try {
            const playlistsRaw = localStorage.getItem('vod-playlists-store');
            if (playlistsRaw) {
                const parsed = JSON.parse(playlistsRaw);
                if (parsed && parsed.state && Array.isArray(parsed.state.playlists)) {
                    vodPlaylists = parsed.state.playlists;
                }
            }
        } catch (e) {
            console.warn('[Export] Failed to parse vod-playlists-store from localStorage:', e);
        }

        // 14c. Get VOD Playlist progress snapshots from localStorage
        let vodPlaylistsProgress: Record<string, PlaylistItemProgressSnapshot> | undefined = undefined;
        try {
            const progressRaw = localStorage.getItem('vod-playlists-progress');
            if (progressRaw) {
                const parsed = JSON.parse(progressRaw);
                if (parsed && parsed.state && parsed.state.byItemId && typeof parsed.state.byItemId === 'object') {
                    vodPlaylistsProgress = parsed.state.byItemId;
                }
            }
        } catch (e) {
            console.warn('[Export] Failed to parse vod-playlists-progress from localStorage:', e);
        }

        // 15. Get UI Layout and Widget Preferences from localStorage
        const uiLayoutKeys = [
            'ynotv:pinnedCategories',
            'ynotv:expandedSources',
            'ynotv:expandedPlaylists',
            'widgetOrder',
            'customGroupWidgetIds',
            'sportsOverlayWidget',
            'recentOverlayWidget',
            'favoritesOverlayWidget',
            'whatsNextOverlayWidget',
            'guidePreviewWidth',
            'guidePreviewHeight',
            'epgChannelColumnWidth',
            'showFavPlaylistName',
            'showRecentPlaylistName',
            'showWatchlistPlaylistName',
            'showCustomPlaylistName'
        ];
        const uiLayout: Record<string, string> = {};
        for (const key of uiLayoutKeys) {
            const val = localStorage.getItem(key);
            if (val !== null) {
                uiLayout[key] = val;
            }
        }

        const exportData: ExportData = {
            version: EXPORT_VERSION,
            timestamp: new Date().toISOString(),
            sources: sourcesResult.data || [],
            settings: settingsResult.data || { theme: 'solid-monochrome' },
            favorites: favoriteData,
            categoryPreferences,
            channelPreferences,
            vodCategoryPreferences,
            customGroups,
            watchlist,
            epgChannelOverrides,
            epgProgramOverrides,
            dvrSchedules,
            dvrRecordings,
            dvrSettings,
            failoverGroups,
            vodHistory,
            episodeHistory,
            userPrefs,
            stremioAddons,
            stremioWatchHistory,
            stremioLibrary,
            customPlaylists,
            playlistCategoryLinks,
            playlistIndividualChannels,
            categoryFolders,
            vodFavorites,
            vodPlaylists,
            vodPlaylistsProgress,
            uiLayout
        };

        return exportData;

    } catch (err) {
        console.error('Export data collection failed:', err);
        throw err;
    }
}

/**
 * Export all application data to a JSON file via an interactive save dialog.
 */
export async function exportAllData(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
        const exportData = await buildExportData();
        const fileName = `ynotv-backup-${new Date().toISOString().split('T')[0]}.json`;
        // Use Bridge for save dialog
        const result = await Bridge.saveJsonFile(JSON.stringify(exportData, null, 2), fileName);

        if (result.canceled) return { success: false, error: 'Cancelled' };

        return { success: true, filePath: result.data?.filePath };

    } catch (err) {
        console.error('Export failed:', err);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Write the full application data to an explicit file path (no dialog).
 * Used by the automated backup scheduler.
 */
export async function exportAllDataToPath(filePath: string): Promise<{ success: boolean; error?: string }> {
    try {
        const exportData = await buildExportData();
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        await writeTextFile(filePath, JSON.stringify(exportData, null, 2));
        return { success: true };
    } catch (err) {
        console.error('Export to path failed:', err);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Import application data from a JSON file
 */
export async function importAllData(): Promise<{ success: boolean; error?: string }> {
    try {
        if (!window.storage) throw new Error(i18n.t('common:storageApiUnavailable'));

        // 1. Open File via Bridge
        const fileResult = await Bridge.openJsonFile();
        if (fileResult.canceled) return { success: false, error: 'Cancelled' };

        if (!fileResult.data) throw new Error(i18n.t('settings:importExport.failedToReadFile'));

        const data: ExportData = JSON.parse(fileResult.data);

        // Basic validation
        if (!data.version || !data.sources || !data.settings) {
            throw new Error(i18n.t('settings:importExport.invalidBackupFormat'));
        }

        // Note: We no longer use PRAGMA foreign_keys = OFF here.
        // tauri-plugin-sql v2 uses sqlx 0.8 which enables foreign_keys = ON
        // per-connection in the pool, so a single PRAGMA call is unreliable.
        // FK constraints have been removed from import-affected tables (see v17 migration).

        // 2. Restore Settings
        await window.storage.updateSettings(data.settings);

        // Restore Stremio addons
        if (data.stremioAddons) {
            localStorage.setItem('stremio-addons', JSON.stringify(data.stremioAddons));
        } else {
            localStorage.removeItem('stremio-addons');
        }

        // Restore Stremio watch history (persisted via the SQLite KV store)
        if (data.stremioWatchHistory && data.stremioWatchHistory.state) {
            const state = data.stremioWatchHistory.state;
            useStremioWatchStore.setState({
                history: state.history ?? [],
                episodeProgress: state.episodeProgress ?? {},
            });
            try {
                await writeAppKv('stremio-watch-history', JSON.stringify({
                    history: state.history ?? [],
                    episodeProgress: state.episodeProgress ?? {},
                }));
            } catch (e) {
                console.warn('[Import] Failed to persist stremio-watch-history:', e);
            }
        }

        // Restore Stremio library (persisted via the SQLite KV store)
        if (data.stremioLibrary && data.stremioLibrary.state) {
            const state = data.stremioLibrary.state;
            useStremioLibraryStore.setState({ library: state.library ?? [] });
            try {
                await writeAppKv('stremio-library', JSON.stringify({
                    library: state.library ?? [],
                }));
            } catch (e) {
                console.warn('[Import] Failed to persist stremio-library:', e);
            }
        }

        // Restore VOD Favorites
        if (data.vodFavorites) {
            try {
                const wrapper = {
                    state: {
                        favorites: data.vodFavorites
                    },
                    version: 0
                };
                localStorage.setItem('vod-favorites', JSON.stringify(wrapper));
            } catch (e) {
                console.warn('[Import] Failed to restore vod-favorites to localStorage:', e);
            }
        } else {
            localStorage.removeItem('vod-favorites');
        }

        // Restore VOD Playlists
        if (data.vodPlaylists) {
            try {
                const wrapper = {
                    state: {
                        playlists: data.vodPlaylists
                    },
                    version: 0
                };
                localStorage.setItem('vod-playlists-store', JSON.stringify(wrapper));
            } catch (e) {
                console.warn('[Import] Failed to restore vod-playlists-store to localStorage:', e);
            }
        }
        // No vodPlaylists in the backup (e.g. older backups)? Keep the user's
        // existing playlists instead of wiping them.

        // Restore VOD Playlist progress snapshots
        if (data.vodPlaylistsProgress && typeof data.vodPlaylistsProgress === 'object') {
            try {
                const wrapper = {
                    state: {
                        byItemId: data.vodPlaylistsProgress
                    },
                    version: 0
                };
                localStorage.setItem('vod-playlists-progress', JSON.stringify(wrapper));
            } catch (e) {
                console.warn('[Import] Failed to restore vod-playlists-progress to localStorage:', e);
            }
        }
        // Same as playlists: a backup without progress snapshots must not wipe
        // progress the user has accumulated since.

        // Restore UI Layout & Widget Preferences
        if (data.uiLayout && typeof data.uiLayout === 'object') {
            for (const [key, val] of Object.entries(data.uiLayout)) {
                if (typeof val === 'string') {
                    localStorage.setItem(key, val);
                }
            }
        }

        // 3. Restore Sources
        // Delete existing sources to ensure clean state matching backup
        const currentSources = await window.storage.getSources();
        if (currentSources.data) {
            for (const source of currentSources.data) {
                await window.storage.deleteSource(source.id);
            }
        }

        for (const source of data.sources) {
            await window.storage.saveSource(source);
        }

        // 4. Restore SQLite data in bulk transactions
        await db.transaction('rw', [
            db.channels, db.categories,
            db.watchlist, db.epgChannelOverrides, db.epgProgramOverrides,
            db.dvrSchedules, db.dvrRecordings, db.dvrSettings,
            db.failoverGroups, db.failoverGroupMembers,
            db.vodHistory, db.episodeHistory, db.prefs,
            db.sourcesMeta, db.programs, db.epgChannels,
            db.vodMovies, db.vodSeries, db.vodEpisodes,
            db.vodCategories, db.channelMetadata,
            db.customPlaylists, db.playlistCategoryLinks, db.playlistIndividualChannels,
            db.categoryFolders
        ], async () => {
            const restoreStep = async (name: string, action: () => Promise<void>) => {
                console.log(`[Import] Starting: ${name}...`);
                try {
                    await action();
                    console.log(`[Import] Success: ${name}`);
                } catch (e) {
                    console.error(`[Import] FAILURE: ${name}. Error:`, e);
                    throw new Error(i18n.t('settings:importExport.restoreFailed', { name, detail: e instanceof Error ? e.message : String(e) }));
                }
            };

            // Clear existing data (both configurations and cache tables)
            // MUST clear child/dependent tables first to avoid SQLite FOREIGN KEY constraint failures!
            await restoreStep('Clear Databases', async () => {
                // Drop any leftover backup tables from failed migrations to prevent FOREIGN KEY constraint issues on delete/clear.
                const oldBackupTables = [
                    '_old_dvr_schedules_v17',
                    '_old_dvr_recordings_v17',
                    '_old_custom_group_channels_v17',
                    '_old_failover_group_members_v17',
                    'old_playlist_individual_channels_v16',
                    'old_playlist_individual_channels',
                    'old_playlist_category_links'
                ];
                for (const table of oldBackupTables) {
                    try {
                        await db.execute(`DROP TABLE IF EXISTS ${table}`);
                    } catch (e) {
                        console.warn(`[Import] Failed to drop clean-up table ${table}:`, e);
                    }
                }

                const tablesToClear = [
                    // 1. Child/dependent tables first
                    { name: 'customGroupChannels', table: db.customGroupChannels },
                    { name: 'failoverGroupMembers', table: db.failoverGroupMembers },
                    { name: 'playlistIndividualChannels', table: db.playlistIndividualChannels },
                    { name: 'playlistCategoryLinks', table: db.playlistCategoryLinks },
                    { name: 'dvrRecordings', table: db.dvrRecordings },
                    { name: 'dvrSchedules', table: db.dvrSchedules },
                    { name: 'watchlist', table: db.watchlist },
                    { name: 'epgChannelOverrides', table: db.epgChannelOverrides },
                    { name: 'epgProgramOverrides', table: db.epgProgramOverrides },
                    { name: 'programs', table: db.programs },
                    { name: 'channelMetadata', table: db.channelMetadata },
                    { name: 'vodEpisodes', table: db.vodEpisodes },

                    // 2. Parent tables
                    { name: 'customGroups', table: db.customGroups },
                    { name: 'failoverGroups', table: db.failoverGroups },
                    { name: 'customPlaylists', table: db.customPlaylists },
                    { name: 'categoryFolders', table: db.categoryFolders },
                    { name: 'vodSeries', table: db.vodSeries },
                    { name: 'vodMovies', table: db.vodMovies },
                    { name: 'vodCategories', table: db.vodCategories },
                    { name: 'categories', table: db.categories },
                    { name: 'channels', table: db.channels },

                    // 3. Root tables and independent/config tables
                    { name: 'sourcesMeta', table: db.sourcesMeta },
                    { name: 'dvrSettings', table: db.dvrSettings },
                    { name: 'vodHistory', table: db.vodHistory },
                    { name: 'episodeHistory', table: db.episodeHistory },
                    { name: 'prefs', table: db.prefs },
                    { name: 'epgChannels', table: db.epgChannels }
                ];

                for (const t of tablesToClear) {
                    try {
                        await t.table.clear();
                    } catch (err) {
                        console.error(`[Import] Failed to clear table: ${t.name}. Error:`, err);
                        throw new Error(i18n.t('settings:importExport.clearTableFailed', { table: t.name, detail: err instanceof Error ? err.message : String(err) }));
                    }
                }
            });

            await restoreStep('Channel Stubs', async () => {
                // Collect and merge all channel stubs to prevent FOREIGN KEY constraint failures
                const channelStubsMap = new Map<string, StoredChannel>();

                // 1. Add Favorites stubs
                if (data.favorites && data.favorites.length > 0) {
                    for (const fav of data.favorites) {
                        channelStubsMap.set(fav.streamId, {
                            stream_id: fav.streamId,
                            source_id: fav.sourceId,
                            name: (fav as any).name ?? 'Unknown',
                            category_ids: [],
                            is_favorite: true
                        } as unknown as StoredChannel);
                    }
                }

                // 2. Add Channel Preferences stubs (enabled/disabled status and alias)
                if (data.channelPreferences && data.channelPreferences.length > 0) {
                    for (const pref of data.channelPreferences) {
                        const existing = channelStubsMap.get(pref.streamId);
                        channelStubsMap.set(pref.streamId, {
                            stream_id: pref.streamId,
                            source_id: pref.sourceId,
                            name: (pref as any).name ?? existing?.name ?? 'Unknown',
                            category_ids: [],
                            is_favorite: existing?.is_favorite ?? false,
                            enabled: pref.enabled,
                            alias: pref.alias
                        } as unknown as StoredChannel);
                    }
                }

                // 3. Add placeholders for any other referenced stream_ids to satisfy SQLite foreign keys
                const referencedStreamIds = new Set<string>();
                const streamIdToSource = new Map<string, string>();

                if (data.playlistIndividualChannels) {
                    for (const ch of data.playlistIndividualChannels) {
                        referencedStreamIds.add(ch.stream_id);
                    }
                }
                if (data.customGroups) {
                    for (const g of data.customGroups) {
                        if (g.channels) {
                            for (const streamId of g.channels) {
                                referencedStreamIds.add(streamId);
                            }
                        }
                    }
                }
                if (data.failoverGroups) {
                    for (const g of data.failoverGroups) {
                        if (g.members) {
                            for (const m of g.members) {
                                referencedStreamIds.add(m.streamId);
                            }
                        }
                    }
                }
                if (data.watchlist) {
                    for (const w of data.watchlist) {
                        referencedStreamIds.add(w.channelId);
                        if (w.sourceId) streamIdToSource.set(w.channelId, w.sourceId);
                    }
                }
                if (data.dvrSchedules) {
                    for (const s of data.dvrSchedules) {
                        referencedStreamIds.add(s.channelId);
                        if (s.sourceId) streamIdToSource.set(s.channelId, s.sourceId);
                    }
                }

                for (const streamId of referencedStreamIds) {
                    if (!channelStubsMap.has(streamId)) {
                        // Find or fallback source_id
                        const sourceId = streamIdToSource.get(streamId) || 'unknown';
                        channelStubsMap.set(streamId, {
                            stream_id: streamId,
                            source_id: sourceId,
                            name: 'Unknown Placeholder',
                            category_ids: [],
                            enabled: true
                        } as unknown as StoredChannel);
                    }
                }

                // Bulk add all channel stubs
                if (channelStubsMap.size > 0) {
                    await db.channels.bulkAdd(Array.from(channelStubsMap.values()));
                }
            });

            await restoreStep('Category Preferences', async () => {
                if (data.categoryPreferences && data.categoryPreferences.length > 0) {
                    const catStubs = data.categoryPreferences.map(pref => ({
                        category_id: pref.categoryId,
                        source_id: pref.sourceId,
                        category_name: (pref as any).name ?? 'Unknown', // Placeholder
                        enabled: pref.enabled,
                        display_order: pref.displayOrder,
                        filter_words: pref.filterWords,
                        alias: pref.alias,
                        folder_id: pref.folderId ?? (pref as any).folder_id ?? null
                    } as StoredCategory));

                    await db.categories.bulkAdd(catStubs);
                }
            });

            await restoreStep('VOD Category Preferences', async () => {
                if (data.vodCategoryPreferences && data.vodCategoryPreferences.length > 0) {
                    const vodCatStubs = data.vodCategoryPreferences.map(pref => ({
                        category_id: pref.categoryId,
                        source_id: pref.sourceId,
                        name: (pref as any).name ?? 'Unknown', // Placeholder
                        type: (pref as any).type ?? 'movie',
                        enabled: pref.enabled,
                        display_order: pref.displayOrder
                    } as any));

                    await db.vodCategories.bulkAdd(vodCatStubs);
                }
            });

            await restoreStep('Watchlist', async () => {
                if (data.watchlist && data.watchlist.length > 0) {
                    const watchlistItems = data.watchlist.map(w => ({
                        id: w.id,
                        program_id: w.programId,
                        channel_id: w.channelId,
                        channel_name: w.channelName,
                        program_title: w.programTitle,
                        description: w.description,
                        start_time: w.startTime,
                        end_time: w.endTime,
                        source_id: w.sourceId,
                        added_at: w.addedAt,
                        reminder_enabled: w.reminderEnabled,
                        reminder_minutes: w.reminderMinutes,
                        autoswitch_enabled: w.autoswitchEnabled,
                        autoswitch_seconds_before: w.autoswitchSecondsBefore,
                        reminder_shown: w.reminderShown,
                        autoswitch_triggered: w.autoswitchTriggered
                    }));
                    await db.watchlist.bulkAdd(watchlistItems);
                }
            });

            await restoreStep('EPG Channel Overrides', async () => {
                if (data.epgChannelOverrides && data.epgChannelOverrides.length > 0) {
                    const overrides = data.epgChannelOverrides.map(o => ({
                        stream_id: o.streamId || (o as any).stream_id,
                        epg_channel_id: o.epgChannelId !== undefined ? o.epgChannelId : (o as any).epg_channel_id,
                        stream_icon: o.streamIcon !== undefined ? o.streamIcon : (o as any).stream_icon,
                        logo_background: (o as any).logoBackground !== undefined ? (o as any).logoBackground : (o as any).logo_background,
                        logo_padding: (o as any).logoPadding !== undefined ? (o as any).logoPadding : (o as any).logo_padding,
                        timeshift_hours: o.timeshiftHours !== undefined ? o.timeshiftHours : (o as any).timeshift_hours
                    }));
                    await db.epgChannelOverrides.bulkAdd(overrides);
                }
            });

            await restoreStep('EPG Program Overrides', async () => {
                if (data.epgProgramOverrides && data.epgProgramOverrides.length > 0) {
                    const overrides = data.epgProgramOverrides.map(o => ({
                        id: o.id,
                        stream_id: o.streamId || (o as any).stream_id,
                        title: o.title,
                        subtitle: o.subtitle || (o as any).subtitle,
                        description: o.description,
                        start: o.start,
                        end: o.end,
                        is_deleted: o.isDeleted !== undefined ? o.isDeleted : (o as any).is_deleted,
                        is_custom: o.isCustom !== undefined ? o.isCustom : (o as any).is_custom
                    }));
                    await db.epgProgramOverrides.bulkAdd(overrides);
                }
            });

            await restoreStep('DVR Schedules', async () => {
                if (data.dvrSchedules && data.dvrSchedules.length > 0) {
                    const schedules = data.dvrSchedules.map(s => ({
                        id: s.id,
                        source_id: s.sourceId,
                        channel_id: s.channelId,
                        channel_name: s.channelName,
                        program_title: s.programTitle,
                        scheduled_start: s.scheduledStart,
                        scheduled_end: s.scheduledEnd,
                        start_padding_sec: s.startPaddingSec,
                        end_padding_sec: s.endPaddingSec,
                        status: s.status,
                        series_match_title: s.seriesMatchTitle,
                        recurrence: s.recurrence,
                        created_at: s.createdAt,
                        started_at: s.startedAt,
                        stream_url: s.streamUrl
                    }));
                    await db.dvrSchedules.bulkAdd(schedules as any);
                }
            });

            await restoreStep('DVR Recordings', async () => {
                if (data.dvrRecordings && data.dvrRecordings.length > 0) {
                    const recordings = data.dvrRecordings.map(r => ({
                        id: r.id,
                        schedule_id: r.scheduleId,
                        file_path: r.filePath,
                        filename: r.filename,
                        size_bytes: r.sizeBytes,
                        channel_name: r.channelName,
                        program_title: r.programTitle,
                        scheduled_start: r.scheduledStart,
                        scheduled_end: r.scheduledEnd,
                        actual_start: r.actualStart,
                        actual_end: r.actualEnd,
                        duration_sec: r.durationSec,
                        status: r.status,
                        error_message: r.errorMessage,
                        keep_until: r.keepUntil,
                        auto_delete_policy: r.autoDeletePolicy,
                        created_at: r.createdAt,
                        thumbnail_path: r.thumbnailPath,
                        progress_seconds: r.progressSeconds ?? (r as any).progress_seconds ?? 0,
                        last_watched_at: r.lastWatchedAt ?? (r as any).last_watched_at
                    }));
                    await db.dvrRecordings.bulkAdd(recordings as any);
                }
            });

            await restoreStep('DVR Settings', async () => {
                if (data.dvrSettings && data.dvrSettings.length > 0) {
                    await db.dvrSettings.bulkAdd(data.dvrSettings);
                }
            });

            await restoreStep('Failover Groups', async () => {
                if (data.failoverGroups && data.failoverGroups.length > 0) {
                    for (const group of data.failoverGroups) {
                        await db.failoverGroups.add({
                            group_id: group.groupId,
                            name: group.name,
                            created_at: group.createdAt
                        });

                        if (group.members && group.members.length > 0) {
                            const members = group.members.map(m => ({
                                id: m.id,
                                group_id: group.groupId,
                                stream_id: m.streamId,
                                priority: m.priority
                            }));
                            await db.failoverGroupMembers.bulkAdd(members);
                        }
                    }
                }
            });

            await restoreStep('VOD Watch History', async () => {
                if (data.vodHistory && data.vodHistory.length > 0) {
                    const history = data.vodHistory.map(h => ({
                        id: h.id,
                        media_id: h.mediaId,
                        media_type: h.mediaType || ((h.seasonNum !== undefined && h.seasonNum !== null) || (h.episodeNum !== undefined && h.episodeNum !== null) ? 'series' : 'movie'),
                        source_id: h.sourceId,
                        title: h.title,
                        watched_at: h.watchedAt,
                        progress_seconds: h.progressSeconds,
                        total_duration: h.totalDuration,
                        poster_url: h.posterUrl,
                        season_num: h.seasonNum,
                        episode_num: h.episodeNum,
                        episode_title: h.episodeTitle
                    }));
                    await db.vodHistory.bulkAdd(history);
                }
            });

            await restoreStep('Episode Watch History', async () => {
                if (data.episodeHistory && data.episodeHistory.length > 0) {
                    const history = data.episodeHistory.map(h => ({
                        id: h.id,
                        episode_id: h.episodeId,
                        series_id: h.seriesId,
                        source_id: h.sourceId,
                        season_num: h.seasonNum,
                        episode_num: h.episodeNum,
                        title: h.title,
                        watched_at: h.watchedAt,
                        progress_seconds: h.progressSeconds,
                        total_duration: h.totalDuration,
                        completed: h.completed
                    }));
                    await db.episodeHistory.bulkAdd(history);
                }
            });

            await restoreStep('User Prefs', async () => {
                if (data.userPrefs && data.userPrefs.length > 0) {
                    await db.prefs.bulkAdd(data.userPrefs);
                }
            });

            await restoreStep('Custom Playlists', async () => {
                if (data.customPlaylists && data.customPlaylists.length > 0) {
                    await db.customPlaylists.bulkAdd(data.customPlaylists);
                }
            });

            await restoreStep('Playlist Category Links', async () => {
                if (data.playlistCategoryLinks && data.playlistCategoryLinks.length > 0) {
                    await db.playlistCategoryLinks.bulkAdd(data.playlistCategoryLinks);
                }
            });

            await restoreStep('Category Folders', async () => {
                if (data.categoryFolders && data.categoryFolders.length > 0) {
                    const folders = data.categoryFolders.map(f => ({
                        folder_id: f.folderId,
                        playlist_id: f.playlistId,
                        name: f.name,
                        display_order: f.displayOrder,
                        created_at: f.createdAt
                    }));
                    await db.categoryFolders.bulkAdd(folders);
                }
            });

            await restoreStep('Playlist Individual Channels', async () => {
                if (data.playlistIndividualChannels && data.playlistIndividualChannels.length > 0) {
                    await db.playlistIndividualChannels.bulkAdd(data.playlistIndividualChannels);
                }
            });
        });

        // 5. Restore Custom Groups (separate transaction to keep original pattern)
        if (data.customGroups && data.customGroups.length > 0) {
            try {
                console.log('[Import] Starting: Custom Groups...');
                await db.transaction('rw', [db.customGroups, db.customGroupChannels], async () => {
                    // MUST clear child customGroupChannels before parent customGroups to avoid FK failures
                    await db.customGroupChannels.clear();
                    await db.customGroups.clear();

                    for (const group of data.customGroups!) {
                        await db.customGroups.add({
                            group_id: group.groupId,
                            name: group.name,
                            display_order: group.displayOrder,
                            created_at: Date.now()
                        });

                        if (group.channels && group.channels.length > 0) {
                            const now = Date.now();
                            const groupChannels: CustomGroupChannel[] = group.channels.map((streamId, index) => ({
                                group_id: group.groupId,
                                stream_id: streamId,
                                display_order: index,
                                added_at: now
                            }));
                            await db.customGroupChannels.bulkAdd(groupChannels);
                        }
                    }
                });
                console.log('[Import] Success: Custom Groups');
            } catch (e) {
                console.error('[Import] FAILURE: Custom Groups. Error:', e);
                throw new Error(i18n.t('settings:importExport.restoreCustomGroupsFailed', { detail: e instanceof Error ? e.message : String(e) }));
            }
        }

        return { success: true };

    } catch (err) {
        console.error('Import failed:', err);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
