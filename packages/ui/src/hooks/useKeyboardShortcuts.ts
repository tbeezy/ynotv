/**
 * useKeyboardShortcuts.ts
 *
 * Attaches a global `keydown` listener and dispatches to action handlers
 * based on the user's configured shortcut map.
 *
 * Previously this was an inline useEffect inside App.tsx (lines 1086-1248).
 * All action handlers and refs are passed in via the options object so this
 * hook has zero knowledge of React state — it only reads refs and calls
 * callbacks. This makes the dependency array stay empty ([]) exactly as
 * it was before, avoiding re-registration on every render.
 *
 * The hook is intentionally NOT responsible for loading shortcuts from
 * storage — that's still done by useAutoSync which calls onShortcutsLoaded.
 */

import { useEffect, type RefObject, type MutableRefObject } from 'react';
import type { ShortcutAction, ShortcutsMap } from '../types/app';
import { DEFAULT_SHORTCUTS } from '../constants/shortcuts';
import type { StoredChannel } from '../db';
import type { LayoutMode } from './useMultiview';
import type { View } from '../components/Sidebar';

export interface UseKeyboardShortcutsOptions {
    // --- Refs to current state values (avoid stale closures) ---
    shortcutsRef: MutableRefObject<ShortcutsMap>;
    activeViewRef: MutableRefObject<View>;
    categoriesOpenRef: MutableRefObject<boolean>;
    positionRef: MutableRefObject<number>;
    currentChannelsRef: MutableRefObject<StoredChannel[]>;
    currentChannelRef: MutableRefObject<StoredChannel | null>;
    switchLayoutRef: MutableRefObject<((layout: LayoutMode) => void) | null>;
    titleBarSearchRef: RefObject<HTMLInputElement | null>;
    handlePlayChannelRef: MutableRefObject<(channel: StoredChannel) => void>;
    lastPlayedChannelRef: MutableRefObject<StoredChannel | null>;

    // --- Action callbacks (as refs to avoid stale closures) ---
    handleTogglePlayRef: MutableRefObject<() => void>;
    handleToggleMuteRef: MutableRefObject<() => void>;
    handleToggleStatsRef: MutableRefObject<() => void>;
    handleToggleFullscreenRef: MutableRefObject<() => void>;
    handleShowSubtitleModalRef: MutableRefObject<() => void>;
    handleShowAudioModalRef: MutableRefObject<() => void>;
    handleSeekRef: MutableRefObject<(position: number) => void>;
    handleToggleEpgViewRef: MutableRefObject<() => void>;
    setActiveViewRef: MutableRefObject<React.Dispatch<React.SetStateAction<View>>>;
    setCategoriesOpenRef: MutableRefObject<React.Dispatch<React.SetStateAction<boolean>>>;
    setSidebarExpandedRef: MutableRefObject<React.Dispatch<React.SetStateAction<boolean>>>;
    setShowControlsRef: MutableRefObject<React.Dispatch<React.SetStateAction<boolean>>>;
}

/**
 * Registers a global keydown listener that fires the appropriate action when
 * the user presses a configured shortcut key.
 *
 * Call once at the app root level with stable (ref-based) callbacks.
 * The listener is attached once on mount and removed on unmount.
 */
