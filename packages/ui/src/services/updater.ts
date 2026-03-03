import { check, Update, DownloadEvent } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

// Global state to control the update modal
let updateModalOpen = false;
let updateModalCallback: ((open: boolean) => void) | null = null;
let pendingUpdateCheck = false;

/**
 * Register a callback to control the update modal visibility
 */
export function registerUpdateModal(callback: (open: boolean) => void) {
  updateModalCallback = callback;
}

/**
 * Show the update modal
 */
export function showUpdateModal() {
  updateModalOpen = true;
  updateModalCallback?.(true);
}

/**
 * Hide the update modal
 */
export function hideUpdateModal() {
  updateModalOpen = false;
  updateModalCallback?.(false);
}

/**
 * Check if update modal should be shown (for startup check)
 */
export function shouldShowUpdateModal(): boolean {
  return pendingUpdateCheck;
}

/**
 * Clear the pending update check flag
 */
export function clearPendingUpdateCheck() {
  pendingUpdateCheck = false;
}

/**
 * Trigger manual update check - opens the modal immediately
 */
export function checkForUpdates(): void {
  showUpdateModal();
}

/**
 * Silently check for updates on startup.
 * Sets a flag so the modal will be shown if an update is available.
 */
export async function checkForUpdatesSilent(): Promise<void> {
  try {
    console.log('[Updater] Checking for updates (silent)...');

    const update = await check();

    if (update === null) {
      console.log('[Updater] No update available');
      return;
    }

    console.log('[Updater] Update available:', update.version);

    // Set flag so App.tsx will show the modal
    pendingUpdateCheck = true;
    showUpdateModal();
  } catch (error) {
    console.error('[Updater] Failed to check for updates:', error);
  }
}
