import { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { LocalEntry } from '../../services/local-library/types';

export function computeEpisodeContextMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  let nextX = x;
  let nextY = y;

  // Prevent menu from overflowing right edge
  if (nextX + menuWidth > viewportWidth - 10) {
    nextX = Math.max(10, viewportWidth - menuWidth - 10);
  }
  if (nextX < 10) nextX = 10;

  // Prevent menu from overflowing bottom edge (flip upward if space allows, otherwise clamp)
  if (nextY + menuHeight > viewportHeight - 10) {
    if (y - menuHeight >= 10) {
      nextY = y - menuHeight;
    } else {
      nextY = Math.max(10, viewportHeight - menuHeight - 10);
    }
  }
  if (nextY < 10) nextY = 10;

  return { x: nextX, y: nextY };
}

export interface EpisodeContextMenuProps {
  x: number;
  y: number;
  entry: LocalEntry;
  onClose: () => void;
  onEdit: (entry: LocalEntry) => void;
  onFixMatch: (entry: LocalEntry) => void;
}

export function EpisodeContextMenu({
  x,
  y,
  entry,
  onClose,
  onEdit,
  onFixMatch,
}: EpisodeContextMenuProps) {
  const { t } = useTranslation('vod');
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(() => {
    const vpW = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const vpH = typeof window !== 'undefined' ? window.innerHeight : 1080;
    return computeEpisodeContextMenuPosition(x, y, 190, 86, vpW, vpH);
  });

  useLayoutEffect(() => {
    if (menuRef.current) {
      const menu = menuRef.current;
      setAdjustedPos(
        computeEpisodeContextMenuPosition(
          x,
          y,
          menu.offsetWidth,
          menu.offsetHeight,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    }
  }, [x, y]);

  if (typeof document === 'undefined' || !document.body) {
    return null;
  }

  return createPortal(
    <>
      <div
        className="local-ctx-overlay"
        onClick={onClose}
        onWheel={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="local-ctx-menu"
        style={{ left: adjustedPos.x, top: adjustedPos.y }}
      >
        <button
          type="button"
          className="local-ctx-menu__item"
          onClick={() => {
            onEdit(entry);
            onClose();
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
          {t('editMetadata', 'Edit metadata')}
        </button>
        <button
          type="button"
          className="local-ctx-menu__item"
          onClick={() => {
            onClose();
            onFixMatch(entry);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
          </svg>
          {t('fixMatch', 'Fix match')}
        </button>
      </div>
    </>,
    document.body,
  );
}
