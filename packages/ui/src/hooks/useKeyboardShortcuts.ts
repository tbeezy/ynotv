/**
 * useKeyboardShortcuts.ts
 *
 * Attaches a global `keydown` listener and dispatches to action handlers
 * based on the user's configured shortcut map.
 *
 * Uses the "latest ref" pattern to access current state values without
 * triggering re-registrations of the event listener. All options are stored
 * in a single ref that is updated synchronously during render.
 */

import { useEffect, useRef } from 'react';
import type { ShortcutAction, ShortcutsMap } from '../types/app';
import { DEFAULT_SHORTCUTS } from '../constants/shortcuts';
import type { StoredChannel } from '../db';
import type { LayoutMode } from './useMultiview';
import type { View } from '../components/Sidebar';

export interface UseKeyboardShortcutsOptions {
    // --- Current state values (accessed via latest ref pattern) ---
    shortcuts: ShortcutsMap;
    activeView: View;
    showSettingsPopup: boolean;
    categoriesOpen: boolean;
    categoriesHidden: boolean;
    position: number;
    currentChannels: StoredChannel[];
    currentChannel: StoredChannel | null;
    switchLayout: ((layout: LayoutMode) => void) | null;
    titleBarSearchRef: React.RefObject<HTMLInputElement | null>;
    handlePlayChannel: (channel: StoredChannel, autoSwitched?: boolean) => void;
    lastPlayedChannel: StoredChannel | null;

    // --- Action callbacks ---
    handleTogglePlay: () => void;
    handleToggleMute: () => void;
    handleToggleStats: () => void;
    handleToggleFullscreen: () => void;
    handleShowSubtitleModal: () => void;
    handleShowAudioModal: () => void;
    handleSeek: (position: number) => void;
    handleToggleEpgView: () => void;
    setActiveView: React.Dispatch<React.SetStateAction<View>>;
    setShowSettingsPopup: React.Dispatch<React.SetStateAction<boolean>>;
    setCategoriesOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setSidebarExpanded: React.Dispatch<React.SetStateAction<boolean>>;
    setShowControls: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Registers a global keydown listener that fires the appropriate action when
 * the user presses a configured shortcut key.
 *
 * Uses the latest ref pattern to avoid stale closures - all state is accessed
 * through a single ref that is updated synchronously during render.
 * The listener is attached once on mount and removed on unmount.
 */
export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): void {
    // Store all options in a single ref, updated synchronously during render
    const latestRefs = useRef(options);
    latestRefs.current = options;

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Don't handle shortcuts when typing in inputs
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement
            ) {
                return;
            }

            // Access all values through the latest ref
            const {
                shortcuts,
                activeView,
                showSettingsPopup,
                categoriesOpen,
                categoriesHidden,
                position,
                currentChannels,
                currentChannel,
                switchLayout,
                titleBarSearchRef,
                handlePlayChannel,
                lastPlayedChannel,
                handleTogglePlay,
                handleToggleMute,
                handleToggleStats,
                handleToggleFullscreen,
                handleShowSubtitleModal,
                handleShowAudioModal,
                handleSeek,
                handleToggleEpgView,
                setActiveView,
                setShowSettingsPopup,
                setCategoriesOpen,
                setSidebarExpanded,
                setShowControls,
            } = latestRefs.current;

            // Helper to match keys case-insensitively for letters
            const matches = (action: ShortcutAction, eventKey: string): boolean => {
                const storedKey = shortcuts[action] || DEFAULT_SHORTCUTS[action];
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
                setShowControls(true);
                if (activeView === 'guide') {
                    // LiveTV is open, close it entirely
                    setActiveView('none');
                    setCategoriesOpen(false);
                } else {
                    // Open LiveTV, respect user's category hidden preference
                    setActiveView('guide');
                    setCategoriesOpen(!categoriesHidden);
                }
            } else if (matches('toggleSettings', e.key)) {
                e.preventDefault();
                // Toggle settings popup if in main layout, otherwise toggle full view
                setShowSettingsPopup((show) => !show);
            } else if (matches('toggleSports', e.key)) {
                e.preventDefault();
                setCategoriesOpen(false);
                setActiveView((v) => (v === 'sports' ? 'none' : 'sports'));
            } else if (matches('toggleDvr', e.key)) {
                e.preventDefault();
                setCategoriesOpen(false);
                setActiveView((v) => (v === 'dvr' ? 'none' : 'dvr'));
            } else if (matches('toggleCalendar', e.key)) {
                e.preventDefault();
                setCategoriesOpen(false);
                setActiveView((v) => (v === 'calendar' ? 'none' : 'calendar'));
            } else if (matches('toggleEpgView', e.key)) {
                e.preventDefault();
                handleToggleEpgView();
            } else if (matches('focusSearch', e.key)) {
                e.preventDefault();
                setShowControls(true);
                if (activeView !== 'guide') {
                    setActiveView('guide');
                }
                setCategoriesOpen(true);
                if (titleBarSearchRef.current) {
                    titleBarSearchRef.current.focus();
                }
            } else if (matches('close', e.key)) {
                // Close settings popup first if open
                if (showSettingsPopup) {
                    setShowSettingsPopup(false);
                } else {
                    setActiveView('none');
                }
                setCategoriesOpen(false);
                setSidebarExpanded(false);
                setShowControls(false);
            } else if (matches('seekForward', e.key)) {
                e.preventDefault();
                handleSeek(position + 10);
            } else if (matches('seekBackward', e.key)) {
                e.preventDefault();
                handleSeek(position - 10);
            } else if (matches('layoutMain', e.key)) {
                e.preventDefault();
                switchLayout?.('main');
            } else if (matches('layoutPip', e.key)) {
                e.preventDefault();
                switchLayout?.('pip');
            } else if (matches('layoutBigBottom', e.key)) {
                e.preventDefault();
                switchLayout?.('bigbottom');
            } else if (matches('layout2x2', e.key)) {
                e.preventDefault();
                switchLayout?.('2x2');
            } else if (matches('channelUp', e.key)) {
                e.preventDefault();
                if (currentChannels.length > 0 && currentChannel) {
                    const currentIndex = currentChannels.findIndex((ch) => ch.stream_id === currentChannel.stream_id);
                    if (currentIndex > 0) {
                        handlePlayChannel(currentChannels[currentIndex - 1]);
                    } else if (currentIndex === 0) {
                        // Wrap to last channel
                        handlePlayChannel(currentChannels[currentChannels.length - 1]);
                    }
                }
            } else if (matches('channelDown', e.key)) {
                e.preventDefault();
                if (currentChannels.length > 0 && currentChannel) {
                    const currentIndex = currentChannels.findIndex((ch) => ch.stream_id === currentChannel.stream_id);
                    if (currentIndex >= 0 && currentIndex < currentChannels.length - 1) {
                        handlePlayChannel(currentChannels[currentIndex + 1]);
                    } else if (currentIndex === currentChannels.length - 1) {
                        // Wrap to first channel
                        handlePlayChannel(currentChannels[0]);
                    }
                }
            } else if (matches('replayLastStream', e.key)) {
                e.preventDefault();
                if (lastPlayedChannel) {
                    handlePlayChannel(lastPlayedChannel);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []); // Empty dep array: all state accessed via latest ref
}
