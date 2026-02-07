import { db, type StoredChannel, type StoredCategory } from '../db';
import type { AppSettings, Source, ShortcutsMap } from '../types/electron';

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
    }>;
}

const EXPORT_VERSION = 1;

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
        const favorites = await db.channels
            .filter(ch => ch.is_favorite === true)
            .toArray();
        const favoriteData = favorites.map(ch => ({
            streamId: ch.stream_id,
            sourceId: ch.source_id
        }));

        // 3. Get Category Preferences
        const allCategories = await db.categories.toArray();
        const categoryCallback = (cat: StoredCategory) => {
            return cat.enabled === false || (cat.display_order !== undefined && cat.display_order !== 0);
        };

        const categoryPreferences = allCategories
            .filter(categoryCallback)
            .map(cat => ({
                categoryId: cat.category_id,
                sourceId: cat.source_id,
                enabled: cat.enabled,
                displayOrder: cat.display_order
            }));

        const exportData: ExportData = {
            version: EXPORT_VERSION,
            timestamp: new Date().toISOString(),
            sources: sourcesResult.data || [],
            settings: settingsResult.data || { theme: 'dark' },
            favorites: favoriteData,
            categoryPreferences
        };

        const fileName = `sbtltv-backup-${new Date().toISOString().split('T')[0]}.json`;
        const result = await window.storage.saveJsonFile(JSON.stringify(exportData, null, 2), fileName);

        if (result.canceled) return { success: false, error: 'Cancelled' };
        if (result.error) throw new Error(result.error);

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

        // 1. Open File
        const fileResult = await window.storage.openJsonFile();
        if (fileResult.canceled) return { success: false, error: 'Cancelled' };
        if (fileResult.error) throw new Error(fileResult.error);
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

        // 4. Restore Favorites & Category Preferences to IndexedDB
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

            // Restore Category Preference stubs
            if (data.categoryPreferences && data.categoryPreferences.length > 0) {
                const catStubs = data.categoryPreferences.map(pref => ({
                    category_id: pref.categoryId,
                    source_id: pref.sourceId,
                    category_name: 'Unknown', // Placeholder
                    enabled: pref.enabled,
                    display_order: pref.displayOrder
                } as StoredCategory));

                await db.categories.bulkAdd(catStubs);
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
