import { mkdir, readDir, remove } from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { exportAllDataToPath } from '../utils/exportImport';
import { useUIStore } from '../stores/uiStore';

const BACKUP_DIR = 'backups';
const BACKUP_PREFIX = 'ynotv-backup-';
const LAST_BACKUP_KEY = 'ynotv:lastAutoBackupAt';
// Seeded once on first launch so a fresh install waits a full interval before
// its first backup instead of backing up an empty database at startup.
const INSTALL_TIME_KEY = 'ynotv:autoBackupInstalledAt';

export interface AutoBackupSettings {
    enabled: boolean;
    intervalHours: number;
    maxBackups: number;
    /** Absolute path of a user-chosen backup folder; empty means the default app-data folder. */
    directory: string;
}

export const AUTO_BACKUP_DEFAULTS: AutoBackupSettings = {
    enabled: true,
    intervalHours: 24,
    maxBackups: 5,
    directory: '',
};

/** Read the auto-backup settings from the persisted app settings store. */
export async function readAutoBackupSettings(): Promise<AutoBackupSettings> {
    try {
        const result = await window.storage?.getSettings();
        const s = (result?.data ?? {}) as Record<string, any>;
        return {
            enabled: s.autoBackupEnabled ?? AUTO_BACKUP_DEFAULTS.enabled,
            intervalHours: s.autoBackupIntervalHours ?? AUTO_BACKUP_DEFAULTS.intervalHours,
            maxBackups: s.autoBackupMaxBackups ?? AUTO_BACKUP_DEFAULTS.maxBackups,
            directory: typeof s.autoBackupDirectory === 'string' ? s.autoBackupDirectory : AUTO_BACKUP_DEFAULTS.directory,
        };
    } catch (e) {
        console.warn('[AutoBackup] Failed to read settings, using defaults:', e);
        return { ...AUTO_BACKUP_DEFAULTS };
    }
}

