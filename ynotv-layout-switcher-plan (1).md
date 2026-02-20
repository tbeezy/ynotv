# Multiview Layout Switcher — Full Implementation Plan
# ynoTV Windows — HLS.js secondary viewers with MPV main

## Feature Summary

- **View picker button** → dropdown with 4 layout options
- **Main View** → full MPV, kills all HLS instances
- **PiP View** → full MPV + 1 small draggable HLS overlay
- **2x2 View** → MPV top-left, 3 HLS cells filling the grid
- **Big + Bottom Bar** → MPV large top, 3 small HLS cells along bottom
- **Click HLS cell** → swaps streams (HLS stream loads in MPV, MPV stream moves to that HLS cell)
- **Right-click HLS cell** → context menu with "Stop Stream"
- **Sound** → always on MPV only, all HLS cells permanently muted

---

## Layouts Visualized

```
MAIN VIEW          2x2 VIEW                BIG + BOTTOM          PiP VIEW
┌──────────┐      ┌─────────┬─────────┐   ┌──────────────────┐  ┌──────────┐
│          │      │         │         │   │                  │  │          │
│   MPV    │      │   MPV   │  HLS 2  │   │       MPV        │  │   MPV    │
│  (full)  │      │         │         │   │                  │  │       ┌──┤
│          │      ├─────────┼─────────┤   ├────────┬─────────┤  │       │H2│
└──────────┘      │  HLS 3  │  HLS 4  │   │  HLS 2 │  HLS 3  │  │       └──┘
                  │         │         │   │        │         │  │          │
                  └─────────┴─────────┘   └────────┴─────────┘  └──────────┘
                                          (HLS 4 shown if loaded)
```

---

## Step 1 — Core State: useMultiview Hook

This hook is the brain of everything. It manages:
- Which layout is active
- What's playing in each slot
- The swap logic

```tsx
// src/hooks/useMultiview.ts

import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export type LayoutMode = 'main' | 'pip' | '2x2' | 'bigbottom';

export interface ViewerSlot {
  id: 2 | 3 | 4;
  channelName: string | null;
  channelUrl: string | null;
  active: boolean;
}

// What's currently playing in MPV main
export interface MainSlot {
  channelName: string | null;
  channelUrl: string | null;
}

const EMPTY_SLOTS: ViewerSlot[] = [
  { id: 2, channelName: null, channelUrl: null, active: false },
  { id: 3, channelName: null, channelUrl: null, active: false },
  { id: 4, channelName: null, channelUrl: null, active: false },
];

export function useMultiview() {
  const [layout, setLayout] = useState<LayoutMode>('main');
  const [slots, setSlots] = useState<ViewerSlot[]>(EMPTY_SLOTS.map(s => ({ ...s })));

  // Track what's currently in MPV so we can move it to HLS on swap
  const mainSlotRef = useRef<MainSlot>({ channelName: null, channelUrl: null });

  // Call this whenever MPV loads a new channel (from your existing channel click handler)
  const notifyMainLoaded = useCallback((channelName: string, channelUrl: string) => {
    mainSlotRef.current = { channelName, channelUrl };
  }, []);

  // Switch layout mode
  const switchLayout = useCallback((newLayout: LayoutMode) => {
    if (newLayout === 'main') {
      // Kill all HLS slots
      setSlots(EMPTY_SLOTS.map(s => ({ ...s })));
    }
    setLayout(newLayout);
  }, []);

  // Send a channel to a specific HLS slot (called from right-click context menu)
  const sendToSlot = useCallback((slotId: 2 | 3 | 4, channelName: string, channelUrl: string) => {
    setSlots(prev => prev.map(s =>
      s.id === slotId
        ? { ...s, channelName, channelUrl, active: true }
        : s
    ));
  }, []);

  // Click on HLS cell → swap with MPV
  // MPV gets the HLS stream, that HLS cell gets the old MPV stream
  const swapWithMain = useCallback(async (slotId: 2 | 3 | 4) => {
    const slot = slots.find(s => s.id === slotId);
    if (!slot?.channelUrl) return;

    const previousMain = { ...mainSlotRef.current };
    const newMainUrl = slot.channelUrl;
    const newMainName = slot.channelName;

    // Load the HLS stream into MPV
    await invoke('mpv_load', { url: newMainUrl });
    mainSlotRef.current = { channelName: newMainName, channelUrl: newMainUrl };

    // Move old MPV stream into that HLS slot
    setSlots(prev => prev.map(s =>
      s.id === slotId
        ? {
            ...s,
            channelName: previousMain.channelName,
            channelUrl: previousMain.channelUrl,
            active: !!previousMain.channelUrl, // only active if there was something playing
          }
        : s
    ));
  }, [slots]);

  // Stop a specific HLS slot (right-click → stop)
  const stopSlot = useCallback((slotId: 2 | 3 | 4) => {
    setSlots(prev => prev.map(s =>
      s.id === slotId
        ? { ...s, channelName: null, channelUrl: null, active: false }
        : s
    ));
  }, []);

  // How many slots are visible depends on the layout
  const visibleSlotIds = ((): Array<2 | 3 | 4> => {
    switch (layout) {
      case 'pip': return [2];
      case '2x2': return [2, 3, 4];
      case 'bigbottom': return [2, 3, 4];
      default: return [];
    }
  })();

  const visibleSlots = slots.filter(s => visibleSlotIds.includes(s.id));

  return {
    layout,
    slots,
    visibleSlots,
    switchLayout,
    sendToSlot,
    swapWithMain,
    stopSlot,
    notifyMainLoaded,
  };
}
```

