/**
 * Default keyboard shortcuts — single source of truth.
 * Imported by both App.tsx (runtime) and ShortcutsTab.tsx (settings UI).
 *
 * Keys are ShortcutAction identifiers, values are the default key strings.
 * Users can override these via Settings → Shortcuts.
 */
import type { ShortcutAction } from '../types/app';

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
    toggleSettings: ',',
    focusSearch: 's',
    close: 'Escape',
    seekForward: 'ArrowRight',
    seekBackward: 'ArrowLeft',
    layoutMain: '1',
    layoutPip: '2',
    layoutBigBottom: '3',
    layout2x2: '4',
};
