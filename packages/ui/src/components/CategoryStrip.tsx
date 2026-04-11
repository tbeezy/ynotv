import { useState, useEffect, useRef, useCallback } from 'react';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { useCategoriesBySource, type CategoryWithCount, type SourceWithCategories } from '../hooks/useChannels';
import { db, getWatchlistCount, type CustomGroup } from '../db';
import type { Source } from '@ynotv/core';
import { useSourceVersion } from '../contexts/SourceVersionContext';
import { normalizeBoolean } from '../utils/db-helpers';
import { useModal } from './Modal';
import { createCustomGroup, deleteCustomGroup } from '../services/custom-groups';
import { CustomGroupManager } from './CustomGroupManager';
import { CategoryManager } from './settings/CategoryManager';
import { FavoriteManager } from './settings/FavoriteManager';
import { SourceContextMenu } from './SourceContextMenu';
import { EpgEditorModal } from './EpgEditorModal';
import './CategoryStrip.css';

// Component that detects text overflow and only scrolls when necessary
function ScrollingText({ children, className }: { children: React.ReactNode; className?: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;

    const checkOverflow = () => {
      // Check if text overflows its container
      // scrollWidth = full text width including overflow
      // clientWidth = visible width of the element
      const textWidth = element.scrollWidth;
      const visibleWidth = element.clientWidth;
      const hasOverflow = textWidth > visibleWidth + 2; // +2px safety margin
      setIsOverflowing(hasOverflow);
    };

    // Check multiple times to catch layout changes
    checkOverflow();
    const timeouts = [
      setTimeout(checkOverflow, 50),
      setTimeout(checkOverflow, 200),
      setTimeout(checkOverflow, 500)
    ];

    // Also check on window resize
    const handleResize = () => checkOverflow();
    window.addEventListener('resize', handleResize);

    return () => {
      timeouts.forEach(clearTimeout);
      window.removeEventListener('resize', handleResize);
    };
  }, [children]);

  return (
    <span 
      ref={textRef} 
      className={`${className || ''} ${isOverflowing ? 'overflowing' : ''}`}
    >
      {children}
    </span>
  );
}

interface CategoryStripProps {
  selectedCategoryId: string | null;
  onSelectCategory: (categoryId: string | null) => void;
  visible: boolean;
  sidebarExpanded: boolean;
  showSidebar?: boolean;
  onEditSource?: (sourceId: string) => void;
  onClose?: () => void;
  onShow?: () => void;
  isLiveTV?: boolean;
}

// Chevron Icon for expand/collapse
const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16" height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 0.2s ease',
      marginRight: '8px'
    }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

// Favorites button component
function FavoritesButton({ selectedCategoryId, onSelectCategory, onContextMenu }: { selectedCategoryId: string | null; onSelectCategory: (categoryId: string | null) => void; onContextMenu?: (e: React.MouseEvent) => void }) {
  const favoriteCount = useLiveQuery(
    async () => {
      return await db.channels.countWhere('(is_favorite = 1 OR is_favorite = true)');
    }
  );

  return (
    <button
      className={`category-item ${selectedCategoryId === '__favorites__' ? 'selected' : ''}`}
      onClick={() => onSelectCategory('__favorites__')}
      onContextMenu={onContextMenu}
    >
      <ScrollingText className="category-name">⭐ Favorites</ScrollingText>
      <span className="category-count">{favoriteCount ?? 0}</span>
    </button>
  );
}

// Watchlist button component
function WatchlistButton({ selectedCategoryId, onSelectCategory }: { selectedCategoryId: string | null; onSelectCategory: (categoryId: string | null) => void }) {
  const watchlistCount = useLiveQuery(
    async () => {
      return await getWatchlistCount();
    }
  );

  return (
    <button
      className={`category-item ${selectedCategoryId === '__watchlist__' ? 'selected' : ''}`}
      onClick={() => onSelectCategory('__watchlist__')}
    >
      <ScrollingText className="category-name">📋 Watchlist</ScrollingText>
      <span className="category-count">{watchlistCount ?? 0}</span>
    </button>
  );
}

