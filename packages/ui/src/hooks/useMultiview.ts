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

    switch (mode) {
        case '2x2': {
            const cw = Math.floor((W - gap) / 2);
            const ch = Math.floor((H - gap) / 2);
            return { x: 0, y: 0, w: cw, h: ch };
        }
        case 'bigbottom': {
            const bh = Math.round(BOTTOM_BAR_HEIGHT * d);
            return { x: 0, y: 0, w: W, h: H - bh };
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

    if (mode === 'pip') {
        // PiP overlay: bottom-right, 25% of screen
        const pw = Math.floor(W / 4);
        const ph = Math.floor(H / 4);
        return { x: W - pw - gap, y: H - ph - gap, w: pw, h: ph };
    }

    if (mode === '2x2') {
        const cw = Math.floor((W - gap) / 2);
        const ch = Math.floor((H - gap) / 2);
        const positions: Record<2 | 3 | 4, { x: number; y: number }> = {
            2: { x: cw + gap, y: 0 },         // top-right
            3: { x: 0, y: ch + gap },          // bottom-left
            4: { x: cw + gap, y: ch + gap },   // bottom-right
        };
        const pos = positions[slotId];
        return { x: pos.x, y: pos.y, w: cw, h: ch };
    }

    if (mode === 'bigbottom') {
        const bh = Math.round(BOTTOM_BAR_HEIGHT * d);
        const mainH = H - bh;
        const cellW = Math.floor((W - 2 * gap) / 3);
        const slotMap: Record<2 | 3 | 4, number> = { 2: 0, 3: 1, 4: 2 };
        const idx = slotMap[slotId];
        return { x: idx * (cellW + gap), y: mainH + gap, w: cellW, h: bh - gap };
    }

    return { x: 0, y: 0, w: 0, h: 0 };
}

export function useMultiview() {
    const [layout, setLayout] = useState<LayoutMode>('main');
    const [slots, setSlots] = useState<ViewerSlot[]>(EMPTY_SLOTS.map(s => ({ ...s })));
    const mainSlotRef = useRef<MainSlot>({ channelName: null, channelUrl: null });
    const layoutRef = useRef<LayoutMode>('main');

    useEffect(() => { layoutRef.current = layout; }, [layout]);

    /** Resize primary MPV HWND to match the current layout mode */
    const syncMpvGeometry = useCallback(async (mode?: LayoutMode) => {
        const m = mode ?? layoutRef.current;
        const r = primaryRect(m);
        try {
            await invoke('mpv_set_geometry', { x: r.x, y: r.y, width: r.w, height: r.h });
        } catch (e) {
            console.warn('[useMultiview] syncMpvGeometry failed:', e);
        }
    }, []);

    /** Re-sync on resize */
    useEffect(() => {
        const onResize = () => {
            const m = layoutRef.current;
            if (m === 'main') return;
            syncMpvGeometry(m);
            // Also reposition secondary slots
            const slots_snapshot = EMPTY_SLOTS; // state unavailable in closure, Rust handles it
            void slots_snapshot; // just resize — secondary slots are repositioned separately
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [syncMpvGeometry]);

    const notifyMainLoaded = useCallback((channelName: string, channelUrl: string) => {
        mainSlotRef.current = { channelName, channelUrl };
    }, []);

    const switchLayout = useCallback(async (newLayout: LayoutMode) => {
        if (newLayout === 'main') {
            // Kill all secondary MPVs before going back to main
            await invoke('multiview_kill_all').catch(() => { });
            setSlots(EMPTY_SLOTS.map(s => ({ ...s })));
        }
        setLayout(newLayout);
        await syncMpvGeometry(newLayout);
    }, [syncMpvGeometry]);

    /** Load a stream URL into a secondary MPV slot */
    const sendToSlot = useCallback(async (slotId: 2 | 3 | 4, channelName: string, channelUrl: string) => {
        const mode = layoutRef.current;
        const r = secondaryRect(slotId, mode);
        try {
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
        await invoke('multiview_stop_slot', { slotId }).catch(() => { });
        setSlots(prev => prev.map(s =>
            s.id === slotId ? { ...s, channelName: null, channelUrl: null, active: false } : s
        ));
    }, []);

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
    };
}
