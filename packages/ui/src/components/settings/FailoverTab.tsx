import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  listFailoverGroups,
  createFailoverGroup,
  deleteFailoverGroup,
  renameFailoverGroup,
  getFailoverGroupMembers,
  removeChannelFromFailoverGroup,
  reorderFailoverGroupMember,
  type getFailoverGroupForChannel,
} from '../../services/failover-groups';
import { FailoverAutoClusterModal } from '../FailoverAutoClusterModal';
import { db } from '../../db';
import type { FailoverGroup } from '../../db';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import './FailoverTab.css';

interface GroupWithMembers extends FailoverGroup {
  memberCount: number;
  members?: Array<{ stream_id: string; priority: number; name: string; stream_icon?: string; source_id?: string; category_ids?: string | string[] }>;
  expanded?: boolean;
}

// ── SortableList: container-level pointer tracking for drag reorder ────────────

interface SortableListProps<T> {
  items: T[];
  getKey: (item: T) => string;
  onReorder: (newItems: T[]) => void;
  renderItem: (item: T, index: number, handleProps: React.HTMLAttributes<HTMLSpanElement>) => React.ReactNode;
}

function SortableList<T>({ items, getKey, onReorder, renderItem }: SortableListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [fromIdx, setFromIdx] = useState<number | null>(null);

  const getIndexFromY = (clientY: number): number => {
    if (!containerRef.current) return 0;
    const children = Array.from(containerRef.current.children) as HTMLElement[];
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return children.length - 1;
  };

  const handlePointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    draggingIdx.current = index;
    setFromIdx(index);
    setOverIdx(index);
  };

  const handleContainerPointerMove = (e: React.PointerEvent) => {
    if (draggingIdx.current === null) return;
    e.preventDefault();
    const idx = getIndexFromY(e.clientY);
    setOverIdx(idx);
  };

  const handleContainerPointerUp = (e: React.PointerEvent) => {
    if (draggingIdx.current === null) return;
    const from = draggingIdx.current;
    const to = overIdx ?? from;
    draggingIdx.current = null;
    setFromIdx(null);
    setOverIdx(null);
    if (from !== to) {
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      onReorder(next);
    }
  };

  return (
    <div
      ref={containerRef}
      className="failover-channel-list"
      onPointerMove={handleContainerPointerMove}
      onPointerUp={handleContainerPointerUp}
    >
      {items.map((item, index) => {
        const key = getKey(item);
        const isDragging = fromIdx === index;
        const isDragOver = overIdx === index && fromIdx !== null && fromIdx !== index;
        const handleProps: React.HTMLAttributes<HTMLSpanElement> = {
          onPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => handlePointerDown(e, index),
          style: { cursor: 'grab', touchAction: 'none' },
        };
        return (
          <div
            key={key}
            className="failover-member-item"
            data-dragging={isDragging ? 'true' : undefined}
            data-dragover={isDragOver ? 'true' : undefined}
            style={{ opacity: isDragging ? 0.4 : 1 }}
          >
            {renderItem(item, index, handleProps)}
          </div>
        );
      })}
    </div>
  );
}

// ── Main FailoverTab ──────────────────────────────────────────────────────────

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

