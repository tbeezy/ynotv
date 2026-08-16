import { Fragment, createContext, useContext, useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { createPortal } from 'react-dom';
import { useLiveQuery } from '../hooks/useSqliteLiveQuery';
import { useCategoriesBySource, useEnabledSources, type CategoryWithCount, type SourceWithCategories } from '../hooks/useChannels';
import { db, getWatchlistCount, type CustomGroup, updateCategoryEnabled, updateCategoryAlias, type CustomPlaylist, type PlaylistCategoryLink, type CategoryFolder, updateCategoriesBatch } from '../db';
import { PlaylistEditorModal } from './PlaylistEditorModal';
import type { Source } from '@ynotv/core';
import { useSourceVersion } from '../contexts/SourceVersionContext';
import { normalizeBoolean } from '../utils/db-helpers';
import { matchesSearch } from '../utils/searchNormalization';
import { useModal } from './Modal';
import { useSettingsStore, type CategorySettings } from '../stores/settingsStore';
import { createCustomGroup, deleteCustomGroup } from '../services/custom-groups';
import { CustomGroupManager } from './CustomGroupManager';
import { CreateCustomOptionModal } from './CreateCustomOptionModal';
import { CategoryManager } from './settings/CategoryManager';
import { FavoriteManager } from './settings/FavoriteManager';
import { SourceContextMenu } from './SourceContextMenu';
import { CategoryContextMenu } from './CategoryContextMenu';
import { FolderContextMenu } from './FolderContextMenu';
import { FavoritesContextMenu } from './FavoritesContextMenu';
import { RecentChannelsContextMenu } from './RecentChannelsContextMenu';
import { PlaylistContextMenu } from './PlaylistContextMenu';
import { EpgEditorModal } from './EpgEditorModal';
import { LogoEditorModal } from './LogoEditorModal';
import { clearRecentChannels } from '../utils/recentChannels';
import { useCategorySortOrder, useIncludeAllChannelsToPlaylist, useSidebarDragHotkey } from '../stores/uiStore';
import { isCategorySortCustomized, setCategorySortCustomized } from '../utils/categorySortOverrides';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import './CategoryStrip.css';

function SortableSidebarItem({ id, children, disabled, className = '', stickyStyle, dropIndicator = null }: { id: string; children: React.ReactNode; disabled?: boolean; className?: string; stickyStyle?: React.CSSProperties; dropIndicator?: 'above' | 'below' | null }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  // IMPORTANT: position:sticky must live on THIS wrapper div, not on the inner
  // child element. The wrapper is the block containing block — if sticky is set
  // on the child instead, the child's scroll range is limited to the wrapper
  // height (~38px) and it never actually sticks within the scroll container.
  const style: React.CSSProperties = {
    // Only apply transform while actively dragging. A static transform creates
    // a new CSS containing block that would trap sticky positioning.
    transform: isDragging ? CSS.Transform.toString(transform) : undefined,
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : undefined,
    touchAction: 'none',
    // Merge sticky positioning when provided (pinned categories)
    ...stickyStyle,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`sortable-sidebar-item ${className} ${isDragging ? 'dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
    >
      {children}
    </div>
  );
}

function SortableSourceHeader({
  id,
  disabled,
  className = '',
  onClick,
  onContextMenu,
  dropIndicator = null,
  children
}: {
  id: string;
  disabled?: boolean;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  dropIndicator?: 'above' | 'below' | null;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : undefined,
    touchAction: 'none',
  };
  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`sortable-sidebar-item ${className} ${isDragging ? 'dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </button>
  );
}

function parseCategoryIds(raw: string | string[] | number[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch { /* not JSON */ }
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [String(raw)];
}

const CategoryStripVisibilityContext = createContext(true);

// Component that detects text overflow and only scrolls when necessary
function ScrollingText({ children, className }: { children: React.ReactNode; className?: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const resizeActive = useContext(CategoryStripVisibilityContext);

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    if (!resizeActive) {
      setIsOverflowing(false);
      return;
    }

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
  }, [children, resizeActive]);

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
  onEditSource?: (sourceId: string) => void;
  onClose?: () => void;
  onShow?: () => void;
  isLiveTV?: boolean;
}

// Chevron Icon for expand/collapse
const ChevronIcon = ({ expanded, size = 16 }: { expanded: boolean; size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size} height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 0.2s ease',
      marginRight: size <= 12 ? '4px' : '8px',
      flexShrink: 0
    }}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

// Favorites button component
function FavoritesButton({ selectedCategoryId, onSelectCategory, onContextMenu }: { selectedCategoryId: string | null; onSelectCategory: (categoryId: string | null) => void; onContextMenu?: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation('live');
  const enabledSourceIds = useEnabledSources();
  const favoriteCount = useLiveQuery(
    async () => {
      if (enabledSourceIds) {
        const idsList = Array.from(enabledSourceIds);
        if (idsList.length === 0) return 0;
        const placeholders = idsList.map(() => '?').join(',');
        return await db.channels.countWhere(
          `(is_favorite = 1 OR is_favorite = true) AND source_id IN (${placeholders})`,
          idsList
        );
      }
      return await db.channels.countWhere('(is_favorite = 1 OR is_favorite = true)');
    },
    [enabledSourceIds]
  );

  return (
    <button
      className={`category-item category-list-bar ${selectedCategoryId === '__favorites__' ? 'selected' : ''}`}
      onClick={() => onSelectCategory('__favorites__')}
      onContextMenu={onContextMenu}
    >
      <div className="category-item-left">
        <span className="category-icon favorites-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </span>
        <ScrollingText className="category-name">{t('favorites')}</ScrollingText>
      </div>
      <span className="category-count">{favoriteCount ?? 0}</span>
    </button>
  );
}

// Watchlist button component
function WatchlistButton({ selectedCategoryId, onSelectCategory, onContextMenu }: { selectedCategoryId: string | null; onSelectCategory: (categoryId: string | null) => void; onContextMenu?: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation('live');
  const enabledSourceIds = useEnabledSources();
  const watchlistCount = useLiveQuery(
    async () => {
      return await getWatchlistCount(enabledSourceIds || undefined);
    },
    [enabledSourceIds]
  );

  return (
    <button
      className={`category-item category-list-bar ${selectedCategoryId === '__watchlist__' ? 'selected' : ''}`}
      onClick={() => onSelectCategory('__watchlist__')}
      onContextMenu={onContextMenu}
    >
      <div className="category-item-left">
        <span className="category-icon watchlist-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <ScrollingText className="category-name">{t('watchlist')}</ScrollingText>
      </div>
      <span className="category-count">{watchlistCount ?? 0}</span>
    </button>
  );
}

// Recently Viewed button component
function RecentlyViewedButton({ selectedCategoryId, onSelectCategory, onContextMenu }: { selectedCategoryId: string | null; onSelectCategory: (categoryId: string | null) => void; onContextMenu?: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation('live');
  const recentCount = useLiveQuery(
    async () => {
      const { getRecentChannels } = await import('../utils/recentChannels');
      return getRecentChannels().length;
    }
  );

  return (
    <button
      className={`category-item category-list-bar ${selectedCategoryId === '__recent__' ? 'selected' : ''}`}
      onClick={() => onSelectCategory('__recent__')}
      onContextMenu={onContextMenu}
    >
      <div className="category-item-left">
        <span className="category-icon recent-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </span>
        <ScrollingText className="category-name">{t('recentlyViewed')}</ScrollingText>
      </div>
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
      className={`category-item category-list-bar custom-group-item ${selectedCategoryId === group.group_id ? 'selected' : ''}`}
      onClick={() => onSelectCategory(group.group_id)}
      onContextMenu={(e) => onContextMenu(e, group.group_id)}
    >
      <div className="category-item-left">
        <span className="category-icon custom-group-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <ScrollingText className="category-name">{group.name}</ScrollingText>
      </div>
      <span className="category-count">{channelCount ?? 0}</span>
    </button>
  );
}

function PlaylistCategoryLinkItem({
  link,
  selectedCategoryId,
  onSelectCategory,
  displayName,
  channelCount,
  onContextMenu,
  isPinned,
  style,
}: {
  link: PlaylistCategoryLink;
  selectedCategoryId: string | null;
  onSelectCategory: (id: string | null) => void;
  displayName?: string;
  channelCount?: number;
  onContextMenu?: (e: React.MouseEvent) => void;
  isPinned?: boolean;
  style?: React.CSSProperties;
}) {
  const virtualId = `__plcat_${link.id}`;
  
  // Live lookup of category name (bypassed if precomputed)
  const category = useLiveQuery(
    () => displayName !== undefined ? null : db.categories.get(link.category_id),
    [link.category_id, displayName]
  );

  // Live count of channels in this category (bypassed if precomputed)
  const queryChannelCount = useLiveQuery(
    async () => {
      if (channelCount !== undefined) return channelCount;
      let count = 0;
      if (link.source_id !== 'custom') {
        const rows = await db.channels.whereRaw(
          `source_id = ? AND EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ?) AND (enabled IS NULL OR enabled NOT IN (0, '0', 'false'))`,
          [link.source_id, link.category_id]
        ).toArray();
        count += rows.length;
      }
      let manualCount = await db.playlistIndividualChannels
        .whereRaw('playlist_id = ? AND parent_category_id = ?', [link.playlist_id, `link:${link.id}`])
        .count();
      if (manualCount === 0) {
        manualCount = await db.playlistIndividualChannels
          .whereRaw('playlist_id = ? AND parent_category_id = ?', [link.source_id, link.category_id])
          .count();
      }
      return count + manualCount;
    },
    [link.source_id, link.category_id, link.playlist_id, link.id, channelCount],
    0
  );

  const finalName = displayName !== undefined ? displayName : (link.custom_name || category?.alias || category?.category_name || link.category_id);
  const finalCount = channelCount !== undefined ? channelCount : (queryChannelCount ?? 0);

  return (
    <button
      className={`category-item nested playlist-cat-item ${selectedCategoryId === virtualId ? 'selected' : ''} ${isPinned ? 'is-pinned' : ''}`}
      onClick={() => onSelectCategory(virtualId)}
      onContextMenu={onContextMenu}
      style={style}
    >
      <div className="nested-category-wrapper">
        {isPinned && (
          <span className="category-pin-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'rotate(45deg)' }}>
              <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
            </svg>
          </span>
        )}
        <ScrollingText className="category-name">{finalName}</ScrollingText>
      </div>
      <span className="category-count">{finalCount}</span>
    </button>
  );
}

function SidebarFolderHeader({
  folder,
  isFolderExpanded,
  folderCount,
  isPinned,
  onToggle,
  onContextMenu,
  style,
  'data-folder-id': dataFolderId,
}: {
  folder: CategoryFolder;
  isFolderExpanded: boolean;
  folderCount: number;
  isPinned?: boolean;
  onToggle: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  'data-folder-id'?: string;
}) {
  return (
    <button
      className={`category-folder-header ${isPinned ? 'is-pinned' : ''}`}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      style={style}
      data-folder-id={dataFolderId}
    >
      <div className="folder-header-left">
        <ChevronIcon expanded={isFolderExpanded} size={12} />
        <span className="category-icon folder-icon">
          {isPinned ? '📌' : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          )}
        </span>
        <ScrollingText className="folder-name">{folder.name}</ScrollingText>
      </div>
      <span className="folder-count">{folderCount}</span>
    </button>
  );
}



export function CategoryStrip({ selectedCategoryId, onSelectCategory, visible, onEditSource, onClose, onShow, isLiveTV }: CategoryStripProps) {
  const { t } = useTranslation('live');
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const prevVisibleRef = useRef(visible);
  const prevSelectedCatRef = useRef(selectedCategoryId);
  const pendingScrollRef = useRef(false);
  const reopenPendingRef = useRef(visible);

  // Track scroll triggers: only flag pending scroll on opening LiveTV or changing categories
  useLayoutEffect(() => {
    const justOpened = visible && !prevVisibleRef.current;
    const catChanged = selectedCategoryId !== prevSelectedCatRef.current;

    if (justOpened) {
      reopenPendingRef.current = true;
    }

    prevVisibleRef.current = visible;
    prevSelectedCatRef.current = selectedCategoryId;

    if (justOpened || (visible && catChanged)) {
      pendingScrollRef.current = true;
    }
  }, [visible, selectedCategoryId]);

  const groupedCategories = useCategoriesBySource();
  const categorySortOrder = useCategorySortOrder();
  const includeAllChannelsToPlaylist = useIncludeAllChannelsToPlaylist();
  const [sortOverridesVersion, setSortOverridesVersion] = useState(0);

  const [pinnedCategories, setPinnedCategories] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('ynotv:pinnedCategories');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const handlePinCategory = (sourceId: string, categoryId: string) => {
    const key = `${sourceId}:${categoryId}`;
    setPinnedCategories(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      localStorage.setItem('ynotv:pinnedCategories', JSON.stringify(next));
      return next;
    });
  };

  const handleUnpinCategory = useCallback((sourceId: string, categoryId: string) => {
    const key = `${sourceId}:${categoryId}`;
    setPinnedCategories(prev => {
      const next = prev.filter(k => k !== key);
      localStorage.setItem('ynotv:pinnedCategories', JSON.stringify(next));
      return next;
    });
  }, []);

  const [pinnedFolders, setPinnedFolders] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('ynotv:pinnedFolders');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const handlePinFolder = useCallback((sourceId: string, folderId: string) => {
    const key = `${sourceId}:${folderId}`;
    setPinnedFolders(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      localStorage.setItem('ynotv:pinnedFolders', JSON.stringify(next));
      return next;
    });
  }, []);

  const handleUnpinFolder = useCallback((sourceId: string, folderId: string) => {
    const key = `${sourceId}:${folderId}`;
    setPinnedFolders(prev => {
      const next = prev.filter(k => k !== key);
      localStorage.setItem('ynotv:pinnedFolders', JSON.stringify(next));
      return next;
    });
  }, []);

  const [folderContextMenu, setFolderContextMenu] = useState<{
    x: number;
    y: number;
    folderId: string;
    folderName: string;
    sourceId: string;
    sourceName: string;
  } | null>(null);

  useEffect(() => {
    const handleOverridesChange = () => {
      setSortOverridesVersion(prev => prev + 1);
    };
    window.addEventListener('ynotv:category-sort-overrides-changed', handleOverridesChange);
    return () => {
      window.removeEventListener('ynotv:category-sort-overrides-changed', handleOverridesChange);
    };
  }, []);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const filteredGroupedCategories = useMemo(() => {
    if (!searchQuery.trim()) {
      return groupedCategories;
    }
    return groupedCategories.map(group => {
      // Find categories that match the search query with multi-language/Cyrillic support
      const filteredCategories = group.categories.filter(cat => 
        matchesSearch(cat.alias || cat.category_name, searchQuery)
      );
      
      return {
        ...group,
        categories: filteredCategories
      };
    }).filter(group => group.categories.length > 0); // Only keep groups that have matching categories
  }, [groupedCategories, searchQuery]);

  const [sources, setSources] = useState<Record<string, string>>({});
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('ynotv:expandedSources');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    localStorage.setItem('ynotv:expandedSources', JSON.stringify(expandedSources));
  }, [expandedSources]);
  const { version } = useSourceVersion(); // Listen for source changes

  // Category visibility settings — reactive store selectors (the setters
  // dispatch the legacy event for any remaining listener; no IPC round-trip).
  const showAllChannels = useSettingsStore((s) => s.showAllChannels);
  const showFavorites = useSettingsStore((s) => s.showFavorites);
  const showWatchlist = useSettingsStore((s) => s.showWatchlist);
  const showRecentlyViewed = useSettingsStore((s) => s.showRecentlyViewed);
  const favoritesMode = useSettingsStore((s) => s.favoritesMode);

  // Resizable category sidebar width
  const [categoryWidth, setCategoryWidth] = useState(() => {
    const saved = localStorage.getItem('categoryStripContentWidth');
    return saved ? parseInt(saved) : 240;
  });

  // Set CSS custom property for layout
  useEffect(() => {
    document.documentElement.style.setProperty('--category-strip-content-width', `${categoryWidth}px`);
  }, [categoryWidth]);

  // Track mouse position for hover-to-show sidebar button
  const [mouseX, setMouseX] = useState(0);
  const [mouseY, setMouseY] = useState(0);

  // Calculate if mouse is in the "middle left" area (center 40% of screen height, within 40px of left edge)
  const isInMiddleLeftZone = useMemo(() => {
    const windowHeight = window.innerHeight;
    const middleStart = windowHeight * 0.3; // 30% from top
    const middleEnd = windowHeight * 0.7;   // 70% from top (30% from bottom)
    const isInVerticalZone = mouseY >= middleStart && mouseY <= middleEnd;
    const isNearLeftEdge = mouseX <= 50; // Within 50px of left edge
    return isNearLeftEdge && isInVerticalZone && !visible && isLiveTV;
  }, [mouseX, mouseY, visible, isLiveTV]);

  // Calculate if mouse is near left edge but NOT in the middle zone (for hint)
  const isNearLeftEdgeOutsideMiddle = useMemo(() => {
    const windowHeight = window.innerHeight;
    const middleStart = windowHeight * 0.3;
    const middleEnd = windowHeight * 0.7;
    const isOutsideVerticalZone = mouseY < middleStart || mouseY > middleEnd;
    const isNearLeftEdge = mouseX <= 50;
    return isNearLeftEdge && isOutsideVerticalZone && !visible && isLiveTV;
  }, [mouseX, mouseY, visible, isLiveTV]);

  // Handle mouse movement globally when sidebar is hidden
  useEffect(() => {
    if (!visible && isLiveTV) {
      const handleMouseMove = (e: MouseEvent) => {
        setMouseX(e.clientX);
        setMouseY(e.clientY);
      };

      document.addEventListener('mousemove', handleMouseMove);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
      };
    }
  }, [visible, isLiveTV]);

  // Custom Groups additions
  const { showModal, showConfirm, showPrompt, ModalComponent } = useModal();
  const [managingGroup, setManagingGroup] = useState<{ id: string, name: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, groupId: string } | null>(null);
  const [isCreateOptionModalOpen, setIsCreateOptionModalOpen] = useState(false);

  // Custom Playlists states
  const [expandedPlaylists, setExpandedPlaylists] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('ynotv:expandedPlaylists');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [playlistContextMenu, setPlaylistContextMenu] = useState<{
    x: number; y: number; playlistId: string; playlistName: string
  } | null>(null);
  const [editingPlaylist, setEditingPlaylist] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    localStorage.setItem('ynotv:expandedPlaylists', JSON.stringify(expandedPlaylists));
  }, [expandedPlaylists]);

  const handleTogglePlaylist = (playlistId: string) => {
    setExpandedPlaylists(prev => ({ ...prev, [playlistId]: !prev[playlistId] }));
  };

  const handleCreatePlaylist = () => {
    showPrompt(
      t('newPlaylistTitle'),
      t('newPlaylistMsg'),
      async (name) => {
        if (name.trim()) {
          const { createPlaylist } = await import('../services/playlist-editor');
          const id = await createPlaylist(name.trim());
          setExpandedPlaylists(prev => ({ ...prev, [id]: true }));
          setEditingPlaylist({ id, name: name.trim() });
        }
      },
      undefined,
      t('newPlaylistPlaceholder'),
      '',
      i18n.t('common:create'),
      i18n.t('common:cancel')
    );
  };

  const handleDeletePlaylist = (playlistId: string) => {
    showConfirm(
      t('deletePlaylistTitle'),
      t('deletePlaylistMsg'),
      async () => {
        const { deletePlaylist } = await import('../services/playlist-editor');
        await deletePlaylist(playlistId);
        if (selectedCategoryId?.startsWith('__plcat_') || 
            selectedCategoryId?.startsWith('__plindiv_')) {
          onSelectCategory(null);
        }
      }
    );
  };

  const handlePlaylistContextMenu = (e: React.MouseEvent, playlistId: string, playlistName: string) => {
    e.preventDefault();
    setPlaylistContextMenu({ x: e.clientX, y: e.clientY, playlistId, playlistName });
  };

  // Source Context Menu additions
  const [sourceContextMenu, setSourceContextMenu] = useState<{ x: number, y: number, sourceId: string, sourceName: string } | null>(null);
  const [managingCategorySource, setManagingCategorySource] = useState<{ id: string, name: string; initialCreateFolder?: boolean; initialBulkFolder?: { folder_id: string; name: string } } | null>(null);
  const [epgEditorSource, setEpgEditorSource] = useState<{ id: string, name: string } | null>(null);

  // Favorites Context Menu additions
  const [favoritesContextMenu, setFavoritesContextMenu] = useState<{ x: number, y: number } | null>(null);
  const [managingFavorites, setManagingFavorites] = useState(false);

  // Recently Viewed Context Menu additions
  const [recentContextMenu, setRecentContextMenu] = useState<{ x: number, y: number } | null>(null);

  // Generic Sidebar Item Context Menu additions
  const [genericSidebarContextMenu, setGenericSidebarContextMenu] = useState<{ x: number, y: number, type: 'all' | 'watchlist', title: string } | null>(null);

  const handleSidebarItemHide = async (type: 'all' | 'watchlist' | 'favorites' | 'recent') => {
    // Write through the store setter (persists + dispatches the legacy event
    // so Settings.tsx's local-state listener stays in sync).
    const patch: Partial<CategorySettings> = {};
    if (type === 'all') {
      patch.showAllChannels = false;
    } else if (type === 'watchlist') {
      patch.showWatchlist = false;
    } else if (type === 'favorites') {
      patch.showFavorites = false;
    } else {
      patch.showRecentlyViewed = false;
    }
    useSettingsStore.getState().setCategorySettings(patch);
  };

  // Category Context Menu additions
  const [categoryContextMenu, setCategoryContextMenu] = useState<{ x: number, y: number, categoryId: string, categoryName: string, sourceId: string, sourceName: string } | null>(null);
  const [logoEditorCategory, setLogoEditorCategory] = useState<{ categoryId: string, categoryName: string, sourceId: string } | null>(null);

  const customGroups = useLiveQuery(
    () => db.customGroups.orderBy('display_order').toArray()
  );

  // Per-source favorite counts (source_id -> count) for the per-source Favorites entries.
  // No table filter so it reacts to is_favorite changes on the channels table.
  const perSourceFavoriteCounts = useLiveQuery(
    async () => {
      const rows = await db.channels.whereRaw('(is_favorite = 1 OR is_favorite = true)').toArray();
      const map = new Map<string, number>();
      for (const ch of rows) {
        map.set(ch.source_id, (map.get(ch.source_id) || 0) + 1);
      }
      return map;
    },
    [],
    new Map<string, number>()
  );

  // Load all custom playlists ordered by display_order
  const customPlaylists = useLiveQuery(
    () => db.customPlaylists.orderBy('display_order').toArray(),
    [],
    [],
    0,
    'custom_playlists'
  );

  // Load all playlist category links
  const allPlaylistCategoryLinks = useLiveQuery(
    () => db.playlistCategoryLinks.toArray(),
    [],
    [],
    0,
    'playlist_category_links'
  );

  // Load all category folders
  const allCategoryFolders = useLiveQuery(
    async () => {
      const folders = await db.categoryFolders.toArray();
      return folders.sort((a, b) => a.display_order - b.display_order);
    },
    [],
    [],
    0,
    'category_folders'
  );

  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  // Track the most-recently expanded folder so we can scroll it into view
  const lastExpandedFolderRef = useRef<string | null>(null);

  const toggleFolder = (folderId: string) => {
    setExpandedFolders(prev => {
      const nowExpanded = !prev[folderId];
      if (nowExpanded) {
        lastExpandedFolderRef.current = folderId;
      }
      return {
        ...prev,
        [folderId]: nowExpanded
      };
    });
  };

  const getStickyOffsetForElement = (targetEl: HTMLElement) => {
    const sourceGroupEl = targetEl.closest('.category-source-group');
    if (!sourceGroupEl) return 0;

    let stickyOffset = 0;
    const sourceHeader = sourceGroupEl.querySelector<HTMLElement>('.category-source-header');
    if (sourceHeader) stickyOffset += sourceHeader.offsetHeight;

    const stickyItems = Array.from(
      sourceGroupEl.querySelectorAll<HTMLElement>(
        '.category-folder-header.is-pinned, .category-item.nested.is-pinned'
      )
    );

    for (const el of stickyItems) {
      if (el === targetEl) continue;
      if (el.compareDocumentPosition(targetEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
        stickyOffset += el.offsetHeight;
      }
    }

    return stickyOffset;
  };

  const getNaturalTopInScrollContainer = (container: HTMLElement, targetEl: HTMLElement) => {
    const previousPosition = targetEl.style.getPropertyValue('position');
    const previousPositionPriority = targetEl.style.getPropertyPriority('position');
    const previousTop = targetEl.style.getPropertyValue('top');
    const previousTopPriority = targetEl.style.getPropertyPriority('top');

    targetEl.style.setProperty('position', 'static', 'important');
    targetEl.style.setProperty('top', 'auto', 'important');

    const containerRect = container.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    const naturalTop = container.scrollTop + targetRect.top - containerRect.top;

    if (previousPosition) {
      targetEl.style.setProperty('position', previousPosition, previousPositionPriority);
    } else {
      targetEl.style.removeProperty('position');
    }
    if (previousTop) {
      targetEl.style.setProperty('top', previousTop, previousTopPriority);
    } else {
      targetEl.style.removeProperty('top');
    }

    return naturalTop;
  };

  // After a folder is expanded, reset the scroll so its header and first
  // category are visible below the source header and pinned rows.
  useLayoutEffect(() => {
    const folderId = lastExpandedFolderRef.current;
    if (!folderId) return;
    lastExpandedFolderRef.current = null;

    const container = scrollContainerRef.current;
    if (!container) return;

    // Locate the folder header robustly (avoid querySelector escaping issues by
    // comparing the attribute directly rather than building a selector string).
    let headerEl: HTMLElement | null = null;
    const headers = container.querySelectorAll<HTMLElement>('[data-folder-id]');
    for (const h of Array.from(headers)) {
      if (h.getAttribute('data-folder-id') === folderId) {
        headerEl = h;
        break;
      }
    }
    if (!headerEl) return;

    const stickyOffset = getStickyOffsetForElement(headerEl);
    const naturalTop = getNaturalTopInScrollContainer(container, headerEl);

    container.scrollTop = Math.max(0, naturalTop - stickyOffset);
  }, [expandedFolders]);

  // Load all categories for link name mapping
  const allCategoriesList = useLiveQuery(
    () => db.categories.toArray(),
    [],
    []
  );

  const categoryNamesMap = useMemo(() => {
    const map = new Map<string, string>();
    if (allCategoriesList) {
      for (const cat of allCategoriesList) {
        map.set(cat.category_id, cat.alias || cat.category_name);
      }
    }
    return map;
  }, [allCategoriesList]);

  // Auto-expand the parent (source/playlist AND folder) of the currently selected category ONLY when reopening LiveTV / transparent LiveTV EPG
  useLayoutEffect(() => {
    if (!visible || !reopenPendingRef.current || !selectedCategoryId) return;

    let parentSourceId: string | null = null;
    let parentPlaylistId: string | null = null;
    let parentFolderId: string | null = null;
    let resolved = false;

    if (selectedCategoryId.startsWith('__allsrc_pl_')) {
      parentPlaylistId = selectedCategoryId.replace('__allsrc_pl_', '');
      resolved = true;
    } else if (selectedCategoryId.startsWith('__allsrc_')) {
      parentSourceId = selectedCategoryId.replace('__allsrc_', '');
      resolved = true;
    } else if (selectedCategoryId.startsWith('__favsrc_')) {
      parentSourceId = selectedCategoryId.replace('__favsrc_', '');
      resolved = true;
    } else if (selectedCategoryId.startsWith('__plindiv_')) {
      const id = selectedCategoryId.replace('__plindiv_', '');
      if (customPlaylists !== undefined) {
        const isPlaylist = customPlaylists.some(p => p.playlist_id === id);
        if (isPlaylist) {
          parentPlaylistId = id;
        } else {
          parentSourceId = id;
        }
        resolved = true;
      }
    } else if (selectedCategoryId.startsWith('__plcat_')) {
      const linkId = parseInt(selectedCategoryId.replace('__plcat_', ''), 10);
      if (!isNaN(linkId) && allPlaylistCategoryLinks !== undefined) {
        const link = allPlaylistCategoryLinks.find(l => l.id === linkId);
        if (link) {
          const isPlaylist = customPlaylists?.some(p => p.playlist_id === link.playlist_id);
          if (isPlaylist) {
            parentPlaylistId = link.playlist_id;
          } else {
            parentSourceId = link.playlist_id;
          }
          if (link.folder_id) {
            parentFolderId = link.folder_id;
          }
        }
        resolved = true;
      }
    } else if (
      selectedCategoryId === '__all__' ||
      selectedCategoryId === '__favorites__' ||
      selectedCategoryId === '__watchlist__' ||
      selectedCategoryId === '__recent__'
    ) {
      resolved = true;
    } else {
      // Normal native category ID - ensure groupedCategories & allCategoriesList are populated before resolving
      if (groupedCategories && groupedCategories.length > 0 && allCategoriesList) {
        const foundGroup = groupedCategories.find(g =>
          g.categories.some(cat => cat.category_id === selectedCategoryId)
        );
        if (foundGroup) {
          parentSourceId = foundGroup.sourceId;
        }
        const nativeCat = allCategoriesList.find(c => c.category_id === selectedCategoryId);
        if (nativeCat && nativeCat.folder_id) {
          parentFolderId = nativeCat.folder_id;
        }
        resolved = true;
      }
    }

    if (resolved) {
      if (parentSourceId) {
        setExpandedSources(prev => {
          if (prev[parentSourceId!] === true) return prev;
          return { ...prev, [parentSourceId!]: true };
        });
      }
      if (parentPlaylistId) {
        setExpandedPlaylists(prev => {
          if (prev[parentPlaylistId!] === true) return prev;
          return { ...prev, [parentPlaylistId!]: true };
        });
      }
      if (parentFolderId) {
        setExpandedFolders(prev => {
          if (prev[parentFolderId!] === true) return prev;
          return { ...prev, [parentFolderId!]: true };
        });
      }
      reopenPendingRef.current = false;
    }
  }, [
    visible,
    selectedCategoryId,
    groupedCategories,
    customPlaylists,
    allPlaylistCategoryLinks,
    allCategoriesList
  ]);

  // Scroll the selected category item into view instantly when sidebar is opened
  useLayoutEffect(() => {
    if (!visible || !selectedCategoryId || !pendingScrollRef.current) return;

    const container = scrollContainerRef.current;
    if (!container) return;
    const selectedEl = container.querySelector('.category-item.selected') as HTMLElement | null;
    if (selectedEl) {
      const containerRect = container.getBoundingClientRect();
      const elementRect = selectedEl.getBoundingClientRect();
      
      const stickyOffset = getStickyOffsetForElement(selectedEl);
      
      const viewTop = containerRect.top + stickyOffset;
      const viewBottom = containerRect.bottom;
      
      const elementTop = elementRect.top;
      const elementBottom = elementRect.bottom;
      
      if (elementTop < viewTop) {
        container.scrollTop -= (viewTop - elementTop);
      } else if (elementBottom > viewBottom) {
        container.scrollTop += (elementBottom - viewBottom);
      }
      
      pendingScrollRef.current = false;
    }
  }, [visible, selectedCategoryId, expandedSources, expandedPlaylists]);

  // Load flat playlist individual channel counts (where parent_category_id is NULL)
  const flatPlaylistIndividualCounts = useLiveQuery(
    async () => {
      const all = await db.playlistIndividualChannels.toArray();
      const counts = new Map<string, number>();
      for (const item of all) {
        if (!item.parent_category_id) {
          counts.set(item.playlist_id, (counts.get(item.playlist_id) || 0) + 1);
        }
      }
      return counts;
    },
    [],
    new Map(),
    0,
    'playlist_individual_channels'
  );

  // Load total playlist individual channel counts (all of them)
  const totalPlaylistIndividualCounts = useLiveQuery(
    async () => {
      const all = await db.playlistIndividualChannels.toArray();
      const counts = new Map<string, number>();
      for (const item of all) {
        counts.set(item.playlist_id, (counts.get(item.playlist_id) || 0) + 1);
      }
      return counts;
    },
    [],
    new Map(),
    0,
    'playlist_individual_channels'
  );

  // Load manual nested channel counts grouped by parent_category_id
  const manualCategoryChannelCounts = useLiveQuery(
    async () => {
      const all = await db.playlistIndividualChannels.toArray();
      const links = await db.playlistCategoryLinks.toArray();
      
      const streamIds = all.map(item => item.stream_id);
      const channels = streamIds.length > 0 ? await db.channels.where('stream_id').anyOf(streamIds).toArray() : [];
      const channelMap = new Map(channels.map(ch => [ch.stream_id, ch]));

      const counts = new Map<string, number>();
      for (const item of all) {
        if (item.parent_category_id) {
          let targetSourceId: string | null = null;
          let targetCategoryId: string | null = null;

          if (item.parent_category_id.startsWith('link:')) {
            const linkId = parseInt(item.parent_category_id.replace('link:', ''), 10);
            const link = links.find(l => l.id === linkId);
            if (link) {
              targetSourceId = link.source_id;
              targetCategoryId = link.category_id;
            }
          } else {
            targetSourceId = item.playlist_id;
            targetCategoryId = item.parent_category_id;
          }

          const ch = channelMap.get(item.stream_id);
          const isCustomCategory = targetSourceId === 'custom';
          const isNative = !isCustomCategory && targetSourceId && targetCategoryId && ch && ch.source_id === targetSourceId && parseCategoryIds(ch.category_ids).includes(targetCategoryId);

          if (!isNative) {
            const key = `${item.playlist_id}:${item.parent_category_id}`;
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        }
      }
      // Add inherited counts for links that do not have custom overrides
      for (const link of links) {
        const linkKey = `${link.playlist_id}:link:${link.id}`;
        if (!counts.has(linkKey) || counts.get(linkKey) === 0) {
          const targetKey = `${link.source_id}:${link.category_id}`;
          const targetCount = counts.get(targetKey) || 0;
          if (targetCount > 0) {
            counts.set(linkKey, targetCount);
          }
        }
      }
      return counts;
    },
    [],
    new Map<string, number>()
  );

  interface SidebarSourceItem {
    id: string;
    type: 'real' | 'playlist';
    name: string;
    count: number;
    realGroup?: typeof filteredGroupedCategories[0];
    playlistGroup?: CustomPlaylist;
  }

  // Load unified sidebar order from preference
  const sidebarOrderPref = useLiveQuery(
    () => db.prefs.get('sidebar_sources_order'),
    []
  );

  const sidebarSourcesOrder = useMemo(() => {
    if (!sidebarOrderPref?.value) return null;
    try {
      return JSON.parse(sidebarOrderPref.value) as string[];
    } catch {
      return null;
    }
  }, [sidebarOrderPref]);

  const categoryChannelCounts = useMemo(() => {
    const catCounts = new Map<string, number>();
    if (!filteredGroupedCategories) return catCounts;
    for (const g of filteredGroupedCategories) {
      for (const cat of g.categories) {
        catCounts.set(cat.category_id, cat.channelCount);
      }
    }
    return catCounts;
  }, [filteredGroupedCategories]);

  const combinedSources = useMemo(() => {
    const list: SidebarSourceItem[] = [];
    
    // Add real sources
    for (const group of filteredGroupedCategories) {
      const customLinks = (allPlaylistCategoryLinks || [])
        .filter(l => l.playlist_id === group.sourceId);
      const individualCount = totalPlaylistIndividualCounts?.get(group.sourceId) || 0;
      
      let count = group.categories.reduce((s, cat) => s + cat.channelCount, 0);
      for (const link of customLinks) {
        count += categoryChannelCounts.get(link.category_id) || 0;
      }
      count += individualCount;

      list.push({
        id: group.sourceId,
        type: 'real',
        name: sources[group.sourceId] || t('loading'),
        count,
        realGroup: group
      });
    }
    
    // Add custom playlists
    if (customPlaylists) {
      for (const playlist of customPlaylists) {
        const playlistLinks = (allPlaylistCategoryLinks || [])
          .filter(l => l.playlist_id === playlist.playlist_id);
        const individualCount = flatPlaylistIndividualCounts?.get(playlist.playlist_id) || 0;
        
        let totalCount = 0;
        for (const link of playlistLinks) {
          const nativeCount = categoryChannelCounts.get(link.category_id) || 0;
          const manualCount = manualCategoryChannelCounts?.get(`${playlist.playlist_id}:link:${link.id}`) || 0;
          totalCount += nativeCount + manualCount;
        }
        totalCount += individualCount;
        
        list.push({
          id: `playlist:${playlist.playlist_id}`,
          type: 'playlist',
          name: playlist.name,
          count: totalCount,
          playlistGroup: playlist
        });
      }
    }
    
    // Sort according to sidebarSourcesOrder if it exists
    if (sidebarSourcesOrder) {
      const orderMap = new Map(sidebarSourcesOrder.map((id, index) => [id, index]));
      list.sort((a, b) => {
        const orderA = orderMap.has(a.id) ? orderMap.get(a.id)! : Number.MAX_SAFE_INTEGER;
        const orderB = orderMap.has(b.id) ? orderMap.get(b.id)! : Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
      });
    }
    
    return list;
  }, [filteredGroupedCategories, sources, customPlaylists, allPlaylistCategoryLinks, flatPlaylistIndividualCounts, totalPlaylistIndividualCounts, sidebarSourcesOrder, categoryChannelCounts, manualCategoryChannelCounts]);

  const sidebarDragHotkey = useSidebarDragHotkey();
  const [isDragKeyPressed, setIsDragKeyPressed] = useState(false);

  useEffect(() => {
    if (sidebarDragHotkey === 'None') {
      setIsDragKeyPressed(true);
      return;
    }

    const checkKey = (e: KeyboardEvent) => {
      let active = false;
      if (sidebarDragHotkey === 'Control') active = e.ctrlKey;
      else if (sidebarDragHotkey === 'Alt') active = e.altKey;
      else if (sidebarDragHotkey === 'Shift') active = e.shiftKey;
      else if (sidebarDragHotkey === 'Meta') active = e.metaKey;
      setIsDragKeyPressed(active);
    };

    const handleKeyDown = (e: KeyboardEvent) => checkKey(e);
    const handleKeyUp = (e: KeyboardEvent) => checkKey(e);

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [sidebarDragHotkey]);

  const isDragActive = sidebarDragHotkey === 'None' || isDragKeyPressed;

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Drag-over tracking for the above/below drop indicator. Shared across the
  // three DndContexts (sources, per-source categories, per-playlist categories)
  // since only one drag is ever active at a time.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overDragId, setOverDragId] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragOver = (event: DragOverEvent) => {
    if (event.over && event.active.id !== event.over.id) {
      setOverDragId(String(event.over.id));
    } else {
      setOverDragId(null);
    }
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
    setOverDragId(null);
  };

  const handleSourceDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setOverDragId(null);
    if (!over || active.id === over.id || !combinedSources) return;

    const oldIndex = combinedSources.findIndex((item: SidebarSourceItem) => item.id === active.id);
    const newIndex = combinedSources.findIndex((item: SidebarSourceItem) => item.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const next: SidebarSourceItem[] = arrayMove(combinedSources, oldIndex, newIndex);
    const orderedIds = next.map((item: SidebarSourceItem) => item.id);

    try {
      await db.prefs.put({
        key: 'sidebar_sources_order',
        value: JSON.stringify(orderedIds)
      });

      const playlistsOnly = next.filter((item: SidebarSourceItem) => item.type === 'playlist');
      for (let i = 0; i < playlistsOnly.length; i++) {
        if (playlistsOnly[i].playlistGroup) {
          await db.customPlaylists.update(playlistsOnly[i].playlistGroup!.playlist_id, { display_order: i });
        }
      }
    } catch (err) {
      console.error('Failed to save sidebar source order:', err);
    }
  };

  const handleCategoryDragEnd = async (sourceId: string, currentList: { id: string; type: 'native' | 'link'; nativeCat?: any; customLink?: any }[], event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setOverDragId(null);
    if (!over || active.id === over.id || !currentList) return;

    const oldIndex = currentList.findIndex(c => c.id === active.id);
    const newIndex = currentList.findIndex(c => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(currentList, oldIndex, newIndex);
    try {
      const nativeUpdates: { categoryId: string; displayOrder: number; folderId?: string | null }[] = [];
      const linkItems: PlaylistCategoryLink[] = [];

      reordered.forEach((catItem: { id: string; type: 'native' | 'link'; nativeCat?: any; customLink?: any }, idx: number) => {
        if (catItem.type === 'native' && catItem.nativeCat) {
          nativeUpdates.push({
            categoryId: catItem.nativeCat.category_id,
            displayOrder: idx,
            folderId: catItem.nativeCat.folder_id || null,
          });
        } else if (catItem.type === 'link' && catItem.customLink) {
          linkItems.push({
            ...catItem.customLink,
            display_order: idx,
          });
        }
      });

      if (nativeUpdates.length > 0) {
        await updateCategoriesBatch(nativeUpdates);
      }
      if (linkItems.length > 0) {
        await db.playlistCategoryLinks.bulkPut(linkItems);
      }

      setCategorySortCustomized(sourceId, true);
    } catch (err) {
      console.error('Failed to save category drag order:', err);
    }
  };

  const handleCreateGroup = () => {
    showPrompt(
      t('createGroupTitle'),
      t('createGroupMsg'),
      async (name) => {
        if (name.trim()) {
          await createCustomGroup(name.trim());
        }
      },
      undefined, // cancel handler
      t('createGroupPlaceholder'),
      '', // initial value
      i18n.t('common:create'),
      i18n.t('common:cancel')
    );
  };

  const handleDeleteGroup = (groupId: string) => {
    showConfirm(
      t('deleteGroupTitle'),
      t('deleteGroupMsg'),
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

  const handleRecentContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setRecentContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCategoryContextMenu = (e: React.MouseEvent, categoryId: string, categoryName: string, sourceId: string, sourceName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCategoryContextMenu({ x: e.clientX, y: e.clientY, categoryId, categoryName, sourceId, sourceName });
  };

  const handleHideCategory = async (categoryId: string) => {
    try {
      await updateCategoryEnabled(categoryId, false);
    } catch (err) {
      console.error('[CategoryStrip] Failed to hide category:', err);
    }
  };

  const handleRenameCategory = (categoryId: string, currentName: string) => {
    showPrompt(
      t('renameCategoryTitle'),
      t('renameCategoryMsg'),
      async (newName) => {
        const trimmed = newName.trim();
        if (trimmed && trimmed !== currentName) {
          try {
            if (categoryId.startsWith('link:')) {
              const linkId = parseInt(categoryId.replace('link:', ''), 10);
              if (!isNaN(linkId)) {
                const { renameCategoryLink } = await import('../services/playlist-editor');
                await renameCategoryLink(linkId, trimmed);
              }
            } else {
              await updateCategoryAlias(categoryId, trimmed);
            }
          } catch (err) {
            console.error('[CategoryStrip] Failed to rename category:', err);
          }
        }
      },
      undefined,
      t('categoryNamePlaceholder'),
      currentName,
      i18n.t('common:rename'),
      i18n.t('common:cancel'),
      false
    );
  };

  // ── Drag-to-resize for category sidebar ───────────────────────────────────
  const isResizingCategory = useRef(false);
  const isFirstLoad = useRef(true);

  const handleCategoryResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isResizingCategory.current = true;

    const startX = e.clientX;
    const startWidth = categoryWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingCategory.current) return;
      const dx = moveEvent.clientX - startX;
      let newWidth = startWidth + dx;
      newWidth = Math.max(180, Math.min(newWidth, 500));
      document.documentElement.style.setProperty('--category-strip-content-width', `${newWidth}px`);
    };

    const handleMouseUp = () => {
      if (!isResizingCategory.current) return;
      isResizingCategory.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);

      const finalWidthStr = getComputedStyle(document.documentElement).getPropertyValue('--category-strip-content-width');
      const finalWidth = parseInt(finalWidthStr) || 240;
      setCategoryWidth(finalWidth);
      localStorage.setItem('categoryStripContentWidth', String(finalWidth));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [categoryWidth]);

  const handleCategoryResizeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCategoryWidth(240);
    localStorage.setItem('categoryStripContentWidth', '240');
    document.documentElement.style.setProperty('--category-strip-content-width', '240px');
  }, []);

  // One-shot per session: collapse all source categories once the
  // (authoritative, hydrated) setting is known. Reactive on the setting so the
  // collapse isn't lost to the boot race — CategoryStrip mounts at boot and
  // this effect used to consume isFirstLoad with the store's hardcoded default
  // before ensureSettingsHydration() reconciled the real value.
  const collapseOnStartup = useSettingsStore((s) => s.collapseSourceCategoriesOnStartup);
  useEffect(() => {
    if (collapseOnStartup && isFirstLoad.current) {
      setExpandedPlaylists({});
      setExpandedSources({});
      isFirstLoad.current = false;
    }
  }, [collapseOnStartup]);

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

          // Read the value AFTER the await so hydration has had a chance to
          // land — new sources initialize collapsed/expanded per the setting.
          const collapseOnStartup = useSettingsStore.getState().collapseSourceCategoriesOnStartup;

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
    <CategoryStripVisibilityContext.Provider value={visible}>
    <>
      <div className={`category-strip ${visible ? 'visible' : 'hidden'} ${isDragActive ? 'drag-hotkey-active' : ''}`}>
        {/* Resizer Handle */}
        <div
          className="category-strip-resizer"
          onMouseDown={handleCategoryResizeMouseDown}
          onContextMenu={handleCategoryResizeContextMenu}
          title={t('dragResizeSidebar')}
        />
        <div className="category-strip-header">
          <span className="category-strip-title">{t('categories')}</span>
          <div className="category-strip-actions">
            <button
              className="add-group-btn"
              onClick={() => setIsCreateOptionModalOpen(true)}
              title={t('createGroupPlaylist')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
            </button>
            {onClose && (
              <button
                className="guide-nav-btn"
                onClick={onClose}
                title={t('hideSidebar')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="category-search-container">
          <div className={`category-search-input-wrapper ${searchFocused ? 'focused' : ''}`}>
            <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <input
              type="text"
              className="category-search-input"
              placeholder={t('searchCategoriesPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
            />
            {searchQuery && (
              <button className="search-clear-btn" onClick={() => setSearchQuery('')}>
                ✕
              </button>
            )}
          </div>
        </div>

      <div className="category-strip-top">
        {/* "All Channels" option */}
        {showAllChannels && (
          <button
            className={`category-item category-list-bar ${selectedCategoryId === null ? 'selected' : ''}`}
            onClick={() => onSelectCategory(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setGenericSidebarContextMenu({ x: e.clientX, y: e.clientY, type: 'all', title: t('allChannels') });
            }}
          >
            <div className="category-item-left">
              <span className="category-icon all-channels-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                  <polyline points="17 2 12 7 7 2" />
                </svg>
              </span>
              <ScrollingText className="category-name">{t('allChannels')}</ScrollingText>
            </div>
            <span className="category-count">{totalChannels}</span>
          </button>
        )}

        {/* "Favorites" option (top-level, shown in global or both mode) */}
        {showFavorites && (favoritesMode === 'global' || favoritesMode === 'both') && (
          <FavoritesButton
            selectedCategoryId={selectedCategoryId}
            onSelectCategory={onSelectCategory}
            onContextMenu={handleFavoritesContextMenu}
          />
        )}

        {/* "Watchlist" option */}
        {showWatchlist && (
          <WatchlistButton
            selectedCategoryId={selectedCategoryId}
            onSelectCategory={onSelectCategory}
            onContextMenu={(e) => {
              e.preventDefault();
              setGenericSidebarContextMenu({ x: e.clientX, y: e.clientY, type: 'watchlist', title: 'Watchlist' });
            }}
          />
        )}

        {/* "Recently Viewed" option */}
        {showRecentlyViewed && (
          <RecentlyViewedButton
            selectedCategoryId={selectedCategoryId}
            onSelectCategory={onSelectCategory}
            onContextMenu={handleRecentContextMenu}
          />
        )}

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

      <div className="category-strip-scrollable" ref={scrollContainerRef}>
        <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragCancel={handleDragCancel} onDragEnd={handleSourceDragEnd}>
          <SortableContext items={combinedSources.map(s => s.id)} strategy={verticalListSortingStrategy}>
            {combinedSources.map((item, index) => {
          const sourceActiveIndex = activeDragId ? combinedSources.findIndex((s: SidebarSourceItem) => s.id === activeDragId) : -1;
          const sourceOverIndex = overDragId ? combinedSources.findIndex((s: SidebarSourceItem) => s.id === overDragId) : -1;
          const sourceDropIndicator = overDragId === item.id && activeDragId !== overDragId
            ? (sourceActiveIndex < sourceOverIndex ? 'below' : 'above')
            : null;
          if (item.type === 'real' && item.realGroup) {
            const group = item.realGroup;
            const isExpanded = expandedSources[group.sourceId] || searchQuery.trim().length > 0;
            return (
              <div 
                key={item.id} 
                className={`category-source-group ${isExpanded ? 'is-expanded' : ''}`}
              >
                <SortableSourceHeader
                  id={item.id}
                  disabled={!isDragActive}
                  className="category-source-header"
                  onClick={() => toggleSource(group.sourceId)}
                  onContextMenu={(e) => handleSourceContextMenu(e, group.sourceId, sources[group.sourceId] || t('source'))}
                  dropIndicator={sourceDropIndicator}
                >
                  <div className="source-header-left">
                    <ChevronIcon expanded={isExpanded} />
                    <div className="source-name-container">
                      <ScrollingText className="source-name">{sources[group.sourceId] || t('loading')}</ScrollingText>
                    </div>
                  </div>
                  <span className="source-count">{item.count}</span>
                </SortableSourceHeader>

                {isExpanded && (
                  <div className="category-source-content">
                    {(() => {
                      interface UnifiedSidebarCat {
                        id: string;
                        type: 'native' | 'link';
                        name: string;
                        count: number;
                        displayOrder: number;
                        folderId?: string | null;
                        nativeCat?: typeof group.categories[0];
                        customLink?: PlaylistCategoryLink;
                      }
                      
                      const list: UnifiedSidebarCat[] = [];
                      
                      // Add native categories
                      for (const cat of group.categories) {
                        const manualCount = manualCategoryChannelCounts?.get(`${group.sourceId}:${cat.category_id}`) || 0;
                        list.push({
                          id: cat.category_id,
                          type: 'native',
                          name: cat.alias || cat.category_name,
                          count: cat.channelCount + manualCount,
                          displayOrder: cat.display_order ?? 0,
                          folderId: cat.folder_id || null,
                          nativeCat: cat
                        });
                      }
                      
                      // Add custom links
                      const customLinks = (allPlaylistCategoryLinks || [])
                        .filter(l => l.playlist_id === group.sourceId);
                      for (const link of customLinks) {
                        const nativeCount = categoryChannelCounts.get(link.category_id) || 0;
                        const manualCount = manualCategoryChannelCounts?.get(`${group.sourceId}:link:${link.id}`) || 0;
                        list.push({
                          id: `link:${link.id}`,
                          type: 'link',
                          name: link.custom_name || (categoryNamesMap.get(link.category_id) || link.category_id),
                          count: nativeCount + manualCount,
                          displayOrder: link.display_order ?? 0,
                          folderId: link.folder_id || null,
                          customLink: link
                        });
                      }
                      
                      // Sort
                      const isAlphabetical = categorySortOrder === 'alphabetical' && !isCategorySortCustomized(group.sourceId);
                      if (isAlphabetical) {
                        list.sort((a, b) => {
                          const aKey = `${group.sourceId}:${a.id}`;
                          const bKey = `${group.sourceId}:${b.id}`;
                          const aPinned = pinnedCategories.includes(aKey);
                          const bPinned = pinnedCategories.includes(bKey);
                          if (aPinned && !bPinned) return -1;
                          if (!aPinned && bPinned) return 1;
                          return a.name.localeCompare(b.name);
                        });
                      } else {
                        list.sort((a, b) => {
                          const aKey = `${group.sourceId}:${a.id}`;
                          const bKey = `${group.sourceId}:${b.id}`;
                          const aPinned = pinnedCategories.includes(aKey);
                          const bPinned = pinnedCategories.includes(bKey);
                          if (aPinned && !bPinned) return -1;
                          if (!aPinned && bPinned) return 1;
                          if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
                          return a.name.localeCompare(b.name);
                        });
                      }
                      
                      const individualCount = flatPlaylistIndividualCounts?.get(group.sourceId) || 0;
                      
                       return (
                        <>
                          {includeAllChannelsToPlaylist && (
                            <button
                              key={`__allsrc_${group.sourceId}`}
                              className={`category-item nested ${selectedCategoryId === `__allsrc_${group.sourceId}` ? 'selected' : ''}`}
                              onClick={() => onSelectCategory(`__allsrc_${group.sourceId}`)}
                            >
                              <ScrollingText className="category-name">{t('allChannels')}</ScrollingText>
                              <span className="category-count">{item.count}</span>
                            </button>
                          )}
                          {(favoritesMode === 'perSource' || favoritesMode === 'both') && (perSourceFavoriteCounts?.get(group.sourceId) || 0) > 0 && (
                            <button
                              key={`__favsrc_${group.sourceId}`}
                              className={`category-item nested favorites-source-item ${selectedCategoryId === `__favsrc_${group.sourceId}` ? 'selected' : ''}`}
                              onClick={() => onSelectCategory(`__favsrc_${group.sourceId}`)}
                            >
                              <div className="nested-category-wrapper">
                                <span className="category-icon favorites-icon">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                  </svg>
                                </span>
                                <ScrollingText className="category-name">{t('favorites')}</ScrollingText>
                              </div>
                              <span className="category-count">{perSourceFavoriteCounts?.get(group.sourceId) ?? 0}</span>
                            </button>
                          )}
                          {(() => {
                            let pinStackTop = 40;
                            // Only advance the pin stack for actually-pinned items so that
                            // non-pinned expanded folder headers don't shift the top offsets
                            // of pinned categories below them.
                            const takePinTop = (minTop: number, step: number, isActuallyPinned = true) => {
                              const top = Math.max(minTop, pinStackTop);
                              if (isActuallyPinned) pinStackTop += step;
                              return `${top}px`;
                            };
                            const sourceFolders = (allCategoryFolders || [])
                              .filter(f => f.playlist_id === group.sourceId)
                              .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
                            const folderMap = new Map<string, UnifiedSidebarCat[]>();
                            const rootCats: UnifiedSidebarCat[] = [];

                            for (const catItem of list) {
                              if (catItem.folderId && sourceFolders.some((f: CategoryFolder) => f.folder_id === catItem.folderId)) {
                                if (!folderMap.has(catItem.folderId)) {
                                  folderMap.set(catItem.folderId, []);
                                }
                                folderMap.get(catItem.folderId)!.push(catItem);
                              } else {
                                rootCats.push(catItem);
                              }
                            }

                            const renderCatItem = (catItem: UnifiedSidebarCat, isFolderChild: boolean) => {
                              let itemContent: React.ReactNode = null;
                              let wrapperStickyStyle: React.CSSProperties | undefined;
                              const activeIdx = activeDragId ? list.findIndex(c => c.id === activeDragId) : -1;
                              const overIdx = overDragId ? list.findIndex(c => c.id === overDragId) : -1;
                              const dropIndicator = overDragId === catItem.id && activeDragId !== overDragId
                                ? (activeIdx < overIdx ? 'below' : 'above')
                                : null;
                              if (catItem.type === 'native' && catItem.nativeCat) {
                                const category = catItem.nativeCat;
                                const isPinned = pinnedCategories.includes(`${group.sourceId}:${category.category_id}`);
                                // Sticky must be on the SortableSidebarItem wrapper div (not the inner
                                // button) — the wrapper is the containing block. If sticky were set on
                                // the inner button, it would be confined to the wrapper's ~38px height
                                // and could never actually stick while scrolling.
                                if (isPinned) {
                                  wrapperStickyStyle = { position: 'sticky', top: takePinTop(40, 38), zIndex: isFolderChild ? 90 : 99 };
                                }
                                itemContent = (
                                  <button
                                    key={category.category_id}
                                    className={`category-item nested ${isFolderChild ? 'folder-nested' : ''} ${selectedCategoryId === category.category_id ? 'selected' : ''} ${isPinned ? 'is-pinned' : ''}`}
                                    onClick={() => onSelectCategory(category.category_id)}
                                    onContextMenu={(e) => handleCategoryContextMenu(e, category.category_id, category.alias || category.category_name, group.sourceId, sources[group.sourceId] || 'Source')}
                                  >
                                    <div className="nested-category-wrapper">
                                      {isPinned && (
                                        <span className="category-pin-icon">
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ transform: 'rotate(45deg)' }}>
                                            <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
                                          </svg>
                                        </span>
                                      )}
                                      <ScrollingText className="category-name">{category.alias || category.category_name}</ScrollingText>
                                    </div>
                                    <span className="category-count">{catItem.count}</span>
                                  </button>
                                );
                              } else if (catItem.type === 'link' && catItem.customLink) {
                                const link = catItem.customLink;
                                const isPinned = pinnedCategories.includes(`${group.sourceId}:link:${link.id}`);
                                if (isPinned) {
                                  wrapperStickyStyle = { position: 'sticky', top: takePinTop(40, 38), zIndex: isFolderChild ? 90 : 99 };
                                }
                                itemContent = (
                                  <PlaylistCategoryLinkItem
                                    key={catItem.id}
                                    link={link}
                                    selectedCategoryId={selectedCategoryId}
                                    onSelectCategory={onSelectCategory}
                                    displayName={catItem.name}
                                    channelCount={catItem.count}
                                    isPinned={isPinned}
                                    onContextMenu={(e) => handleCategoryContextMenu(e, `link:${link.id}`, catItem.name, group.sourceId, sources[group.sourceId] || 'Source')}
                                  />
                                );
                              }
                              if (!itemContent) return null;
                              return (
                                <SortableSidebarItem key={catItem.id} id={catItem.id} disabled={!isDragActive} stickyStyle={wrapperStickyStyle} dropIndicator={dropIndicator}>
                                  {itemContent}
                                </SortableSidebarItem>
                              );
                            };

                            const isFolderPinned = (fId: string) => pinnedFolders.includes(`${group.sourceId}:${fId}`);

                            const sortedSourceFolders = [...sourceFolders].sort((a, b) => {
                              const aPinned = isFolderPinned(a.folder_id);
                              const bPinned = isFolderPinned(b.folder_id);
                              if (aPinned && !bPinned) return -1;
                              if (!aPinned && bPinned) return 1;
                              return (a.display_order ?? 0) - (b.display_order ?? 0);
                            });

                            const folderContext = (folder: CategoryFolder) => ({
                              onContextMenu: (e: React.MouseEvent) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setFolderContextMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  folderId: folder.folder_id,
                                  folderName: folder.name,
                                  sourceId: group.sourceId,
                                  sourceName: sources[group.sourceId] || 'Source',
                                });
                              },
                            });

                            return (
                              <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragCancel={handleDragCancel} onDragEnd={(e) => handleCategoryDragEnd(group.sourceId, list, e)}>
                                <SortableContext items={list.map(c => c.id)} strategy={verticalListSortingStrategy}>
                                  {sortedSourceFolders.map((folder: CategoryFolder) => {
                                    const folderCats = folderMap.get(folder.folder_id) || [];
                                    const isFolderExpanded = !!expandedFolders[folder.folder_id] || searchQuery.trim().length > 0;
                                    const folderChannelCount = folderCats.reduce((sum, c) => sum + c.count, 0);
                                    const isPinnedFolder = isFolderPinned(folder.folder_id);
                                    const folderHeaderTop = isPinnedFolder
                                      ? takePinTop(40, 34, true)
                                      : (isFolderExpanded ? takePinTop(40, 34, false) : undefined);
                                    const folderHeaderStyle: React.CSSProperties | undefined =
                                      isPinnedFolder
                                        ? { position: 'sticky', top: folderHeaderTop, zIndex: 96, '--category-folder-sticky-top': folderHeaderTop } as React.CSSProperties
                                        : isFolderExpanded
                                          ? { position: 'sticky', top: folderHeaderTop, zIndex: 95, '--category-folder-sticky-top': folderHeaderTop } as React.CSSProperties
                                          : undefined;

                                    if (searchQuery.trim() && folderCats.length === 0) return null;

                                    const header = (
                                      <SidebarFolderHeader
                                        folder={folder}
                                        isFolderExpanded={isFolderExpanded}
                                        folderCount={folderChannelCount}
                                        isPinned={isPinnedFolder}
                                        onToggle={() => toggleFolder(folder.folder_id)}
                                        onContextMenu={folderContext(folder).onContextMenu}
                                        style={folderHeaderStyle}
                                        data-folder-id={folder.folder_id}
                                      />
                                    );

                                    if (isPinnedFolder) {
                                      return (
                                        <Fragment key={folder.folder_id}>
                                          {header}
                                          {isFolderExpanded && folderCats.map(catItem => renderCatItem(catItem, true))}
                                        </Fragment>
                                      );
                                    }

                                    return (
                                      <div key={folder.folder_id} className={`category-folder-group ${isFolderExpanded ? 'is-expanded' : ''}`}>
                                        {header}
                                        {isFolderExpanded && (
                                          <div className="category-folder-content">
                                            {folderCats.map(catItem => renderCatItem(catItem, true))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                  {rootCats.map(catItem => renderCatItem(catItem, false))}
                                </SortableContext>
                              </DndContext>
                            );
                          })()}
                          
                          {individualCount > 0 && (
                            <button
                              className={`category-item nested playlist-indiv-item ${
                                selectedCategoryId === `__plindiv_${group.sourceId}` ? 'selected' : ''
                              }`}
                              onClick={() => onSelectCategory(`__plindiv_${group.sourceId}`)}
                            >
                              <ScrollingText className="category-name">{t('individualChannels')}</ScrollingText>
                              <span className="category-count">{individualCount}</span>
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            );
          } else if (item.type === 'playlist' && item.playlistGroup) {
            const playlist = item.playlistGroup;
            const isExpanded = !!expandedPlaylists[playlist.playlist_id];
            const getLinkName = (link: PlaylistCategoryLink) => {
              return link.custom_name || (categoryNamesMap.get(link.category_id) || link.category_id);
            };

            const playlistLinks = (allPlaylistCategoryLinks || [])
              .filter(l => l.playlist_id === playlist.playlist_id);

            const isAlphabetical = categorySortOrder === 'alphabetical' && !isCategorySortCustomized(playlist.playlist_id);

            if (isAlphabetical) {
              playlistLinks.sort((a, b) => {
                const nameA = getLinkName(a);
                const nameB = getLinkName(b);
                return nameA.localeCompare(nameB);
              });
            } else {
              playlistLinks.sort((a, b) => a.display_order - b.display_order);
            }

            const individualCount = flatPlaylistIndividualCounts?.get(playlist.playlist_id) || 0;

            return (
              <div 
                key={item.id} 
                className={`category-source-group playlist-source-group ${isExpanded ? 'is-expanded' : ''}`}
              >
                <SortableSourceHeader
                  id={item.id}
                  disabled={!isDragActive}
                  className="category-source-header playlist-source-header"
                  onClick={() => handleTogglePlaylist(playlist.playlist_id)}
                  onContextMenu={(e) => handlePlaylistContextMenu(e, playlist.playlist_id, playlist.name)}
                  dropIndicator={sourceDropIndicator}
                >
                  <div className="source-header-left">
                    <ChevronIcon expanded={isExpanded} />
                    <div className="source-name-container">
                      <ScrollingText className="source-name">{playlist.name}</ScrollingText>
                    </div>
                  </div>
                  <span className="source-count">{item.count}</span>
                </SortableSourceHeader>

                  {isExpanded && (
                    <div className="category-source-content">
                      {includeAllChannelsToPlaylist && (
                        <button
                          key={`__allsrc_pl_${playlist.playlist_id}`}
                          className={`category-item nested ${selectedCategoryId === `__allsrc_pl_${playlist.playlist_id}` ? 'selected' : ''}`}
                          onClick={() => onSelectCategory(`__allsrc_pl_${playlist.playlist_id}`)}
                        >
                          <ScrollingText className="category-name">{t('allChannels')}</ScrollingText>
                          <span className="category-count">{item.count}</span>
                        </button>
                      )}
                      {(() => {
                        const sourceFolders = (allCategoryFolders || [])
                          .filter(f => f.playlist_id === playlist.playlist_id)
                          .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
                        const folderMap = new Map<string, PlaylistCategoryLink[]>();
                        const rootLinks: PlaylistCategoryLink[] = [];

                        for (const link of playlistLinks) {
                          if (link.folder_id && sourceFolders.some((f: CategoryFolder) => f.folder_id === link.folder_id)) {
                            if (!folderMap.has(link.folder_id)) {
                              folderMap.set(link.folder_id, []);
                            }
                            folderMap.get(link.folder_id)!.push(link);
                          } else {
                            rootLinks.push(link);
                          }
                        }

                        let pinStackTop = 40;
                        const takePinTop = (minTop: number, step: number, isActuallyPinned = true) => {
                          const top = Math.max(minTop, pinStackTop);
                          if (isActuallyPinned) pinStackTop += step;
                          return `${top}px`;
                        };
                        const renderLink = (link: PlaylistCategoryLink, isFolderChild: boolean) => {
                          const nativeCount = categoryChannelCounts.get(link.category_id) || 0;
                          const manualCount = manualCategoryChannelCounts?.get(`${playlist.playlist_id}:link:${link.id}`) || 0;
                          const count = nativeCount + manualCount;
                          const name = link.custom_name || (categoryNamesMap.get(link.category_id) || link.category_id);
                          const isPinned = pinnedCategories.includes(`${playlist.playlist_id}:link:${link.id}`);
                          const activeIdx = activeDragId ? plCatList.findIndex(c => c.id === activeDragId) : -1;
                          const overIdx = overDragId ? plCatList.findIndex(c => c.id === overDragId) : -1;
                          const dropIndicator = overDragId === `link:${link.id}` && activeDragId !== overDragId
                            ? (activeIdx < overIdx ? 'below' : 'above')
                            : null;
                          // Sticky must live on the wrapper div, not the inner component.
                          const wrapperStickyStyle: React.CSSProperties | undefined = isPinned
                            ? { position: 'sticky', top: takePinTop(40, 38), zIndex: isFolderChild ? 90 : 99 }
                            : undefined;
                          // paddingLeft only affects the inner item's visual indent, not stickiness.
                          const innerStyle: React.CSSProperties | undefined = isFolderChild ? { paddingLeft: '32px' } : undefined;
                          return (
                            <SortableSidebarItem key={`link:${link.id}`} id={`link:${link.id}`} disabled={!isDragActive} stickyStyle={wrapperStickyStyle} dropIndicator={dropIndicator}>
                              <PlaylistCategoryLinkItem
                                key={link.id}
                                link={link}
                                selectedCategoryId={selectedCategoryId}
                                onSelectCategory={onSelectCategory}
                                displayName={name}
                                channelCount={count}
                                isPinned={isPinned}
                                onContextMenu={(e) => handleCategoryContextMenu(e, `link:${link.id}`, name, playlist.playlist_id, playlist.name)}
                                style={innerStyle}
                              />
                            </SortableSidebarItem>
                          );
                        };

                        const isFolderPinned = (fId: string) => pinnedFolders.includes(`${playlist.playlist_id}:${fId}`);

                        const sortedSourceFolders = [...sourceFolders].sort((a, b) => {
                          const aPinned = isFolderPinned(a.folder_id);
                          const bPinned = isFolderPinned(b.folder_id);
                          if (aPinned && !bPinned) return -1;
                          if (!aPinned && bPinned) return 1;
                          return (a.display_order ?? 0) - (b.display_order ?? 0);
                        });

                        const folderContext = (folder: CategoryFolder) => ({
                          onContextMenu: (e: React.MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setFolderContextMenu({
                              x: e.clientX,
                              y: e.clientY,
                              folderId: folder.folder_id,
                              folderName: folder.name,
                              sourceId: playlist.playlist_id,
                              sourceName: playlist.name,
                            });
                          },
                        });

                        const plCatList = playlistLinks.map(l => ({ id: `link:${l.id}`, type: 'link' as const, customLink: l }));

                        return (
                          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragCancel={handleDragCancel} onDragEnd={(e) => handleCategoryDragEnd(playlist.playlist_id, plCatList, e)}>
                            <SortableContext items={plCatList.map(c => c.id)} strategy={verticalListSortingStrategy}>
                              {sortedSourceFolders.map((folder: CategoryFolder) => {
                                const fLinks = folderMap.get(folder.folder_id) || [];
                                const isFolderExpanded = !!expandedFolders[folder.folder_id] || searchQuery.trim().length > 0;
                                const totalCount = fLinks.reduce((sum, link) => {
                                  const nativeCount = categoryChannelCounts.get(link.category_id) || 0;
                                  const manualCount = manualCategoryChannelCounts?.get(`${playlist.playlist_id}:link:${link.id}`) || 0;
                                  return sum + nativeCount + manualCount;
                                }, 0);
                                const isPinnedFolder = isFolderPinned(folder.folder_id);
                                const folderHeaderTop = isPinnedFolder
                                  ? takePinTop(40, 34, true)
                                  : (isFolderExpanded ? takePinTop(40, 34, false) : undefined);
                                const folderHeaderStyle: React.CSSProperties | undefined =
                                  isPinnedFolder
                                    ? { position: 'sticky', top: folderHeaderTop, zIndex: 96, '--category-folder-sticky-top': folderHeaderTop } as React.CSSProperties
                                    : isFolderExpanded
                                      ? { position: 'sticky', top: folderHeaderTop, zIndex: 95, '--category-folder-sticky-top': folderHeaderTop } as React.CSSProperties
                                      : undefined;

                                if (searchQuery.trim() && fLinks.length === 0) return null;

                                const header = (
                                  <SidebarFolderHeader
                                    folder={folder}
                                    isFolderExpanded={isFolderExpanded}
                                    folderCount={totalCount}
                                    isPinned={isPinnedFolder}
                                    onToggle={() => toggleFolder(folder.folder_id)}
                                    onContextMenu={folderContext(folder).onContextMenu}
                                    style={folderHeaderStyle}
                                    data-folder-id={folder.folder_id}
                                  />
                                );

                                if (isPinnedFolder) {
                                  return (
                                    <Fragment key={folder.folder_id}>
                                      {header}
                                      {isFolderExpanded && fLinks.map(link => renderLink(link, true))}
                                    </Fragment>
                                  );
                                }

                                return (
                                  <div key={folder.folder_id} className={`category-folder-group ${isFolderExpanded ? 'is-expanded' : ''}`}>
                                    {header}
                                    {isFolderExpanded && (
                                      <div className="category-folder-content">
                                        {fLinks.map(link => renderLink(link, true))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                              {rootLinks.map(link => renderLink(link, false))}
                            </SortableContext>
                          </DndContext>
                        );
                      })()}

                      {individualCount > 0 && (
                        <button
                          className={`category-item nested playlist-indiv-item ${
                            selectedCategoryId === `__plindiv_${playlist.playlist_id}` ? 'selected' : ''
                          }`}
                          onClick={() => onSelectCategory(`__plindiv_${playlist.playlist_id}`)}
                        >
                          <ScrollingText className="category-name">{t('individualChannels')}</ScrollingText>
                          <span className="category-count">{individualCount}</span>
                        </button>
                      )}

                      {playlistLinks.length === 0 && individualCount === 0 && (
                        <div className="playlist-empty-hint">
                          <span>{t('emptyPlaylist')}</span>
                          <button 
                            className="playlist-edit-link"
                            onClick={() => setEditingPlaylist({ id: playlist.playlist_id, name: playlist.name })}
                          >
                            Edit Playlist
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
          }
          return null;
        })}
      </SortableContext>
    </DndContext>

        {filteredGroupedCategories.length === 0 && (!customPlaylists || customPlaylists.length === 0) && (
          <div className="category-empty">
            <p>{t('noCategoriesYet')}</p>
            <p className="hint">{t('addSourceSettings')}</p>
          </div>
        )}
      </div>

      <ModalComponent />

      <CreateCustomOptionModal
        isOpen={isCreateOptionModalOpen}
        onClose={() => setIsCreateOptionModalOpen(false)}
        onCreateGroup={async (name) => {
          await createCustomGroup(name);
        }}
        onCreatePlaylist={async (name) => {
          const { createPlaylist } = await import('../services/playlist-editor');
          const id = await createPlaylist(name);
          setExpandedPlaylists(prev => ({ ...prev, [id]: true }));
          setEditingPlaylist({ id, name });
        }}
      />

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
          onCreateCategoryFolder={(id, name) => setManagingCategorySource({ id, name, initialCreateFolder: true })}
          onEditSource={(id) => {
            if (onEditSource) {
              onEditSource(id);
            }
          }}
          onEditEpg={(id, name) => setEpgEditorSource({ id, name })}
        />
      )}

      {/* Playlist Context Menu */}
      {playlistContextMenu && (
        <PlaylistContextMenu
          playlistId={playlistContextMenu.playlistId}
          playlistName={playlistContextMenu.playlistName}
          position={{ x: playlistContextMenu.x, y: playlistContextMenu.y }}
          onClose={() => setPlaylistContextMenu(null)}
          onEditContents={() => {
            setEditingPlaylist({ id: playlistContextMenu.playlistId, name: playlistContextMenu.playlistName });
          }}
          onManageCategories={() => {
            setManagingCategorySource({ id: playlistContextMenu.playlistId, name: playlistContextMenu.playlistName });
          }}
          onCreateCategoryFolder={() => {
            setManagingCategorySource({ id: playlistContextMenu.playlistId, name: playlistContextMenu.playlistName, initialCreateFolder: true });
          }}
          onExportM3u={async () => {
            try {
              const { generateM3uForPlaylist } = await import('../services/playlist-export');
              const content = await generateM3uForPlaylist(playlistContextMenu.playlistId);
              const result = await window.storage.saveM3UFile(content, playlistContextMenu.playlistName);
              if (result.success) {
                alert(t('playlistExported'));
              }
            } catch (err) {
              console.error('[CategoryStrip] M3U export failed:', err);
              alert(t('exportFailed', { error: String(err) }));
            }
          }}
          onRename={() => {
            showPrompt(
              t('renamePlaylist'),
              t('enterNewName'),
              async (newName) => {
                if (newName.trim()) {
                  const { renamePlaylist } = await import('../services/playlist-editor');
                  await renamePlaylist(playlistContextMenu.playlistId, newName.trim());
                }
              },
              undefined, t('newNamePlaceholder'), playlistContextMenu.playlistName, i18n.t('common:rename'), i18n.t('common:cancel')
            );
          }}
          onDelete={() => {
            handleDeletePlaylist(playlistContextMenu.playlistId);
          }}
        />
      )}

      {/* Playlist Editor Modal */}
      {editingPlaylist && (
        <PlaylistEditorModal
          playlistId={editingPlaylist.id}
          playlistName={editingPlaylist.name}
          onClose={() => setEditingPlaylist(null)}
        />
      )}

      {/* Category Context Menu */}
      {categoryContextMenu && (
        <CategoryContextMenu
          categoryId={categoryContextMenu.categoryId}
          categoryName={categoryContextMenu.categoryName}
          sourceId={categoryContextMenu.sourceId}
          sourceName={categoryContextMenu.sourceName}
          position={{ x: categoryContextMenu.x, y: categoryContextMenu.y }}
          onClose={() => setCategoryContextMenu(null)}
          onManageCategories={(id, name) => setManagingCategorySource({ id, name })}
          onHideCategory={categoryContextMenu.categoryId.startsWith('link:') ? undefined : handleHideCategory}
          onRenameCategory={handleRenameCategory}
          isPinned={pinnedCategories.includes(`${categoryContextMenu.sourceId}:${categoryContextMenu.categoryId}`)}
          onPin={() => handlePinCategory(categoryContextMenu.sourceId, categoryContextMenu.categoryId)}
          onUnpin={() => handleUnpinCategory(categoryContextMenu.sourceId, categoryContextMenu.categoryId)}
          onOpenLogoEditor={(catId, catName, srcId) => setLogoEditorCategory({ categoryId: catId, categoryName: catName, sourceId: srcId })}
        />
      )}

      {/* Folder Context Menu */}
      {folderContextMenu && (
        <FolderContextMenu
          folderId={folderContextMenu.folderId}
          folderName={folderContextMenu.folderName}
          sourceId={folderContextMenu.sourceId}
          sourceName={folderContextMenu.sourceName}
          position={{ x: folderContextMenu.x, y: folderContextMenu.y }}
          onClose={() => setFolderContextMenu(null)}
          isPinned={pinnedFolders.includes(`${folderContextMenu.sourceId}:${folderContextMenu.folderId}`)}
          onPin={() => handlePinFolder(folderContextMenu.sourceId, folderContextMenu.folderId)}
          onUnpin={() => handleUnpinFolder(folderContextMenu.sourceId, folderContextMenu.folderId)}
          onManageFolder={(folderId, folderName, sourceId, sourceName) => {
            setManagingCategorySource({
              id: sourceId,
              name: sourceName,
              initialBulkFolder: { folder_id: folderId, name: folderName }
            });
          }}
          onManageCategories={(sourceId, sourceName) => setManagingCategorySource({ id: sourceId, name: sourceName })}
        />
      )}

      {/* Favorites Context Menu */}
      {favoritesContextMenu && (
        <FavoritesContextMenu
          position={{ x: favoritesContextMenu.x, y: favoritesContextMenu.y }}
          onClose={() => setFavoritesContextMenu(null)}
          onManageFavorites={() => setManagingFavorites(true)}
          onHide={() => handleSidebarItemHide('favorites')}
        />
      )}

      {/* Recently Viewed Context Menu */}
      {recentContextMenu && (
        <RecentChannelsContextMenu
          position={{ x: recentContextMenu.x, y: recentContextMenu.y }}
          onClose={() => setRecentContextMenu(null)}
          onClearRecent={() => {
            showConfirm(
              t('clearRecentTitle'),
              t('clearRecentMsg'),
              () => {
                clearRecentChannels();
                if (selectedCategoryId === '__recent__') {
                  onSelectCategory(null);
                }
              }
            );
          }}
          onHide={() => handleSidebarItemHide('recent')}
        />
      )}

      {/* Generic Sidebar Context Menu */}
      {genericSidebarContextMenu && (
        <SidebarItemContextMenu
          position={{ x: genericSidebarContextMenu.x, y: genericSidebarContextMenu.y }}
          title={genericSidebarContextMenu.title}
          onClose={() => setGenericSidebarContextMenu(null)}
          onHide={() => handleSidebarItemHide(genericSidebarContextMenu.type)}
        />
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
            initialCreateFolder={managingCategorySource.initialCreateFolder}
            initialBulkFolder={managingCategorySource.initialBulkFolder}
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

      {/* Category Logo Editor Modal — opened from category right-click */}
      {logoEditorCategory && (
        <LogoEditorModal
          categoryId={logoEditorCategory.categoryId}
          categoryName={logoEditorCategory.categoryName}
          sourceId={logoEditorCategory.sourceId}
          onClose={() => setLogoEditorCategory(null)}
        />
      )}
      </div>

      {/* Sidebar hint - subtle indicator when hovering left edge outside middle zone */}
      {isNearLeftEdgeOutsideMiddle && (
        <div
          className="sidebar-hint-indicator"
          style={{
            position: 'fixed',
            left: 0,
            top: mouseY - 15,
            width: '3px',
            height: '30px',
            background: 'var(--accent-primary, rgba(0, 212, 255, 0.4))',
            borderRadius: '0 3px 3px 0',
            zIndex: 109,
            pointerEvents: 'none',
            transition: 'opacity 0.2s ease',
          }}
        />
      )}

      {/* Show Sidebar Button - visible when sidebar is hidden, in LiveTV, and hovering middle-left */}
      {!visible && onShow && isLiveTV && (
        <button
          className={`show-sidebar-btn ${isInMiddleLeftZone ? 'visible' : ''}`}
          onClick={onShow}
          onMouseEnter={() => {
            // Ensure button stays visible when hovering over it
            setMouseX(25);
          }}
          title={t('showSidebar')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
      )}
    </>
    </CategoryStripVisibilityContext.Provider>
  );
}

interface SidebarItemContextMenuProps {
  position: { x: number; y: number };
  title: string;
  onClose: () => void;
  onHide: () => void;
}

function SidebarItemContextMenu({ position, title, onClose, onHide }: SidebarItemContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState(position);

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

      if (x + menuWidth > viewportWidth) x = viewportWidth - menuWidth - 10;
      if (x < 10) x = 10;

      if (y + menuHeight > viewportHeight) y = viewportHeight - menuHeight - 10;
      if (y < 10) y = 10;

      setAdjustedPosition({ x, y });
    }
  }, [position]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="program-context-menu"
      style={{ left: `${adjustedPosition.x}px`, top: `${adjustedPosition.y}px` }}
    >
      <div className="context-menu-header" style={{ padding: '8px 12px 4px', fontSize: '11px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {title}
      </div>
      <div className="context-menu-item" onClick={() => { onHide(); onClose(); }}>
        🚫 Hide Category
      </div>
    </div>,
    document.body
  );
}