function formatTimestamp(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function getLastBackupAt(): number | null {
    try {
        const raw = localStorage.getItem(LAST_BACKUP_KEY);
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

/** Record the first-launch timestamp if it has not been recorded yet. */
function seedInstallTime(): void {
    try {
        if (localStorage.getItem(INSTALL_TIME_KEY) === null) {
            localStorage.setItem(INSTALL_TIME_KEY, String(Date.now()));
        }
    } catch {
        // Non-fatal: without a seed the first backup simply fires sooner.
    }
}

/** First-launch timestamp used to delay the very first backup by one interval. */
function getInstallTime(): number | null {
    try {
        const raw = localStorage.getItem(INSTALL_TIME_KEY);
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null;
    }
}

/** Absolute path of the active backup folder (custom choice or the default app-data folder). */
export async function getBackupDirPath(): Promise<string> {
    const settings = await readAutoBackupSettings();
    if (settings.directory && settings.directory.trim().length > 0) {
        return settings.directory.trim();
    }
    return join(await appDataDir(), BACKUP_DIR);
}

/** Whether the user has chosen a custom (non-default) backup folder. */
export async function hasCustomBackupDir(): Promise<boolean> {
    const settings = await readAutoBackupSettings();
    return Boolean(settings.directory && settings.directory.trim().length > 0);
}

/** Open a native folder picker and return the chosen path, or null if canceled. */
export async function pickBackupFolder(): Promise<string | null> {
    try {
        const selected = await open({
            directory: true,
            recursive: true,
            multiple: false,
            title: 'Choose backup folder',
        });
        return typeof selected === 'string' ? selected : null;
    } catch (e) {
        console.error('[AutoBackup] Failed to pick a folder:', e);
        return null;
    }
}

/** Names of existing backup files in the given directory, oldest first. */
export async function listBackups(dir: string): Promise<string[]> {
    try {
        await mkdir(dir, { recursive: true }).catch(() => {});
        const entries = await readDir(dir);
        return entries
            .filter((e) => e.isFile && e.name.startsWith(BACKUP_PREFIX) && e.name.endsWith('.json'))
            .map((e) => e.name)
            .sort();
    } catch (e) {
        console.error('[AutoBackup] Failed to list backups in', dir, e);
        return [];
    }
}

/** Delete the oldest backups in a directory until at most `maxBackups` remain. */
async function pruneBackups(dir: string, maxBackups: number): Promise<void> {
    if (!maxBackups || maxBackups <= 0) return;
    const names = await listBackups(dir);
    const toDelete = names.slice(0, Math.max(0, names.length - maxBackups));
    for (const name of toDelete) {
        try {
            await remove(await join(dir, name));
        } catch (e) {
            console.warn('[AutoBackup] Failed to remove old backup:', name, e);
        }
    }
}

let backupInFlight = false;

/** Write a new backup file now and prune according to the max-backups setting. */
export async function runAutoBackupNow(): Promise<{ success: boolean; filePath?: string; error?: string }> {
    if (backupInFlight) return { success: false, error: 'A backup is already in progress' };
    backupInFlight = true;
    try {
        const dir = await getBackupDirPath();
        await mkdir(dir, { recursive: true }).catch(() => {});
        const fileName = `${BACKUP_PREFIX}${formatTimestamp()}.json`;
        const fullPath = await join(dir, fileName);

        const result = await exportAllDataToPath(fullPath);
        if (!result.success) return { success: false, error: result.error };

        try {
            localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
        } catch (e) {
            // Non-fatal: last-backup timestamp is only used for scheduling.
        }

        const settings = await readAutoBackupSettings();
        await pruneBackups(dir, settings.maxBackups);
        return { success: true, filePath: fullPath };
    } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
        backupInFlight = false;
    }
}

/** Open the backup folder in the OS file manager (best effort). */
export async function openBackupFolder(): Promise<void> {
    try {
        const dir = await getBackupDirPath();
        await mkdir(dir, { recursive: true }).catch(() => {});
        try {
            await openPath(dir);
        } catch (e) {
            // Fallback: reveal the newest backup file in its folder.
            const names = await listBackups(dir);
            if (names.length > 0) {
                const newest = await join(dir, names[names.length - 1]);
                await revealItemInDir(newest);
            }
        }
    } catch (e) {
        console.error('[AutoBackup] Failed to open backup folder:', e);
    }
}

// ── Scheduler ────────────────────────────────────────────────────────────────
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerStarted = false;
let syncWatchUnsubscribe: (() => void) | null = null;
// Last time any sync was observed active. The backup requires a quiet window
// after this so a sync whose startup is delayed doesn't slip in right after the
// idle check and race the backup.
let lastSyncActiveAt = 0;

function clearTimer() {
    if (schedulerTimer) {
        clearTimeout(schedulerTimer);
        schedulerTimer = null;
    }
}

/** Whether an EPG/VOD/TMDB sync is currently running (would make a backup race with it). */
function isSyncInProgress(): boolean {
    try {
        const s = useUIStore.getState();
        return Boolean(s.channelSyncing || s.vodSyncing || s.tmdbMatching);
    } catch {
        return false;
    }
}

/**
 * Resolve once no sync is in progress AND a quiet period has elapsed since the
 * last sync activity. Polls every 3s; falls through after a safety timeout so a
 * stuck flag can never block backups forever.
 */
async function waitForSyncIdle(quietPeriodMs = 30_000, timeoutMs = 30 * 60 * 1000): Promise<void> {
    const started = Date.now();
    await new Promise<void>((resolve) => {
        const tick = () => {
            const idle = !isSyncInProgress();
            const quiet = Date.now() - lastSyncActiveAt >= quietPeriodMs;
            if ((idle && quiet) || Date.now() - started >= timeoutMs) {
                clearInterval(interval);
                resolve();
            }
        };
        const interval = setInterval(tick, 3000);
        tick();
    });
}

async function scheduleNext(): Promise<void> {
    clearTimer();
    const settings = await readAutoBackupSettings();
    if (!settings.enabled) return;

    const intervalMs = Math.max(1, settings.intervalHours) * 60 * 60 * 1000;
    // Treat the install time as the baseline until a real backup exists, so a
    // fresh install waits a full interval rather than backing up at startup.
    const last = getLastBackupAt() ?? getInstallTime();
    const due = !last || Date.now() - last >= intervalMs;
    // Give the app a few seconds to settle before the very first backup.
    const delay = due ? 5000 : Math.max(1000, intervalMs - (Date.now() - last));

    schedulerTimer = setTimeout(async () => {
        await waitForSyncIdle();
        const result = await runAutoBackupNow();
        if (!result.success) {
            console.error('[AutoBackup] Scheduled backup failed:', result.error);
        } else {
            console.log('[AutoBackup] Backup written:', result.filePath);
        }
        void scheduleNext();
    }, delay);
}

export function startAutoBackupScheduler(): void {
    if (schedulerStarted) return;
    schedulerStarted = true;
    seedInstallTime();
    // Treat launch as a moment where a startup sync may be about to begin, so a
    // backup that is due at launch waits out that sync even though its flag is
    // only set a few seconds in.
    lastSyncActiveAt = Date.now();
    if (!syncWatchUnsubscribe) {
        try {
            syncWatchUnsubscribe = useUIStore.subscribe((state) => {
                if (state.channelSyncing || state.vodSyncing || state.tmdbMatching) {
                    lastSyncActiveAt = Date.now();
                }
            });
        } catch (e) {
            syncWatchUnsubscribe = null;
        }
    }
    void scheduleNext();
    window.addEventListener('ynotv:auto-backup-settings-changed', scheduleNext);
}

export function stopAutoBackupScheduler(): void {
    clearTimer();
    schedulerStarted = false;
    if (syncWatchUnsubscribe) {
        syncWatchUnsubscribe();
        syncWatchUnsubscribe = null;
    }
    window.removeEventListener('ynotv:auto-backup-settings-changed', scheduleNext);
}
