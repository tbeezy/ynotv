import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { scheduleRecording, detectScheduleConflicts, addToWatchlist, db, type DvrSchedule } from '../db';
import type { StoredProgram, WatchlistOptions } from '../db';
import { StalkerClient } from '@ynotv/local-adapter';
import { useModal } from './Modal';
import { WatchlistOptionsModal } from './WatchlistOptionsModal';
import './ProgramContextMenu.css';

interface ProgramContextMenuProps {
    program: StoredProgram;
    sourceId: string;
    channelId: string;
    channelName: string;
    position: { x: number; y: number };
    onClose: () => void;
}

export function ProgramContextMenu({
    program,
    sourceId,
    channelId,
    channelName,
    position,
    onClose,
}: ProgramContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [scheduling, setScheduling] = useState(false);
    const [addingToWatchlist, setAddingToWatchlist] = useState(false);
    const [showWatchlistModal, setShowWatchlistModal] = useState(false);
    const [channelForWatchlist, setChannelForWatchlist] = useState<import('../db').StoredChannel | null>(null);
    const [adjustedPosition, setAdjustedPosition] = useState(position);
    const { showSuccess, showError, showInfo, ModalComponent } = useModal();

    // Adjust position to keep menu within viewport
    useLayoutEffect(() => {
        if (menuRef.current) {
            const menu = menuRef.current;
            const rect = menu.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let x = position.x;
            let y = position.y;

            // Prevent menu from going off right edge
            if (x + rect.width > viewportWidth) {
                x = viewportWidth - rect.width - 10;
            }

            // Prevent menu from going off bottom edge
            if (y + rect.height > viewportHeight) {
                y = viewportHeight - rect.height - 10;
            }

            // Prevent menu from going off left edge
            if (x < 10) {
                x = 10;
            }

            // Prevent menu from going off top edge
            if (y < 10) {
                y = 10;
            }

            setAdjustedPosition({ x, y });
        }
    }, [position]);

    // Close on click outside (but not when modal is open)
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (showWatchlistModal) return; // Don't close if modal is open
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        }

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose, showWatchlistModal]);

    // Close on escape (but not when modal is open)
    useEffect(() => {
        function handleEscape(e: KeyboardEvent) {
            if (showWatchlistModal) return; // Don't close if modal is open
            if (e.key === 'Escape') {
                onClose();
            }
        }

        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [onClose, showWatchlistModal]);

    async function handleAddToWatchlistClick() {
        const channel = await db.channels.get(channelId);
        if (channel) {
            setChannelForWatchlist(channel);
            setShowWatchlistModal(true);
        } else {
            showError('Error', 'Channel not found');
            onClose();
        }
    }

    async function handleWatchlistConfirm(options: WatchlistOptions) {
        setShowWatchlistModal(false);
        setAddingToWatchlist(true);

        try {
            if (!channelForWatchlist) {
                showError('Error', 'Channel not found');
                onClose();
                return;
            }

            const added = await addToWatchlist(program, channelForWatchlist, options);
            if (added) {
                const reminderText = options.reminder_enabled
                    ? options.reminder_minutes > 0
                        ? ` (Reminder: ${options.reminder_minutes} min before)`
                        : ' (Reminder at start time)'
                    : '';
                showSuccess('Added to Watchlist', `${program.title}${reminderText}`);
            } else {
                showInfo('Already in Watchlist', `${program.title} is already in your watchlist`);
            }
            onClose();
        } catch (error: any) {
            console.error('Failed to add to watchlist:', error);
            showError('Failed to Add', error?.message || 'Failed to add to watchlist');
        } finally {
            setAddingToWatchlist(false);
        }
    }

    async function handleScheduleRecording() {
        setScheduling(true);

        try {
            const startTime = program.start instanceof Date ? program.start : new Date(program.start);
            const endTime = program.end instanceof Date ? program.end : new Date(program.end);

            // Get channel info to check if we need URL resolution
            const channel = await db.channels.get(channelId);
            let resolvedUrl: string | undefined;

            // For Stalker sources, resolve the URL before scheduling
            if (channel?.direct_url?.startsWith('stalker_')) {
                if (!window.storage) {
                    throw new Error('Storage API not available');
                }

                const sourceRes = await window.storage.getSource(sourceId);
                if (sourceRes.data?.type === 'stalker' && sourceRes.data.mac) {
                    const client = new StalkerClient({
                        baseUrl: sourceRes.data.url,
                        mac: sourceRes.data.mac,
                        userAgent: sourceRes.data.user_agent
                    }, sourceId);

                    resolvedUrl = await client.resolveStreamUrl(channel.direct_url);
                    console.log('[ProgramContextMenu] Resolved Stalker URL:', resolvedUrl);
                }
            }

            const schedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'> = {
                source_id: sourceId,
                channel_id: channelId,
                channel_name: channelName,
                program_title: program.title,
                scheduled_start: Math.floor(startTime.getTime() / 1000),
                scheduled_end: Math.floor(endTime.getTime() / 1000),
                start_padding_sec: 60,
                end_padding_sec: 300,
                series_match_title: undefined,
                recurrence: undefined,
                stream_url: resolvedUrl,
            };

            // Check for conflicts
            const conflictResult = await detectScheduleConflicts(schedule);
            if (conflictResult.hasConflict) {
                showError('Scheduling Conflict', conflictResult.message || 'This program conflicts with an existing recording.');
                onClose();
                return;
            }

            // Schedule the recording
            await scheduleRecording(schedule);
            showSuccess('Recording Scheduled', `${program.title} has been scheduled`);
            onClose();
        } catch (error: any) {
            console.error('Failed to schedule recording:', error);
            showError('Scheduling Failed', error?.message || 'Failed to schedule recording');
        } finally {
            setScheduling(false);
        }
    }

    return (
        <>
            <div
                ref={menuRef}
                className="program-context-menu"
                style={{
                    left: `${adjustedPosition.x}px`,
                    top: `${adjustedPosition.y}px`,
                }}
            >
                <div className="context-menu-item" onClick={handleScheduleRecording}>
                    {scheduling ? '⏳ Scheduling...' : '📹 Schedule Recording'}
                </div>
                <div className="context-menu-item" onClick={handleAddToWatchlistClick}>
                    {addingToWatchlist ? '⏳ Adding...' : '⭐ Add to Watchlist'}
                </div>
                <div className="context-menu-separator" />
                <div className="context-menu-item context-menu-item-secondary" onClick={onClose}>
                    Cancel
                </div>
                <ModalComponent />
            </div>
            <WatchlistOptionsModal
                isOpen={showWatchlistModal}
                program={program}
                channel={channelForWatchlist}
                onConfirm={handleWatchlistConfirm}
                onCancel={() => setShowWatchlistModal(false)}
            />
        </>
    );
}