---

## Step 2 — Layout Picker Button

This is the button the user clicks to switch between views.

```tsx
// src/components/LayoutPicker/LayoutPicker.tsx

import { useState, useRef, useEffect } from 'react';
import { LayoutMode } from '../../hooks/useMultiview';
import './LayoutPicker.css';

interface LayoutPickerProps {
  currentLayout: LayoutMode;
  onSelect: (layout: LayoutMode) => void;
}

const LAYOUTS: { mode: LayoutMode; label: string; icon: string; description: string }[] = [
  {
    mode: 'main',
    label: 'Main View',
    icon: '▣',
    description: 'Single full-screen player',
  },
  {
    mode: 'pip',
    label: 'Picture in Picture',
    icon: '⧉',
    description: 'Full player + 1 overlay',
  },
  {
    mode: '2x2',
    label: '2×2 Grid',
    icon: '⊞',
    description: 'Equal 4-panel grid',
  },
  {
    mode: 'bigbottom',
    label: 'Big + Bottom Bar',
    icon: '⬒',
    description: 'Large main + 3 below',
  },
];

export function LayoutPicker({ currentLayout, onSelect }: LayoutPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (mode: LayoutMode) => {
    onSelect(mode);
    setOpen(false);
  };

  const current = LAYOUTS.find(l => l.mode === currentLayout)!;

  return (
    <div className="layout-picker" ref={ref}>
      <button
        className="layout-picker-btn"
        onClick={() => setOpen(o => !o)}
        title="Change layout"
      >
        <span className="layout-picker-icon">{current.icon}</span>
        <span className="layout-picker-label">{current.label}</span>
        <span className="layout-picker-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="layout-picker-dropdown">
          {LAYOUTS.map(layout => (
            <button
              key={layout.mode}
              className={`layout-picker-option ${layout.mode === currentLayout ? 'layout-picker-option-active' : ''}`}
              onClick={() => handleSelect(layout.mode)}
            >
              {/* Mini layout preview */}
              <LayoutPreview mode={layout.mode} />
              <div className="layout-picker-option-text">
                <span className="layout-picker-option-label">{layout.label}</span>
                <span className="layout-picker-option-desc">{layout.description}</span>
              </div>
              {layout.mode === currentLayout && (
                <span className="layout-picker-check">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Small SVG-style grid preview for each layout
function LayoutPreview({ mode }: { mode: LayoutMode }) {
  return (
    <div className="layout-preview">
      {mode === 'main' && (
        <div className="lp-main">
          <div className="lp-cell lp-cell-main" />
        </div>
      )}
      {mode === 'pip' && (
        <div className="lp-pip">
          <div className="lp-cell lp-cell-main" />
          <div className="lp-cell lp-cell-pip" />
        </div>
      )}
      {mode === '2x2' && (
        <div className="lp-grid-2x2">
          <div className="lp-cell lp-cell-main" />
          <div className="lp-cell lp-cell-secondary" />
          <div className="lp-cell lp-cell-secondary" />
          <div className="lp-cell lp-cell-secondary" />
        </div>
      )}
      {mode === 'bigbottom' && (
        <div className="lp-bigbottom">
          <div className="lp-cell lp-cell-main" />
          <div className="lp-bottom-row">
            <div className="lp-cell lp-cell-secondary" />
            <div className="lp-cell lp-cell-secondary" />
            <div className="lp-cell lp-cell-secondary" />
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Step 3 — HLS Cell Component

Each secondary viewer cell. Handles click-to-swap and right-click-to-stop.

```tsx
// src/components/MultiviewCell/MultiviewCell.tsx

