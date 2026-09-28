/**
 * useKeyboardShortcuts.ts
 *
 * Attaches a global `keydown` + `mousedown` (mouse side buttons) listener and
 * dispatches to action handlers based on the user's configured shortcut map.
 *
 * Uses the "latest ref" pattern to access current state values without
 * triggering re-registrations of the event listener. All options are stored
 * in a single ref that is updated synchronously during render.
 */

import { useEffect, useRef } from 'react';
import type { ShortcutAction, ShortcutsMap } from '../types/app';
import { DEFAULT_SHORTCUTS, MOUSE_BUTTON_SHORTCUTS } from '../constants/shortcuts';
import type { StoredChannel } from '../db';
import type { LayoutMode } from './useMultiview';
import type { View } from './useNavigation';
import { Bridge } from '../services/tauri-bridge';
import { parseCategoryIds } from './useChannels';
import { useSettingsStore } from '../stores/settingsStore';

export interface UseKeyboardShortcutsOptions {
    // --- Current state values (accessed via latest ref pattern) ---
    shortcuts: ShortcutsMap;
    activeView: View;
    showSettingsPopup: boolean;
    categoriesOpen: boolean;
    categoriesHidden: boolean;
    categoriesHiddenTransparent: boolean;
    position: number;
    currentChannels: StoredChannel[];
    currentChannel: StoredChannel | null;
    categoryId?: string | null;
    setCategoryId?: (id: string | null) => void;
    switchLayout: ((layout: LayoutMode) => void) | null;
    titleBarSearchRef: React.RefObject<HTMLInputElement | null>;
    handlePlayChannel: (channel: StoredChannel, autoSwitched?: boolean) => void;
    lastPlayedChannel: StoredChannel | null;
    jellyfinEnabled?: boolean;

    // --- Action callbacks ---
    showShortcutsOverlay: boolean;
    setShowShortcutsOverlay: React.Dispatch<React.SetStateAction<boolean>>;
    handleToggleConnectionInfo?: () => void;
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
    setShowControls: React.Dispatch<React.SetStateAction<boolean>>;
    guideTransparent: boolean;
    setGuideTransparent: React.Dispatch<React.SetStateAction<boolean>>;
    isTransparentGuideZapActive: boolean;

    // --- Channel info overlay flash ---
    onChannelChangeFlash?: () => void;
    // --- Transparent guide flash on channel zap ---
    onTransparentGuideZapFlash?: () => void;
    // --- Built-in mouse back-button navigation (close popup / stop / exit view) ---
    handleMouseBackNavigation: () => void;
}