// Recently Viewed button component
function RecentlyViewedButton({ selectedCategoryId, onSelectCategory }: { selectedCategoryId: string | null; onSelectCategory: (categoryId: string | null) => void }) {
  const recentCount = useLiveQuery(
    async () => {
      const { getRecentChannels } = await import('../utils/recentChannels');
      return getRecentChannels().length;
    }
  );

  return (
    <button
      className={`category-item ${selectedCategoryId === '__recent__' ? 'selected' : ''}`}
      onClick={() => onSelectCategory('__recent__')}
    >
      <ScrollingText className="category-name">🕐 Recently Viewed</ScrollingText>
      <span className="category-count">{recentCount ?? 0}</span>
    </button>
  );
}

// Custom Group button with reactive channel count
interface CustomGroupButtonProps {
  group: CustomGroup;
  selectedCategoryId: string | null;
  onSelectCategory: (id: string | null) => void;
  onContextMenu: (e: React.MouseEvent, groupId: string) => void;
}
function CustomGroupButton({ group, selectedCategoryId, onSelectCategory, onContextMenu }: CustomGroupButtonProps) {
  const channelCount = useLiveQuery(
    () => db.customGroupChannels.where('group_id').equals(group.group_id).count(),
    [group.group_id]
  );

  return (
    <button
      className={`category-item ${selectedCategoryId === group.group_id ? 'selected' : ''}`}
      onClick={() => onSelectCategory(group.group_id)}
      onContextMenu={(e) => onContextMenu(e, group.group_id)}
    >
      <ScrollingText className="category-name">📂 {group.name}</ScrollingText>
      <span className="category-count">{channelCount ?? 0}</span>
    </button>
  );
}



