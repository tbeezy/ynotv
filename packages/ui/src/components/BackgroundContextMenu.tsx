import { useRef, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import './BackgroundContextMenu.css';

interface BackgroundContextMenuProps {
  position: { x: number; y: number };
  sportsWidget: 'autohide' | 'persistent' | null;
  sportsLiveSidebarWidget?: boolean;
  recentWidget: '5' | '10' | null;
  favoritesWidget: boolean;
  whatsNextWidget: boolean;
  customGroupIds: string[];
  onAddSportsAutohide: () => void;
  onAddSportsPersistent: () => void;
  onRemoveSports: () => void;
  onAddSportsLiveSidebar?: () => void;
  onRemoveSportsLiveSidebar?: () => void;
  onAddRecent5: () => void;
  onAddRecent10: () => void;
  onRemoveRecent: () => void;
  onAddFavorites: () => void;
  onRemoveFavorites: () => void;
  onAddWhatsNext: () => void;
  onRemoveWhatsNext: () => void;
  onRemoveCustomGroup?: (groupId: string) => void;
  onAddCustomGroup: () => void;
  onClose: () => void;
}

export function BackgroundContextMenu({
  position,
  sportsWidget,
  sportsLiveSidebarWidget,
  recentWidget,
  favoritesWidget,
  whatsNextWidget,
  customGroupIds,
  onAddSportsAutohide,
  onAddSportsPersistent,
  onRemoveSports,
  onAddSportsLiveSidebar,
  onRemoveSportsLiveSidebar,
  onAddRecent5,
  onAddRecent10,
  onRemoveRecent,
  onAddFavorites,
  onRemoveFavorites,
  onAddWhatsNext,
  onRemoveWhatsNext,
  onRemoveCustomGroup,
  onAddCustomGroup,
  onClose,
}: BackgroundContextMenuProps) {
  useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (menuRef.current) {
      const menu = menuRef.current;
      const menuWidth = menu.offsetWidth;
      const menuHeight = menu.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let x = position.x;
      let y = position.y;

      const isBottomHalf = position.y > viewportHeight / 2;
      if (isBottomHalf) {
        y = position.y - menuHeight;
      }

      if (x + menuWidth > viewportWidth) {
        x = viewportWidth - menuWidth - 10;
      }
      if (x < 10) x = 10;
      if (y + menuHeight > viewportHeight) y = viewportHeight - menuHeight - 10;
      if (y < 10) y = 10;

      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    }
  }, [position]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const hasCustomGroups = customGroupIds.length > 0;
  const hasAnyWidget = sportsWidget !== null || sportsLiveSidebarWidget || recentWidget !== null || favoritesWidget || whatsNextWidget || hasCustomGroups;

  return createPortal(
    <div ref={menuRef} className="background-context-menu">
      {hasAnyWidget && (
        <>
          <div className="context-menu-header">{i18n.t('contextMenu.activeWidgets')}</div>
          {sportsWidget && (
            <div className="context-menu-item context-menu-item-info" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                {i18n.t('contextMenu.liveSports', { mode: sportsWidget === 'autohide' ? i18n.t('contextMenu.autohide') : i18n.t('contextMenu.persistent') })}
              </span>
              <button 
                className="context-menu-remove-btn" 
                onClick={(e) => { e.stopPropagation(); onRemoveSports(); onClose(); }}
                title={i18n.t('contextMenu.stopLiveSports')}
              >
                ✕
              </button>
            </div>
          )}
          {sportsLiveSidebarWidget && (
            <div className="context-menu-item context-menu-item-info" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                {i18n.t('contextMenu.sportsLiveSidebar', 'Live Game Sidebar')}
              </span>
              <button 
                className="context-menu-remove-btn" 
                onClick={(e) => { e.stopPropagation(); onRemoveSportsLiveSidebar?.(); onClose(); }}
                title={i18n.t('contextMenu.stopSportsLiveSidebar', 'Remove Live Game Sidebar')}
              >
                ✕
              </button>
            </div>
          )}
          {recentWidget && (
            <div className="context-menu-item context-menu-item-info" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                {i18n.t('contextMenu.recentChannelsCount', { count: recentWidget })}
              </span>
              <button 
                className="context-menu-remove-btn" 
                onClick={(e) => { e.stopPropagation(); onRemoveRecent(); onClose(); }}
                title={i18n.t('contextMenu.stopRecentChannels')}
              >
                ✕
              </button>
            </div>
          )}
          {favoritesWidget && (
            <div className="context-menu-item context-menu-item-info" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                {i18n.t('common:favorites')}
              </span>
              <button 
                className="context-menu-remove-btn" 
                onClick={(e) => { e.stopPropagation(); onRemoveFavorites(); onClose(); }}
                title={i18n.t('contextMenu.stopFavorites')}
              >
                ✕
              </button>
            </div>
          )}
          {whatsNextWidget && (
            <div className="context-menu-item context-menu-item-info" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {i18n.t('contextMenu.whatsNext')}
              </span>
              <button 
                className="context-menu-remove-btn" 
                onClick={(e) => { e.stopPropagation(); onRemoveWhatsNext(); onClose(); }}
                title={i18n.t('contextMenu.stopWhatsNext')}
              >
                ✕
              </button>
            </div>
          )}
          {hasCustomGroups && customGroupIds.map((gid) => (
            <div key={gid} className="context-menu-item context-menu-item-info" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                </svg>
                {i18n.t('contextMenu.customGroup')}
              </span>
              {onRemoveCustomGroup && (
                <button 
                  className="context-menu-remove-btn" 
                  onClick={(e) => { e.stopPropagation(); onRemoveCustomGroup(gid); onClose(); }}
                  title={i18n.t('contextMenu.stopCustomGroup')}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="context-menu-separator" />
        </>
      )}

      <div className="context-menu-header">{i18n.t('contextMenu.addWidget')}</div>
      {sportsWidget !== 'autohide' && (
        <div className="context-menu-item" onClick={() => { onAddSportsAutohide(); onClose(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {i18n.t('contextMenu.liveSportsAutohide')}
        </div>
      )}
      {sportsWidget !== 'persistent' && (
        <div className="context-menu-item" onClick={() => { onAddSportsPersistent(); onClose(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {i18n.t('contextMenu.liveSportsPersistent')}
        </div>
      )}
      {!sportsLiveSidebarWidget && onAddSportsLiveSidebar && (
        <div className="context-menu-item" onClick={() => { onAddSportsLiveSidebar(); onClose(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
          {i18n.t('contextMenu.sportsLiveSidebar', 'Live Game Sidebar')}
        </div>
      )}
      {!recentWidget && (
        <>
          <div className="context-menu-item" onClick={() => { onAddRecent5(); onClose(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            {i18n.t('contextMenu.recentChannels5')}
          </div>
          <div className="context-menu-item" onClick={() => { onAddRecent10(); onClose(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            {i18n.t('contextMenu.recentChannels10')}
          </div>
        </>
      )}
      {!favoritesWidget && (
        <div className="context-menu-item" onClick={() => { onAddFavorites(); onClose(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          {i18n.t('common:favorites')}
        </div>
      )}
      {!whatsNextWidget && (
        <div className="context-menu-item" onClick={() => { onAddWhatsNext(); onClose(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          {i18n.t('contextMenu.whatsNext')}
        </div>
      )}
      {/* Custom Group — always available; opens the picker */}
      <div className="context-menu-item" onClick={() => { onAddCustomGroup(); onClose(); }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
        </svg>
        {i18n.t('contextMenu.customGroupEllipsis')}
      </div>
    </div>,
    document.body
  );
}