import { useEffect, useRef, useState } from 'react';
import Hls, { HlsConfig } from 'hls.js';
import './MultiviewCell.css';

const HLS_CONFIG: Partial<HlsConfig> = {
  liveSyncDurationCount: 3,
  liveMaxLatencyDurationCount: 6,
  maxBufferLength: 15,
  manifestLoadingMaxRetry: 4,
  levelLoadingMaxRetry: 4,
  fragLoadingMaxRetry: 4,
};

interface MultiviewCellProps {
  slotId: 2 | 3 | 4;
  channelName: string | null;
  channelUrl: string | null;
  active: boolean;
  onSwapWithMain: () => void;   // left click
  onStop: () => void;           // right-click → stop
}

export function MultiviewCell({
  slotId,
  channelName,
  channelUrl,
  active,
  onSwapWithMain,
  onStop,
}: MultiviewCellProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  // Load stream whenever URL changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (!channelUrl) {
      video.src = '';
      setStatus('idle');
      return;
    }

    setStatus('loading');

    if (Hls.isSupported()) {
      const hls = new Hls(HLS_CONFIG);
      hlsRef.current = hls;
      hls.loadSource(channelUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setStatus('playing');
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) setStatus('error');
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }

    // Fallback for native HLS support
    video.src = channelUrl;
    video.play().catch(() => {});
    setStatus('playing');
    return () => { video.src = ''; };
  }, [channelUrl]);

  const handleRightClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!active) return;
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleClick = () => {
    if (!active) return;
    onSwapWithMain();
  };

  return (
    <>
      <div
        className={`multiview-cell ${active ? 'multiview-cell-active' : 'multiview-cell-empty'}`}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        title={active ? `Click to swap "${channelName}" to main` : 'Empty — right-click a channel to send here'}
      >
        <video
          ref={videoRef}
          muted          // always muted — sound is always on MPV
          playsInline
          className="multiview-cell-video"
        />

        {/* Status overlays */}
        {!active && (
          <div className="multiview-cell-overlay">
            <span className="multiview-cell-slot-label">Viewer {slotId}</span>
            <span className="multiview-cell-hint">Right-click a channel to load</span>
          </div>
        )}

        {active && status === 'loading' && (
          <div className="multiview-cell-overlay multiview-cell-overlay-transparent">
            <div className="multiview-spinner" />
          </div>
        )}

        {active && status === 'error' && (
          <div className="multiview-cell-overlay multiview-cell-overlay-error">
            <span>⚠ Stream Error</span>
          </div>
        )}

        {/* Channel name badge — always shown when active */}
        {active && (
          <div className="multiview-cell-badge">
            <span>{channelName}</span>
            <span className="multiview-cell-swap-hint">↕ Click to swap</span>
          </div>
        )}
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <CellContextMenu
          position={contextMenu}
          channelName={channelName}
          onStop={() => {
            onStop();
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

function CellContextMenu({
  position,
  channelName,
  onStop,
  onClose,
}: {
  position: { x: number; y: number };
  channelName: string | null;
  onStop: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="cell-context-menu"
      style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 9999 }}
    >
      {channelName && (
        <div className="cell-context-header">{channelName}</div>
      )}
      <button className="cell-context-item cell-context-danger" onClick={onStop}>
        ⏹ Stop Stream
      </button>
    </div>
  );
}
```

---

## Step 4 — Layout Container

This component renders the correct layout based on the current mode.
It handles all 4 layouts in one place.

```tsx
// src/components/MultiviewLayout/MultiviewLayout.tsx

import { MultiviewCell } from '../MultiviewCell/MultiviewCell';
import { ViewerSlot } from '../../hooks/useMultiview';
import './MultiviewLayout.css';

interface MultiviewLayoutProps {
  layout: 'main' | 'pip' | '2x2' | 'bigbottom';
  slots: ViewerSlot[];                           // all 3 secondary slots
  onSwapWithMain: (slotId: 2 | 3 | 4) => void;
  onStop: (slotId: 2 | 3 | 4) => void;
}

export function MultiviewLayout({
  layout,
  slots,
  onSwapWithMain,
  onStop,
}: MultiviewLayoutProps) {
  const slot2 = slots.find(s => s.id === 2)!;
  const slot3 = slots.find(s => s.id === 3)!;
  const slot4 = slots.find(s => s.id === 4)!;

  const cell = (slot: ViewerSlot) => (
    <MultiviewCell
      key={slot.id}
      slotId={slot.id}
      channelName={slot.channelName}
      channelUrl={slot.channelUrl}
      active={slot.active}
      onSwapWithMain={() => onSwapWithMain(slot.id)}
      onStop={() => onStop(slot.id)}
    />
  );

  if (layout === 'main') {
    // Just the MPV area, full size — no secondary cells rendered
    return (
      <div className="layout-main">
        <div className="layout-mpv-area" id="mpv-container" />
      </div>
    );
  }

  if (layout === 'pip') {
    return (
      <div className="layout-pip">
        <div className="layout-mpv-area" id="mpv-container" />
        <div className="layout-pip-overlay">
          {cell(slot2)}
        </div>
      </div>
    );
  }

  if (layout === '2x2') {
    return (
      <div className="layout-2x2">
        <div className="layout-mpv-area" id="mpv-container" />
        {cell(slot2)}
        {cell(slot3)}
        {cell(slot4)}
      </div>
    );
  }

  if (layout === 'bigbottom') {
    return (
      <div className="layout-bigbottom">
        <div className="layout-mpv-area" id="mpv-container" />
        <div className="layout-bottom-bar">
          {cell(slot2)}
          {cell(slot3)}
          {cell(slot4)}
        </div>
      </div>
    );
  }

  return null;
}
```

---

## Step 5 — Layout CSS

```css
/* MultiviewLayout.css */

/* ── SHARED ─────────────────────────────── */

.layout-mpv-area {
  background: #000;
  /* MPV renders into this element via --wid on Windows */
}

/* ── MAIN VIEW ──────────────────────────── */

.layout-main {
  display: grid;
  width: 100%;
  height: 100%;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}

.layout-main .layout-mpv-area {
  width: 100%;
  height: 100%;
}

/* ── PiP VIEW ───────────────────────────── */

.layout-pip {
  position: relative;
  width: 100%;
  height: 100%;
}

.layout-pip .layout-mpv-area {
  width: 100%;
  height: 100%;
}

.layout-pip-overlay {
  position: absolute;
  bottom: 72px; /* above controls bar */
  right: 12px;
  width: 240px;
  height: 135px;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
  z-index: 50;
  /* draggable — see useDraggable hook in Step 6 */
}

/* ── 2x2 GRID ───────────────────────────── */

.layout-2x2 {
  display: grid;
  width: 100%;
  height: 100%;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
  background: #111; /* gap color */
}

.layout-2x2 .layout-mpv-area {
  /* MPV always top-left */
  grid-column: 1;
  grid-row: 1;
}

/* ── BIG + BOTTOM BAR ───────────────────── */

.layout-bigbottom {
  display: grid;
  width: 100%;
  height: 100%;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr 160px; /* main takes remaining, bottom is fixed height */
  gap: 2px;
  background: #111;
}

.layout-bigbottom .layout-mpv-area {
  grid-row: 1;
}

.layout-bottom-bar {
  grid-row: 2;
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 2px;
}

/* ── CELL CSS (shared across layouts) ──── */

.multiview-cell {
  position: relative;
  background: #0a0a0a;
  overflow: hidden;
  cursor: pointer;
}

.multiview-cell-active:hover {
  outline: 2px solid rgba(255, 255, 255, 0.3);
  outline-offset: -2px;
}

.multiview-cell-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.multiview-cell-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: rgba(255, 255, 255, 0.35);
  font-size: 11px;
  pointer-events: none;
}

