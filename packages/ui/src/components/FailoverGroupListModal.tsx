import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import { db } from '../db';
import {
    listFailoverGroups,
    createFailoverGroup,
    deleteFailoverGroup,
    renameFailoverGroup,
    getFailoverGroupMembers,
    removeChannelFromFailoverGroup,
} from '../services/failover-groups';
import { FailoverGroupManager } from './FailoverGroupManager';
import { FailoverAutoClusterModal } from './FailoverAutoClusterModal';
import { useSourceNameMap } from '../hooks/useChannels';
import { useSettingsStore } from '../stores/settingsStore';
import './FailoverGroupListModal.css';

interface FailoverGroupListModalProps {
    onClose: () => void;
}

interface FailoverGroupItem {
    group_id: string;
    name: string;
    memberCount: number;
    created_at: number;
}

interface MemberDetail {
    stream_id: string;
    name: string;
    stream_icon?: string;
    source_id?: string;
    priority: number;
}

/* ── SVG Icons ── */
function LinkSvg({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
    );
}

function ZapSvg({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
    );
}

function PlusSvg({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    );
}

function EditSvg({ size = 13 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
    );
}

function TrashSvg({ size = 13 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    );
}

function CheckSvg({ size = 13 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

function CrossSvg({ size = 13 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    );
}

function TvSvg({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6, flexShrink: 0 }}>
            <rect width="20" height="15" x="2" y="7" rx="2" ry="2" />
            <polyline points="17 2 12 7 7 2" />
        </svg>
    );
}

function SettingsSvg({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    );
}

