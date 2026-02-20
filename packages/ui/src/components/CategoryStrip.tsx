import { useState, useEffect } from 'react';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { useCategoriesBySource, type CategoryWithCount, type SourceWithCategories } from '../hooks/useChannels';
import { db, getWatchlistCount, type CustomGroup } from '../db';
import type { Source } from '@ynotv/core';
import { useSourceVersion } from '../contexts/SourceVersionContext';
import { normalizeBoolean } from '../utils/db-helpers';
import { useModal } from './Modal';
import { createCustomGroup, deleteCustomGroup } from '../services/custom-groups';
import { CustomGroupManager } from './CustomGroupManager';
import './CategoryStrip.css';

interface CategoryStripProps {
  selectedCategoryId: string | null;
  onSelectCategory: (categoryId: string | null) => void;
  visible: boolean;
  sidebarExpanded: boolean;
  showSidebar?: boolean;
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
function FavoritesButton({ selectedCategoryId, onSelectCategory }: { selectedCategoryId: string | null; onSelectCategory: (categoryId: string | null) => void }) {
  const favoriteCount = useLiveQuery(
    async () => {
      return await db.channels.countWhere('(is_favorite = 1 OR is_favorite = true)');
    }
  );

  return (
    <button
      className={`category-item ${selectedCategoryId === '__favorites__' ? 'selected' : ''}`}
      onClick={() => onSelectCategory('__favorites__')}
    >
      <span className="category-name">⭐ Favorites</span>
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
      <span className="category-name">📋 Watchlist</span>
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
      <span className="category-name">🕐 Recently Viewed</span>
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
      <span className="category-name">📂 {group.name}</span>
      <span className="category-count">{channelCount ?? 0}</span>
    </button>
  );
}



export function CategoryStrip({ selectedCategoryId, onSelectCategory, visible, sidebarExpanded, showSidebar = true }: CategoryStripProps) {
  const groupedCategories = useCategoriesBySource();
  const [sources, setSources] = useState<Record<string, string>>({});
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const { version } = useSourceVersion(); // Listen for source changes

  // Custom Groups additions
  const { showModal, showConfirm, showPrompt, ModalComponent } = useModal();
  const [managingGroup, setManagingGroup] = useState<{ id: string, name: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, groupId: string } | null>(null);

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

  // Fetch source names to resolve IDs
  useEffect(() => {
    async function fetchSources() {
      if (window.storage) {
        const result = await window.storage.getSources();
        if (result.data) {
          const sourceMap = result.data.reduce((acc: Record<string, string>, s: Source) => {
            acc[s.id] = s.name;
            return acc;
          }, {});
          setSources(sourceMap);

          const sourcesData = result.data;

          // Initialize new sources as expanded (only if not already set)
          setExpandedSources(prev => {
            const next = { ...prev };
            sourcesData.forEach((s: Source) => {
              if (next[s.id] === undefined) {
                next[s.id] = true;
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
    <div className={`category-strip ${visible ? 'visible' : 'hidden'} ${sidebarExpanded ? 'sidebar-expanded' : ''} ${showSidebar ? 'with-sidebar' : 'no-sidebar'}`}>
      <div className="category-strip-header">
        <span className="category-strip-title">Categories</span>
        <button
          className="add-group-btn"
          onClick={handleCreateGroup}
          title="Create Custom Group"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '1.2rem',
            padding: '0 4px'
          }}
        >
          +
        </button>
      </div>

      <div className="category-strip-list">
        {/* "All Channels" option */}
        <button
          className={`category-item ${selectedCategoryId === null ? 'selected' : ''}`}
          onClick={() => onSelectCategory(null)}
        >
          <span className="category-name">All Channels</span>
          <span className="category-count">{totalChannels}</span>
        </button>

        {/* "Favorites" option */}
        <FavoritesButton
          selectedCategoryId={selectedCategoryId}
          onSelectCategory={onSelectCategory}
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
            <div className="section-divider"></div>
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

        <div className="section-divider" style={{ height: 1, background: 'var(--surface-border)', margin: '8px 0' }}></div>

        {/* Grouped Category list */}
        {groupedCategories.map((group) => (
          <div key={group.sourceId} className="category-source-group">
            <button
              className="category-source-header"
              onClick={() => toggleSource(group.sourceId)}
            >
              <div className="source-header-left">
                <ChevronIcon expanded={expandedSources[group.sourceId]} />
                <span className="source-name">{sources[group.sourceId] || 'Loading...'}</span>
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
                    <span className="category-name">{category.category_name}</span>
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
    </div>
  );
}
