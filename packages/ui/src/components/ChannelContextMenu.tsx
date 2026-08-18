import { useState, useEffect, useRef, useLayoutEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { scheduleRecording, detectScheduleConflicts, type DvrSchedule, db, updateChannelAlias, getDvrSettings } from '../db';
import type { StoredChannel } from '../db';
import { StalkerClient } from '@ynotv/local-adapter';
import { useModal } from './Modal';
import { addChannelsToGroup } from '../services/custom-groups';
import { addChannelToFailoverGroup, createFailoverGroup } from '../services/failover-groups';
import { addToRecentChannels } from '../utils/recentChannels';
import { EpgEditorModal } from './EpgEditorModal';
import { useEpgClockFormat } from '../stores/uiStore';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import './ProgramContextMenu.css'; // Reuse the same styles

type MenuView = 'main' | 'quick' | 'custom' | 'group' | 'failover';

interface ChannelContextMenuProps {
    channel: StoredChannel;
    position: { x: number; y: number };
    onClose: () => void;
    // Multiview props
    currentLayout?: string;
    onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string, sourceName?: string | null) => void;
    // Popout props
    onPlayInPopout?: (channel: StoredChannel) => void;
    // External player prop
    onPlayInExternal?: (channel: StoredChannel) => void;
}

// Helper to format date for datetime-local input
function formatDateForInput(date: Date): string {
    return date.toISOString().split('T')[0];
}

function formatTimeForInput(date: Date): string {
    return date.toTimeString().slice(0, 5);
}

function formatDuration(minutes: number): string {
    if (minutes <= 0) return i18n.t('contextMenu.min', { count: 0 });
    const hrs = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hrs === 0) {
        return i18n.t('contextMenu.min', { count: mins });
    }
    if (mins === 0) {
        return i18n.t('contextMenu.hr', { count: hrs });
    }
    return `${hrs}h ${mins}m`;
}

