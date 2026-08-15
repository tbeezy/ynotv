import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLiveQuery } from '../../hooks/useSqliteLiveQuery';
import { db, type StoredCategory, updateCategoriesBatch, type CategoryFolder } from '../../db';
import { useCategorySortOrder } from '../../stores/uiStore';
import { isCategorySortCustomized, setCategorySortCustomized } from '../../utils/categorySortOverrides';
import { createCategoryFolder, renameCategoryFolder, deleteCategoryFolder, reorderCategoryFolders } from '../../services/playlist-editor';
import { ChannelManager } from './ChannelManager';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './CategoryManager.css';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Folders and categories share a DndContext but must only drop onto their own
// kind; filter droppables by the data type tag registered in useSortable.
const categoryListCollisionDetection: CollisionDetection = (args) => {
    const type = args.active.data.current?.type;
    if (!type) return closestCenter(args);
    const filtered = args.droppableContainers.filter(c => c.data.current?.type === type);
    return closestCenter({ ...args, droppableContainers: filtered });
};

type ManagedCategory = 
    | { type: 'native'; id: string; name: string; enabled: boolean; displayOrder: number; folderId?: string | null; category: StoredCategory }
    | { type: 'link'; id: string; linkId: number; name: string; enabled: boolean; displayOrder: number; folderId?: string | null; link: any };

function SortableInsideFolderCategory(props: {
    cat: ManagedCategory;
    onRemove: (id: string) => void;
}) {
    const { cat, onRemove } = props;
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: cat.id });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 99 : 1,
        touchAction: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        background: 'rgba(255,255,255,0.04)',
        borderRadius: '4px',
        border: '1px solid rgba(255,255,255,0.06)',
        fontSize: '0.82rem',
        cursor: 'grab',
        userSelect: 'none',
    };

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            {...listeners}
            className={`cm-bulk-inside-item${isDragging ? ' dragging' : ''}`}
        >
            <span style={{ fontWeight: 500 }}>{cat.name}</span>
            <button
                style={{ background: 'rgba(255,75,75,0.15)', border: '1px solid rgba(255,75,75,0.3)', color: '#ff4b4b', borderRadius: '4px', cursor: 'pointer', fontSize: '0.72rem', padding: '2px 8px', fontWeight: 600 }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemove(cat.id)}
                title={i18n.t('settings:categoryManager.removeFromFolder')}
            >
                ✕ {i18n.t('common:remove')}
            </button>
        </div>
    );
}

function SortableCategoryRow({ id, disabled, className, onClick, children, dropIndicator = null }: {
    id: string;
    disabled: boolean;
    className: string;
    onClick?: (e: React.MouseEvent) => void;
    children: React.ReactNode;
    dropIndicator?: 'above' | 'below' | null;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled, data: { type: 'category' } });
    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 99 : 1,
        touchAction: 'none',
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${className}${isDragging ? ' dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
            onClick={onClick}
            {...attributes}
            {...listeners}
        >
            {children}
        </div>
    );
}

const FolderIcon = ({ size = 16 }: { size?: number }) => (
    <svg 
        width={size} 
        height={size} 
        viewBox="0 0 24 24" 
        fill="none" 
        stroke="currentColor" 
        strokeWidth="2.5" 
        strokeLinecap="round" 
        strokeLinejoin="round"
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
);

const PencilIcon = ({ size = 14 }: { size?: number }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
    </svg>
);

function SortableFolderCard(props: {
    folder: CategoryFolder;
    folderCategoriesCount: number;
    isCollapsed: boolean;
    folderIndex: number;
    totalFolders: number;
    dropIndicator: 'above' | 'below' | null;
    children: React.ReactNode;
    onToggleCollapse: () => void;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onBulk: () => void;
    onRename: () => void;
    onDelete: () => void;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.folder.folder_id, data: { type: 'folder' } });
    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 99 : 1,
    };
    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`cm-folder-card${isDragging ? ' dragging' : ''}${props.dropIndicator ? ` drop-${props.dropIndicator}` : ''}`}
        >
            <div
                className="cm-folder-card-header"
                onClick={props.onToggleCollapse}
                style={{ cursor: 'grab', touchAction: 'none' }}
                {...attributes}
                {...listeners}
            >
                <div className="cm-folder-header-left">
                    <FolderIcon size={16} />
                    <span style={{ fontWeight: 600 }}>{props.folder.name}</span>
                    <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', fontWeight: 'normal' }}>
                        ({i18n.t('settings:categoryManager.folderCategoriesCount', { count: props.folderCategoriesCount })})
                    </span>
                </div>

                <div className="cm-folder-header-actions" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
                    <button
                        className="order-btn"
                        disabled={props.folderIndex === 0}
                        onClick={props.onMoveUp}
                        title={i18n.t('settings:categoryManager.moveFolderUp')}
                    >
                        ↑
                    </button>
                    <button
                        className="order-btn"
                        disabled={props.folderIndex === props.totalFolders - 1}
                        onClick={props.onMoveDown}
                        title={i18n.t('settings:categoryManager.moveFolderDown')}
                    >
                        ↓
                    </button>
                    <button
                        className="cm-folder-bulk-btn"
                        onClick={props.onBulk}
                        title={i18n.t('settings:categoryManager.bulkAddRemoveHint')}
                        style={{
                            background: 'rgba(0, 212, 255, 0.12)',
                            border: '1px solid rgba(0, 212, 255, 0.3)',
                            borderRadius: '4px',
                            color: '#00d4ff',
                            fontSize: '0.75rem',
                            padding: '3px 8px',
                            cursor: 'pointer',
                            fontWeight: 500,
                            marginRight: '6px'
                        }}
                    >
                        ⇄ {i18n.t('settings:categoryManager.bulkAddRemove')}
                    </button>
                    <button
                        className="cm-folder-icon-btn"
                        onClick={props.onRename}
                        title={i18n.t('settings:categoryManager.renameFolderHint')}
                    >
                        <PencilIcon size={14} />
                    </button>
                    <button
                        className="cm-folder-icon-btn delete"
                        onClick={props.onDelete}
                        title={i18n.t('settings:categoryManager.deleteFolderHint')}
                    >
                        ✕
                    </button>
                </div>
            </div>

            {!props.isCollapsed && (
                <div className="cm-folder-card-body">{props.children}</div>
            )}
        </div>
    );
}

interface CategoryManagerProps {
    sourceId: string;
    sourceName: string;
    onClose: () => void;
    onChange?: () => void;
    initialCreateFolder?: boolean;
    initialBulkFolder?: { folder_id: string; name: string } | null;
}

