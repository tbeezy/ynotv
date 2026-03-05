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

    // --- Action callbacks ---
    handleTogglePlay: () => void;
    handleToggleMute: () => void;
    handleToggleStats: () => void;
    handleToggleFullscreen: () => void;
    handleShowSubtitleModal: () => void;
    handleShowAudioModal: () => void;
    handleSeek: (position: number) => void;
    setActiveView: React.Dispatch<React.SetStateAction<View>>;
    setCategoriesOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setSidebarExpanded: React.Dispatch<React.SetStateAction<boolean>>;
    setShowControls: React.Dispatch<React.SetStateAction<boolean>>;
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

        handleTogglePlay,
        handleToggleMute,
        handleToggleStats,
        handleToggleFullscreen,
        handleShowSubtitleModal,
        handleShowAudioModal,
        handleSeek,
        setActiveView,
        setCategoriesOpen,
        setSidebarExpanded,
        setShowControls,
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
                handleTogglePlay();
            } else if (matches('toggleMute', e.key)) {
                handleToggleMute();
            } else if (matches('toggleStats', e.key)) {
                e.preventDefault();
                handleToggleStats();
            } else if (matches('toggleFullscreen', e.key)) {
                e.preventDefault();
                handleToggleFullscreen();
            } else if (matches('selectSubtitle', e.key)) {
                e.preventDefault();
                handleShowSubtitleModal();
            } else if (matches('selectAudio', e.key)) {
                e.preventDefault();
                handleShowAudioModal();
            } else if (matches('toggleGuide', e.key)) {
                setActiveView((v) => (v === 'guide' ? 'none' : 'guide'));
            } else if (matches('toggleCategories', e.key)) {
                setCategoriesOpen((open) => !open);
            } else if (matches('toggleLiveTV', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                const currentCategoriesOpen = categoriesOpenRef.current;

                setShowControls(true);

                const newLiveTVState = !(currentActiveView === 'guide' && currentCategoriesOpen);
                if (newLiveTVState) {
                    setActiveView('guide');
                    setCategoriesOpen(true);
                } else {
                    setActiveView('none');
                    setCategoriesOpen(false);
                }
            } else if (matches('toggleSettings', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                setActiveView(currentActiveView === 'settings' ? 'none' : 'settings');
            } else if (matches('toggleSports', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                setCategoriesOpen(false);
                setActiveView(currentActiveView === 'sports' ? 'none' : 'sports');
            } else if (matches('toggleDvr', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                setCategoriesOpen(false);
                setActiveView(currentActiveView === 'dvr' ? 'none' : 'dvr');
            } else if (matches('toggleCalendar', e.key)) {
                e.preventDefault();
                const currentActiveView = activeViewRef.current;
                setCategoriesOpen(false);
                setActiveView(currentActiveView === 'calendar' ? 'none' : 'calendar');
            } else if (matches('focusSearch', e.key)) {
                e.preventDefault();
                setShowControls(true);
                if (activeViewRef.current !== 'guide') {
                    setActiveView('guide');
                }
                setCategoriesOpen(true);
                if (titleBarSearchRef.current) {
                    titleBarSearchRef.current.focus();
                }
            } else if (matches('close', e.key)) {
                setActiveView('none');
                setCategoriesOpen(false);
                setSidebarExpanded(false);
                setShowControls(false);
            } else if (matches('seekForward', e.key)) {
                e.preventDefault();
                handleSeek(positionRef.current + 10);
            } else if (matches('seekBackward', e.key)) {
                e.preventDefault();
                handleSeek(positionRef.current - 10);
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
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []); // Empty dep array: all state accessed via refs, callbacks are stable
}
