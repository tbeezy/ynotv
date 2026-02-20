import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type LayoutMode = 'main' | 'pip' | '2x2' | 'bigbottom';

export interface ViewerSlot {
    id: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    active: boolean;
}

export interface MainSlot {
    channelName: string | null;
    channelUrl: string | null;
}

const EMPTY_SLOTS: ViewerSlot[] = [
    { id: 2, channelName: null, channelUrl: null, active: false },
    { id: 3, channelName: null, channelUrl: null, active: false },
    { id: 4, channelName: null, channelUrl: null, active: false },
];

// Height of the bottom bar in bigbottom layout (must match CSS)
const BOTTOM_BAR_HEIGHT = 162;

// UI element heights that multiview must avoid
const TITLE_BAR_HEIGHT = 32; // Title bar height
const MEDIA_BAR_HEIGHT = 90; // Now playing bar height (approximate, includes padding)

/** Scale factor applied to mpv_set_geometry coordinates to account for DPR */
function dpr() {
    return window.devicePixelRatio || 1;
}

/** Compute the target rect (in physical pixels) for the primary MPV slot */
function primaryRect(mode: LayoutMode): { x: number; y: number; w: number; h: number } {
    const d = dpr();
    const W = Math.round(window.innerWidth * d);
    const H = Math.round(window.innerHeight * d);
    const gap = Math.round(2 * d);

    // Account for UI elements that multiview must avoid
    const titleBarH = Math.round(TITLE_BAR_HEIGHT * d);
    const mediaBarH = Math.round(MEDIA_BAR_HEIGHT * d);
    const availableH = H - titleBarH - mediaBarH;

    switch (mode) {
        case '2x2': {
            const cw = Math.floor((W - gap) / 2);
            const ch = Math.floor((availableH - gap) / 2);
            return { x: 0, y: titleBarH, w: cw, h: ch };
        }
        case 'bigbottom': {
            const bh = Math.round(BOTTOM_BAR_HEIGHT * d);
            return { x: 0, y: titleBarH, w: W, h: availableH - bh };
        }
        default:
            // main / pip — fill window
            return { x: 0, y: 0, w: 0, h: 0 }; // 0,0 => restore to full size
    }
}

/** Compute the secondary slot rect (physical pixels) */
function secondaryRect(slotId: 2 | 3 | 4, mode: LayoutMode): { x: number; y: number; w: number; h: number } {
    const d = dpr();
    const W = Math.round(window.innerWidth * d);
    const H = Math.round(window.innerHeight * d);
    const gap = Math.round(2 * d);

    // Account for UI elements that multiview must avoid
    const titleBarH = Math.round(TITLE_BAR_HEIGHT * d);
    const mediaBarH = Math.round(MEDIA_BAR_HEIGHT * d);
    const availableH = H - titleBarH - mediaBarH;

    if (mode === 'pip') {
        // PiP overlay: bottom-right, 25% of screen (above media bar)
        const pw = Math.floor(W / 4);
        const ph = Math.floor(availableH / 4);
        return { x: W - pw - gap, y: H - mediaBarH - ph - gap, w: pw, h: ph };
    }

    if (mode === '2x2') {
        const cw = Math.floor((W - gap) / 2);
        const ch = Math.floor((availableH - gap) / 2);
        const positions: Record<2 | 3 | 4, { x: number; y: number }> = {
            2: { x: cw + gap, y: titleBarH },                    // top-right
            3: { x: 0, y: titleBarH + ch + gap },                // bottom-left
            4: { x: cw + gap, y: titleBarH + ch + gap },         // bottom-right
        };
        const pos = positions[slotId];
        return { x: pos.x, y: pos.y, w: cw, h: ch };
    }

    if (mode === 'bigbottom') {
        const bh = Math.round(BOTTOM_BAR_HEIGHT * d);
        const mainH = availableH - bh;
        const cellW = Math.floor((W - 2 * gap) / 3);
        const slotMap: Record<2 | 3 | 4, number> = { 2: 0, 3: 1, 4: 2 };
        const idx = slotMap[slotId];
        return { x: idx * (cellW + gap), y: titleBarH + mainH + gap, w: cellW, h: bh - gap };
    }

    return { x: 0, y: 0, w: 0, h: 0 };
}