export function CategoryManager({ sourceId, sourceName, onClose, onChange, initialCreateFolder, initialBulkFolder }: CategoryManagerProps) {
    useTranslation();
    const [categories, setCategories] = useState<Array<
        | { type: 'native'; id: string; name: string; enabled: boolean; displayOrder: number; folderId?: string | null; category: StoredCategory }
        | { type: 'link'; id: string; linkId: number; name: string; enabled: boolean; displayOrder: number; folderId?: string | null; link: any }
    >>([]);
    const [isDirty, setIsDirty] = useState(false);
    const [hideUnselected, setHideUnselected] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [managingCategory, setManagingCategory] = useState<{ id: string; name: string } | null>(null);
    const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});
    const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const [isCreateOnlyModalOpen, setIsCreateOnlyModalOpen] = useState(!!initialCreateFolder);
    const [createOnlyFolderName, setCreateOnlyFolderName] = useState('');
    const [bulkFolderTarget, setBulkFolderTarget] = useState<CategoryFolder | null>(() => {
        if (initialBulkFolder) {
            const playlistId = sourceId.startsWith('playlist:') ? sourceId.replace('playlist:', '') : sourceId;
            return {
                folder_id: initialBulkFolder.folder_id,
                playlist_id: playlistId,
                name: initialBulkFolder.name,
                display_order: 0,
                created_at: Date.now()
            };
        }
        return null;
    });
    const [bulkLeftSearch, setBulkLeftSearch] = useState('');
    const [bulkRightSearch, setBulkRightSearch] = useState('');
    const [renamingFolder, setRenamingFolder] = useState<CategoryFolder | null>(null);
    const [renameInput, setRenameInput] = useState('');
    const [deletingFolderTarget, setDeletingFolderTarget] = useState<CategoryFolder | null>(null);
    const isSavingRef = useRef(false);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);
    const [selectToMoveMode, setSelectToMoveMode] = useState<'inactive' | 'selecting' | 'ready'>('inactive');
    const [selectedForMove, setSelectedForMove] = useState<Set<string>>(new Set());
    const categorySortOrder = useCategorySortOrder();
    const targetPlaylistId = sourceId.startsWith('playlist:') ? sourceId.replace('playlist:', '') : sourceId;
    const [isCustomized, setIsCustomized] = useState(() => isCategorySortCustomized(targetPlaylistId));
    const isUnlockingRef = useRef(false);

    const handleUnlockOrder = useCallback(() => {
        isUnlockingRef.current = true;
        setCategorySortCustomized(targetPlaylistId, true);
        setIsCustomized(true);
        setIsDirty(true);
    }, [targetPlaylistId]);

    const handleResetToAlphabetical = useCallback(() => {
        isUnlockingRef.current = false;
        setCategorySortCustomized(targetPlaylistId, false);
        setIsCustomized(false);
    }, [targetPlaylistId]);

    const categorySensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );


    // Load categories for this source
    const dbCategories = useLiveQuery(
        () => db.categories.where('source_id').equals(targetPlaylistId).toArray(),
        [targetPlaylistId],
        []
    );

    // Load category links for this source
    const categoryLinks = useLiveQuery(
        () => db.playlistCategoryLinks.where('playlist_id').equals(targetPlaylistId).sortBy('display_order'),
        [targetPlaylistId],
        []
    );

    // Load category folders for this source/playlist
    const categoryFolders = useLiveQuery(
        async () => {
            const folders = await db.categoryFolders.where('playlist_id').equals(targetPlaylistId).toArray();
            return folders.sort((a, b) => a.display_order - b.display_order);
        },
        [targetPlaylistId],
        []
    );

    // Resolve name details for link categories
    const [dbCategoriesMap, setDbCategoriesMap] = useState<Record<string, StoredCategory>>({});
    useEffect(() => {
        if (!categoryLinks || categoryLinks.length === 0) return;
        const ids = categoryLinks.map(l => l.category_id);
        db.categories.where('category_id').anyOf(ids).toArray().then(cats => {
            const map = cats.reduce((acc: Record<string, StoredCategory>, cat) => {
                acc[cat.category_id] = cat;
                return acc;
            }, {});
            setDbCategoriesMap(map);
        });
    }, [categoryLinks]);

    // Initialize categories from database (but not while saving)
    useEffect(() => {
        if (isUnlockingRef.current) {
            isUnlockingRef.current = false;
            return;
        }

        if (dbCategories && !isSavingRef.current) {
            const list: Array<
                | { type: 'native'; id: string; name: string; enabled: boolean; displayOrder: number; folderId?: string | null; category: StoredCategory }
                | { type: 'link'; id: string; linkId: number; name: string; enabled: boolean; displayOrder: number; folderId?: string | null; link: any }
            > = [];

            // Add native categories
            for (const cat of dbCategories) {
                list.push({
                    type: 'native',
                    id: cat.category_id,
                    name: cat.alias || cat.category_name,
                    enabled: cat.enabled !== false,
                    displayOrder: cat.display_order ?? 9999,
                    folderId: cat.folder_id || null,
                    category: cat,
                });
            }

            // Add custom category links
            for (const link of categoryLinks || []) {
                if (link.id === undefined) continue;
                const cat = dbCategoriesMap[link.category_id];
                const resolvedName = cat?.alias || cat?.category_name || link.category_id;
                list.push({
                    type: 'link',
                    id: `link:${link.id}`,
                    linkId: link.id,
                    name: link.custom_name || resolvedName,
                    enabled: true, // category links are always active
                    displayOrder: link.display_order ?? 9999,
                    folderId: link.folder_id || null,
                    link,
                });
            }

            // Sort
            const isAlphabetical = categorySortOrder === 'alphabetical' && !isCustomized;
            if (isAlphabetical) {
                list.sort((a, b) => a.name.localeCompare(b.name));
            } else {
                list.sort((a, b) => {
                    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
                    return a.name.localeCompare(b.name);
                });
            }

            // Set final displayOrder based on sorted index
            const normalized = list.map((item, idx) => ({
                ...item,
                displayOrder: idx,
            }));

            setCategories(normalized);
            setIsDirty(false);
        }
    }, [dbCategories, categoryLinks, dbCategoriesMap, categorySortOrder, isCustomized]);

    // Toggle enable/disable
    const toggleCategory = useCallback((id: string) => {
        setCategories(cats => cats.map(cat =>
            cat.id === id ? { ...cat, enabled: !cat.enabled } : cat
        ));
        setIsDirty(true);
    }, []);

    // Move category to top
    const moveToTop = useCallback((index: number) => {
        if (index === 0) return;
        setCategories(cats => {
            const newCats = [...cats];
            const [moved] = newCats.splice(index, 1);
            newCats.unshift(moved);
            return newCats.map((cat, idx) => ({ ...cat, displayOrder: idx }));
        });
        setIsDirty(true);
    }, []);

    const handleSelectToMoveToggle = useCallback(() => {
        if (selectToMoveMode === 'inactive') {
            setSelectToMoveMode('selecting');
            setSelectedForMove(new Set());
        } else if (selectToMoveMode === 'selecting') {
            if (selectedForMove.size > 0) {
                setSelectToMoveMode('ready');
            } else {
                setSelectToMoveMode('inactive');
            }
        } else if (selectToMoveMode === 'ready') {
            if (selectedForMove.size > 0) {
                setCategories(cats => {
                    const newCats = [...cats];
                    const selected = newCats.filter(cat => selectedForMove.has(cat.id));
                    const unselected = newCats.filter(cat => !selectedForMove.has(cat.id));
                    const reordered = [...selected, ...unselected];
                    return reordered.map((cat, idx) => ({ ...cat, displayOrder: idx }));
                });
                setIsDirty(true);
            }
            setSelectedForMove(new Set());
            setSelectToMoveMode('inactive');
        }
    }, [selectToMoveMode, selectedForMove]);

    const handleSelectToMoveCancel = useCallback(() => {
        setSelectToMoveMode('inactive');
        setSelectedForMove(new Set());
    }, []);

    const toggleSelectForMove = useCallback((id: string) => {
        setSelectedForMove(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    // Move category up
    const moveUp = useCallback((index: number) => {
        if (index === 0) return;
        setCategories(cats => {
            const newCats = [...cats];
            [newCats[index - 1], newCats[index]] = [newCats[index], newCats[index - 1]];
            return newCats.map((cat, idx) => ({ ...cat, displayOrder: idx }));
        });
        setIsDirty(true);
    }, []);

    // Move category down
    const moveDown = useCallback((index: number) => {
        setCategories(cats => {
            if (index === cats.length - 1) return cats;
            const newCats = [...cats];
            [newCats[index], newCats[index + 1]] = [newCats[index + 1], newCats[index]];
            return newCats.map((cat, idx) => ({ ...cat, displayOrder: idx }));
        });
        setIsDirty(true);
    }, []);

    // Delete custom categories / category links
    const handleDeleteLink = useCallback(async (linkId: number) => {
        const confirm = window.confirm(i18n.t('settings:categoryManager.confirmDeleteLink'));
        if (!confirm) return;
        const { removeCategoryFromPlaylist } = await import('../../services/playlist-editor');
        await removeCategoryFromPlaylist(linkId);
        if (onChange) onChange();
    }, [onChange]);

    const handleCategoryDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        setCategories(cats => {
            const oldIndex = cats.findIndex(c => c.id === active.id);
            const newIndex = cats.findIndex(c => c.id === over.id);
            if (oldIndex === -1 || newIndex === -1) return cats;
            const reordered = arrayMove(cats, oldIndex, newIndex);
            return reordered.map((cat, idx) => ({ ...cat, displayOrder: idx }));
        });
        setIsDirty(true);
    }, []);

    const handleFolderDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        if (!categoryFolders || categoryFolders.length === 0) return;
        const folders = [...categoryFolders].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
        const oldIndex = folders.findIndex(f => f.folder_id === active.id);
        const newIndex = folders.findIndex(f => f.folder_id === over.id);
        if (oldIndex === -1 || newIndex === -1) return;
        const reordered = arrayMove(folders, oldIndex, newIndex);
        reorderCategoryFolders(reordered.map((f, idx) => ({ folderId: f.folder_id, displayOrder: idx })))
            .catch(err => console.error('[CategoryManager] Failed to reorder folders:', err));
    }, [categoryFolders]);

    const handleDragStart = useCallback((event: DragStartEvent) => {
        setActiveId(String(event.active.id));
    }, []);

    const handleDragOver = useCallback((event: DragOverEvent) => {
        if (event.over && event.active.id !== event.over.id) {
            setOverId(String(event.over.id));
        } else {
            setOverId(null);
        }
    }, []);

    const handleDragEnd = useCallback((event: DragEndEvent) => {
        setActiveId(null);
        setOverId(null);
        if (event.active.data.current?.type === 'folder') {
            handleFolderDragEnd(event);
        } else {
            handleCategoryDragEnd(event);
        }
    }, [handleFolderDragEnd, handleCategoryDragEnd]);

    const handleDragCancel = useCallback(() => {
        setActiveId(null);
        setOverId(null);
    }, []);

    const handleFolderMoveUp = useCallback(async (folderIndex: number, sorted: CategoryFolder[]) => {
        if (folderIndex === 0) return;
        const newFolders = [...sorted];
        [newFolders[folderIndex - 1], newFolders[folderIndex]] = [newFolders[folderIndex], newFolders[folderIndex - 1]];
        await reorderCategoryFolders(newFolders.map((f, idx) => ({ folderId: f.folder_id, displayOrder: idx })));
    }, []);

    const handleFolderMoveDown = useCallback(async (folderIndex: number, sorted: CategoryFolder[]) => {
        if (folderIndex === sorted.length - 1) return;
        const newFolders = [...sorted];
        [newFolders[folderIndex], newFolders[folderIndex + 1]] = [newFolders[folderIndex + 1], newFolders[folderIndex]];
        await reorderCategoryFolders(newFolders.map((f, idx) => ({ folderId: f.folder_id, displayOrder: idx })));
    }, []);

    // @dnd-kit sensors for Bulk Edit Categories in Folder
    const bulkSensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    // Get visible categories based on filter and search
    const visibleCategories = useMemo(() => {
        let filtered = categories;

        if (hideUnselected) {
            filtered = filtered.filter(c => c.enabled !== false);
        }

        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            filtered = filtered.filter(c => c.name.toLowerCase().includes(query));
        }

        return filtered;
    }, [categories, hideUnselected, searchQuery]);

    // Select all visible
    const handleSelectAll = useCallback(() => {
        if (selectToMoveMode !== 'inactive') {
            const expandedIds = visibleCategories
                .filter(cat => !cat.folderId || !collapsedFolders[cat.folderId])
                .map(c => c.id);
            setSelectedForMove(prev => new Set([...prev, ...expandedIds]));
        } else {
            setCategories(cats => cats.map(cat => {
                const isVisible = (!hideUnselected || cat.enabled !== false) && 
                                  (!searchQuery.trim() || cat.name.toLowerCase().includes(searchQuery.toLowerCase()));
                if (isVisible && cat.type === 'native') {
                    return { ...cat, enabled: true };
                }
                return cat;
            }));
            setIsDirty(true);
        }
    }, [selectToMoveMode, visibleCategories, collapsedFolders, hideUnselected, searchQuery]);

    // Select none visible
    const handleSelectNone = useCallback(() => {
        if (selectToMoveMode !== 'inactive') {
            setSelectedForMove(new Set());
        } else {
            setCategories(cats => cats.map(cat => {
                const isVisible = (!hideUnselected || cat.enabled !== false) && 
                                  (!searchQuery.trim() || cat.name.toLowerCase().includes(searchQuery.toLowerCase()));
                if (isVisible && cat.type === 'native') {
                    return { ...cat, enabled: false };
                }
                return cat;
            }));
            setIsDirty(true);
        }
    }, [selectToMoveMode, hideUnselected, searchQuery]);

    // Helper to get active target category IDs to move
    const getTargetCategoryIdsToMove = useCallback((): string[] => {
        if (selectedForMove.size > 0) {
            return Array.from(selectedForMove);
        }
        if (searchQuery.trim().length > 0) {
            return visibleCategories.map(c => c.id);
        }
        return visibleCategories.filter(c => c.enabled !== false).map(c => c.id);
    }, [selectedForMove, visibleCategories, searchQuery]);

    // Batch move selected categories to a folder
    const handleMoveSelectedToFolder = useCallback((folderId: string | null) => {
        const targetIds = getTargetCategoryIdsToMove();
        if (targetIds.length === 0) return;

        const targetSet = new Set(targetIds);
        setCategories(cats => cats.map(cat => {
            if (targetSet.has(cat.id)) {
                return { ...cat, folderId };
            }
            return cat;
        }));
        setIsDirty(true);
        setSelectedForMove(new Set());
        setSelectToMoveMode('inactive');
        setIsFolderModalOpen(false);
    }, [getTargetCategoryIdsToMove]);

    // Single category folder assignment
    const handleAssignFolderSingle = useCallback((id: string, folderId: string | null) => {
        setCategories(cats => cats.map(cat =>
            cat.id === id ? { ...cat, folderId } : cat
        ));
        setIsDirty(true);
    }, []);

    // Sort categories alphabetically by name (alias if available, otherwise original name)
    const handleSortABC = useCallback(() => {
        setCategories(cats => {
            const sorted = [...cats].sort((a, b) => {
                const nameA = (a.name || '').trim();
                const nameB = (b.name || '').trim();
                return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
            });
            return sorted.map((c, idx) => ({ ...c, displayOrder: idx }));
        });
        if (targetPlaylistId) {
            setCategorySortCustomized(targetPlaylistId, true);
            setIsCustomized(true);
        }
        setIsDirty(true);
    }, [targetPlaylistId]);

    // Save changes
    const handleSave = useCallback(async () => {
        try {
            isSavingRef.current = true;

            // Save native categories in batch
            const nativeUpdates = categories
                .filter(cat => cat.type === 'native')
                .map(cat => ({
                    categoryId: cat.id,
                    enabled: cat.enabled,
                    displayOrder: cat.displayOrder,
                    folderId: cat.folderId || null,
                }));

            if (nativeUpdates.length > 0) {
                await updateCategoriesBatch(nativeUpdates);
            }

            // Save custom links updates in database
            const linkItems = categories
                .filter(cat => cat.type === 'link')
                .map(cat => ({
                    ...cat.link,
                    display_order: cat.displayOrder,
                    folder_id: cat.folderId || null,
                }));

            if (linkItems.length > 0) {
                await db.playlistCategoryLinks.bulkPut(linkItems);
            }

            await new Promise(resolve => setTimeout(resolve, 300));
            if (onChange) await onChange();
            onClose();
        } catch (err) {
            console.error('[CategoryManager] Failed to save:', err);
            alert(i18n.t('settings:categoryManager.errSave'));
            isSavingRef.current = false;
        }
    }, [categories, onChange, onClose]);



    const enabledCount = categories.filter(c => c.enabled !== false).length;
    const totalCount = categories.length;

    const modalContent = (
        <div className="category-manager-overlay">
            <div className="category-manager-modal" onClick={e => e.stopPropagation()}>
                <div className="category-manager-header">
                    <h2>{i18n.t('settings:categoryManager.manageTitle', { name: sourceName })}</h2>
                    <button className="close-btn" onClick={onClose}>✕</button>
                </div>

                <div className="category-manager-stats" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>{i18n.t('settings:categoryManager.categoriesEnabled', { enabled: enabledCount, total: totalCount })}</span>
                    <span style={{ opacity: 0.7, fontSize: '0.85em' }}>
                        ({i18n.t('settings:categoryManager.orderLabel', { order: categorySortOrder === 'alphabetical' && !isCustomized ? i18n.t('common:alphabetical') : i18n.t('common:default') })})
                    </span>
                    {categorySortOrder === 'alphabetical' && (
                        !isCustomized ? (
                            <button
                                onClick={handleUnlockOrder}
                                style={{
                                    padding: '2px 8px',
                                    fontSize: '0.85em',
                                    background: 'var(--bg-primary, #1e1e1e)',
                                    border: '1px solid var(--surface-border, #333)',
                                    borderRadius: '4px',
                                    color: 'var(--text-primary, #fff)',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    marginLeft: '8px'
                                }}
                                title={i18n.t('settings:categoryManager.unlockOrderHint')}
                            >
                                <svg 
                                    xmlns="http://www.w3.org/2000/svg" 
                                    width="12" 
                                    height="12" 
                                    viewBox="0 0 24 24" 
                                    fill="none" 
                                    stroke="currentColor" 
                                    strokeWidth="2" 
                                    strokeLinecap="round" 
                                    strokeLinejoin="round"
                                >
                                    <path d="M12 20h9"/>
                                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                                </svg>
                                <span>{i18n.t('settings:categoryManager.customizeOrder')}</span>
                            </button>
                        ) : (
                            <button
                                onClick={handleResetToAlphabetical}
                                style={{
                                    padding: '2px 8px',
                                    fontSize: '0.85em',
                                    background: 'var(--bg-primary, #1e1e1e)',
                                    border: '1px solid var(--surface-border, #333)',
                                    borderRadius: '4px',
                                    color: 'var(--text-primary, #fff)',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    marginLeft: '8px'
                                }}
                                title={i18n.t('settings:categoryManager.resetOrderHint')}
                            >
                                <svg 
                                    xmlns="http://www.w3.org/2000/svg" 
                                    width="12" 
                                    height="12" 
                                    viewBox="0 0 24 24" 
                                    fill="none" 
                                    stroke="currentColor" 
                                    strokeWidth="2" 
                                    strokeLinecap="round" 
                                    strokeLinejoin="round"
                                >
                                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                                    <path d="M3 3v5h5"/>
                                </svg>
                                <span>{i18n.t('settings:categoryManager.resetToAlphabetical')}</span>
                            </button>
                        )
                    )}
                </div>

                <div className="category-manager-actions" style={{ flexWrap: 'wrap', gap: '8px' }}>
                    <button onClick={handleSelectAll}>✓ {i18n.t('common:selectAll')}</button>
                    <button onClick={handleSelectNone}>✗ {i18n.t('common:selectNone')}</button>
                    <div className="divider-vertical"></div>
                    <button
                        onClick={handleSortABC}
                        title={i18n.t('settings:categoryManager.sortAZHint')}
                    >
                        🔤 {i18n.t('common:sortAZ')}
                    </button>
                    <div className="divider-vertical"></div>
                    <button
                        onClick={() => setHideUnselected(!hideUnselected)}
                        className={hideUnselected ? 'active-toggle' : ''}
                    >
                        {hideUnselected ? '👁 ' + i18n.t('common:showAll') : '👁‍🗨 ' + i18n.t('settings:categoryManager.hideUnselected')}
                    </button>
                    <button
                        onClick={handleSelectToMoveToggle}
                        className={selectToMoveMode !== 'inactive' ? 'active-toggle' : ''}
                    >
                        {selectToMoveMode === 'inactive' && '⇈ ' + i18n.t('settings:categoryManager.multiSelect')}
                        {selectToMoveMode === 'selecting' && `✓ ${i18n.t('settings:categoryManager.doneSelecting', { count: selectedForMove.size })}`}
                        {selectToMoveMode === 'ready' && '⇈ ' + i18n.t('settings:categoryManager.moveSelectedTop')}
                    </button>

                    <button
                        onClick={() => {
                            setCreateOnlyFolderName('');
                            setIsCreateOnlyModalOpen(true);
                        }}
                        style={{ color: 'var(--accent-primary, #00d4ff)', borderColor: 'rgba(0,212,255,0.3)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                        title={i18n.t('settings:categoryManager.createFolderHint')}
                    >
                        <FolderIcon size={14} /> + {i18n.t('settings:categoryManager.createFolder')}
                    </button>

                    {selectToMoveMode !== 'inactive' && (
                        <button
                            onClick={handleSelectToMoveCancel}
                            className="cancel-select-btn"
                        >
                            {i18n.t('common:cancel')}
                        </button>
                    )}
                </div>

                <div className="category-search">
                    <input
                        type="text"
                        placeholder={i18n.t('settings:categoryManager.searchPlaceholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>

                <DndContext
                    sensors={categorySensors}
                    collisionDetection={categoryListCollisionDetection}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragEnd={handleDragEnd}
                    onDragCancel={handleDragCancel}
                >
                    <div className="category-list">
                    {(() => {
                        const sortedCategoryFolders = categoryFolders && categoryFolders.length > 0
                            ? [...categoryFolders].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
                            : [];
                        const rootCategories = visibleCategories.filter(c => !c.folderId || !sortedCategoryFolders.some((f: CategoryFolder) => f.folder_id === c.folderId));
                        const categoryRenderOrder = new Map<string, number>();
                        let renderIdx = 0;
                        for (const folder of sortedCategoryFolders) {
                            for (const c of visibleCategories.filter(cc => cc.folderId === folder.folder_id)) {
                                categoryRenderOrder.set(c.id, renderIdx++);
                            }
                        }
                        for (const c of rootCategories) {
                            categoryRenderOrder.set(c.id, renderIdx++);
                        }

                        const renderCategoryItem = (cat: any) => {
                            const isAlphabetical = categorySortOrder === 'alphabetical' && !isCustomized;
                            const canDrag = !isAlphabetical && selectToMoveMode === 'inactive';
                            const index = categories.findIndex(c => c.id === cat.id);
                            const isOver = overId === cat.id && activeId !== overId;
                            const activeIdx = activeId != null ? categoryRenderOrder.get(activeId) : undefined;
                            const myIdx = categoryRenderOrder.get(cat.id);
                            const dropIndicator = isOver && activeIdx !== undefined && myIdx !== undefined
                                ? (activeIdx < myIdx ? 'below' : 'above')
                                : null;

                            return (
                                <SortableCategoryRow
                                    key={cat.id}
                                    id={cat.id}
                                    disabled={!canDrag}
                                    className={`category-item ${canDrag ? 'draggable' : ''} ${selectToMoveMode !== 'inactive' && selectedForMove.has(cat.id) ? 'selected-for-move' : ''} ${selectToMoveMode !== 'inactive' ? 'selection-mode-item' : ''}`}
                                    onClick={selectToMoveMode !== 'inactive' ? () => toggleSelectForMove(cat.id) : undefined}
                                    dropIndicator={dropIndicator}
                                >

                                    {cat.type === 'native' ? (
                                        <label 
                                            className="category-checkbox" 
                                            onClick={selectToMoveMode !== 'inactive' ? (e) => e.preventDefault() : undefined}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={cat.enabled}
                                                onChange={selectToMoveMode !== 'inactive' ? () => {} : () => toggleCategory(cat.id)}
                                                onPointerDown={(e) => e.stopPropagation()}
                                                disabled={selectToMoveMode !== 'inactive'}
                                            />
                                            <span className="category-name">{cat.name}</span>
                                        </label>
                                    ) : (
                                        <div className="category-checkbox">
                                            <span className="category-name" style={{ marginLeft: '24px' }}>
                                                🔗 {cat.name}
                                            </span>
                                        </div>
                                    )}

                                    <div className="category-actions-row" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                        {categoryFolders && categoryFolders.length > 0 && (
                                            <select
                                                className="cm-folder-select"
                                                value={cat.folderId || ''}
                                                onChange={(e) => {
                                                    const val = e.target.value || null;
                                                    handleAssignFolderSingle(cat.id, val);
                                                }}
                                                onClick={(e) => e.stopPropagation()}
                                                onPointerDown={(e) => e.stopPropagation()}
                                                title={i18n.t('settings:categoryManager.assignFolderHint')}
                                            >
                                                <option value="">📁 {i18n.t('settings:categoryManager.rootLevel')}</option>
                                                {categoryFolders.map((f: CategoryFolder) => (
                                                    <option key={f.folder_id} value={f.folder_id}>📁 {f.name}</option>
                                                ))}
                                            </select>
                                        )}

                                        <button
                                            className="manage-channels-btn"
                                            onClick={selectToMoveMode !== 'inactive' ? (e) => e.stopPropagation() : () => setManagingCategory({ id: cat.id, name: cat.name })}
                                            onPointerDown={(e) => e.stopPropagation()}
                                            disabled={selectToMoveMode !== 'inactive'}
                                            title={i18n.t('settings:categoryManager.manageChannelsHint')}
                                        >
                                            📺 {i18n.t('settings:categoryManager.channels')}
                                        </button>
                                        {cat.type === 'link' && (
                                            <button
                                                className="category-delete-btn"
                                                onClick={selectToMoveMode !== 'inactive' ? (e) => e.stopPropagation() : () => handleDeleteLink(cat.linkId)}
                                                onPointerDown={(e) => e.stopPropagation()}
                                                disabled={selectToMoveMode !== 'inactive'}
                                                title={i18n.t('settings:categoryManager.removeLinkHint')}
                                                style={{
                                                    background: 'transparent',
                                                    border: 'none',
                                                    color: '#ff4b4b',
                                                    cursor: selectToMoveMode !== 'inactive' ? 'default' : 'pointer',
                                                    fontSize: '1rem',
                                                    marginLeft: '8px',
                                                    padding: '4px',
                                                    opacity: selectToMoveMode !== 'inactive' ? 0.3 : 1
                                                }}
                                            >
                                                ✕
                                            </button>
                                        )}
                                    </div>

                                    {!isAlphabetical && (
                                        <div className="category-reorder">
                                            <button
                                                className="order-btn"
                                                onClick={selectToMoveMode !== 'inactive' ? (e) => e.stopPropagation() : () => moveToTop(index)}
                                                onPointerDown={(e) => e.stopPropagation()}
                                                disabled={index === 0 || selectToMoveMode !== 'inactive'}
                                                title={i18n.t('common:moveToTop')}
                                            >
                                                ↑↑
                                            </button>
                                            <button
                                                className="order-btn"
                                                onClick={selectToMoveMode !== 'inactive' ? (e) => e.stopPropagation() : () => moveUp(index)}
                                                onPointerDown={(e) => e.stopPropagation()}
                                                disabled={index === 0 || selectToMoveMode !== 'inactive'}
                                                title={i18n.t('common:moveUp')}
                                            >
                                                ↑
                                            </button>
                                            <button
                                                className="order-btn"
                                                onClick={selectToMoveMode !== 'inactive' ? (e) => e.stopPropagation() : () => moveDown(index)}
                                                onPointerDown={(e) => e.stopPropagation()}
                                                disabled={index === categories.length - 1 || selectToMoveMode !== 'inactive'}
                                                title={i18n.t('common:moveDown')}
                                            >
                                                ↓
                                            </button>
                                        </div>
                                    )}
                                </SortableCategoryRow>
                            );
                        };

                        if (sortedCategoryFolders.length > 0) {
                            const folderActiveIdx = activeId != null
                                ? sortedCategoryFolders.findIndex(f => f.folder_id === activeId)
                                : -1;

                            return (
                                <>
                                    <SortableContext items={sortedCategoryFolders.map(f => f.folder_id)} strategy={verticalListSortingStrategy}>
                                        {sortedCategoryFolders.map((folder: CategoryFolder, folderIndex: number) => {
                                            const folderCategories = visibleCategories.filter(c => c.folderId === folder.folder_id);
                                            const isCollapsed = !!collapsedFolders[folder.folder_id];
                                            const isFolderOver = overId === folder.folder_id && activeId !== overId;
                                            const folderOverIdx = overId === folder.folder_id ? sortedCategoryFolders.findIndex(f => f.folder_id === overId) : -1;
                                            const folderDropIndicator = isFolderOver && folderActiveIdx !== -1
                                                ? (folderActiveIdx < folderOverIdx ? 'below' : 'above')
                                                : null;

                                            return (
                                                <SortableFolderCard
                                                    key={folder.folder_id}
                                                    folder={folder}
                                                    folderCategoriesCount={folderCategories.length}
                                                    isCollapsed={isCollapsed}
                                                    folderIndex={folderIndex}
                                                    totalFolders={sortedCategoryFolders.length}
                                                    dropIndicator={folderDropIndicator}
                                                    onToggleCollapse={() => setCollapsedFolders(prev => ({ ...prev, [folder.folder_id]: !prev[folder.folder_id] }))}
                                                    onMoveUp={() => handleFolderMoveUp(folderIndex, sortedCategoryFolders)}
                                                    onMoveDown={() => handleFolderMoveDown(folderIndex, sortedCategoryFolders)}
                                                    onBulk={() => {
                                                        setBulkLeftSearch('');
                                                        setBulkRightSearch('');
                                                        setBulkFolderTarget(folder);
                                                    }}
                                                    onRename={() => {
                                                        setRenamingFolder(folder);
                                                        setRenameInput(folder.name);
                                                    }}
                                                    onDelete={() => setDeletingFolderTarget(folder)}
                                                >
                                                    <SortableContext items={folderCategories.map(c => c.id)} strategy={verticalListSortingStrategy}>
                                                        {folderCategories.length === 0 ? (
                                                            <div className="cm-folder-empty-hint">{i18n.t('settings:categoryManager.folderEmpty')}</div>
                                                        ) : (
                                                            folderCategories.map(cat => renderCategoryItem(cat))
                                                        )}
                                                    </SortableContext>
                                                </SortableFolderCard>
                                            );
                                        })}
                                    </SortableContext>

                                    {rootCategories.length > 0 && (
                                        <div className="cm-root-categories">
                                            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.5)', margin: '12px 0 6px' }}>{i18n.t('settings:categoryManager.rootCategories')}</div>
                                            <SortableContext items={rootCategories.map(c => c.id)} strategy={verticalListSortingStrategy}>
                                                {rootCategories.map(cat => renderCategoryItem(cat))}
                                            </SortableContext>
                                        </div>
                                    )}
                                </>
                            );
                        }

                        return (
                            <SortableContext items={visibleCategories.map(c => c.id)} strategy={verticalListSortingStrategy}>
                                {visibleCategories.map(cat => renderCategoryItem(cat))}
                            </SortableContext>
                        );
                    })()}
                    </div>
                </DndContext>

                <div className="category-manager-footer">
                    <button className="cancel-btn" onClick={onClose}>{i18n.t('common:cancel')}</button>
                    <button
                        className="save-btn"
                        onClick={handleSave}
                        disabled={!isDirty}
                    >
                        {i18n.t('common:saveChanges')}
                    </button>
                </div>

                {managingCategory && (
                    <ChannelManager
                        categoryId={managingCategory.id}
                        categoryName={managingCategory.name}
                        sourceId={sourceId}
                        onClose={() => setManagingCategory(null)}
                        onChange={onChange}
                    />
                )}

                {/* Custom Move to Folder Modal */}
                {isFolderModalOpen && (() => {
                    const activeMoveIds = getTargetCategoryIdsToMove();
                    const activeMoveCount = activeMoveIds.length;

                    return (
                        <div className="cm-folder-modal-overlay" onClick={() => setIsFolderModalOpen(false)}>
                            <div className="cm-folder-modal" onClick={e => e.stopPropagation()}>
                                <div className="cm-folder-modal-header">
                                    <h3>
                                        <FolderIcon size={18} />
                                        <span>{activeMoveCount > 0 ? i18n.t('settings:categoryManager.moveCategoriesToFolder', { count: activeMoveCount }) : i18n.t('settings:categoryManager.foldersInSource', { name: sourceName })}</span>
                                    </h3>
                                    <button className="close-btn" onClick={() => setIsFolderModalOpen(false)}>✕</button>
                                </div>

                                <div className="cm-folder-modal-body">
                                    <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.6)', marginBottom: '4px' }}>
                                        {activeMoveCount > 0 ? i18n.t('settings:categoryManager.selectDestFolder') : i18n.t('settings:categoryManager.currentSourceFolders')}
                                    </div>

                                    <button
                                        className="cm-folder-option-btn root"
                                        onClick={() => {
                                            if (activeMoveCount > 0) {
                                                handleMoveSelectedToFolder(null);
                                            }
                                            setIsFolderModalOpen(false);
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <FolderIcon size={16} />
                                            <span>{i18n.t('settings:categoryManager.rootLevelNoFolder')}</span>
                                        </div>
                                        <span style={{ opacity: 0.5, fontSize: '0.75rem' }}>{i18n.t('common:default')}</span>
                                    </button>

                                    {categoryFolders && categoryFolders.length > 0 ? (
                                        categoryFolders.map((f: CategoryFolder) => {
                                            const count = categories.filter(c => c.folderId === f.folder_id).length;
                                            return (
                                                <button
                                                    key={f.folder_id}
                                                    className="cm-folder-option-btn"
                                                    onClick={() => {
                                                        if (activeMoveCount > 0) {
                                                            handleMoveSelectedToFolder(f.folder_id);
                                                        }
                                                        setIsFolderModalOpen(false);
                                                    }}
                                                >
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                        <FolderIcon size={16} />
                                                        <span style={{ fontWeight: 600 }}>{f.name}</span>
                                                    </div>
                                                    <span style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)' }}>
                                                        {i18n.t('settings:categoryManager.categoryCount', { count })}
                                                    </span>
                                                </button>
                                            );
                                        })
                                    ) : (
                                        <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', fontStyle: 'italic', padding: '6px 0' }}>
                                            {i18n.t('settings:categoryManager.noFoldersYet')}
                                        </div>
                                    )}

                                    {/* Add New Folder Inline Form */}
                                    <div className="cm-folder-create-box">
                                        <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--accent-primary, #00d4ff)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                            <FolderIcon size={14} /> + {i18n.t('settings:categoryManager.addNewFolder')}
                                        </div>
                                        <div style={{ display: 'flex', gap: '8px' }}>
                                            <input
                                                type="text"
                                                className="cm-folder-create-input"
                                                placeholder={i18n.t('settings:categoryManager.folderNamePlaceholder')}
                                                value={newFolderName}
                                                onChange={e => setNewFolderName(e.target.value)}
                                                onKeyDown={async e => {
                                                    if (e.key === 'Enter' && newFolderName.trim()) {
                                                        const newFolderId = await createCategoryFolder(targetPlaylistId, newFolderName.trim());
                                                        if (newFolderId && activeMoveCount > 0) {
                                                            handleMoveSelectedToFolder(newFolderId);
                                                        }
                                                        setNewFolderName('');
                                                        setIsFolderModalOpen(false);
                                                    }
                                                }}
                                                autoFocus
                                            />
                                            <button
                                                className="save-btn"
                                                style={{ padding: '6px 14px', whiteSpace: 'nowrap' }}
                                                disabled={!newFolderName.trim()}
                                                onClick={async () => {
                                                    if (!newFolderName.trim()) return;
                                                    const newFolderId = await createCategoryFolder(targetPlaylistId, newFolderName.trim());
                                                    if (newFolderId && activeMoveCount > 0) {
                                                        handleMoveSelectedToFolder(newFolderId);
                                                    }
                                                    setNewFolderName('');
                                                    setIsFolderModalOpen(false);
                                                }}
                                            >
                                                {activeMoveCount > 0 ? i18n.t('settings:categoryManager.createAndAssign') : i18n.t('settings:categoryManager.createFolder')}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="category-manager-footer" style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                    <button className="cancel-btn" onClick={() => setIsFolderModalOpen(false)}>{i18n.t('common:close')}</button>
                                </div>
                            </div>
                        </div>
                    );
                })()}
                {/* Dedicated Create New Folder Modal */}
                {isCreateOnlyModalOpen && (() => {
                    const handleCancel = () => {
                        setIsCreateOnlyModalOpen(false);
                        if (initialCreateFolder && !bulkFolderTarget && !isDirty) {
                            onClose();
                        }
                    };

                    const handleCreate = async () => {
                        const name = createOnlyFolderName.trim();
                        if (!name) return;
                        const newFolderId = await createCategoryFolder(targetPlaylistId, name);
                        setCreateOnlyFolderName('');
                        setIsCreateOnlyModalOpen(false);
                        if (newFolderId) {
                            setBulkLeftSearch('');
                            setBulkRightSearch('');
                            setBulkFolderTarget({
                                folder_id: newFolderId,
                                playlist_id: targetPlaylistId,
                                name: name,
                                display_order: 999,
                                created_at: Date.now()
                            });
                        }
                    };

                    return (
                        <div className="cm-folder-modal-overlay" onClick={handleCancel}>
                            <div className="cm-folder-modal" style={{ maxWidth: '420px' }} onClick={e => e.stopPropagation()}>
                                <div className="cm-folder-modal-header">
                                    <h3>
                                        <FolderIcon size={18} />
                                        <span>{i18n.t('settings:categoryManager.createNewFolder')}</span>
                                    </h3>
                                    <button className="close-btn" onClick={handleCancel}>✕</button>
                                </div>

                                <div className="cm-folder-modal-body" style={{ gap: '16px' }}>
                                    <div className="cm-modal-subtext">
                                        {i18n.t('settings:categoryManager.enterFolderNamePre')}<strong>{sourceName}</strong>{i18n.t('settings:categoryManager.enterFolderNamePost')}
                                    </div>

                                    <input
                                        type="text"
                                        className="cm-folder-create-input"
                                        style={{ width: '100%', boxSizing: 'border-box', fontSize: '0.9rem', padding: '10px 14px' }}
                                        placeholder={i18n.t('settings:categoryManager.folderNamePlaceholder')}
                                        value={createOnlyFolderName}
                                        onChange={e => setCreateOnlyFolderName(e.target.value)}
                                        onKeyDown={async e => {
                                            if (e.key === 'Enter' && createOnlyFolderName.trim()) {
                                                await handleCreate();
                                            }
                                        }}
                                        autoFocus
                                    />
                                </div>

                                <div className="category-manager-footer" style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                                    <button className="cancel-btn" onClick={handleCancel}>{i18n.t('common:cancel')}</button>
                                    <button
                                        className="save-btn"
                                        style={{ padding: '6px 18px' }}
                                        disabled={!createOnlyFolderName.trim()}
                                        onClick={handleCreate}
                                    >
                                        {i18n.t('settings:categoryManager.createFolder')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Bulk Add/Remove Categories in Folder Modal */}
                {bulkFolderTarget && (() => {
                    const folderId = bulkFolderTarget.folder_id;

                    const insideFolder = categories.filter(c => c.folderId === folderId);
                    const outsideFolder = categories.filter(c => !c.folderId);

                    const filteredInside = insideFolder.filter(c =>
                        !bulkLeftSearch.trim() || c.name.toLowerCase().includes(bulkLeftSearch.toLowerCase())
                    );

                    const filteredOutside = outsideFolder.filter(c =>
                        !bulkRightSearch.trim() || c.name.toLowerCase().includes(bulkRightSearch.toLowerCase())
                    );

                    const handleBulkDragEnd = (event: DragEndEvent) => {
                        const { active, over } = event;
                        if (!over || active.id === over.id) return;

                        const oldIndex = insideFolder.findIndex(c => c.id === active.id);
                        const newIndex = insideFolder.findIndex(c => c.id === over.id);
                        if (oldIndex === -1 || newIndex === -1) return;

                        const reorderedInside = arrayMove(insideFolder, oldIndex, newIndex);

                        setCategories(prevCats => {
                            let insideIdx = 0;
                            const next = prevCats.map(cat => {
                                if (cat.folderId === folderId) {
                                    return reorderedInside[insideIdx++];
                                }
                                return cat;
                            });
                            return next.map((cat, i) => ({ ...cat, displayOrder: i }));
                        });
                        setIsDirty(true);
                    };

                    const handleCloseBulkModal = async () => {
                        setBulkFolderTarget(null);
                        if (initialCreateFolder || initialBulkFolder) {
                            if (isDirty) {
                                await handleSave();
                            } else {
                                onClose();
                            }
                        }
                    };

                    return (
                        <div className="cm-folder-modal-overlay" onClick={handleCloseBulkModal}>
                            <div className="cm-folder-modal cm-bulk-modal" style={{ maxWidth: '840px' }} onClick={e => e.stopPropagation()}>
                                <div className="cm-folder-modal-header">
                                    <h3>
                                        <FolderIcon size={18} />
                                        <span>{i18n.t('settings:categoryManager.bulkEditPre')}<strong>{bulkFolderTarget.name}</strong></span>
                                    </h3>
                                    <button className="close-btn" onClick={handleCloseBulkModal}>✕</button>
                                </div>

                                <div className="cm-folder-modal-body">
                                    <div className="cm-bulk-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', height: '55vh' }}>
                                        
                                        {/* Left Column: Categories currently in this folder */}
                                        <div className="cm-bulk-col" style={{ display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '12px', overflow: 'hidden' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                                                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent-primary, #00d4ff)' }}>
                                                    📁 {i18n.t('settings:categoryManager.inFolder', { count: insideFolder.length })}
                                                </div>
                                                {insideFolder.length > 0 && (
                                                    <button
                                                        style={{ background: 'transparent', border: 'none', color: '#ff4b4b', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}
                                                        onClick={() => {
                                                            const ids = new Set(insideFolder.map(c => c.id));
                                                            setCategories(cats => cats.map(c => ids.has(c.id) ? { ...c, folderId: null } : c));
                                                            setIsDirty(true);
                                                        }}
                                                    >
                                                        {i18n.t('settings:categoryManager.removeAll')}
                                                    </button>
                                                )}
                                            </div>

                                            <input
                                                type="text"
                                                className="cm-folder-create-input"
                                                style={{ marginBottom: '8px', padding: '6px 10px', fontSize: '0.8rem' }}
                                                placeholder={i18n.t('settings:categoryManager.filterInFolder')}
                                                value={bulkLeftSearch}
                                                onChange={e => setBulkLeftSearch(e.target.value)}
                                            />

                                            <div className="cm-bulk-scroll-list" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                {filteredInside.length > 0 ? (
                                                    <DndContext
                                                        sensors={bulkSensors}
                                                        collisionDetection={closestCenter}
                                                        onDragEnd={handleBulkDragEnd}
                                                    >
                                                        <SortableContext
                                                            items={filteredInside.map(c => c.id)}
                                                            strategy={verticalListSortingStrategy}
                                                        >
                                                            {filteredInside.map(cat => (
                                                                <SortableInsideFolderCategory
                                                                    key={cat.id}
                                                                    cat={cat}
                                                                    onRemove={(id) => handleAssignFolderSingle(id, null)}
                                                                />
                                                            ))}
                                                        </SortableContext>
                                                    </DndContext>
                                                ) : (
                                                    <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', fontStyle: 'italic', padding: '12px 0', textAlign: 'center' }}>
                                                        {i18n.t('settings:categoryManager.noCategoriesInFolder')}
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Right Column: Available root categories */}
                                        <div className="cm-bulk-col" style={{ display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '12px', overflow: 'hidden' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                                                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary, rgba(255,255,255,0.8))' }}>
                                                    📄 {i18n.t('settings:categoryManager.availableRoot', { count: outsideFolder.length })}
                                                </div>
                                                {filteredOutside.length > 0 && bulkRightSearch.trim() && (
                                                    <button
                                                        style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary, #00d4ff)', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}
                                                        onClick={() => {
                                                            const ids = new Set(filteredOutside.map(c => c.id));
                                                            setCategories(cats => cats.map(c => ids.has(c.id) ? { ...c, folderId } : c));
                                                            setIsDirty(true);
                                                        }}
                                                    >
                                                        + {i18n.t('settings:categoryManager.addAllFiltered', { count: filteredOutside.length })}
                                                    </button>
                                                )}
                                            </div>

                                            <input
                                                type="text"
                                                className="cm-folder-create-input"
                                                style={{ marginBottom: '8px', padding: '6px 10px', fontSize: '0.8rem' }}
                                                placeholder={i18n.t('settings:categoryManager.filterAvailableRoot')}
                                                value={bulkRightSearch}
                                                onChange={e => setBulkRightSearch(e.target.value)}
                                            />

                                            <div className="cm-bulk-scroll-list" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                                {filteredOutside.length > 0 ? (
                                                    filteredOutside.map(cat => (
                                                        <div
                                                            key={cat.id}
                                                            onClick={() => handleAssignFolderSingle(cat.id, folderId)}
                                                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'rgba(255,255,255,0.04)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.06)', fontSize: '0.82rem', cursor: 'pointer' }}
                                                            className="cm-bulk-add-row"
                                                        >
                                                            <span style={{ fontWeight: 500 }}>{cat.name}</span>
                                                            <span style={{ fontSize: '0.72rem', color: 'var(--accent-primary, #00d4ff)', fontWeight: 600, padding: '2px 6px', background: 'rgba(0,212,255,0.1)', borderRadius: '4px' }}>
                                                                + {i18n.t('common:add')}
                                                            </span>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', fontStyle: 'italic', padding: '12px 0', textAlign: 'center' }}>
                                                        {i18n.t('settings:categoryManager.noAvailableRoot')}
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                    </div>
                                </div>

                                <div className="category-manager-footer" style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'flex-end' }}>
                                    <button className="save-btn" style={{ padding: '6px 20px' }} onClick={handleCloseBulkModal}>{i18n.t('common:done')}</button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Custom Rename Folder Modal */}
                {renamingFolder && (
                    <div className="cm-folder-modal-overlay" onClick={() => setRenamingFolder(null)}>
                        <div className="cm-folder-modal" style={{ maxWidth: '420px' }} onClick={e => e.stopPropagation()}>
                            <div className="cm-folder-modal-header">
                                <h3>
                                    <PencilIcon size={18} />
                                    <span>{i18n.t('settings:categoryManager.renameFolderTitle')}</span>
                                </h3>
                                <button className="close-btn" onClick={() => setRenamingFolder(null)}>✕</button>
                            </div>

                            <div className="cm-folder-modal-body" style={{ gap: '16px' }}>
                                <div className="cm-modal-subtext">
                                    {i18n.t('settings:categoryManager.enterNewFolderNamePre')}<strong>{renamingFolder.name}</strong>{i18n.t('settings:categoryManager.enterNewFolderNamePost')}
                                </div>

                                <input
                                    type="text"
                                    className="cm-folder-create-input"
                                    style={{ width: '100%', boxSizing: 'border-box', fontSize: '0.9rem', padding: '10px 14px' }}
                                    value={renameInput}
                                    onChange={e => setRenameInput(e.target.value)}
                                    onKeyDown={async e => {
                                        if (e.key === 'Enter' && renameInput.trim()) {
                                            await renameCategoryFolder(renamingFolder.folder_id, renameInput.trim());
                                            setRenamingFolder(null);
                                        }
                                    }}
                                    autoFocus
                                />
                            </div>

                            <div className="category-manager-footer" style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                                <button className="cancel-btn" onClick={() => setRenamingFolder(null)}>{i18n.t('common:cancel')}</button>
                                <button
                                    className="save-btn"
                                    style={{ padding: '6px 18px' }}
                                    disabled={!renameInput.trim() || renameInput.trim() === renamingFolder.name}
                                    onClick={async () => {
                                        if (!renameInput.trim()) return;
                                        await renameCategoryFolder(renamingFolder.folder_id, renameInput.trim());
                                        setRenamingFolder(null);
                                    }}
                                >
                                    {i18n.t('settings:categoryManager.saveName')}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Custom Delete Folder Confirmation Modal */}
                {deletingFolderTarget && (
                    <div className="cm-folder-modal-overlay" onClick={() => setDeletingFolderTarget(null)}>
                        <div className="cm-folder-modal" style={{ maxWidth: '440px' }} onClick={e => e.stopPropagation()}>
                            <div className="cm-folder-modal-header">
                                <h3>
                                    <span style={{ color: '#ff4b4b' }}>⚠️</span>
                                    <span>{i18n.t('settings:categoryManager.deleteFolderTitle')}</span>
                                </h3>
                                <button className="close-btn" onClick={() => setDeletingFolderTarget(null)}>✕</button>
                            </div>

                            <div className="cm-folder-modal-body" style={{ gap: '12px' }}>
                                <div style={{ fontSize: '0.92rem', fontWeight: 600 }}>
                                    {i18n.t('settings:categoryManager.deleteFolderConfirmPre')}<strong>{i18n.t('settings:categoryManager.deleteFolderConfirmName', { name: deletingFolderTarget.name })}</strong>{i18n.t('settings:categoryManager.deleteFolderConfirmPost')}
                                </div>
                                <div className="cm-modal-subtext">
                                    {i18n.t('settings:categoryManager.deleteFolderSub')}
                                </div>
                            </div>

                            <div className="category-manager-footer" style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                                <button className="cancel-btn" onClick={() => setDeletingFolderTarget(null)}>{i18n.t('common:cancel')}</button>
                                <button
                                    className="save-btn"
                                    style={{ padding: '6px 18px', background: '#ff4b4b', borderColor: '#ff4b4b', color: '#fff' }}
                                    onClick={async () => {
                                        await deleteCategoryFolder(deletingFolderTarget.folder_id);
                                        setDeletingFolderTarget(null);
                                    }}
                                    autoFocus
                                >
                                    {i18n.t('settings:categoryManager.deleteFolderTitle')}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
}
