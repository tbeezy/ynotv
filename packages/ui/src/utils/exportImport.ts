import { db, type StoredChannel, type StoredCategory } from '../db';
import type { Source } from '@ynotv/core';
import type { AppSettings, ShortcutsMap } from '../types/app';
import { Bridge } from '../services/tauri-bridge';
import { normalizeBoolean } from './db-helpers';

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
    }>;
    channelPreferences: Array<{
        streamId: string;
        sourceId: string;
        enabled?: boolean;
    }>;
}

const EXPORT_VERSION = 2;

/**
 * Export all application data to a JSON file
 */
export async function exportAllData(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    try {
        if (!window.storage) throw new Error('Storage API not available');

        // 1. Get Sources and Settings
        const sourcesResult = await window.storage.getSources();
        const settingsResult = await window.storage.getSettings();

        if (sourcesResult.error) throw new Error(sourcesResult.error);
        if (settingsResult.error) throw new Error(settingsResult.error);

        // 2. Get Favorites from DB
        const allChannels = await db.channels.toArray();
        const favorites = allChannels.filter(ch => normalizeBoolean(ch.is_favorite));
        const favoriteData = favorites.map(ch => ({
            streamId: ch.stream_id,
            sourceId: ch.source_id
        }));

        // 3. Get Category Preferences (including filter words)
        const allCategories = await db.categories.toArray();
        const categoryCallback = (cat: StoredCategory) => {
            // SQLite returns BOOLEAN as 0/1, handle both cases
            const enabled = cat.enabled as boolean | number | undefined;
            const isDisabled = enabled === false || enabled === 0;
            const hasCustomSettings = isDisabled ||
                (cat.display_order !== undefined && cat.display_order !== 0) ||
                (cat.filter_words && cat.filter_words.length > 0);
            return hasCustomSettings;
        };

        const categoryPreferences = allCategories
            .filter(categoryCallback)
            .map(cat => ({
                categoryId: cat.category_id,
                sourceId: cat.source_id,
                enabled: cat.enabled,
                displayOrder: cat.display_order,
                filterWords: cat.filter_words
            }));

        // 4. Get Channel Preferences (enabled/disabled status)
        const channelCallback = (ch: StoredChannel) => {
            const enabled = ch.enabled as boolean | number | undefined;
            // Only include if channel has been explicitly disabled
            return enabled === false || enabled === 0;
        };

        const channelPreferences = allChannels
            .filter(channelCallback)
            .map(ch => ({
                streamId: ch.stream_id,
                sourceId: ch.source_id,
                enabled: ch.enabled
            }));

        const exportData: ExportData = {
            version: EXPORT_VERSION,
            timestamp: new Date().toISOString(),
            sources: sourcesResult.data || [],
            settings: settingsResult.data || { theme: 'glass-neon' },
            favorites: favoriteData,
            categoryPreferences,
            channelPreferences
        };

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
 * Import application data from a JSON file
 */
export async function importAllData(): Promise<{ success: boolean; error?: string }> {
    try {
        if (!window.storage) throw new Error('Storage API not available');

        // 1. Open File via Bridge
        const fileResult = await Bridge.openJsonFile();
        if (fileResult.canceled) return { success: false, error: 'Cancelled' };

        if (!fileResult.data) throw new Error('Failed to read file');

        const data: ExportData = JSON.parse(fileResult.data);

        // Basic validation
        if (!data.version || !data.sources || !data.settings) {
            throw new Error('Invalid backup file format');
        }

        // 2. Restore Settings
        await window.storage.updateSettings(data.settings);

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

        // 4. Restore Favorites & Category Preferences to SQLite
        // We restore them as "stub" records. The sync process will later fill in the full details
        // but preserve these flags because logic in syncSource (db/sync.ts) reads existing records first.

        await db.transaction('rw', [db.channels, db.categories], async () => {
            // Clear existing DB data for cleanliness? 
            // Ideally yes, user is "Importing" a full state.
            await db.channels.clear();
            await db.categories.clear();

            // Restore Favorites stubs
            if (data.favorites && data.favorites.length > 0) {
                const favoriteStubs = data.favorites.map(fav => ({
                    stream_id: fav.streamId,
                    source_id: fav.sourceId,
                    name: 'Unknown', // Placeholder, will be overwritten by sync
                    category_ids: [],
                    is_favorite: true
                } as unknown as StoredChannel));

                await db.channels.bulkAdd(favoriteStubs);
            }

            // Restore Category Preference stubs (including filter words)
            if (data.categoryPreferences && data.categoryPreferences.length > 0) {
                const catStubs = data.categoryPreferences.map(pref => ({
                    category_id: pref.categoryId,
                    source_id: pref.sourceId,
                    category_name: 'Unknown', // Placeholder
                    enabled: pref.enabled,
                    display_order: pref.displayOrder,
                    filter_words: pref.filterWords
                } as StoredCategory));

                await db.categories.bulkAdd(catStubs);
            }

            // Restore Channel Preference stubs (enabled/disabled status)
            if (data.channelPreferences && data.channelPreferences.length > 0) {
                const channelStubs = data.channelPreferences.map(pref => ({
                    stream_id: pref.streamId,
                    source_id: pref.sourceId,
                    name: 'Unknown', // Placeholder, will be overwritten by sync
                    category_ids: [],
                    enabled: pref.enabled
                } as unknown as StoredChannel));

                await db.channels.bulkAdd(channelStubs);
            }
        });

        // 5. Trigger a reload or notify user? e.g., reload window to refresh Stores
        // For now, we return success and let UI handle the notification/reload prompt.

        return { success: true };

    } catch (err) {
        console.error('Import failed:', err);
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}
