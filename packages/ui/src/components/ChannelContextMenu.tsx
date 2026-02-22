import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { scheduleRecording, detectScheduleConflicts, type DvrSchedule, db } from '../db';
import type { StoredChannel } from '../db';
import { StalkerClient } from '@ynotv/local-adapter';
import { useModal } from './Modal';
import { addChannelsToGroup } from '../services/custom-groups';
import { addToRecentChannels } from '../utils/recentChannels';
import './ProgramContextMenu.css'; // Reuse the same styles

type MenuView = 'main' | 'quick' | 'custom' | 'group';

interface ChannelContextMenuProps {
    channel: StoredChannel;
    position: { x: number; y: number };
    onClose: () => void;
    // Multiview props
    currentLayout?: string;
    onSendToSlot?: (slotId: 2 | 3 | 4, channelName: string, channelUrl: string) => void;
}

// Helper to format date for datetime-local input
function formatDateForInput(date: Date): string {
    return date.toISOString().split('T')[0];
}

function formatTimeForInput(date: Date): string {
    return date.toTimeString().slice(0, 5);
}

export function ChannelContextMenu({
    channel,
    position,
    onClose,
    currentLayout,
    onSendToSlot,
}: ChannelContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [currentView, setCurrentView] = useState<MenuView>('main');
    const [durationMinutes, setDurationMinutes] = useState(30);
    const [scheduling, setScheduling] = useState(false);
    const [adjustedPosition, setAdjustedPosition] = useState(position);
    const { showSuccess, showError, ModalComponent } = useModal();

    // Group state
    const [customGroups, setCustomGroups] = useState<{ group_id: string; name: string }[]>([]);
    const [addingToGroup, setAddingToGroup] = useState<string | null>(null);

    // Custom date/time state
    const now = new Date();
    const defaultEnd = new Date(now.getTime() + 30 * 60 * 1000);
    const [startDate, setStartDate] = useState(formatDateForInput(now));
    const [startTime, setStartTime] = useState(formatTimeForInput(now));
    const [endDate, setEndDate] = useState(formatDateForInput(defaultEnd));
    const [endTime, setEndTime] = useState(formatTimeForInput(defaultEnd));

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

    // Adjust position to keep menu within viewport
    useLayoutEffect(() => {
        if (menuRef.current) {
            const menu = menuRef.current;
            const rect = menu.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let x = position.x;
            let y = position.y;

            // Determine if click was in top or bottom half of the screen
            const isBottomHalf = position.y > viewportHeight / 2;

            if (isBottomHalf) {
                // If bottom half, menu pops UP (bottom left is at cursor)
                y = position.y - rect.height;
            }

            if (x + rect.width > viewportWidth) x = viewportWidth - rect.width - 10;
            if (x < 10) x = 10;

            // Safety bounds for Y-axis
            if (y + rect.height > viewportHeight) y = viewportHeight - rect.height - 10;
            if (y < 10) y = 10;

            setAdjustedPosition({ x, y });
        }
    }, [position, currentView]);

    // Close on click outside
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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

    async function createRecording(startTimestamp: number, endTimestamp: number, title: string) {
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
            start_padding_sec: 0,
            end_padding_sec: 0,
            series_match_title: undefined,
            recurrence: undefined,
            stream_url: resolvedUrl,
        };

        const conflictResult = await detectScheduleConflicts(schedule);
        if (conflictResult.hasConflict) {
            showError('Scheduling Conflict', conflictResult.message || 'This program conflicts with an existing recording.');
            return;
        }

        await scheduleRecording(schedule);
        const durationMins = Math.round((endTimestamp - startTimestamp) / 60);
        showSuccess('Recording Scheduled', `${channel.name} scheduled for ${durationMins} minutes`);
        onClose();
    }

    async function handleConfirmQuickRecord() {
        setScheduling(true);
        try {
            const now = new Date();
            const startTimestamp = Math.floor(now.getTime() / 1000);
            const endTimestamp = startTimestamp + (durationMinutes * 60);
            await createRecording(startTimestamp, endTimestamp, `${channel.name} - Quick Record`);
        } catch (error: any) {
            console.error('Failed to schedule recording:', error);
            showError('Scheduling Failed', error?.message || 'Failed to schedule recording');
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
                showError('Invalid Input', 'Invalid date/time selected');
                return;
            }
            if (endDateTime <= startDateTime) {
                showError('Invalid Input', 'End time must be after start time');
                return;
            }

            const startTimestamp = Math.floor(startDateTime.getTime() / 1000);
            const endTimestamp = Math.floor(endDateTime.getTime() / 1000);
            await createRecording(startTimestamp, endTimestamp, `${channel.name} - Scheduled`);
        } catch (error: any) {
            console.error('Failed to schedule recording:', error);
            showError('Scheduling Failed', error?.message || 'Failed to schedule recording');
        } finally {
            setScheduling(false);
        }
    }

    async function handleAddToGroup(groupId: string, groupName: string) {
        if (addingToGroup) return;
        setAddingToGroup(groupId);
        try {
            await addChannelsToGroup(groupId, [channel.stream_id]);
            showSuccess('Added to Group', `${channel.name} added to "${groupName}"`);
            onClose();
        } catch (e: any) {
            console.error('Failed to add channel to group:', e);
            showError('Failed', e?.message || 'Could not add channel to group');
            setAddingToGroup(null);
        }
    }

    const durationOptions = [5, 15, 30, 60, 90, 120, 180, 240];

    // ── ADD TO GROUP VIEW ──
    if (currentView === 'group') {
        return createPortal(
            <div
                ref={menuRef}
                className="program-context-menu"
                style={{ left: `${adjustedPosition.x}px`, top: `${adjustedPosition.y}px`, minWidth: '200px' }}
            >
                <div className="context-menu-header">
                    Add to Group
                </div>
                <div className="context-menu-separator" />
                {customGroups.length === 0 && (
                    <div style={{ padding: '10px 16px', opacity: 0.5, fontSize: '0.85rem' }}>
                        No custom groups yet
                    </div>
                )}
                {customGroups.map(group => (
                    <div
                        key={group.group_id}
                        className="context-menu-item"
                        onClick={() => handleAddToGroup(group.group_id, group.name)}
                        style={{ opacity: addingToGroup === group.group_id ? 0.5 : 1 }}
                    >
                        {addingToGroup === group.group_id ? '⏳' : '📋'} {group.name}
                    </div>
                ))}
                <div className="context-menu-separator" />
                <div className="context-menu-item context-menu-item-secondary" onClick={() => setCurrentView('main')}>
                    ← Back
                </div>
                <ModalComponent />
            </div>,
            document.body
        );
    }

    // ── QUICK RECORD VIEW ──
    if (currentView === 'quick') {
        return createPortal(
            <div
                ref={menuRef}
                className="program-context-menu"
                style={{ left: `${adjustedPosition.x}px`, top: `${adjustedPosition.y}px`, minWidth: '200px' }}
            >
                <div className="context-menu-header">
                    Quick Record {channel.name}
                </div>
                <div className="context-menu-separator" />
                <div className="duration-options">
                    {durationOptions.map((mins) => (
                        <button
                            key={mins}
                            className={`duration-option ${durationMinutes === mins ? 'selected' : ''}`}
                            onClick={() => setDurationMinutes(mins)}
                        >
                            {mins < 60 ? `${mins} min` : `${mins / 60} hour${mins > 60 ? 's' : ''}`}
                        </button>
                    ))}
                </div>
                <div className="context-menu-separator" />
                <div className="context-menu-actions">
                    <button
                        className="context-menu-btn context-menu-btn-primary"
                        onClick={handleConfirmQuickRecord}
                        disabled={scheduling}
                    >
                        {scheduling ? '⏳ Starting...' : `📹 Record ${durationMinutes} min`}
                    </button>
                    <button className="context-menu-btn context-menu-btn-secondary" onClick={onClose} disabled={scheduling}>
                        Cancel
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
                style={{ left: `${adjustedPosition.x}px`, top: `${adjustedPosition.y}px`, minWidth: '260px' }}
            >
                <div className="context-menu-header">Schedule Recording</div>
                <div className="context-menu-separator" />

                <div className="datetime-section">
                    <label className="datetime-label">Start</label>
                    <div className="datetime-inputs">
                        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="datetime-input" />
                        <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="datetime-input" />
                    </div>
                </div>

                <div className="datetime-section">
                    <label className="datetime-label">End</label>
                    <div className="datetime-inputs">
                        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="datetime-input" />
                        <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="datetime-input" />
                    </div>
                </div>

                <div className="context-menu-separator" />
                <div className="context-menu-actions">
                    <button
                        className="context-menu-btn context-menu-btn-primary"
                        onClick={handleConfirmCustomRecord}
                        disabled={scheduling}
                    >
                        {scheduling ? '⏳ Scheduling...' : '📹 Schedule'}
                    </button>
                    <button className="context-menu-btn context-menu-btn-secondary" onClick={onClose} disabled={scheduling}>
                        Cancel
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
        if (currentLayout === 'pip') return [2];
        return [2, 3, 4]; // 2x2 and bigbottom have 3 secondary slots
    })();

    const handleSendToSlot = async (slotId: 2 | 3 | 4) => {
        if (!onSendToSlot) return;
        // Resolve the stream URL (same logic as main player)
        const url = channel.direct_url ?? '';
        onSendToSlot(slotId, channel.name, url);
        addToRecentChannels(channel);
        onClose();
    };

    return createPortal(
        <div
            ref={menuRef}
            className="program-context-menu"
            style={{ left: `${adjustedPosition.x}px`, top: `${adjustedPosition.y}px` }}
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
                            📺 Send to Viewer {slotId}
                        </div>
                    ))}
                    <div className="context-menu-separator" />
                </>
            )}
            <div className="context-menu-item" onClick={() => setCurrentView('custom')}>
                📹 Record...
            </div>
            <div className="context-menu-item" onClick={() => setCurrentView('quick')}>
                ⚡ Quick Record
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item" onClick={() => setCurrentView('group')}>
                📋 Add to Group →
            </div>
            <div className="context-menu-separator" />
            <div className="context-menu-item context-menu-item-secondary" onClick={onClose}>
                Cancel
            </div>
            <ModalComponent />
        </div>,
        document.body
    );
}
