/**
 * MultiviewCell — A slot overlay panel.
 *
 * The actual video is rendered by a native MPV process positioned behind this element.
 * This component only provides the interactive overlay: click to swap, right-click to stop,
 * and a placeholder when the slot is empty.
 */
import { useEffect, useRef, useState } from 'react';
import './MultiviewCell.css';

interface MultiviewCellProps {
    slotId: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    active: boolean;
    onSwapWithMain: () => void;
    onStop: () => void;
    onSetProperty: (property: string, value: any) => void;
}

export function MultiviewCell({
    slotId,
    channelName,
    active,
    onSwapWithMain,
    onStop,
    onSetProperty,
}: MultiviewCellProps) {
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    const handleClick = () => {
        if (active) onSwapWithMain();
    };

    const handleRightClick = (e: React.MouseEvent) => {
        e.preventDefault();
        if (active) setContextMenu({ x: e.clientX, y: e.clientY });
    };

    return (
        <>
            <div
                className={`multiview-cell ${active ? 'multiview-cell-active' : 'multiview-cell-empty'}`}
                onClick={handleClick}
                onContextMenu={handleRightClick}
                title={active ? `Click to swap "${channelName}" to main` : 'Right-click a channel → Send to Viewer'}
            >
                {!active && (
                    <div className="multiview-cell-overlay">
                        <div className="multiview-cell-slot-icon">
                            {/* TV icon */}
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <rect x="2" y="7" width="20" height="15" rx="2" />
                                <polyline points="17 2 12 7 7 2" />
                            </svg>
                        </div>
                        <span className="multiview-cell-slot-label">Viewer {slotId}</span>
                        <span className="multiview-cell-hint">Right-click a channel → Send to Viewer</span>
                    </div>
                )}

                {active && (
                    <div className="multiview-cell-badge">
                        <span className="multiview-cell-name">{channelName}</span>
                        <span className="multiview-cell-swap-hint">click to swap</span>
                    </div>
                )}
            </div>

            {contextMenu && (
                <CellContextMenu
                    position={contextMenu}
                    channelName={channelName}
                    onPlay={() => { onSetProperty('pause', false); setContextMenu(null); }}
                    onPause={() => { onSetProperty('pause', true); setContextMenu(null); }}
                    onStop={() => { onStop(); setContextMenu(null); }}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </>
    );
}

function CellContextMenu({
    position,
    channelName,
    onPlay,
    onPause,
    onStop,
    onClose,
}: {
    position: { x: number; y: number };
    channelName: string | null;
    onPlay: () => void;
    onPause: () => void;
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
            {channelName && <div className="cell-context-header">{channelName}</div>}
            <button className="cell-context-item" onClick={onPlay}>
                ▶ Play Stream
            </button>
            <button className="cell-context-item" onClick={onPause}>
                ⏸ Pause Stream
            </button>
            <button className="cell-context-item cell-context-danger" onClick={onStop}>
                ⏹ Stop / Clear Slot
            </button>
        </div>
    );
}