export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): void {
    const {
        shortcutsRef,
        activeViewRef,
        categoriesOpenRef,
        positionRef,
        currentChannelsRef,
        currentChannelRef,
        switchLayoutRef,
        titleBarSearchRef,
        handlePlayChannelRef,
        lastPlayedChannelRef,
        handleTogglePlayRef,
        handleToggleMuteRef,
        handleToggleStatsRef,
        handleToggleFullscreenRef,
        handleShowSubtitleModalRef,
        handleShowAudioModalRef,
        handleSeekRef,
        handleToggleEpgViewRef,
        setActiveViewRef,
        setCategoriesOpenRef,
        setSidebarExpandedRef,
        setShowControlsRef,
    } = options;

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't handle shortcuts when typing in inputs
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement
            ) {
                return;
            }

            const currentShortcuts = shortcutsRef.current;

            // Helper to match keys case-insensitively for letters
            const matches = (action: ShortcutAction, eventKey: string): boolean => {
                const storedKey = currentShortcuts[action] || DEFAULT_SHORTCUTS[action];
                if (!storedKey) return false;

                // Precise match first
                if (eventKey === storedKey) return true;

                // Case-insensitive match for single letters
                if (eventKey.length === 1 && storedKey.length === 1) {
                    return eventKey.toLowerCase() === storedKey.toLowerCase();
                }

                return false;
            };

            if (matches('togglePlay', e.key)) {
                e.preventDefault();
                handleTogglePlayRef.current();
            } else if (matches('toggleMute', e.key)) {
                handleToggleMuteRef.current();
            } else if (matches('toggleStats', e.key)) {
                e.preventDefault();
                handleToggleStatsRef.current();
            } else if (matches('toggleFullscreen', e.key)) {
                e.preventDefault();
                handleToggleFullscreenRef.current();
            } else if (matches('selectSubtitle', e.key)) {
                e.preventDefault();
                handleShowSubtitleModalRef.current();
            } else if (matches('selectAudio', e.key)) {
                e.preventDefault();
                handleShowAudioModalRef.current();
            } else if (matches('toggleGuide', e.key)) {
                setActiveViewRef.current((v) => (v === 'guide' ? 'none' : 'guide'));
            } else if (matches('toggleCategories', e.key)) {
                setCategoriesOpenRef.current((open) => !open);
            } else if (matches('toggleLiveTV', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                const currentCategoriesOpen = categoriesOpenRef.current;

                setShowControlsRef.current(true);

                const newLiveTVState = !(currentActiveView === 'guide' && currentCategoriesOpen);
                if (newLiveTVState) {
                    setActiveViewRef.current('guide');
                    setCategoriesOpenRef.current(true);
                } else {
                    setActiveViewRef.current('none');
                    setCategoriesOpenRef.current(false);
                }
            } else if (matches('toggleSettings', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                setActiveViewRef.current(currentActiveView === 'settings' ? 'none' : 'settings');
            } else if (matches('toggleSports', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                setCategoriesOpenRef.current(false);
                setActiveViewRef.current(currentActiveView === 'sports' ? 'none' : 'sports');
            } else if (matches('toggleDvr', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                setCategoriesOpenRef.current(false);
                setActiveViewRef.current(currentActiveView === 'dvr' ? 'none' : 'dvr');
            } else if (matches('toggleCalendar', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                setCategoriesOpenRef.current(false);
                setActiveViewRef.current(currentActiveView === 'calendar' ? 'none' : 'calendar');
            } else if (matches('toggleEpgView', e.key)) {
                e.preventDefault();
                handleToggleEpgViewRef.current();
            } else if (matches('focusSearch', e.key)) {
                e.preventDefault();
                setShowControlsRef.current(true);
                if (activeViewRef.current !== 'guide') {
                    setActiveViewRef.current('guide');
                }
                setCategoriesOpenRef.current(true);
                if (titleBarSearchRef.current) {
                    titleBarSearchRef.current.focus();
                }
            } else if (matches('close', e.key)) {
                setActiveViewRef.current('none');
                setCategoriesOpenRef.current(false);
                setSidebarExpandedRef.current(false);
                setShowControlsRef.current(false);
            } else if (matches('seekForward', e.key)) {
                e.preventDefault();
                handleSeekRef.current(positionRef.current + 10);
            } else if (matches('seekBackward', e.key)) {
                e.preventDefault();
                handleSeekRef.current(positionRef.current - 10);
            } else if (matches('layoutMain', e.key)) {
                e.preventDefault();
                switchLayoutRef.current?.('main');
            } else if (matches('layoutPip', e.key)) {
                e.preventDefault();
                switchLayoutRef.current?.('pip');
            } else if (matches('layoutBigBottom', e.key)) {
                e.preventDefault();
                switchLayoutRef.current?.('bigbottom');
            } else if (matches('layout2x2', e.key)) {
                e.preventDefault();
                switchLayoutRef.current?.('2x2');
            } else if (matches('channelUp', e.key)) {
                e.preventDefault();
                const channels = currentChannelsRef.current;
                const currentCh = currentChannelRef.current;
                if (channels.length > 0 && currentCh) {
                    const currentIndex = channels.findIndex((ch) => ch.stream_id === currentCh.stream_id);
                    if (currentIndex > 0) {
                        handlePlayChannelRef.current(channels[currentIndex - 1]);
                    } else if (currentIndex === 0) {
                        // Wrap to last channel
                        handlePlayChannelRef.current(channels[channels.length - 1]);
                    }
                }
            } else if (matches('channelDown', e.key)) {
                e.preventDefault();
                const channels = currentChannelsRef.current;
                const currentCh = currentChannelRef.current;
                if (channels.length > 0 && currentCh) {
                    const currentIndex = channels.findIndex((ch) => ch.stream_id === currentCh.stream_id);
                    if (currentIndex >= 0 && currentIndex < channels.length - 1) {
                        handlePlayChannelRef.current(channels[currentIndex + 1]);
                    } else if (currentIndex === channels.length - 1) {
                        // Wrap to first channel
                        handlePlayChannelRef.current(channels[0]);
                    }
                }
            } else if (matches('replayLastStream', e.key)) {
                e.preventDefault();
                const lastChannel = lastPlayedChannelRef.current;
                if (lastChannel) {
                    handlePlayChannelRef.current(lastChannel);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []); // Empty dep array: all state accessed via refs, callbacks are stable
}