export function FailoverTab() {
  useTranslation();
  const [groups, setGroups] = useState<GroupWithMembers[]>([]);
  const [loading, setLoading] = useState(true);
  const [newGroupName, setNewGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [showAutoCluster, setShowAutoCluster] = useState(false);
  const [displaySource, setDisplaySource] = useState(false);
  const [sourceNameMap, setSourceNameMap] = useState<Map<string, string>>(new Map());
  const [categoryNameMap, setCategoryNameMap] = useState<Map<string, string>>(new Map());

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const allGroups = await listFailoverGroups();
      setGroups(prev => {
        // Preserve expanded state
        const expandedMap = new Map(prev.filter(g => g.expanded).map(g => [g.group_id, true]));
        return allGroups.map(g => ({ ...g, expanded: expandedMap.get(g.group_id) || false }));
      });
    } catch (e) {
      console.error('[FailoverTab] Failed to load groups:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Load source and category name maps for display
  useEffect(() => {
    async function loadMaps() {
      try {
        const sourcesResult = await window.storage.getSources();
        const allSources = (sourcesResult.data || []).filter((s: any) => s.enabled !== false);
        const sMap = new Map(allSources.map((s: any) => [String(s.id), s.name]));
        setSourceNameMap(sMap);

        const allCategories = await db.categories.toArray();
        const cMap = new Map(allCategories.map(c => [String(c.category_id), c.category_name]));
        setCategoryNameMap(cMap);
      } catch (e) {
        console.error('[FailoverTab] Failed to load source/category maps:', e);
      }
    }
    loadMaps();
  }, []);

  const toggleExpand = useCallback(async (groupId: string) => {
    setGroups(prev => {
      const idx = prev.findIndex(g => g.group_id === groupId);
      if (idx === -1) return prev;
      const next = [...prev];
      const expanded = !next[idx].expanded;
      next[idx] = { ...next[idx], expanded };
      return next;
    });

    // Load members if expanding
    const group = groups.find(g => g.group_id === groupId);
    if (group && !group.expanded && (!group.members || group.members.length === 0)) {
      try {
        const members = await getFailoverGroupMembers(groupId);
        setGroups(prev => {
          const idx = prev.findIndex(g => g.group_id === groupId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], members };
          return next;
        });
      } catch (e) {
        console.error('[FailoverTab] Failed to load members:', e);
      }
    }
  }, [groups]);

  const handleCreateGroup = useCallback(async () => {
    const name = newGroupName.trim();
    if (!name) return;
    try {
      await createFailoverGroup(name);
      setNewGroupName('');
      setCreating(false);
      loadGroups();
    } catch (e) {
      console.error('[FailoverTab] Failed to create group:', e);
    }
  }, [newGroupName, loadGroups]);

  const handleDeleteGroup = useCallback(async (groupId: string) => {
    if (!confirm(i18n.t('settings:failover.deleteConfirm'))) return;
    try {
      await deleteFailoverGroup(groupId);
      loadGroups();
    } catch (e) {
      console.error('[FailoverTab] Failed to delete group:', e);
    }
  }, [loadGroups]);

  const handleRenameGroup = useCallback(async (groupId: string, newName: string) => {
    try {
      await renameFailoverGroup(groupId, newName.trim());
      setGroups(prev => prev.map(g => g.group_id === groupId ? { ...g, name: newName.trim() } : g));
    } catch (e) {
      console.error('[FailoverTab] Failed to rename group:', e);
    }
  }, []);

  const handleRemoveMember = useCallback(async (streamId: string, groupId: string) => {
    try {
      await removeChannelFromFailoverGroup(streamId);
      setGroups(prev => {
        const idx = prev.findIndex(g => g.group_id === groupId);
        if (idx === -1) return prev;
        const next = [...prev];
        const members = (next[idx].members || []).filter(m => m.stream_id !== streamId);
        next[idx] = { ...next[idx], members, memberCount: members.length };
        return next;
      });
    } catch (e) {
      console.error('[FailoverTab] Failed to remove member:', e);
    }
  }, []);

  const handleReorder = useCallback(async (groupId: string, newItems: Array<{ stream_id: string; priority: number; name: string; stream_icon?: string; source_id?: string; category_ids?: string | string[] }>) => {
    setGroups(prev => {
      const idx = prev.findIndex(g => g.group_id === groupId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], members: newItems };
      return next;
    });

    try {
      for (let i = 0; i < newItems.length; i++) {
        await reorderFailoverGroupMember(newItems[i].stream_id, i);
      }
    } catch (e) {
      console.error('[FailoverTab] Failed to reorder:', e);
    }
  }, []);

  const getPriorityLabel = (priority: number) => {
    if (priority === 0) return i18n.t('settings:failover.primary');
    return i18n.t('settings:failover.backup', { priority });
  };

  const getMemberSourceCategory = (member: NonNullable<GroupWithMembers['members']>[number]): string => {
    const sourceName = sourceNameMap.get(String(member.source_id)) || member.source_id || i18n.t('settings:failover.unknown');
    const catIds = parseCategoryIds(member.category_ids);
    const catName = catIds.length > 0 ? (categoryNameMap.get(String(catIds[0])) || catIds[0]) : '—';
    return `${sourceName} → ${catName}`;
  };

  return (
    <div className="failover-tab">
      <h3>{i18n.t('settings:failover.groups')}</h3>
      <p className="failover-desc">
        {i18n.t('settings:failover.desc')}
      </p>

      <div className="failover-toolbar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {!creating && (
            <>
              <button className="failover-create-btn" onClick={() => setCreating(true)}>
                + {i18n.t('settings:failover.newGroup')}
              </button>
              <button
                className="failover-create-btn"
                onClick={() => setShowAutoCluster(true)}
                style={{
                  background: 'rgba(0, 212, 255, 0.12)',
                  borderColor: 'rgba(0, 212, 255, 0.35)',
                  color: 'var(--accent-primary, #00d4ff)',
                }}
                title={i18n.t('settings:failover.smartAutoGroupTooltip', { defaultValue: 'Automatically scan and cluster similar channels into failover groups' })}
              >
                <span>⚡</span> {i18n.t('settings:failover.smartAutoGroup', { defaultValue: 'Smart Auto-Group' })}
              </button>
            </>
          )}
        </div>
        <label className="failover-display-source-label" title={i18n.t('settings:failover.displaySourceHint')}>
          <input
            type="checkbox"
            checked={displaySource}
            onChange={e => setDisplaySource(e.target.checked)}
          />
          {i18n.t('settings:failover.displaySource')}
        </label>
      </div>

      {/* Create new group */}
      {creating && (
        <div className="failover-create-row">
          <div className="failover-create-form">
            <input
              type="text"
              placeholder={i18n.t('settings:failover.groupNamePlaceholder')}
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateGroup()}
              autoFocus
            />
            <button onClick={handleCreateGroup} disabled={!newGroupName.trim()}>{i18n.t('common:create')}</button>
            <button className="cancel-btn" onClick={() => { setCreating(false); setNewGroupName(''); }}>{i18n.t('common:cancel')}</button>
          </div>
        </div>
      )}


      {loading ? (
        <div className="failover-empty">{i18n.t('settings:failover.loading')}</div>
      ) : groups.length === 0 ? (
        <div className="failover-empty">{i18n.t('settings:failover.noGroups')}</div>
      ) : (
        <div className="failover-group-list">
          {groups.map(group => (
            <div key={group.group_id} className="failover-group-card">
              <div className="failover-group-header">
                <button
                  className="failover-expand-btn"
                  onClick={() => toggleExpand(group.group_id)}
                  title={group.expanded ? i18n.t('common:collapse') : i18n.t('common:expand')}
                >
                  {group.expanded ? '▼' : '▶'}
                </button>
                <EditableGroupName
                  name={group.name}
                  onRename={(name) => handleRenameGroup(group.group_id, name)}
                />
                <span className="failover-group-count">{i18n.t('settings:failover.channelsCount', { count: group.memberCount })}</span>
                <button
                  className="failover-delete-btn"
                  onClick={() => handleDeleteGroup(group.group_id)}
                  title={i18n.t('settings:failover.deleteGroup')}
                >
                  🗑
                </button>
              </div>

              {group.expanded && (
                <div className="failover-group-members">
                  {group.members && group.members.length > 0 ? (
                    <SortableList
                      items={group.members}
                      getKey={m => m.stream_id}
                      onReorder={(newItems) => handleReorder(group.group_id, newItems)}
                      renderItem={(member, _index, handleProps) => (
                        <>
                          <span className="failover-drag-handle" {...handleProps}>⋮⋮</span>
                          {member.stream_icon
                            ? <img src={member.stream_icon} className="failover-member-icon" alt="" />
                            : <span className="failover-member-icon-placeholder">📺</span>
                          }
                          <div className="failover-member-info">
                            <span className="failover-member-name">{member.name}</span>
                            {displaySource && (
                              <span className="failover-member-source">{getMemberSourceCategory(member)}</span>
                            )}
                          </div>
                          <span className={`failover-priority-badge ${member.priority === 0 ? 'primary' : ''}`}>
                            {getPriorityLabel(member.priority)}
                          </span>
                          <button
                            className="failover-remove-member-btn"
                            onClick={() => handleRemoveMember(member.stream_id, group.group_id)}
                            title={i18n.t('settings:failover.removeFromGroup')}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    />
                  ) : (
                    <div className="failover-no-members">
                      {i18n.t('settings:failover.noMembers')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showAutoCluster && (
        <FailoverAutoClusterModal
          isOpen={showAutoCluster}
          onClose={() => {
            setShowAutoCluster(false);
            loadGroups();
          }}
          onSuccess={() => {
            loadGroups();
          }}
        />
      )}
    </div>
  );
}


// ── EditableGroupName ─────────────────────────────────────────────────────────

function EditableGroupName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(name); }, [name]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) {
      onRename(trimmed);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="failover-rename-input"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditing(false); setValue(name); } }}
        onBlur={commit}
        autoFocus
      />
    );
  }

  return (
    <span className="failover-group-name" onClick={() => setEditing(true)} title={i18n.t('settings:failover.clickToRename')}>
      {name}
    </span>
  );
}