export function FailoverGroupListModal({ onClose }: FailoverGroupListModalProps) {
    const { t } = useTranslation('settings');
    const sourceNameMap = useSourceNameMap();

    const [groups, setGroups] = useState<FailoverGroupItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
    const [groupMembersMap, setGroupMembersMap] = useState<Map<string, MemberDetail[]>>(new Map());

    // Settings for Overlays
    const showFailoverLiveTvWidget = useSettingsStore((s) => s.showFailoverLiveTvWidget);
    const setShowFailoverLiveTvWidget = useSettingsStore((s) => s.setShowFailoverLiveTvWidget);
    const showFailoverMediaBarWidget = useSettingsStore((s) => s.showFailoverMediaBarWidget);
    const setShowFailoverMediaBarWidget = useSettingsStore((s) => s.setShowFailoverMediaBarWidget);

    // Creating & Editing State
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [managingGroup, setManagingGroup] = useState<{ id: string; name: string } | null>(null);
    const [showAutoCluster, setShowAutoCluster] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

    const newNameInputRef = useRef<HTMLInputElement>(null);
    const editNameInputRef = useRef<HTMLInputElement>(null);

    const loadGroups = useCallback(async () => {
        setLoading(true);
        try {
            const data = await listFailoverGroups();
            setGroups(data);
        } catch (e) {
            console.error('Failed to load failover groups:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadGroups();
    }, [loadGroups]);

    useEffect(() => {
        if (creating && newNameInputRef.current) {
            newNameInputRef.current.focus();
        }
    }, [creating]);

    useEffect(() => {
        if (editingId && editNameInputRef.current) {
            editNameInputRef.current.focus();
            editNameInputRef.current.select();
        }
    }, [editingId]);

    // Handle Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (editingId) {
                    setEditingId(null);
                } else if (creating) {
                    setCreating(false);
                } else if (deleteConfirmId) {
                    setDeleteConfirmId(null);
                } else {
                    onClose();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [editingId, creating, deleteConfirmId, onClose]);

    // Expand & load channels for a specific group
    const toggleExpandGroup = async (groupId: string) => {
        setExpandedGroupIds((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
                // Load members if not loaded yet
                if (!groupMembersMap.has(groupId)) {
                    getFailoverGroupMembers(groupId).then((members) => {
                        setGroupMembersMap((m) => new Map(m).set(groupId, members));
                    });
                }
            }
            return next;
        });
    };

    // Remove single member directly from card
    const handleRemoveMember = async (groupId: string, streamId: string) => {
        try {
            await removeChannelFromFailoverGroup(streamId);
            // Refresh members in map
            const updated = await getFailoverGroupMembers(groupId);
            setGroupMembersMap((m) => new Map(m).set(groupId, updated));
            loadGroups();
        } catch (e) {
            console.error('Failed to remove channel:', e);
        }
    };


    const handleCreate = async () => {
        const trimmed = newName.trim();
        if (!trimmed) return;
        try {
            await createFailoverGroup(trimmed);
            setNewName('');
            setCreating(false);
            loadGroups();
        } catch (e) {
            console.error('Failed to create failover group:', e);
        }
    };

    const handleNewNameKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleCreate();
        if (e.key === 'Escape') {
            setCreating(false);
            setNewName('');
        }
    };

    const startEdit = (group: FailoverGroupItem) => {
        setEditingId(group.group_id);
        setEditName(group.name);
        setDeleteConfirmId(null);
    };

    const commitEdit = async () => {
        if (!editingId) return;
        const trimmed = editName.trim();
        if (trimmed) {
            try {
                await renameFailoverGroup(editingId, trimmed);
                loadGroups();
            } catch (e) {
                console.error('Failed to rename failover group:', e);
            }
        }
        setEditingId(null);
    };

    const handleEditKey = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') commitEdit();
        if (e.key === 'Escape') setEditingId(null);
    };

    const handleDelete = async (groupId: string) => {
        try {
            await deleteFailoverGroup(groupId);
            setDeleteConfirmId(null);
            setGroupMembersMap((m) => {
                const next = new Map(m);
                next.delete(groupId);
                return next;
            });
            loadGroups();
        } catch (e) {
            console.error('Failed to delete failover group:', e);
        }
    };

    // Filter groups by search
    const filteredGroups = useMemo(() => {
        if (!searchQuery.trim()) return groups;
        const q = searchQuery.toLowerCase();
        return groups.filter((g) => {
            if (g.name.toLowerCase().includes(q)) return true;
            const members = groupMembersMap.get(g.group_id);
            if (members && members.some((m) => m.name.toLowerCase().includes(q))) return true;
            return false;
        });
    }, [groups, searchQuery, groupMembersMap]);

    const totalMembersCount = useMemo(() => {
        return groups.reduce((acc, g) => acc + g.memberCount, 0);
    }, [groups]);

    return createPortal(
        <>
            <div className="failover-group-list-overlay" onClick={onClose}>
                <div className="failover-group-list-modal" onClick={(e) => e.stopPropagation()}>
                    {/* Header */}
                    <div className="failover-group-list-header">
                        <div className="failover-group-list-header-left">
                            <span style={{ color: 'var(--accent-primary, #00d4ff)' }}><LinkSvg size={18} /></span>
                            <h2>{t('failover.groups')}</h2>
                            <span className="failover-header-badge">
                                {t('failover.groupsStreamsCount', { defaultValue: '{{groups}} groups • {{streams}} streams', groups: groups.length, streams: totalMembersCount })}
                            </span>
                        </div>
                        <button className="close-btn" onClick={onClose} title={i18n.t('common:close')}>
                            <CrossSvg size={14} />
                        </button>
                    </div>

                    {/* Content */}
                    <div className="failover-group-list-content">
                        {/* Toolbar */}
                        <div className="failover-group-list-toolbar">
                            <div className="fgl-toolbar-top">
                                <input
                                    type="text"
                                    className="fgl-search-input"
                                    placeholder={t('failover.searchPlaceholder', { defaultValue: 'Search groups or channel names...' })}
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />

                                <div style={{ display: 'flex', gap: '8px' }}>
                                    {!creating ? (
                                        <button className="fgl-create-btn" onClick={() => setCreating(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                                            <PlusSvg size={13} />
                                            <span>{t('failover.createGroup')}</span>
                                        </button>
                                    ) : null}

                                    <button
                                        className="fgl-create-btn"
                                        onClick={() => setShowAutoCluster(true)}
                                        style={{
                                            background: 'rgba(0, 212, 255, 0.12)',
                                            borderColor: 'rgba(0, 212, 255, 0.35)',
                                            color: 'var(--accent-primary, #00d4ff)',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                        }}
                                        title={i18n.t('settings:failover.smartAutoGroupTooltip', { defaultValue: 'Automatically scan and cluster similar channels into failover groups' })}
                                    >
                                        <ZapSvg size={13} />
                                        <span>{i18n.t('settings:failover.smartAutoGroup', { defaultValue: 'Smart Auto-Group' })}</span>
                                    </button>
                                </div>
                            </div>

                            {creating && (
                                <div className="fgl-create-row">
                                    <input
                                        ref={newNameInputRef}
                                        className="fgl-create-input"
                                        placeholder={t('failover.createGroupPlaceholder')}
                                        value={newName}
                                        onChange={(e) => setNewName(e.target.value)}
                                        onKeyDown={handleNewNameKey}
                                    />
                                    <button className="fgl-create-ok" onClick={handleCreate}>{i18n.t('common:create')}</button>
                                    <button className="fgl-create-cancel" onClick={() => { setCreating(false); setNewName(''); }}>{i18n.t('common:cancel')}</button>
                                </div>
                            )}

                            {/* Widget Display Preferences */}
                            <div className="fgl-display-options-strip" style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                padding: '8px 12px',
                                marginTop: '10px',
                                background: 'rgba(255, 255, 255, 0.03)',
                                border: '1px solid rgba(255, 255, 255, 0.06)',
                                borderRadius: '8px',
                                fontSize: '0.8rem',
                                color: 'rgba(255, 255, 255, 0.75)',
                                flexWrap: 'wrap',
                                gap: '10px',
                            }}>
                                <span style={{ fontWeight: 500, color: 'rgba(255, 255, 255, 0.6)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <SettingsSvg size={13} />
                                    <span>{t('failover.widgetOverlayVisibility', { defaultValue: 'Widget Overlay Visibility:' })}</span>
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' }}>
                                        <input
                                            type="checkbox"
                                            checked={showFailoverLiveTvWidget !== false}
                                            onChange={(e) => setShowFailoverLiveTvWidget(e.target.checked)}
                                            style={{ accentColor: 'var(--accent-primary, #00d4ff)', cursor: 'pointer' }}
                                        />
                                        <span>{t('failover.showLiveTvWidget', { defaultValue: 'Show LiveTV Guide Widget' })}</span>
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' }}>
                                        <input
                                            type="checkbox"
                                            checked={showFailoverMediaBarWidget !== false}
                                            onChange={(e) => setShowFailoverMediaBarWidget(e.target.checked)}
                                            style={{ accentColor: 'var(--accent-primary, #00d4ff)', cursor: 'pointer' }}
                                        />
                                        <span>{t('failover.showMediaBarWidget', { defaultValue: 'Show Player Media Bar Widget' })}</span>
                                    </label>
                                </div>
                            </div>
                        </div>

                        {/* List */}
                        {loading ? (
                            <div className="fgl-empty">{t('failover.loading')}</div>
                        ) : filteredGroups.length === 0 ? (
                            <div className="fgl-empty">
                                <p>{t('failover.noGroups')}</p>
                                <p className="fgl-hint">{t('failover.noGroupsHint')}</p>
                            </div>
                        ) : (
                            <div className="fgl-list">
                                {filteredGroups.map((group) => {
                                    const isExpanded = expandedGroupIds.has(group.group_id);
                                    const members = groupMembersMap.get(group.group_id) || [];

                                    return (
                                        <div
                                            key={group.group_id}
                                            className={`fgl-card ${isExpanded ? 'is-expanded' : ''}`}
                                        >
                                            {/* Card Header */}
                                            <div
                                                className="fgl-card-header"
                                                onClick={() => toggleExpandGroup(group.group_id)}
                                            >
                                                <div className="fgl-card-left">
                                                    <svg
                                                        className={`fgl-chevron ${isExpanded ? 'expanded' : ''}`}
                                                        width="12"
                                                        height="12"
                                                        viewBox="0 0 24 24"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="2.5"
                                                        style={{ transition: 'transform 0.15s ease' }}
                                                    >
                                                        <polyline points="9 18 15 12 9 6" />
                                                    </svg>

                                                    {editingId === group.group_id ? (
                                                        <div className="fgl-edit-row" onClick={(e) => e.stopPropagation()}>
                                                            <input
                                                                ref={editNameInputRef}
                                                                className="fgl-edit-input"
                                                                value={editName}
                                                                onChange={(e) => setEditName(e.target.value)}
                                                                onKeyDown={handleEditKey}
                                                                onBlur={commitEdit}
                                                            />
                                                            <button className="fgl-edit-ok" onClick={commitEdit}>
                                                                <CheckSvg size={12} />
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <span className="fgl-card-name">{group.name}</span>
                                                            <span className={`fgl-card-badge ${group.memberCount > 0 ? 'has-streams' : ''}`}>
                                                                {t('failover.streamCount', { count: group.memberCount })}
                                                            </span>
                                                        </>
                                                    )}
                                                </div>

                                                <div className="fgl-card-actions" onClick={(e) => e.stopPropagation()}>
                                                    <button
                                                        className="fgl-manage-btn"
                                                        onClick={() => setManagingGroup({ id: group.group_id, name: group.name })}
                                                        title={t('failover.manageChannelsTooltip', { defaultValue: 'Manage priority, add channels, or view suggested backup streams' })}
                                                        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                                                    >
                                                        <ZapSvg size={12} />
                                                        <span>{t('failover.manageChannels', { defaultValue: 'Manage Channels' })}</span>
                                                    </button>

                                                    <button
                                                        className="fgl-action-btn"
                                                        onClick={() => startEdit(group)}
                                                        title={i18n.t('common:rename')}
                                                    >
                                                        <EditSvg size={12} />
                                                    </button>

                                                    {deleteConfirmId === group.group_id ? (
                                                        <>
                                                            <button
                                                                className="fgl-action-btn fgl-confirm"
                                                                onClick={() => handleDelete(group.group_id)}
                                                                title={t('failover.confirmDelete')}
                                                            >
                                                                <CheckSvg size={12} />
                                                            </button>
                                                            <button
                                                                className="fgl-action-btn"
                                                                onClick={() => setDeleteConfirmId(null)}
                                                                title={i18n.t('common:cancel')}
                                                            >
                                                                <CrossSvg size={12} />
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <button
                                                            className="fgl-action-btn fgl-danger"
                                                            onClick={() => setDeleteConfirmId(group.group_id)}
                                                            title={i18n.t('common:delete')}
                                                        >
                                                            <TrashSvg size={12} />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Card Expanded Members Preview */}
                                            {isExpanded && (
                                                <div className="fgl-card-body">
                                                    {members.length === 0 ? (
                                                        <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)', padding: '6px 0' }}>
                                                            {t('failover.noChannelsInGroup', { defaultValue: 'No channels in this group yet. Click "Manage Channels" to add streams.' })}
                                                        </div>
                                                    ) : (
                                                        members.map((m) => {
                                                            const isPrimary = m.priority === 0;
                                                            const sourceName = m.source_id && sourceNameMap ? sourceNameMap.get(m.source_id) : undefined;
                                                            return (
                                                                <div key={m.stream_id} className="fgl-member-row">
                                                                    <div className="fgl-member-left">
                                                                        <span className={`fgl-priority-badge ${isPrimary ? 'primary' : ''}`}>
                                                                            {isPrimary
                                                                                ? t('failover.primaryLabel', { defaultValue: 'Primary' })
                                                                                : t('failover.backupNum', { defaultValue: 'Backup {{num}}', num: m.priority })}
                                                                        </span>
                                                                        {m.stream_icon ? (
                                                                            <img src={m.stream_icon} className="fgl-member-logo" alt="" />
                                                                        ) : (
                                                                            <TvSvg size={14} />
                                                                        )}
                                                                        <span className="fgl-member-name">{m.name}</span>
                                                                        {sourceName && (
                                                                            <span className="fgl-member-source">{sourceName}</span>
                                                                        )}
                                                                    </div>

                                                                    <button
                                                                        className="fgl-member-remove-btn"
                                                                        onClick={() => handleRemoveMember(group.group_id, m.stream_id)}
                                                                        title={t('failover.removeChannelFromGroup', { defaultValue: 'Remove channel from group' })}
                                                                    >
                                                                        <CrossSvg size={12} />
                                                                    </button>
                                                                </div>
                                                            );
                                                        })
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="failover-group-list-footer">
                        <span className="fgl-footer-hint">
                            {t('failover.footerExpandHint', { defaultValue: 'Click any group to expand its channels, or click "Manage Channels" to reorder or add backups.' })}
                        </span>
                        <button className="close-done-btn" onClick={onClose}>{i18n.t('common:done')}</button>
                    </div>
                </div>
            </div>

            {managingGroup && (
                <FailoverGroupManager
                    groupId={managingGroup.id}
                    groupName={managingGroup.name}
                    onClose={() => {
                        setManagingGroup(null);
                        setGroupMembersMap(new Map());
                        loadGroups();
                    }}
                />
            )}

            {showAutoCluster && (
                <FailoverAutoClusterModal
                    isOpen={showAutoCluster}
                    onClose={() => {
                        setShowAutoCluster(false);
                        setGroupMembersMap(new Map());
                        loadGroups();
                    }}
                    onSuccess={() => {
                        setGroupMembersMap(new Map());
                        loadGroups();
                    }}
                />
            )}
        </>,
        document.body
    );
}