export function ChannelContextMenu({
    channel,
    position,
    onClose,
    currentLayout,
    onSendToSlot,
    onPlayInPopout,
    onPlayInExternal,
}: ChannelContextMenuProps) {
    useTranslation();
    const epgClockFormat = useEpgClockFormat();
    const menuRef = useRef<HTMLDivElement>(null);
    const [currentView, setCurrentView] = useState<MenuView>('main');
    const [durationMinutes, setDurationMinutes] = useState(30);
    const [customHours, setCustomHours] = useState<string>('');
    const [customMinutes, setCustomMinutes] = useState<string>('');
    const [isCustomActive, setIsCustomActive] = useState(false);
    const [quickTitle, setQuickTitle] = useState('');
    const [customTitle, setCustomTitle] = useState('');
    const [scheduling, setScheduling] = useState(false);
    const [adjustedPosition, setAdjustedPosition] = useState(position);
    const [showEpgEditor, setShowEpgEditor] = useState(false);
    const [menuHidden, setMenuHidden] = useState(false);
    const { showSuccess, showError, showPrompt, showConfirm, showModal, ModalComponent } = useModal();

    // Group state
    const [customGroups, setCustomGroups] = useState<{ group_id: string; name: string }[]>([]);
    const [addingToGroup, setAddingToGroup] = useState<string | null>(null);

    // Failover group state
    const [failoverGroups, setFailoverGroups] = useState<{ group_id: string; name: string }[]>([]);
    const [addingToFailoverGroup, setAddingToFailoverGroup] = useState<string | null>(null);
    const [creatingFailoverGroup, setCreatingFailoverGroup] = useState(false);
    const [newFailoverGroupName, setNewFailoverGroupName] = useState('');
    const failoverNameInputRef = useRef<HTMLInputElement>(null);

    // Submenu group search filters
    const [customGroupSearch, setCustomGroupSearch] = useState('');
    const [failoverGroupSearch, setFailoverGroupSearch] = useState('');

    // Reset submenu searches when leaving their views
    useEffect(() => {
        if (currentView !== 'group') setCustomGroupSearch('');
        if (currentView !== 'failover') setFailoverGroupSearch('');
    }, [currentView]);

    // Shared style for the group-submenu search inputs
    const groupSearchInputStyle: CSSProperties = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 8px',
        borderRadius: '4px',
        border: '1px solid rgba(255,255,255,0.2)',
        background: 'rgba(0,0,0,0.3)',
        color: 'var(--text-primary, #fff)',
        fontSize: '0.85rem',
        fontFamily: 'inherit',
        outline: 'none',
    };

    // Custom date/time state
    const now = new Date();
    const defaultEnd = new Date(now.getTime() + 30 * 60 * 1000);
    const [startDate, setStartDate] = useState(formatDateForInput(now));
    const [startTime, setStartTime] = useState(formatTimeForInput(now));
    const [endDate, setEndDate] = useState(formatDateForInput(defaultEnd));
    const [endTime, setEndTime] = useState(formatTimeForInput(defaultEnd));
    const [recurrence, setRecurrence] = useState('once');
    const [recurrenceDays, setRecurrenceDays] = useState(3);

    // Load custom groups when the user opens the group submenu
    useEffect(() => {
        if (currentView !== 'group') return;
        let isMounted = true;
        db.customGroups.toArray().then(groups => {
            if (isMounted) setCustomGroups(groups.sort((a, b) => a.name.localeCompare(b.name)));
        }).catch(() => {
            if (isMounted) setCustomGroups([]);
        });
        return () => { isMounted = false; };
    }, [currentView]);

    // Load failover groups when the user opens the failover group submenu
    useEffect(() => {
        if (currentView !== 'failover') return;
        let isMounted = true;
        db.failoverGroups.toArray().then(groups => {
            if (isMounted) setFailoverGroups(groups.sort((a, b) => a.name.localeCompare(b.name)));
        }).catch(() => {
            if (isMounted) setFailoverGroups([]);
        });
        return () => { isMounted = false; };
    }, [currentView]);

    // Adjust position to keep menu within viewport
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

            if (isBottomHalf) {
                // If bottom half, menu pops UP (bottom left is at cursor)
                y = position.y - menuHeight;
            }

            if (x + menuWidth > viewportWidth) x = viewportWidth - menuWidth - 10;
            if (x < 10) x = 10;

            // Safety bounds for Y-axis
            if (y + menuHeight > viewportHeight) y = viewportHeight - menuHeight - 10;
            if (y < 10) y = 10;

            setAdjustedPosition({ x, y });
        }
    }, [position, currentView, customGroups, failoverGroups, creatingFailoverGroup, scheduling]);

    const getMenuStyle = (extra: React.CSSProperties = {}): React.CSSProperties => ({
        left: `${adjustedPosition.x}px`,
        top: `${adjustedPosition.y}px`,
        display: menuHidden ? 'none' : undefined,
        ...extra,
    });

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

    async function handleCopyStreamUrl() {
        try {
            let streamUrl = channel.direct_url || '';

            // Resolve the stream URL (crucial for Stalker channels, etc.)
            if (channel.source_id) {
                try {
                    const { resolvePlayUrl } = await import('../services/stream-resolver');
                    const resolved = await resolvePlayUrl(channel.source_id, streamUrl);
                    streamUrl = resolved.url;
                } catch (e) {
                    console.error('[ChannelContextMenu] Failed to resolve stream URL:', e);
                }
            }

            // If it's an Xtream source and direct_url isn't already a full URL, we need to build it
            if (channel.source_id && window.storage && !streamUrl.startsWith('http')) {
                const sourceRes = await window.storage.getSource(channel.source_id);
                if (sourceRes.data?.type === 'xtream' && sourceRes.data.username && sourceRes.data.password) {
                    const baseUrl = sourceRes.data.url.replace(/\/+$/, '');
                    const rawStreamId = channel.stream_id.replace(`${channel.source_id}_`, '');
                    streamUrl = `${baseUrl}/live/${encodeURIComponent(sourceRes.data.username)}/${encodeURIComponent(sourceRes.data.password)}/${rawStreamId}.ts`;
                }
            }

            setMenuHidden(true);
            if (streamUrl) {
                await navigator.clipboard.writeText(streamUrl);
                showModal({
                    title: i18n.t('contextMenu.copied'),
                    message: i18n.t('contextMenu.streamUrlCopied'),
                    type: 'success',
                    confirmText: 'OK',
                    onConfirm: () => onClose(),
                    onCancel: () => onClose(),
                });
            } else {
                showModal({
                    title: i18n.t('contextMenu.error'),
                    message: i18n.t('contextMenu.couldNotResolveUrl'),
                    type: 'error',
                    confirmText: 'OK',
                    onConfirm: () => onClose(),
                    onCancel: () => onClose(),
                });
            }
        } catch (e: any) {
            console.error('Failed to copy stream URL:', e);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.error'),
                message: e?.message || i18n.t('contextMenu.failedCopyUrl'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        }
    }

    async function createRecording(
        startTimestamp: number,
        endTimestamp: number,
        title: string,
        recurrence?: string,
        startPadding?: number,
        endPadding?: number
    ) {
        let resolvedUrl: string | undefined;

        if (channel.direct_url?.startsWith('stalker_')) {
            if (!window.storage) throw new Error('Storage API not available');
            const sourceRes = await window.storage.getSource(channel.source_id);
            if (sourceRes.data?.type === 'stalker' && sourceRes.data.mac) {
                const client = new StalkerClient({
                    baseUrl: sourceRes.data.url,
                    mac: sourceRes.data.mac,
                    userAgent: sourceRes.data.user_agent
                }, channel.source_id);
                resolvedUrl = await client.resolveStreamUrl(channel.direct_url);
            }
        }

        const schedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'> = {
            source_id: channel.source_id,
            channel_id: channel.stream_id,
            channel_name: channel.name,
            program_title: title,
            scheduled_start: startTimestamp,
            scheduled_end: endTimestamp,
            start_padding_sec: startPadding ?? 0,
            end_padding_sec: endPadding ?? 0,
            series_match_title: undefined,
            recurrence: recurrence,
            stream_url: resolvedUrl,
        };

        const conflictResult = await detectScheduleConflicts(schedule);
        if (conflictResult.hasConflict) {
            const sourceMeta = await db.sourcesMeta.get(channel.source_id);
            const maxConnections = parseInt(sourceMeta?.max_connections || '1');
            const isViewingConflict = conflictResult.message?.toLowerCase().includes('watching this source');

            setMenuHidden(true);
            if (maxConnections === 1 && isViewingConflict) {
                showConfirm(
                    i18n.t('contextMenu.oneConnectionLimit'),
                    i18n.t('contextMenu.oneConnectionLimitMsg'),
                    async () => {
                        try {
                            setScheduling(true);
                            await scheduleRecording(schedule);
                            const durationMins = Math.round((endTimestamp - startTimestamp) / 60);
                            showModal({
                                title: i18n.t('contextMenu.recordingScheduled'),
                                message: i18n.t('contextMenu.scheduledForMinutes', { name: channel.name, count: durationMins }),
                                type: 'success',
                                confirmText: 'OK',
                                onConfirm: () => onClose(),
                                onCancel: () => onClose(),
                            });
                        } catch (err: any) {
                            showModal({
                                title: i18n.t('contextMenu.schedulingFailed'),
                                message: err?.message || i18n.t('contextMenu.failedScheduleRecording'),
                                type: 'error',
                                confirmText: 'OK',
                                onConfirm: () => onClose(),
                                onCancel: () => onClose(),
                            });
                        } finally {
                            setScheduling(false);
                        }
                    },
                    () => onClose(),
                    i18n.t('contextMenu.ignoreAndRecord'),
                    'OK'
                );
            } else {
                showModal({
                    title: i18n.t('contextMenu.schedulingConflict'),
                    message: conflictResult.message || i18n.t('contextMenu.programConflict'),
                    type: 'error',
                    confirmText: 'OK',
                    onConfirm: () => onClose(),
                    onCancel: () => onClose(),
                });
            }
            return;
        }

        await scheduleRecording(schedule);
        const durationMins = Math.round((endTimestamp - startTimestamp) / 60);
        setMenuHidden(true);
        showModal({
            title: i18n.t('contextMenu.recordingScheduled'),
            message: i18n.t('contextMenu.scheduledForMinutes', { name: channel.name, count: durationMins }),
            type: 'success',
            confirmText: 'OK',
            onConfirm: () => onClose(),
            onCancel: () => onClose(),
        });
    }

    const handleCustomHoursChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        if (val === '' || /^\d+$/.test(val)) {
            setCustomHours(val);
            setIsCustomActive(true);
        }
    };

    const handleCustomMinutesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        if (val === '' || /^\d+$/.test(val)) {
            setCustomMinutes(val);
            setIsCustomActive(true);
        }
    };

    async function handleConfirmQuickRecord() {
        setScheduling(true);
        try {
            const now = new Date();
            const startTimestamp = Math.floor(now.getTime() / 1000);
            const finalDuration = isCustomActive
                ? (parseInt(customHours) || 0) * 60 + (parseInt(customMinutes) || 0)
                : durationMinutes;
            const endTimestamp = startTimestamp + (finalDuration * 60);
            const titleToUse = quickTitle.trim() || i18n.t('contextMenu.quickRecordTitle', { name: channel.name });
            await createRecording(startTimestamp, endTimestamp, titleToUse);
        } catch (error: any) {
            console.error('Failed to schedule recording:', error);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.schedulingFailed'),
                message: error?.message || i18n.t('contextMenu.failedScheduleRecording'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } finally {
            setScheduling(false);
        }
    }

    async function handleConfirmCustomRecord() {
        setScheduling(true);
        try {
            const startDateTime = new Date(`${startDate}T${startTime}`);
            const endDateTime = new Date(`${endDate}T${endTime}`);

            if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
                setMenuHidden(true);
                showModal({
                    title: i18n.t('contextMenu.invalidInput'),
                    message: i18n.t('contextMenu.invalidDateTime'),
                    type: 'error',
                    confirmText: 'OK',
                    onConfirm: () => onClose(),
                    onCancel: () => onClose(),
                });
                return;
            }
            if (endDateTime <= startDateTime) {
                setMenuHidden(true);
                showModal({
                    title: i18n.t('contextMenu.invalidInput'),
                    message: i18n.t('contextMenu.endAfterStart'),
                    type: 'error',
                    confirmText: 'OK',
                    onConfirm: () => onClose(),
                    onCancel: () => onClose(),
                });
                return;
            }

            const startTimestamp = Math.floor(startDateTime.getTime() / 1000);
            const endTimestamp = Math.floor(endDateTime.getTime() / 1000);
            const finalRecurrence = recurrence === 'every' ? `every:${recurrenceDays}` : recurrence;

            // Load default paddings from settings
            const settings = await getDvrSettings();

            const titleToUse = customTitle.trim() || i18n.t('contextMenu.scheduledTitle', { name: channel.name });
            await createRecording(
                startTimestamp,
                endTimestamp,
                titleToUse,
                finalRecurrence !== 'once' ? finalRecurrence : undefined,
                settings.default_start_padding_sec,
                settings.default_end_padding_sec
            );
        } catch (error: any) {
            console.error('Failed to schedule recording:', error);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.schedulingFailed'),
                message: error?.message || i18n.t('contextMenu.failedScheduleRecording'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } finally {
            setScheduling(false);
        }
    }

    async function handleAddToGroup(groupId: string, groupName: string) {
        if (addingToGroup) return;
        setAddingToGroup(groupId);
        try {
            await addChannelsToGroup(groupId, [channel.stream_id]);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.addedToGroup'),
                message: i18n.t('contextMenu.addedToGroupMsg', { name: channel.name, group: groupName }),
                type: 'success',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } catch (e: any) {
            console.error('Failed to add channel to group:', e);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.failed'),
                message: e?.message || i18n.t('contextMenu.couldNotAddToGroup'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
            setAddingToGroup(null);
        }
    }

    async function handleAddToFailoverGroup(groupId: string, groupName: string) {
        if (addingToFailoverGroup) return;
        setAddingToFailoverGroup(groupId);
        try {
            await addChannelToFailoverGroup(groupId, channel.stream_id);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.addedToFailoverGroup'),
                message: i18n.t('contextMenu.addedToGroupMsg', { name: channel.name, group: groupName }),
                type: 'success',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } catch (e: any) {
            console.error('Failed to add channel to failover group:', e);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.failed'),
                message: e?.message || i18n.t('contextMenu.couldNotAddToFailover'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
            setAddingToFailoverGroup(null);
        }
    }

    async function handleCreateAndAddToFailoverGroup() {
        const trimmed = newFailoverGroupName.trim();
        if (!trimmed) return;
        try {
            const newGroupId = await createFailoverGroup(trimmed);
            await addChannelToFailoverGroup(newGroupId, channel.stream_id);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.createdAndAdded'),
                message: i18n.t('contextMenu.createdAndAddedMsg', { group: trimmed, name: channel.name }),
                type: 'success',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } catch (e: any) {
            console.error('Failed to create failover group:', e);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.failed'),
                message: e?.message || i18n.t('contextMenu.couldNotCreateFailover'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        }
    }

    async function handleHideChannel() {
        try {
            await db.channels.update(channel.stream_id, { enabled: false });
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.channelHidden'),
                message: i18n.t('contextMenu.channelHiddenMsg', { name: channel.name }),
                type: 'success',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } catch (e: any) {
            console.error('Failed to hide channel:', e);
            setMenuHidden(true);
            showModal({
                title: i18n.t('contextMenu.failed'),
                message: e?.message || i18n.t('contextMenu.couldNotHideChannel'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        }
    }

    function handleRenameChannel() {
        showPrompt(
            i18n.t('contextMenu.renameChannel'),
            i18n.t('contextMenu.renameChannelMsg'),
            async (newName) => {
                const trimmed = newName.trim();
                if (trimmed && trimmed !== (channel.alias || channel.name)) {
                    try {
                        await updateChannelAlias(channel.stream_id, trimmed);
                        setMenuHidden(true);
                        showModal({
                            title: i18n.t('contextMenu.channelRenamed'),
                            message: i18n.t('contextMenu.channelRenamedMsg', { name: channel.name, alias: trimmed }),
                            type: 'success',
                            confirmText: 'OK',
                            onConfirm: () => onClose(),
                            onCancel: () => onClose(),
                        });
                        return;
                    } catch (e: any) {
                        console.error('Failed to rename channel:', e);
                        setMenuHidden(true);
                        showModal({
                            title: i18n.t('contextMenu.failed'),
                            message: e?.message || i18n.t('contextMenu.couldNotRenameChannel'),
                            type: 'error',
                            confirmText: 'OK',
                            onConfirm: () => onClose(),
                            onCancel: () => onClose(),
                        });
                        return;
                    }
                }
                onClose();
            },
            () => onClose(),
            i18n.t('contextMenu.channelNamePlaceholder'),
            channel.alias || channel.name,
            i18n.t('contextMenu.rename'),
            i18n.t('common:cancel'),
            false
        );
    }

    const durationOptions = [5, 15, 30, 60, 90, 120, 180, 240];

    // ── ADD TO GROUP VIEW ──
    if (currentView === 'group') {
        return createPortal(
            <div
                ref={menuRef}
                className="program-context-menu"
                style={getMenuStyle({ minWidth: '200px' })}
            >
                <div className="context-menu-header">
                    {i18n.t('contextMenu.addToGroup')}
                </div>
                <div className="context-menu-separator" />
                <div style={{ padding: '6px 12px' }}>
                    <input
                        type="text"
                        placeholder={i18n.t('contextMenu.searchGroupsPlaceholder')}
                        value={customGroupSearch}
                        onChange={e => setCustomGroupSearch(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') setCustomGroupSearch(''); }}
                        style={groupSearchInputStyle}
                    />
                </div>
                <div className="context-menu-scrollable-container">
                    {customGroups.length === 0 && (
                        <div style={{ padding: '10px 16px', opacity: 0.5, fontSize: '0.85rem' }}>
                            {i18n.t('contextMenu.noCustomGroupsYet')}
                        </div>
                    )}
                    {customGroups.length > 0 && customGroups.filter(g =>
                        g.name.toLowerCase().includes(customGroupSearch.trim().toLowerCase())
                    ).length === 0 && (
                        <div style={{ padding: '10px 16px', opacity: 0.5, fontSize: '0.85rem' }}>
                            {i18n.t('contextMenu.noMatchingGroups')}
                        </div>
                    )}
                    {customGroups.filter(g =>
                        !customGroupSearch.trim() || g.name.toLowerCase().includes(customGroupSearch.trim().toLowerCase())
                    ).map(group => (
                        <div
                            key={group.group_id}
                            className="context-menu-item"
                            onClick={() => handleAddToGroup(group.group_id, group.name)}
                            style={{ opacity: addingToGroup === group.group_id ? 0.5 : 1 }}
                        >
                            {group.name}
                        </div>
                    ))}
                </div>
                <div className="context-menu-separator" />
                <div className="context-menu-item context-menu-item-secondary" onClick={() => setCurrentView('main')}>
                    ← {i18n.t('contextMenu.back')}
                </div>
                <ModalComponent />
            </div>,
            document.body
        );
    }

    // ── ADD TO FAILOVER GROUP VIEW ──
    if (currentView === 'failover') {
        return createPortal(
            <div
                ref={menuRef}
                className="program-context-menu"
                style={getMenuStyle({ minWidth: '200px' })}
            >
                <div className="context-menu-header">
                    {i18n.t('contextMenu.addToFailoverGroup')}
                </div>
                <div className="context-menu-separator" />
                <div style={{ padding: '6px 12px' }}>
                    <input
                        type="text"
                        placeholder={i18n.t('contextMenu.searchGroupsPlaceholder')}
                        value={failoverGroupSearch}
                        onChange={e => setFailoverGroupSearch(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') setFailoverGroupSearch(''); }}
                        style={groupSearchInputStyle}
                    />
                </div>
                <div className="context-menu-scrollable-container">
                    {!creatingFailoverGroup ? (
                        <div
                            className="context-menu-item"
                            onClick={() => {
                                setCreatingFailoverGroup(true);
                                setTimeout(() => failoverNameInputRef.current?.focus(), 50);
                            }}
                        >
                            {i18n.t('contextMenu.createNewFailoverGroup')}
                        </div>
                    ) : (
                        <div style={{ padding: '6px 12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <input
                                ref={failoverNameInputRef}
                                type="text"
                                placeholder={i18n.t('contextMenu.groupNamePlaceholder')}
                                value={newFailoverGroupName}
                                onChange={e => setNewFailoverGroupName(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') handleCreateAndAddToFailoverGroup();
                                    if (e.key === 'Escape') {
                                        setCreatingFailoverGroup(false);
                                        setNewFailoverGroupName('');
                                    }
                                }}
                                style={{
                                    flex: 1,
                                    padding: '5px 8px',
                                    borderRadius: '4px',
                                    border: '1px solid var(--accent-primary, #00d4ff)',
                                    background: 'rgba(0,0,0,0.3)',
                                    color: 'var(--text-primary, #fff)',
                                    fontSize: '0.85rem',
                                    fontFamily: 'inherit',
                                    outline: 'none',
                                }}
                            />
                            <button
                                onClick={handleCreateAndAddToFailoverGroup}
                                style={{
                                    padding: '5px 10px',
                                    borderRadius: '4px',
                                    border: 'none',
                                    background: 'var(--accent-primary, #00d4ff)',
                                    color: '#000',
                                    fontWeight: 600,
                                    fontSize: '0.8rem',
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                }}
                            >
                                {i18n.t('common:create')}
                            </button>
                            <button
                                onClick={() => { setCreatingFailoverGroup(false); setNewFailoverGroupName(''); }}
                                style={{
                                    padding: '5px 10px',
                                    borderRadius: '4px',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    background: 'rgba(255,255,255,0.06)',
                                    color: 'rgba(255,255,255,0.7)',
                                    fontSize: '0.8rem',
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                }}
                            >
                                {i18n.t('common:cancel')}
                            </button>
                        </div>
                    )}
                    <div className="context-menu-separator" />
                    {failoverGroups.length === 0 && !creatingFailoverGroup && (
                        <div style={{ padding: '10px 16px', opacity: 0.5, fontSize: '0.85rem' }}>
                            {i18n.t('contextMenu.noFailoverGroupsYet')}
                        </div>
                    )}
                    {failoverGroups.length > 0 && !creatingFailoverGroup && failoverGroups.filter(g =>
                        g.name.toLowerCase().includes(failoverGroupSearch.trim().toLowerCase())
                    ).length === 0 && (
                        <div style={{ padding: '10px 16px', opacity: 0.5, fontSize: '0.85rem' }}>
                            {i18n.t('contextMenu.noMatchingGroups')}
                        </div>
                    )}
                    {failoverGroups.filter(g =>
                        !failoverGroupSearch.trim() || g.name.toLowerCase().includes(failoverGroupSearch.trim().toLowerCase())
                    ).map(group => (
                        <div
                            key={group.group_id}
                            className="context-menu-item"
                            onClick={() => handleAddToFailoverGroup(group.group_id, group.name)}
                            style={{ opacity: addingToFailoverGroup === group.group_id ? 0.5 : 1 }}
                        >
                            {group.name}
                        </div>
                    ))}
                </div>
                <div className="context-menu-separator" />
                <div className="context-menu-item context-menu-item-secondary" onClick={() => setCurrentView('main')}>
                    ← {i18n.t('contextMenu.back')}
                </div>
                <ModalComponent />
            </div>,
            document.body
        );
    }

    // ── QUICK RECORD VIEW ──
    if (currentView === 'quick') {
        const finalDuration = isCustomActive
            ? (parseInt(customHours) || 0) * 60 + (parseInt(customMinutes) || 0)
            : durationMinutes;
        const isRecordDisabled = scheduling || (isCustomActive && finalDuration <= 0);

        return createPortal(
            <div
                ref={menuRef}
                className="program-context-menu"
                style={getMenuStyle({ minWidth: '220px' })}
            >
                <div className="context-menu-header">
                    {i18n.t('contextMenu.quickRecord', { name: channel.name })}
                </div>
                <div className="context-menu-separator" />
                <div className="custom-duration-section" style={{ paddingBottom: '4px' }}>
                    <div className="custom-duration-label">{i18n.t('contextMenu.recordingTitle')}</div>
                    <input
                        type="text"
                        value={quickTitle !== '' ? quickTitle : i18n.t('contextMenu.quickRecordTitle', { name: channel.name })}
                        onChange={(e) => setQuickTitle(e.target.value)}
                        className="datetime-input"
                        style={{ width: '100%', marginTop: '4px' }}
                        placeholder={i18n.t('contextMenu.quickRecordTitle', { name: channel.name })}
                    />
                </div>
                <div className="context-menu-separator" />
                <div className="duration-options">
                    {durationOptions.map((mins) => (
                        <button
                            key={mins}
                            className={`duration-option ${(!isCustomActive && durationMinutes === mins) ? 'selected' : ''}`}
                            onClick={() => {
                                setDurationMinutes(mins);
                                setIsCustomActive(false);
                                setCustomHours('');
                                setCustomMinutes('');
                            }}
                        >
                            {mins < 60 ? i18n.t('contextMenu.min', { count: mins }) : i18n.t('contextMenu.hour', { count: mins / 60 })}
                        </button>
                    ))}
                </div>
                <div className="context-menu-separator" />
                <div className="custom-duration-section">
                    <div className="custom-duration-label">{i18n.t('contextMenu.customDuration')}</div>
                    <div className="custom-duration-inputs">
                        <div className="custom-input-group">
                            <input
                                type="number"
                                min="0"
                                placeholder="0"
                                value={customHours}
                                onChange={handleCustomHoursChange}
                                className="custom-duration-input"
                            />
                            <span>{i18n.t('contextMenu.hrShort')}</span>
                        </div>
                        <div className="custom-input-group">
                            <input
                                type="number"
                                min="0"
                                max="59"
                                placeholder="0"
                                value={customMinutes}
                                onChange={handleCustomMinutesChange}
                                className="custom-duration-input"
                            />
                            <span>{i18n.t('contextMenu.minShort')}</span>
                        </div>
                    </div>
                </div>
                <div className="context-menu-separator" />
                <div className="context-menu-actions">
                    <button
                        className="context-menu-btn context-menu-btn-primary"
                        onClick={handleConfirmQuickRecord}
                        disabled={isRecordDisabled}
                    >
                        {scheduling ? i18n.t('contextMenu.starting') : i18n.t('contextMenu.recordDuration', { duration: formatDuration(finalDuration) })}
                    </button>
                    <button className="context-menu-btn context-menu-btn-secondary" onClick={onClose} disabled={scheduling}>
                        {i18n.t('common:cancel')}
                    </button>
                </div>
                <ModalComponent />
            </div>,
            document.body
        );
    }

    // ── CUSTOM RECORD VIEW ──
    if (currentView === 'custom') {
        return createPortal(
            <div
                ref={menuRef}
                className="program-context-menu"
                style={getMenuStyle({ minWidth: '260px' })}
            >
                <div className="context-menu-header">{i18n.t('contextMenu.scheduleRecording')}</div>
                <div className="context-menu-separator" />

                <div className="datetime-section">
                    <label className="datetime-label">{i18n.t('contextMenu.title')}</label>
                    <input
                        type="text"
                        value={customTitle !== '' ? customTitle : i18n.t('contextMenu.scheduledTitle', { name: channel.name })}
                        onChange={(e) => setCustomTitle(e.target.value)}
                        className="datetime-input"
                        style={{ width: '100%' }}
                        placeholder={i18n.t('contextMenu.scheduledTitle', { name: channel.name })}
                    />
                </div>

                <div className="datetime-section">
                    <label className="datetime-label">{i18n.t('contextMenu.start')}</label>
                    <div className="datetime-inputs">
                        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="datetime-input" />
                        {epgClockFormat === '24h' ? (
                            <div className="time-24h-picker" style={{ display: 'flex', gap: '4px', alignItems: 'center', flex: 1 }}>
                                <select
                                    value={startTime.split(':')[0] || '00'}
                                    onChange={(e) => {
                                        const mins = startTime.split(':')[1] || '00';
                                        setStartTime(`${e.target.value}:${mins}`);
                                    }}
                                    className="datetime-input"
                                    style={{ flex: 1, padding: '8px 4px', textAlign: 'center' }}
                                >
                                    {Array.from({ length: 24 }, (_, i) => {
                                        const h = i.toString().padStart(2, '0');
                                        return <option key={h} value={h}>{h}</option>;
                                    })}
                                </select>
                                <span style={{ color: 'var(--text-secondary, #888)', fontWeight: 'bold' }}>:</span>
                                <select
                                    value={startTime.split(':')[1] || '00'}
                                    onChange={(e) => {
                                        const hrs = startTime.split(':')[0] || '00';
                                        setStartTime(`${hrs}:${e.target.value}`);
                                    }}
                                    className="datetime-input"
                                    style={{ flex: 1, padding: '8px 4px', textAlign: 'center' }}
                                >
                                    {Array.from({ length: 60 }, (_, i) => {
                                        const m = i.toString().padStart(2, '0');
                                        return <option key={m} value={m}>{m}</option>;
                                    })}
                                </select>
                            </div>
                        ) : (
                            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="datetime-input" />
                        )}
                    </div>
                </div>

                <div className="datetime-section">
                    <label className="datetime-label">{i18n.t('contextMenu.end')}</label>
                    <div className="datetime-inputs">
                        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="datetime-input" />
                        {epgClockFormat === '24h' ? (
                            <div className="time-24h-picker" style={{ display: 'flex', gap: '4px', alignItems: 'center', flex: 1 }}>
                                <select
                                    value={endTime.split(':')[0] || '00'}
                                    onChange={(e) => {
                                        const mins = endTime.split(':')[1] || '00';
                                        setEndTime(`${e.target.value}:${mins}`);
                                    }}
                                    className="datetime-input"
                                    style={{ flex: 1, padding: '8px 4px', textAlign: 'center' }}
                                >
                                    {Array.from({ length: 24 }, (_, i) => {
                                        const h = i.toString().padStart(2, '0');
                                        return <option key={h} value={h}>{h}</option>;
                                    })}
                                </select>
                                <span style={{ color: 'var(--text-secondary, #888)', fontWeight: 'bold' }}>:</span>
                                <select
                                    value={endTime.split(':')[1] || '00'}
                                    onChange={(e) => {
                                        const hrs = endTime.split(':')[0] || '00';
                                        setEndTime(`${hrs}:${e.target.value}`);
                                    }}
                                    className="datetime-input"
                                    style={{ flex: 1, padding: '8px 4px', textAlign: 'center' }}
                                >
                                    {Array.from({ length: 60 }, (_, i) => {
                                        const m = i.toString().padStart(2, '0');
                                        return <option key={m} value={m}>{m}</option>;
                                    })}
                                </select>
                            </div>
                        ) : (
                            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="datetime-input" />
                        )}
                    </div>
                </div>

                <div className="datetime-section">
                    <label className="datetime-label">{i18n.t('contextMenu.recurrence')}</label>
                    <select
                        value={recurrence}
                        onChange={(e) => setRecurrence(e.target.value)}
                        className="datetime-input"
                        style={{ width: '100%', background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '4px' }}
                    >
                        <option value="once">{i18n.t('contextMenu.once')}</option>
                        <option value="daily">{i18n.t('contextMenu.daily')}</option>
                        <option value="weekly">{i18n.t('contextMenu.weekly')}</option>
                        <option value="every">{i18n.t('contextMenu.everyXDays')}</option>
                    </select>
                </div>

                {recurrence === 'every' && (
                    <div className="datetime-section">
                        <label className="datetime-label">{i18n.t('contextMenu.days')}</label>
                        <input
                            type="number"
                            min="1"
                            value={recurrenceDays}
                            onChange={(e) => setRecurrenceDays(Math.max(1, parseInt(e.target.value) || 1))}
                            className="datetime-input"
                            style={{ width: '100%' }}
                        />
                    </div>
                )}

                <div className="context-menu-separator" />
                <div className="context-menu-actions">
                    <button
                        className="context-menu-btn context-menu-btn-primary"
                        onClick={handleConfirmCustomRecord}
                        disabled={scheduling}
                    >
                        {scheduling ? i18n.t('contextMenu.scheduling') : i18n.t('contextMenu.schedule')}
                    </button>
                    <button className="context-menu-btn context-menu-btn-secondary" onClick={onClose} disabled={scheduling}>
                        {i18n.t('common:cancel')}
                    </button>
                </div>
                <ModalComponent />
            </div>,
            document.body
        );
    }

    // ── MAIN MENU VIEW ──
    // Determine which secondary slots are available based on the current layout
    const viewerSlots: Array<2 | 3 | 4> = (() => {
        if (!onSendToSlot || !currentLayout || currentLayout === 'main') return [];
        if (currentLayout === 'pip' || currentLayout === 'sbs') return [2];
        return [2, 3, 4]; // 2x2 and bigbottom have 3 secondary slots
    })();

    const handleSendToSlot = async (slotId: 2 | 3 | 4) => {
        if (!onSendToSlot) return;
        let url = channel.direct_url ?? '';

        // Resolve the stream URL (crucial for Stalker channels)
        if (channel.source_id) {
            try {
                const { resolvePlayUrl } = await import('../services/stream-resolver');
                const resolved = await resolvePlayUrl(channel.source_id, url);
                url = resolved.url;
            } catch (e) {
                console.error('[ChannelContextMenu] Failed to resolve multiview URL:', e);
            }
        }

        // Look up source name
        let sourceName: string | null = null;
        if (channel.source_id && window.storage) {
            const result = await window.storage.getSource(channel.source_id);
            if (result.data) {
                sourceName = result.data.name;
            }
        }
        onSendToSlot(slotId, channel.name, url, sourceName);
        addToRecentChannels(channel);
        onClose();
    };

    // ── EPG Editor: render OUTSIDE the context menu portal.
    // The menu's mousedown-outside listener would otherwise fire on any modal
    // tab click (since the modal portal is outside menuRef) and close everything.
    if (showEpgEditor) {
        return (
            <EpgEditorModal
                channel={channel}
                onClose={() => { setShowEpgEditor(false); onClose(); }}
            />
        );
    }

    return createPortal(
        <div
            ref={menuRef}
            className="program-context-menu"
            style={getMenuStyle()}
        >
            {/* Send to Viewer - only shown when a multiview layout is active */}
            {viewerSlots.length > 0 && (
                <>
                    {viewerSlots.map(slotId => (
                        <div
                            key={slotId}
                            className="context-menu-item"
                            onClick={() => handleSendToSlot(slotId)}
                        >
                            {i18n.t('contextMenu.sendToViewer', { slot: slotId })}
                        </div>
                    ))}
                    <div className="context-menu-separator" />
                </>
            )}
            {/* Play in Popout */}
            {onPlayInPopout && (
                <>
                    <div
                        className="context-menu-item"
                        onClick={() => {
                            onPlayInPopout(channel);
                            onClose();
                        }}
                    >
                        {i18n.t('contextMenu.playInPopout')}
                    </div>
                    <div className="context-menu-separator" />
                </>
            )}
            {onPlayInExternal && (
                <>
                    <div
                        className="context-menu-item"
                        onClick={() => {
                            onPlayInExternal(channel);
                            onClose();
                        }}
                    >
                        {i18n.t('contextMenu.sendToExternalPlayer')}
                    </div>
                    <div className="context-menu-separator" />
                </>
            )}
            <div className="context-menu-item" onClick={() => setCurrentView('custom')}>
                {i18n.t('contextMenu.recordEllipsis')}
            </div>
            <div className="context-menu-item" onClick={() => setCurrentView('quick')}>
                {i18n.t('contextMenu.quickRecordLabel')}
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={() => setCurrentView('group')}>
                {i18n.t('contextMenu.addToGroup')} →
            </div>
            <div className="context-menu-item" onClick={() => setCurrentView('failover')}>
                {i18n.t('contextMenu.addToFailoverGroup')} →
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={handleCopyStreamUrl}>
                {i18n.t('contextMenu.copyStreamUrl')}
            </div>
            <div className="context-menu-item" onClick={() => { setShowEpgEditor(true); }}>
                {i18n.t('contextMenu.editEpg')}
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={handleRenameChannel}>
                {i18n.t('contextMenu.renameChannel')}
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={handleHideChannel}>
                {i18n.t('contextMenu.hideChannel')}
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item context-menu-item-secondary" onClick={onClose}>
                {i18n.t('common:cancel')}
            </div>
            <ModalComponent />
        </div>,
        document.body
    );
}

