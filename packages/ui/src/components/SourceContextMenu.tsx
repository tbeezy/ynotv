import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import './ProgramContextMenu.css';

interface SourceContextMenuProps {
    sourceId: string;
    sourceName: string;
    position: { x: number; y: number };
    onClose: () => void;
    onManageCategories?: (sourceId: string, sourceName: string) => void;
    onManageVodCategories?: (sourceId: string, sourceName: string) => void;
    onManageHiddenTitles?: () => void;
    onEditSource?: (sourceId: string) => void;
    onEditEpg?: (sourceId: string, sourceName: string) => void;
    onCreateCategoryFolder?: (sourceId: string, sourceName: string) => void;
}

export function SourceContextMenu({
    sourceId,
    sourceName,
    position,
    onClose,
    onManageCategories,
    onManageVodCategories,
    onManageHiddenTitles,
    onEditSource,
    onEditEpg,
    onCreateCategoryFolder,
}: SourceContextMenuProps) {
    useTranslation();
    const menuRef = useRef<HTMLDivElement>(null);
    const [adjustedPosition, setAdjustedPosition] = useState(position);

    // Dynamic Context Menu calculation
    useLayoutEffect(() => {
        if (menuRef.current) {
            const menu = menuRef.current;
            const menuWidth = menu.offsetWidth;
            const menuHeight = menu.offsetHeight;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let x = position.x;
            let y = position.y;

            // Determine if click was in top or bottom half of the screen
            const isBottomHalf = position.y > viewportHeight / 2;

            // Pop UP if cursor is below 50% screen height
            if (isBottomHalf) {
                y = position.y - menuHeight;
            }

            // Prevent menu from going off right edge
            if (x + menuWidth > viewportWidth) x = viewportWidth - menuWidth - 10;
            if (x < 10) x = 10;

            // Safety bounds for Y-axis
            if (y + menuHeight > viewportHeight) y = viewportHeight - menuHeight - 10;
            if (y < 10) y = 10;

            setAdjustedPosition({ x, y });
        }
    }, [position]);

    // Close on click outside (ignore clicks inside modals since they are rendered in portals)
    useEffect(() => {
        function isInsideModal(target: Node): boolean {
            const el = target as HTMLElement;
            return !!el.closest?.('.modal-overlay') || !!el.closest?.('.modal-container');
        }
        function handleClickOutside(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node) && !isInsideModal(e.target as Node)) {
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

    return createPortal(
        <div
            ref={menuRef}
            className="program-context-menu"
            style={{ left: `${adjustedPosition.x}px`, top: `${adjustedPosition.y}px` }}
        >
            <div className="context-menu-header" style={{ padding: '8px 12px 4px', fontSize: '11px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {sourceName}
            </div>
            {onManageCategories && (
                <div className="context-menu-item" onClick={() => { onManageCategories(sourceId, sourceName); onClose(); }}>
                    {i18n.t('contextMenu.manageCategories')}
                </div>
            )}
            {onCreateCategoryFolder && (
                <div className="context-menu-item" onClick={() => { onCreateCategoryFolder(sourceId, sourceName); onClose(); }}>
                    {i18n.t('contextMenu.createCategoryFolder')}
                </div>
            )}
            {onManageVodCategories && (
                <div className="context-menu-item" onClick={() => { onManageVodCategories(sourceId, sourceName); onClose(); }}>
                    {i18n.t('contextMenu.manageVodCategories')}
                </div>
            )}
            {onManageHiddenTitles && (
                <div className="context-menu-item" onClick={() => { onManageHiddenTitles(); onClose(); }}>
                    {i18n.t('contextMenu.manageHiddenTitles')}
                </div>
            )}
            {onEditSource && (
                <div className="context-menu-item" onClick={() => { onEditSource(sourceId); onClose(); }}>
                    {i18n.t('contextMenu.editSource')}
                </div>
            )}
            {onEditEpg && (
                <div className="context-menu-item" onClick={() => { onEditEpg(sourceId, sourceName); onClose(); }}>
                    {i18n.t('contextMenu.editEpg')}
                </div>
            )}
        </div>,
        document.body
    );
}