export function useMultiview() {
    const [layout, setLayout] = useState<LayoutMode>('main');
    const [slots, setSlots] = useState<ViewerSlot[]>(EMPTY_SLOTS.map(s => ({ ...s })));
    const mainSlotRef = useRef<MainSlot>({ channelName: null, channelUrl: null });
    const layoutRef = useRef<LayoutMode>('main');
    const slotsRef = useRef<ViewerSlot[]>(slots);

    // Guide mode state: save multiview state when EPG opens, restore when it closes
    const savedStateRef = useRef<{ layout: LayoutMode; slots: ViewerSlot[] } | null>(null);
    const isGuideModeRef = useRef(false);

    useEffect(() => { layoutRef.current = layout; }, [layout]);
    useEffect(() => { slotsRef.current = slots; }, [slots]);

    /** Resize primary MPV HWND to match the current layout mode */
    const syncMpvGeometry = useCallback(async (mode?: LayoutMode) => {
        const m = mode ?? layoutRef.current;
        const r = primaryRect(m);
        try {
            console.log('[useMultiview] syncMpvGeometry', {
                mode: m,
                rect: { x: r.x, y: r.y, w: r.w, h: r.h },
                window: { width: window.innerWidth, height: window.innerHeight, dpr: dpr() },
            });

            // CRITICAL: Reset video zoom/align when switching to multiview layouts.
            // EPG preview may have set these, causing black screen if not reset.
            if (m !== 'main') {
                const { Bridge } = await import('../services/tauri-bridge');
                try {
                    await Bridge.setProperty('video-zoom', 0);
                    await Bridge.setProperty('video-align-x', 0);
                    await Bridge.setProperty('video-align-y', 0);
                    console.log('[useMultiview] Reset video-zoom/align for multiview layout');
                } catch (e) {
                    console.warn('[useMultiview] Failed to reset video properties:', e);
                }
            }

            await invoke('mpv_set_geometry', { x: r.x, y: r.y, width: r.w, height: r.h });
        } catch (e) {
            console.warn('[useMultiview] syncMpvGeometry failed:', e);
        }
    }, []);

    /** Reposition all active secondary MPV slots for the current (or provided) layout */
    const repositionSecondarySlots = useCallback(async (mode?: LayoutMode) => {
        const m = mode ?? layoutRef.current;
        const activeSlots = slotsRef.current.filter(s => s.active);

        if (activeSlots.length === 0) {
            return;
        }

        const ops = activeSlots.map(async (slot) => {
            const r = secondaryRect(slot.id, m);
            try {
                console.log('[useMultiview] multiview_reposition_slot', {
                    slotId: slot.id,
                    mode: m,
                    rect: { x: r.x, y: r.y, w: r.w, h: r.h },
                    window: { width: window.innerWidth, height: window.innerHeight, dpr: dpr() },
                });
                await invoke('multiview_reposition_slot', {
                    slotId: slot.id,
                    x: r.x,
                    y: r.y,
                    width: r.w,
                    height: r.h,
                });
            } catch (e) {
                console.warn('[useMultiview] multiview_reposition_slot failed:', slot.id, e);
            }
        });

        await Promise.all(ops);
    }, []);

    /** Re-sync on resize */
    useEffect(() => {
        const onResize = () => {
            const m = layoutRef.current;
            if (m === 'main') return;
            // Primary MPV (main feed)
            syncMpvGeometry(m);
            // Secondary MPVs (slots 2/3/4)
            repositionSecondarySlots(m);
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [syncMpvGeometry, repositionSecondarySlots]);

    const notifyMainLoaded = useCallback((channelName: string, channelUrl: string) => {
        mainSlotRef.current = { channelName, channelUrl };
    }, []);

    const switchLayout = useCallback(async (newLayout: LayoutMode) => {
        if (isGuideModeRef.current && savedStateRef.current) {
            console.log(`[useMultiview] Layout changed to ${newLayout} while guide is open. Deferring until guide closes.`);

            // If switching to 'main' while guide is open, we need to clear pending secondary slots
            if (newLayout === 'main') {
                savedStateRef.current.slots = EMPTY_SLOTS.map(s => ({ ...s }));
                setSlots(EMPTY_SLOTS.map(s => ({ ...s })));
            }
            // Update the pending layout to be restored later
            savedStateRef.current.layout = newLayout;
            setLayout(newLayout);
            return;
        }

        if (newLayout === 'main') {
            // CRITICAL: Kill all secondary MPVs FIRST and wait for them to fully terminate
            // before restoring main MPV to fullscreen. This prevents secondary windows
            // from blocking UI when returning to single-view mode.
            console.log('[useMultiview] Switching to main layout - killing all secondary MPVs...');
            await invoke('multiview_kill_all').catch((e) => {
                console.warn('[useMultiview] Error killing secondary MPVs:', e);
            });
            setSlots(EMPTY_SLOTS.map(s => ({ ...s })));
            // Small delay to ensure windows are fully destroyed before restoring main MPV
            await new Promise(resolve => setTimeout(resolve, 200));
            console.log('[useMultiview] Secondary MPVs killed, restoring main MPV to fullscreen');
        }
        setLayout(newLayout);
        await syncMpvGeometry(newLayout);
        // When switching between 2x2 / pip / bigbottom, reposition existing secondary slots
        // (but NOT when switching to 'main' - they're already killed above)
        if (newLayout !== 'main') {
            await repositionSecondarySlots(newLayout);
        }
    }, [syncMpvGeometry, repositionSecondarySlots]);

    /** Load a stream URL into a secondary MPV slot */
    const sendToSlot = useCallback(async (slotId: 2 | 3 | 4, channelName: string, channelUrl: string) => {
        if (isGuideModeRef.current && savedStateRef.current) {
            console.log(`[useMultiview] Deferring load for slot ${slotId} while guide is open`);
            savedStateRef.current.slots = savedStateRef.current.slots.map(s =>
                s.id === slotId ? { ...s, channelName, channelUrl, active: true } : s
            );
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName, channelUrl, active: true } : s
            ));
            return;
        }

        const mode = layoutRef.current;
        const r = secondaryRect(slotId, mode);
        try {
            console.log('[useMultiview] sendToSlot', {
                slotId,
                channelName,
                url: channelUrl.substring(0, 60) + '...',
                mode,
                rect: { x: r.x, y: r.y, w: r.w, h: r.h },
                window: { width: window.innerWidth, height: window.innerHeight, dpr: dpr() },
            });
            await invoke('multiview_load_slot', {
                slotId,
                url: channelUrl,
                x: r.x, y: r.y, width: r.w, height: r.h,
            });
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName, channelUrl, active: true } : s
            ));
        } catch (e) {
            console.error('[useMultiview] sendToSlot failed:', e);
        }
    }, []);

    /** Swap: load a secondary slot's stream into the primary MPV and vice versa */
    const swapWithMain = useCallback(async (slotId: 2 | 3 | 4, currentSlots: ViewerSlot[]) => {
        const slot = currentSlots.find(s => s.id === slotId);
        if (!slot?.channelUrl) return;

        const prevMain = { ...mainSlotRef.current };
        const newMainUrl = slot.channelUrl;
        const newMainName = slot.channelName;

        if (isGuideModeRef.current && savedStateRef.current) {
            // Update saved state for deferred loading of new secondary assignment
            if (prevMain.channelUrl) {
                savedStateRef.current.slots = savedStateRef.current.slots.map(s =>
                    s.id === slotId
                        ? { ...s, channelName: prevMain.channelName, channelUrl: prevMain.channelUrl, active: true }
                        : s
                );
            } else {
                savedStateRef.current.slots = savedStateRef.current.slots.map(s =>
                    s.id === slotId ? { ...s, channelName: null, channelUrl: null, active: false } : s
                );
            }

            // Sync UI state
            setSlots(prev => prev.map(s =>
                s.id === slotId
                    ? (prevMain.channelUrl
                        ? { ...s, channelName: prevMain.channelName, channelUrl: prevMain.channelUrl, active: true }
                        : { ...s, channelName: null, channelUrl: null, active: false })
                    : s
            ));

            // Still change the primary MPV, because primary MPV runs in background of Guide
            await invoke('mpv_load', { url: newMainUrl });
            mainSlotRef.current = { channelName: newMainName, channelUrl: newMainUrl };
            return;
        }

        // Load the slot's stream into primary MPV
        await invoke('mpv_load', { url: newMainUrl });
        mainSlotRef.current = { channelName: newMainName, channelUrl: newMainUrl };

        // Put the old main stream into the secondary slot
        if (prevMain.channelUrl) {
            const r = secondaryRect(slotId, layoutRef.current);
            await invoke('multiview_load_slot', {
                slotId,
                url: prevMain.channelUrl,
                x: r.x, y: r.y, width: r.w, height: r.h,
            }).catch(() => { });
            setSlots(prev => prev.map(s =>
                s.id === slotId
                    ? { ...s, channelName: prevMain.channelName, channelUrl: prevMain.channelUrl, active: true }
                    : s
            ));
        } else {
            // Old main was empty — just stop the slot
            await invoke('multiview_stop_slot', { slotId }).catch(() => { });
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName: null, channelUrl: null, active: false } : s
            ));
        }
    }, []);

    const stopSlot = useCallback(async (slotId: 2 | 3 | 4) => {
        if (isGuideModeRef.current && savedStateRef.current) {
            savedStateRef.current.slots = savedStateRef.current.slots.map(s =>
                s.id === slotId ? { ...s, channelName: null, channelUrl: null, active: false } : s
            );
            setSlots(prev => prev.map(s =>
                s.id === slotId ? { ...s, channelName: null, channelUrl: null, active: false } : s
            ));
            return;
        }

        await invoke('multiview_stop_slot', { slotId }).catch(() => { });
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelName: null, channelUrl: null, active: false } : s
        ));
    }, []);

    /** Enter guide mode: kill secondary MPVs and save state for restoration */
    const enterGuideMode = useCallback(async () => {
        if (isGuideModeRef.current) return; // Already in guide mode

        console.log('[useMultiview] Entering guide mode - saving multiview state and killing secondaries');
        isGuideModeRef.current = true;

        // Save current multiview state
        savedStateRef.current = {
            layout: layoutRef.current,
            slots: [...slotsRef.current],
        };

        // Kill all secondary MPVs so they don't block EPG UI
        if (layoutRef.current !== 'main') {
            await invoke('multiview_kill_all').catch((e) => {
                console.warn('[useMultiview] Error killing secondary MPVs for guide mode:', e);
            });
            // Temporarily reset primary MPV geometry to fullscreen so it doesn't stay tiny
            // but DO NOT call setLayout('main') as that updates the UI picker
            await invoke('mpv_set_geometry', { x: 0, y: 0, width: 0, height: 0 }).catch(() => { });
        }
    }, []);

    /** Exit guide mode: restore saved multiview state */
    const exitGuideMode = useCallback(async () => {
        if (!isGuideModeRef.current) return; // Not in guide mode

        console.log('[useMultiview] Exiting guide mode - restoring multiview state');
        isGuideModeRef.current = false;

        const saved = savedStateRef.current;
        if (saved && saved.layout !== 'main') {
            // Restore primary MPV layout without touching React state (since it never changed)
            await syncMpvGeometry(saved.layout);

            // Restore secondary slots
            setSlots(saved.slots.map(s => ({ ...s })));

            // Respawn secondary MPVs with their saved channels
            for (const slot of saved.slots) {
                if (slot.active && slot.channelUrl) {
                    const r = secondaryRect(slot.id, saved.layout);
                    try {
                        await invoke('multiview_load_slot', {
                            slotId: slot.id,
                            url: slot.channelUrl,
                            x: r.x, y: r.y, width: r.w, height: r.h,
                        });
                    } catch (e) {
                        console.warn('[useMultiview] Failed to restore slot', slot.id, e);
                    }
                }
            }

            savedStateRef.current = null;
        }
    }, [syncMpvGeometry]);

    const visibleSlotIds = ((): Array<2 | 3 | 4> => {
        switch (layout) {
            case 'pip': return [2];
            case '2x2': return [2, 3, 4];
            case 'bigbottom': return [2, 3, 4];
            default: return [];
        }
    })();

    return {
        layout,
        slots,
        visibleSlots: slots.filter(s => (visibleSlotIds as number[]).includes(s.id)),
        switchLayout,
        sendToSlot,
        swapWithMain,
        stopSlot,
        notifyMainLoaded,
        syncMpvGeometry,
        enterGuideMode,
        exitGuideMode,
    };
}
