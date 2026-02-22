import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import './ProgramContextMenu.css';

interface SourceContextMenuProps {
    sourceId: string;
    sourceName: string;
    position: { x: number; y: number };
    onClose: () => void;
    onManageCategories: (sourceId: string, sourceName: string) => void;
    onEditSource: (sourceId: string) => void;
}

export function SourceContextMenu({
    sourceId,
    sourceName,
    position,
    onClose,
    onManageCategories,
    onEditSource,
}: SourceContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [adjustedPosition, setAdjustedPosition] = useState(position);

    // Dynamic Context Menu calculation
    useLayoutEffect(() => {
        if (menuRef.current) {
            const menu = menuRef.current;
            const rect = menu.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let x = position.x;
            let y = position.y;

            // Determine if click was in top or bottom half of the screen
            const isBottomHalf = position.y > viewportHeight / 2;

            // Pop UP if cursor is below 50% screen height
            if (isBottomHalf) {
                y = position.y - rect.height;
            }

            // Prevent menu from going off right edge
            if (x + rect.width > viewportWidth) x = viewportWidth - rect.width - 10;
            if (x < 10) x = 10;

            // Safety bounds for Y-axis
            if (y + rect.height > viewportHeight) y = viewportHeight - rect.height - 10;
            if (y < 10) y = 10;

            setAdjustedPosition({ x, y });
        }
    }, [position]);

    // Close on click outside
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    // Close on escape
    useEffect(() => {
        function handleEscape(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose();
        }
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [onClose]);

    return (
        <div
            ref={menuRef}
            className="program-context-menu"
            style={{ left: `${adjustedPosition.x}px`, top: `${adjustedPosition.y}px` }}
        >
            <div className="context-menu-header" style={{ padding: '8px 12px 4px', fontSize: '11px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {sourceName}
            </div>
            <div className="context-menu-item" onClick={() => { onManageCategories(sourceId, sourceName); onClose(); }}>
                📋 Manage Categories
            </div>
            <div className="context-menu-item" onClick={() => { onEditSource(sourceId); onClose(); }}>
                ⚙️ Edit Source
            </div>
        </div>
    );
}