.multiview-cell-overlay-transparent {
  background: rgba(0, 0, 0, 0.3);
}

.multiview-cell-overlay-error {
  background: rgba(0, 0, 0, 0.5);
  color: rgba(255, 100, 100, 0.7);
}

.multiview-cell-slot-label {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.2);
}

.multiview-cell-hint {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.15);
}

/* Channel name badge at bottom of cell */
.multiview-cell-badge {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 4px 8px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  opacity: 0;
  transition: opacity 0.15s;
}

.multiview-cell:hover .multiview-cell-badge {
  opacity: 1;
}

.multiview-cell-swap-hint {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.35);
}

/* Spinner */
.multiview-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-top-color: rgba(255, 255, 255, 0.5);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

/* Cell right-click context menu */
.cell-context-menu {
  background: rgba(20, 20, 20, 0.97);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 4px;
  min-width: 160px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
}

.cell-context-header {
  padding: 6px 10px 4px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}

.cell-context-item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  background: none;
  border: none;
  border-radius: 5px;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}

.cell-context-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.cell-context-danger { color: rgba(255, 90, 90, 0.9); }
.cell-context-danger:hover { background: rgba(255, 50, 50, 0.15) !important; }

/* ── LAYOUT PICKER BUTTON ─────────────── */

.layout-picker {
  position: relative;
}