/**
 * Registers a global keydown/mousedown listener that fires the appropriate
 * action when the user presses a configured shortcut key or mouse button.
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
        // Helper to match keys case-insensitively for letters, falling back to physical key code (e.code) for non-English layouts
        const matches = (action: ShortcutAction, eventKey: string, eventCode: string): boolean => {
            const storedKey = latestRefs.current.shortcuts[action] || DEFAULT_SHORTCUTS[action];
            if (!storedKey) return false;

            // 1. Direct character match (case-insensitive for single letters)
            if (eventKey === storedKey) return true;
            if (eventKey.length === 1 && storedKey.length === 1 && eventKey.toLowerCase() === storedKey.toLowerCase()) {
                return true;
            }

            // 2. Physical key position fallback (layout-independent for non-English OS keyboards)
            if (storedKey.length === 1 && /^[a-zA-Z]$/.test(storedKey)) {
                if (eventCode === `Key${storedKey.toUpperCase()}`) return true;
            } else if (storedKey.length === 1 && /^[0-9]$/.test(storedKey)) {
                if (eventCode === `Digit${storedKey}` || eventCode === `Numpad${storedKey}`) return true;
            } else if (storedKey === '/') {
                if (eventCode === 'Slash' || eventCode === 'NumpadDivide') return true;
            } else if (storedKey === ',') {
                if (eventCode === 'Comma') return true;
            } else if (storedKey === ' ') {
                if (eventCode === 'Space') return true;
            }

            return false;
        };

        // Dispatch the configured action for the given event key/code. Mouse
        // side buttons arrive as 'MouseBack'/'MouseForward' via MOUSE_BUTTON_SHORTCUTS.
        const dispatchAction = async (e: { preventDefault: () => void }, key: string, code: string) => {
            // Access all values through the latest ref
            const {
                activeView,
                showSettingsPopup,
                categoriesOpen,
                categoriesHidden,
                categoriesHiddenTransparent,
                position,
                currentChannels,
                currentChannel,
                switchLayout,
                titleBarSearchRef,
                handlePlayChannel,
                lastPlayedChannel,
                showShortcutsOverlay,
                setShowShortcutsOverlay,
                handleToggleConnectionInfo,
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
                setShowControls,
                guideTransparent,
                setGuideTransparent,
                isTransparentGuideZapActive,
                onChannelChangeFlash,
                onTransparentGuideZapFlash,
                handleMouseBackNavigation,
            } = latestRefs.current;

            if (matches('toggleShortcutsOverlay', key, code)) {
                e.preventDefault();
                setShowShortcutsOverlay((show) => !show);
            } else if (matches('togglePlay', key, code)) {
                e.preventDefault();
                handleTogglePlay();
            } else if (matches('toggleMute', key, code)) {
                handleToggleMute();
            } else if (matches('toggleStats', key, code)) {
                e.preventDefault();
                handleToggleStats();
            } else if (matches('toggleConnectionInfo', key, code)) {
                e.preventDefault();
                handleToggleConnectionInfo?.();
            } else if (matches('toggleFullscreen', key, code)) {
                e.preventDefault();
                handleToggleFullscreen();
            } else if (matches('selectSubtitle', key, code)) {
                e.preventDefault();
                handleShowSubtitleModal();
            } else if (matches('selectAudio', key, code)) {
                e.preventDefault();
                handleShowAudioModal();
            } else if (matches('toggleGuide', key, code)) {
                e.preventDefault();
                setShowControls(true);
                if (activeView === 'guide') {
                    if (guideTransparent) {
                        setGuideTransparent(false);
                        setCategoriesOpen(!categoriesHidden);
                    } else {
                        // LiveTV is open, close it entirely
                        setActiveView('none');
                        setCategoriesOpen(false);
                    }
                } else {
                    // Open LiveTV, respect user's category hidden preference
                    setActiveView('guide');
                    setCategoriesOpen(!categoriesHidden);
                    if (!latestRefs.current.categoryId && currentChannel?.category_ids && latestRefs.current.setCategoryId) {
                        const catIds = parseCategoryIds(currentChannel.category_ids);
                        if (catIds.length > 0) {
                            latestRefs.current.setCategoryId(catIds[0]);
                        }
                    }
                }
            } else if (matches('toggleTransparentGuide', key, code)) {
                e.preventDefault();
                setShowControls(true);
                if (activeView === 'guide') {
                    // If already in transparent mode, close; otherwise enter transparent mode
                    if (guideTransparent) {
                        setActiveView('none');
                        setCategoriesOpen(false);
                    }
                } else {
                    // Open guide in transparent mode
                    setGuideTransparent(true);
                    setActiveView('guide');
                    setCategoriesOpen(!categoriesHiddenTransparent);
                }
            } else if (matches('toggleCategories', key, code)) {
                e.preventDefault();
                if (activeView === 'guide') {
                    setCategoriesOpen((open) => !open);
                }
            } else if (matches('toggleLiveTV', key, code)) {
                e.preventDefault();
                setShowControls(true);
                if (activeView === 'guide') {
                    if (guideTransparent) {
                        setGuideTransparent(false);
                        setCategoriesOpen(!categoriesHidden);
                    } else {
                        // LiveTV is open, close it entirely
                        setActiveView('none');
                        setCategoriesOpen(false);
                    }
                } else {
                    // Open LiveTV, respect user's category hidden preference
                    setActiveView('guide');
                    setCategoriesOpen(!categoriesHidden);
                    if (!latestRefs.current.categoryId && currentChannel?.category_ids && latestRefs.current.setCategoryId) {
                        const catIds = parseCategoryIds(currentChannel.category_ids);
                        if (catIds.length > 0) {
                            latestRefs.current.setCategoryId(catIds[0]);
                        }
                    }
                }
            } else if (matches('toggleSettings', key, code)) {
                e.preventDefault();
                // Toggle settings popup if in main layout, otherwise toggle full view
                setShowSettingsPopup((show) => !show);
            } else if (matches('toggleSports', key, code)) {
                e.preventDefault();
                setCategoriesOpen(false);
                setActiveView((v) => (v === 'sports' ? 'none' : 'sports'));
            } else if (matches('toggleDvr', key, code)) {
                e.preventDefault();
                setCategoriesOpen(false);
                setActiveView((v) => (v === 'dvr' ? 'none' : 'dvr'));
            } else if (matches('toggleCalendar', key, code)) {
                e.preventDefault();
                setCategoriesOpen(false);
                setActiveView((v) => (v === 'calendar' ? 'none' : 'calendar'));
            } else if (matches('toggleNuvio', key, code)) {
                e.preventDefault();
                setCategoriesOpen(false);
                setActiveView((v) => (v === 'nuvio' ? 'none' : 'nuvio'));
            } else if (matches('toggleStrem', key, code)) {
                e.preventDefault();
                setCategoriesOpen(false);
                setActiveView((v) => (v === 'stremio' ? 'none' : 'stremio'));
            } else if (matches('toggleJellyfin', key, code)) {
                if (latestRefs.current.jellyfinEnabled) {
                    e.preventDefault();
                    setCategoriesOpen(false);
                    setActiveView((v) => (v === 'jellyfin' ? 'none' : 'jellyfin'));
                }
            } else if (matches('toggleEpgView', key, code)) {
                e.preventDefault();
                handleToggleEpgView();
            } else if (matches('focusSearch', key, code)) {
                e.preventDefault();
                setShowControls(true);
                if (activeView !== 'guide') {
                    setActiveView('guide');
                }
                // Auto-hide keeps the category sidebar out of the way until the user reaches
                // for the left edge, so focusing search must not slide it open. Read from the
                // store directly: this listener is mounted once and would capture a stale value.
                if (!useSettingsStore.getState().categorySidebarAutohide) {
                    setCategoriesOpen(true);
                }
                if (titleBarSearchRef.current) {
                    titleBarSearchRef.current.focus();
                }
            } else if (matches('close', key, code)) {
                e.preventDefault();
                if (showShortcutsOverlay) {
                    setShowShortcutsOverlay(false);
                    return;
                }
                try {
                    if (await Bridge.isFullscreen()) {
                        await Bridge.toggleFullscreen();
                        return;
                    }
                } catch (err) {
                    console.error('[KeyboardShortcuts] Failed to exit fullscreen on Escape:', err);
                }

                // Close settings popup first if open
                if (showSettingsPopup) {
                    setShowSettingsPopup(false);
                } else {
                    setActiveView('none');
                }
                setCategoriesOpen(false);
                setShowControls(false);
            } else if (matches('seekForward', key, code)) {
                e.preventDefault();
                handleSeek(position + 10);
            } else if (matches('seekBackward', key, code)) {
                e.preventDefault();
                handleSeek(position - 10);
            } else if (matches('layoutMain', key, code)) {
                e.preventDefault();
                switchLayout?.('main');
            } else if (matches('layoutPip', key, code)) {
                e.preventDefault();
                switchLayout?.('pip');
            } else if (matches('layoutBigBottom', key, code)) {
                e.preventDefault();
                switchLayout?.('bigbottom');
            } else if (matches('layout2x2', key, code)) {
                e.preventDefault();
                switchLayout?.('2x2');
            } else if (matches('channelUp', key, code)) {
                e.preventDefault();
                if (currentChannels.length > 0 && currentChannel) {
                    const currentIndex = currentChannels.findIndex((ch) => ch.stream_id === currentChannel.stream_id);
                    if (currentIndex > 0) {
                        handlePlayChannel(currentChannels[currentIndex - 1]);
                    } else if (currentIndex === 0) {
                        // Wrap to last channel
                        handlePlayChannel(currentChannels[currentChannels.length - 1]);
                    }
                    // Flash channel info overlay when changing channels outside guide/sports (or during transparent guide overlay zap)
                    if (activeView !== 'guide' && activeView !== 'sports') {
                        onChannelChangeFlash?.();
                        onTransparentGuideZapFlash?.();
                    } else if (activeView === 'guide' && guideTransparent && isTransparentGuideZapActive) {
                        onChannelChangeFlash?.();
                        onTransparentGuideZapFlash?.();
                    }
                }
            } else if (matches('channelDown', key, code)) {
                e.preventDefault();
                if (currentChannels.length > 0 && currentChannel) {
                    const currentIndex = currentChannels.findIndex((ch) => ch.stream_id === currentChannel.stream_id);
                    if (currentIndex >= 0 && currentIndex < currentChannels.length - 1) {
                        handlePlayChannel(currentChannels[currentIndex + 1]);
                    } else if (currentIndex === currentChannels.length - 1) {
                        // Wrap to first channel
                        handlePlayChannel(currentChannels[0]);
                    }
                    // Flash channel info overlay when changing channels outside guide/sports (or during transparent guide overlay zap)
                    if (activeView !== 'guide' && activeView !== 'sports') {
                        onChannelChangeFlash?.();
                        onTransparentGuideZapFlash?.();
                    } else if (activeView === 'guide' && guideTransparent && isTransparentGuideZapActive) {
                        onChannelChangeFlash?.();
                        onTransparentGuideZapFlash?.();
                    }
                }
            } else if (matches('replayLastStream', key, code)) {
                e.preventDefault();
                if (lastPlayedChannel) {
                    handlePlayChannel(lastPlayedChannel);
                }
            } else if (matches('mouseBackNavigation', key, code)) {
                // Kept last so any action the user has bound to the same mouse
                // button takes priority over the built-in back navigation.
                e.preventDefault();
                handleMouseBackNavigation?.();
            }
        };

        const handleKeyDown = async (e: KeyboardEvent) => {
            // Don't handle shortcuts when typing in inputs
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement
            ) {
                return;
            }

            dispatchAction(e, e.key, e.code);
        };

        const handleMouseDown = (e: MouseEvent) => {
            // Only mouse side buttons (back/forward) are supported as shortcut keys
            const key = MOUSE_BUTTON_SHORTCUTS[e.button];
            if (!key) return;

            // Don't handle shortcuts when typing in inputs
            if (
                e.target instanceof HTMLInputElement ||
                e.target instanceof HTMLTextAreaElement
            ) {
                return;
            }

            dispatchAction(e, key, '');
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('mousedown', handleMouseDown);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('mousedown', handleMouseDown);
        };
    }, []); // Empty dep array: all state accessed via latest ref
}