export function CategoryStrip({ selectedCategoryId, onSelectCategory, visible, sidebarExpanded, showSidebar = true, onEditSource, onClose, onShow, isLiveTV }: CategoryStripProps) {
  const groupedCategories = useCategoriesBySource();
  const [sources, setSources] = useState<Record<string, string>>({});
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const { version } = useSourceVersion(); // Listen for source changes

  // Custom Groups additions
  const { showModal, showConfirm, showPrompt, ModalComponent } = useModal();
  const [managingGroup, setManagingGroup] = useState<{ id: string, name: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, groupId: string } | null>(null);

  // Source Context Menu additions
  const [sourceContextMenu, setSourceContextMenu] = useState<{ x: number, y: number, sourceId: string, sourceName: string } | null>(null);
  const [managingCategorySource, setManagingCategorySource] = useState<{ id: string, name: string } | null>(null);
  const [epgEditorSource, setEpgEditorSource] = useState<{ id: string, name: string } | null>(null);

  // Favorites Context Menu additions
  const [favoritesContextMenu, setFavoritesContextMenu] = useState<{ x: number, y: number } | null>(null);
  const [managingFavorites, setManagingFavorites] = useState(false);

  const customGroups = useLiveQuery(
    () => db.customGroups.orderBy('display_order').toArray()
  );

  const handleCreateGroup = () => {
    showPrompt(
      'Create Custom Group',
      'Enter a name for the new group:',
      async (name) => {
        if (name.trim()) {
          await createCustomGroup(name.trim());
        }
      },
      undefined, // cancel handler
      'Group name...',
      '', // initial value
      'Create',
      'Cancel'
    );
  };

  const handleDeleteGroup = (groupId: string) => {
    showConfirm(
      'Delete Group',
      'Are you sure you want to delete this custom group?',
      async () => {
        await deleteCustomGroup(groupId);
      }
    );
  };

  const handleContextMenu = (e: React.MouseEvent, groupId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, groupId });
  };

  const handleSourceContextMenu = (e: React.MouseEvent, sourceId: string, sourceName: string) => {
    e.preventDefault();
    setSourceContextMenu({ x: e.clientX, y: e.clientY, sourceId, sourceName });
  };

  const handleFavoritesContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setFavoritesContextMenu({ x: e.clientX, y: e.clientY });
  };

  // Fetch source names to resolve IDs
  useEffect(() => {
    async function fetchSources() {
      if (window.storage) {
        // Get settings to check if sources should be collapsed on startup
        const settingsResult = await window.storage.getSettings();
        const collapseOnStartup = settingsResult.data?.collapseSourceCategoriesOnStartup ?? false;
        
        const result = await window.storage.getSources();
        if (result.data) {
          const sourceMap = result.data.reduce((acc: Record<string, string>, s: Source) => {
            acc[s.id] = s.name;
            return acc;
          }, {});
          setSources(sourceMap);

          const sourcesData = result.data;

          // Initialize new sources as expanded or collapsed based on setting
          setExpandedSources(prev => {
            const next = { ...prev };
            sourcesData.forEach((s: Source) => {
              if (next[s.id] === undefined) {
                next[s.id] = !collapseOnStartup; // false if collapseOnStartup is true
              }
            });
            return next;
          });
        }
      }
    }
    fetchSources();
  }, [version]); // Re-fetch when version changes

  // Toggle expansion for a source
  const toggleSource = (sourceId: string) => {
    setExpandedSources(prev => ({
      ...prev,
      [sourceId]: !prev[sourceId]
    }));
  };

  // Calculate total channel count for "All" option
  const totalChannels = groupedCategories.reduce((sum, group) =>
    sum + group.categories.reduce((s, cat) => s + cat.channelCount, 0), 0
  );

  return (
    <>
      <div className={`category-strip ${visible ? 'visible' : 'hidden'} ${sidebarExpanded ? 'sidebar-expanded' : ''} ${showSidebar ? 'with-sidebar' : 'no-sidebar'}`}>
        <div className="category-strip-header">
          <span className="category-strip-title">Categories</span>
          <div className="category-strip-actions">
            <button
              className="add-group-btn"
              onClick={handleCreateGroup}
              title="Create Custom Group"
            >
              +
            </button>
            {onClose && (
              <button
                className="hide-sidebar-btn"
                onClick={onClose}
                title="Hide Sidebar"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </button>
            )}
          </div>
        </div>

      <div className="category-strip-top">
        {/* "All Channels" option */}
        <button
          className={`category-item ${selectedCategoryId === null ? 'selected' : ''}`}
          onClick={() => onSelectCategory(null)}
        >
          <ScrollingText className="category-name">All Channels</ScrollingText>
          <span className="category-count">{totalChannels}</span>
        </button>

        {/* "Favorites" option */}
        <FavoritesButton
          selectedCategoryId={selectedCategoryId}
          onSelectCategory={onSelectCategory}
          onContextMenu={handleFavoritesContextMenu}
        />

        {/* "Watchlist" option */}
        <WatchlistButton
          selectedCategoryId={selectedCategoryId}
          onSelectCategory={onSelectCategory}
        />

        {/* "Recently Viewed" option */}
        <RecentlyViewedButton
          selectedCategoryId={selectedCategoryId}
          onSelectCategory={onSelectCategory}
        />

        {/* Custom Groups Section */}
        {customGroups && customGroups.length > 0 && (
          <div className="custom-groups-section">
            {customGroups.map(group => (
              <CustomGroupButton
                key={group.group_id}
                group={group}
                selectedCategoryId={selectedCategoryId}
                onSelectCategory={onSelectCategory}
                onContextMenu={handleContextMenu}
              />
            ))}

          </div>
        )}

      </div>

      <div className="category-strip-scrollable">
        {/* Grouped Category list */}
        {groupedCategories.map((group) => (
          <div key={group.sourceId} className={`category-source-group ${expandedSources[group.sourceId] ? 'is-expanded' : ''}`}>
            <button
              className="category-source-header"
              onClick={() => toggleSource(group.sourceId)}
              onContextMenu={(e) => handleSourceContextMenu(e, group.sourceId, sources[group.sourceId] || 'Source')}
            >
              <div className="source-header-left">
                <ChevronIcon expanded={expandedSources[group.sourceId]} />
                <div className="source-name-container">
                  <ScrollingText className="source-name">{sources[group.sourceId] || 'Loading...'}</ScrollingText>
                </div>
              </div>
              <span className="source-count">
                {group.categories.reduce((s, cat) => s + cat.channelCount, 0)}
              </span>
            </button>

            {expandedSources[group.sourceId] && (
              <div className="category-source-content">
                {group.categories.map((category) => (
                  <button
                    key={category.category_id}
                    className={`category-item nested ${selectedCategoryId === category.category_id ? 'selected' : ''}`}
                    onClick={() => onSelectCategory(category.category_id)}
                  >
                    <ScrollingText className="category-name">{category.category_name}</ScrollingText>
                    <span className="category-count">{category.channelCount}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {groupedCategories.length === 0 && (
          <div className="category-empty">
            <p>No categories yet</p>
            <p className="hint">Add a source in Settings</p>
          </div>
        )}
      </div>

      <ModalComponent />

      {managingGroup && (
        <CustomGroupManager
          groupId={managingGroup.id}
          groupName={managingGroup.name}
          onClose={() => setManagingGroup(null)}
        />
      )}

      {contextMenu && (
        <div
          className="context-menu"
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 2000,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--surface-border)',
            borderRadius: '6px',
            padding: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
          }}
        >
          <div
            onClick={() => {
              const grp = customGroups?.find(g => g.group_id === contextMenu.groupId);
              if (grp) setManagingGroup({ id: grp.group_id, name: grp.name });
              setContextMenu(null);
            }}
            style={{ padding: '8px 12px', cursor: 'pointer', color: 'var(--text-primary)' }}
          >
            Manage
          </div>
          <div
            onClick={() => {
              handleDeleteGroup(contextMenu.groupId);
              setContextMenu(null);
            }}
            style={{ padding: '8px 12px', cursor: 'pointer', color: 'var(--status-live)' }}
          >
            Delete
          </div>

          {/* Overlay to close menu on click outside */}
          <div
            style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: -1 }}
            onClick={() => setContextMenu(null)}
          />
        </div>
      )}

      {sourceContextMenu && (
        <SourceContextMenu
          sourceId={sourceContextMenu.sourceId}
          sourceName={sourceContextMenu.sourceName}
          position={{ x: sourceContextMenu.x, y: sourceContextMenu.y }}
          onClose={() => setSourceContextMenu(null)}
          onManageCategories={(id, name) => setManagingCategorySource({ id, name })}
          onEditSource={(id) => {
            if (onEditSource) {
              onEditSource(id);
            }
          }}
          onEditEpg={(id, name) => setEpgEditorSource({ id, name })}
        />
      )}

      {/* Favorites Context Menu */}
      {favoritesContextMenu && (
        <div
          className="context-menu"
          style={{
            position: 'fixed',
            top: favoritesContextMenu.y,
            left: favoritesContextMenu.x,
            zIndex: 2000,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--surface-border)',
            borderRadius: '6px',
            padding: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
          }}
        >
          <div
            onClick={() => {
              setManagingFavorites(true);
              setFavoritesContextMenu(null);
            }}
            style={{ padding: '8px 12px', cursor: 'pointer', color: 'var(--text-primary)' }}
          >
            ⭐ Manage Favorites
          </div>
          {/* Overlay to close menu on click outside */}
          <div
            style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: -1 }}
            onClick={() => setFavoritesContextMenu(null)}
          />
        </div>
      )}

      {/* Favorite Manager Modal */}
      {managingFavorites && (
        <FavoriteManager
          onClose={() => setManagingFavorites(false)}
          onChange={() => {
            // Refresh categories - the useChannels hook will pick up the new order
          }}
        />
      )}

      {/* Category Manager Modal overlaying the app native to CategoryStrip entirely */}
      {managingCategorySource && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, background: 'var(--bg-primary)' }}>
          <CategoryManager
            sourceId={managingCategorySource.id}
            sourceName={managingCategorySource.name}
            onClose={() => setManagingCategorySource(null)}
            onChange={() => {
              // The DB sync finishes naturally, updating the live hook automatically down the road
            }}
          />
        </div>
      )}

      {/* EPG Editor Modal — opened from source right-click */}
      {epgEditorSource && (
        <EpgEditorModal
          sourceId={epgEditorSource.id}
          sourceName={epgEditorSource.name}
          onClose={() => setEpgEditorSource(null)}
        />
      )}
      </div>

      {/* Show Sidebar Button - visible when sidebar is hidden and in LiveTV */}
      {!visible && onShow && isLiveTV && (
        <button
          className="show-sidebar-btn"
          onClick={onShow}
          title="Show Sidebar"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      )}
    </>
  );
}