.layout-picker-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.1s;
}

.layout-picker-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}

.layout-picker-icon { font-size: 15px; }
.layout-picker-chevron { font-size: 9px; opacity: 0.5; }

.layout-picker-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  background: rgba(18, 18, 18, 0.97);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 6px;
  width: 240px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  z-index: 200;
}

.layout-picker-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: none;
  border: none;
  border-radius: 7px;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.layout-picker-option:hover {
  background: rgba(255, 255, 255, 0.08);
}

.layout-picker-option-active {
  background: rgba(255, 255, 255, 0.06);
}

.layout-picker-option-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
}

.layout-picker-option-label {
  font-size: 13px;
  font-weight: 500;
}

.layout-picker-option-desc {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
}

.layout-picker-check {
  color: rgba(100, 200, 100, 0.8);
  font-size: 13px;
}

/* Layout preview thumbnails */
.layout-preview {
  width: 36px;
  height: 24px;
  border-radius: 3px;
  overflow: hidden;
  background: #1a1a1a;
  flex-shrink: 0;
  border: 1px solid rgba(255,255,255,0.08);
}

.lp-main { width: 100%; height: 100%; }
.lp-cell { border-radius: 1px; }
.lp-cell-main { background: rgba(100, 150, 255, 0.6); }
.lp-cell-secondary { background: rgba(255, 255, 255, 0.2); }

.lp-main .lp-cell-main { width: 100%; height: 100%; }

.lp-pip { position: relative; width: 100%; height: 100%; }
.lp-pip .lp-cell-main { width: 100%; height: 100%; }
.lp-pip .lp-cell-pip {
  position: absolute;
  bottom: 2px; right: 2px;
  width: 40%; height: 40%;
  background: rgba(255, 200, 100, 0.5);
  border-radius: 1px;
}

.lp-grid-2x2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 1px;
  width: 100%; height: 100%;
  background: #111;
}
.lp-grid-2x2 .lp-cell { width: 100%; height: 100%; }

.lp-bigbottom {
  display: grid;
  grid-template-rows: 1fr 8px;
  gap: 1px;
  width: 100%; height: 100%;
  background: #111;
}
.lp-bigbottom .lp-cell-main { width: 100%; height: 100%; }
.lp-bottom-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1px;
}
.lp-bottom-row .lp-cell { width: 100%; height: 100%; }
```

---

## Step 6 — Draggable PiP Overlay

The PiP cell needs to be draggable. Add this hook:

```tsx
// src/hooks/useDraggable.ts

import { useRef, useEffect } from 'react';

