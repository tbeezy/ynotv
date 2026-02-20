import { useState, useRef, useEffect } from 'react';
import { LayoutMode } from '../../hooks/useMultiview';
import './LayoutPicker.css';

interface LayoutPickerProps {
    currentLayout: LayoutMode;
    onSelect: (layout: LayoutMode) => void;
}

const LAYOUTS: { mode: LayoutMode; label: string; description: string }[] = [
    {
        mode: 'main',
        label: 'Main View',
        description: 'Single full-screen player',
    },
    {
        mode: 'pip',
        label: 'Picture in Picture',
        description: 'Full player + 1 overlay',
    },
    {
        mode: 'bigbottom',
        label: 'Big + Bottom Bar',
        description: 'Large main + 3 below',
    },
    {
        mode: '2x2',
        label: '2×2 Grid',
        description: 'Equal 4-panel grid',
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

    return (
        <div className="layout-picker" ref={ref}>
            <button
                className={`layout-picker-btn title-bar-settings-btn ${currentLayout !== 'main' ? 'layout-picker-btn-active' : ''}`}
                onClick={() => setOpen(o => !o)}
                title={`Layout: ${LAYOUTS.find(l => l.mode === currentLayout)?.label}`}
            >
                <LayoutIcon mode={currentLayout} />
            </button>

            {open && (
                <div className="layout-picker-dropdown">
                    <div className="layout-picker-header">View Layout</div>
                    {LAYOUTS.map(layout => (
                        <button
                            key={layout.mode}
                            className={`layout-picker-option ${layout.mode === currentLayout ? 'layout-picker-option-active' : ''}`}
                            onClick={() => handleSelect(layout.mode)}
                        >
                            <div className="layout-picker-preview-wrap">
                                <LayoutPreview mode={layout.mode} />
                            </div>
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

// The button icon changes based on current layout
function LayoutIcon({ mode }: { mode: LayoutMode }) {
    if (mode === 'main') {
        // Single square
        return (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="12" height="12" rx="1.5" fill="currentColor" opacity="0.85" />
            </svg>
        );
    }
    if (mode === 'pip') {
        // Large square + small pip
        return (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="14" height="14" rx="1.5" fill="currentColor" opacity="0.4" />
                <rect x="8.5" y="8.5" width="6" height="5" rx="1" fill="currentColor" opacity="0.9" />
            </svg>
        );
    }
    if (mode === '2x2') {
        // 4-cell grid
        return (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="1" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.9" />
                <rect x="9" y="1" width="6" height="6" rx="1" fill="currentColor" opacity="0.5" />
                <rect x="1" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.5" />
                <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" opacity="0.5" />
            </svg>
        );
    }
    // bigbottom
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="14" height="9" rx="1" fill="currentColor" opacity="0.9" />
            <rect x="1" y="12" width="4" height="3" rx="0.75" fill="currentColor" opacity="0.5" />
            <rect x="6" y="12" width="4" height="3" rx="0.75" fill="currentColor" opacity="0.5" />
            <rect x="11" y="12" width="4" height="3" rx="0.75" fill="currentColor" opacity="0.5" />
        </svg>
    );
}

// Small grid preview in dropdown
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
