/**
 * Default keyboard shortcuts — single source of truth.
 * Imported by both App.tsx (runtime) and ShortcutsTab.tsx (settings UI).
 *
 * Keys are ShortcutAction identifiers, values are the default key strings.
 * Users can override these via Settings → Shortcuts.
 *
 * Mouse buttons are supported as shortcut keys using the special values
 * 'MouseBack' (X1 / browser-back button, e.button === 3) and 'MouseForward'
 * (X2 / browser-forward button, e.button === 4).
 */
import type { ShortcutAction, ShortcutsMap } from '../types/app';

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
    togglePlay: ' ',
    toggleMute: 'm',
    cycleSubtitle: 'j',
    cycleAudio: 'a',
    selectSubtitle: 'j',
    selectAudio: 'a',
    toggleStats: 'i',
    toggleFullscreen: 'f',
    toggleGuide: 'g',
    toggleCategories: 'c',
    toggleLiveTV: 'l',
    toggleDvr: 'r',
    toggleSports: 'u',
    toggleCalendar: 't',
    toggleSettings: ',',
    focusSearch: 's',
    close: 'Escape',
    seekForward: 'ArrowRight',
    seekBackward: 'ArrowLeft',
    layoutMain: '1',
    layoutPip: '2',
    layoutBigBottom: '3',
    layout2x2: '4',
    channelUp: 'ArrowUp',
    channelDown: 'ArrowDown',
    toggleEpgView: 'e',
    replayLastStream: 'q',
    toggleTransparentGuide: 'z',
    toggleNuvio: 'n',
    toggleStrem: 'x',
    toggleJellyfin: 'k',
    toggleShortcutsOverlay: '/',
    toggleConnectionInfo: 'o',
    // Which mouse button triggers the app's built-in "go back" navigation
    // (close settings popup, stop playback, exit a view). Rebind or claim it
    // for another action to free up the mouse back button.
    mouseBackNavigation: 'MouseBack',
};

// Maps MouseEvent.button to the shortcut key identifier used in this file.
export const MOUSE_BUTTON_SHORTCUTS: Record<number, string> = {
    3: 'MouseBack',
    4: 'MouseForward',
};

/** Formats a stored shortcut key for display (e.g. in the settings UI). */
export function formatShortcutKey(key: string): string {
    if (!key) return '';
    if (key === ' ') return 'Space';
    if (key === 'MouseBack') return 'Mouse Back (X1)';
    if (key === 'MouseForward') return 'Mouse Forward (X2)';
    if (key === 'ArrowUp') return '↑';
    if (key === 'ArrowDown') return '↓';
    if (key === 'ArrowLeft') return '←';
    if (key === 'ArrowRight') return '→';
    if (key === 'Escape') return 'Esc';
    if (key === 'Enter') return 'Enter';
    if (key === 'Tab') return 'Tab';
    if (key === 'Control') return 'Ctrl';
    if (key === 'Meta') return 'Cmd';
    if (key === 'Alt') return 'Alt';
    if (key === 'Shift') return 'Shift';
    return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Returns true if `button` (a MouseEvent.button value) should trigger the app's
 * built-in back navigation for the current shortcut configuration. This is the
 * case when the button matches the user's `mouseBackNavigation` binding AND that
 * button isn't claimed by another shortcut action (e.g. rebound to channel up/
 * down) — the other action takes priority.
 */
export function isMouseBackButtonActive(shortcuts: ShortcutsMap, button: number): boolean {
    const binding = shortcuts.mouseBackNavigation || DEFAULT_SHORTCUTS.mouseBackNavigation;
    const boundKey = MOUSE_BUTTON_SHORTCUTS[button];
    if (!boundKey || binding !== boundKey) return false;

    const effective = { ...DEFAULT_SHORTCUTS, ...shortcuts };
    return !Object.entries(effective).some(
        ([action, value]) => action !== 'mouseBackNavigation' && value === boundKey
    );
}