export function useDraggable() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const onMouseDown = (e: MouseEvent) => {
      // Don't drag if clicking a button inside
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = `${startLeft + dx}px`;
      el.style.top = `${startTop + dy}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    el.addEventListener('mousedown', onMouseDown);
    return () => el.removeEventListener('mousedown', onMouseDown);
  }, []);

  return ref;
}
```

Apply it to the PiP overlay in `MultiviewLayout`:

```tsx
// In MultiviewLayout.tsx — update the pip section

import { useDraggable } from '../../hooks/useDraggable';

// Inside the component:
const pipDragRef = useDraggable();

// In the pip JSX:
if (layout === 'pip') {
  return (
    <div className="layout-pip">
      <div className="layout-mpv-area" id="mpv-container" />
      <div className="layout-pip-overlay" ref={pipDragRef}>
        {cell(slot2)}
      </div>
    </div>
  );
}
```

---

## Step 7 — Wire Into Your Channel List

In your existing channel list, add right-click to send to a viewer slot.
This plugs directly into `useMultiview`'s `sendToSlot`:

```tsx
// In your channel list component

interface ChannelContextMenuProps {
  channel: { name: string; url: string };
  position: { x: number; y: number };
  currentLayout: LayoutMode;
  onSendToSlot: (slotId: 2 | 3 | 4, name: string, url: string) => void;
  onPlayMain: (url: string) => void;
  onClose: () => void;
}

function ChannelContextMenu({
  channel, position, currentLayout, onSendToSlot, onPlayMain, onClose
}: ChannelContextMenuProps) {
  // Only show slot options if a multiview layout is active
  const showSlots = currentLayout !== 'main';
  // PiP only has slot 2
  const availableSlots: Array<2 | 3 | 4> =
    currentLayout === 'pip' ? [2] : [2, 3, 4];

  return (
    <div className="context-menu" style={{ position: 'fixed', ...position, zIndex: 9999 }}>
      <div className="context-menu-header">{channel.name}</div>
      <div className="context-divider" />

      <button className="context-item" onClick={() => { onPlayMain(channel.url); onClose(); }}>
        ▶ Play (Main Viewer)
      </button>

      {showSlots && (
        <>
          <div className="context-divider" />
          <div className="context-section-label">Send to Viewer</div>
          {availableSlots.map(id => (
            <button
              key={id}
              className="context-item"
              onClick={() => { onSendToSlot(id, channel.name, channel.url); onClose(); }}
            >
              📺 Viewer {id}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
```

---

## Step 8 — Final App Wiring

```tsx
// In your main App / VideoLayout component

import { useMultiview } from './hooks/useMultiview';
import { MultiviewLayout } from './components/MultiviewLayout/MultiviewLayout';
import { LayoutPicker } from './components/LayoutPicker/LayoutPicker';
import { invoke } from '@tauri-apps/api/core';

export function VideoLayout() {
  const multiview = useMultiview();

  const handleChannelPlay = async (channelName: string, channelUrl: string) => {
    await invoke('mpv_load', { url: channelUrl });
    // Tell multiview hook what's now in MPV (needed for swap logic)
    multiview.notifyMainLoaded(channelName, channelUrl);
  };

  return (
    <div className="app-root">

      {/* The main video area with all layout rendering */}
      <div className="video-area">
        <MultiviewLayout
          layout={multiview.layout}
          slots={multiview.slots}
          onSwapWithMain={multiview.swapWithMain}
          onStop={multiview.stopSlot}
        />
      </div>

      {/* Your existing controls bar — add LayoutPicker to it */}
      <div className="controls-bar">
        {/* ... your existing controls ... */}

        {/* Layout picker — drop this wherever makes sense in your controls bar */}
        <LayoutPicker
          currentLayout={multiview.layout}
          onSelect={multiview.switchLayout}
        />
      </div>

      {/* Channel list — pass sendToSlot and layout down */}
      <ChannelList
        onChannelPlay={handleChannelPlay}
        onSendToSlot={multiview.sendToSlot}
        currentLayout={multiview.layout}
      />
    </div>
  );
}
```

---

## Summary: What Each File Does

| File | Purpose |
|---|---|
| `useMultiview.ts` | All state: layout mode, slot contents, swap logic |
| `MultiviewLayout.tsx` | Renders correct grid based on layout mode |
| `MultiviewCell.tsx` | Individual HLS player cell with click/right-click |
| `LayoutPicker.tsx` | Button + dropdown for choosing layout |
| `useDraggable.ts` | Makes PiP overlay draggable |
| CSS files | Layout grids, cell styles, picker styles |
| `main.rs` / Rust | **No changes needed** |

## Zero Rust Changes

Your entire Rust backend is untouched. The only `invoke` calls in this feature are:
- `mpv_load` (on swap — already exists)
- `mpv_load` (on normal channel click — already exists)

Everything else is pure React state and HLS.js.
