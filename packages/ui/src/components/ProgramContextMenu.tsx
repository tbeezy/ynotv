import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { scheduleRecording, detectScheduleConflicts, addToWatchlist, db, type DvrSchedule, getDvrSettings } from '../db';
import type { StoredProgram, WatchlistOptions } from '../db';
import { StalkerClient } from '@ynotv/local-adapter';
import { useModal } from './Modal';
import { WatchlistOptionsModal } from './WatchlistOptionsModal';
import { TVMazeSearchModal } from './TVMazeSearchModal';
import { DvrScheduleOptionsModal } from './DvrScheduleOptionsModal';
import { CatchupDownloadModal } from './CatchupDownloadModal';
import { useEpgClockFormat } from '../stores/uiStore';
import { useSettingsStore } from '../stores/settingsStore';
import { formatTime } from '../utils/dateTime';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../i18n';
import './ProgramContextMenu.css';

interface ProgramContextMenuProps {
    program: StoredProgram;
    sourceId: string;
    channelId: string;
    channelName: string;
    position: { x: number; y: number };
    onClose: () => void;
    isCatchupAvailable?: boolean;
}

export function ProgramContextMenu({
    program,
    sourceId,
    channelId,
    channelName,
    position,
    onClose,
    isCatchupAvailable = false,
}: ProgramContextMenuProps) {
    useTranslation();
    const epgClockFormat = useEpgClockFormat();
    const menuRef = useRef<HTMLDivElement>(null);
    const [scheduling, setScheduling] = useState(false);
    const [addingToWatchlist, setAddingToWatchlist] = useState(false);
    const [showOptionsModal, setShowOptionsModal] = useState(false);
    const [resolvedUrl, setResolvedUrl] = useState<string | undefined>(undefined);
    const [showWatchlistModal, setShowWatchlistModal] = useState(false);
    const [showTVMazeModal, setShowTVMazeModal] = useState(false);
    const [channelForWatchlist, setChannelForWatchlist] = useState<import('../db').StoredChannel | null>(null);
    const [adjustedPosition, setAdjustedPosition] = useState(position);
    const [menuHidden, setMenuHidden] = useState(false);
    const [defaultStartPadding, setDefaultStartPadding] = useState(60);
    const [defaultEndPadding, setDefaultEndPadding] = useState(300);
    // catchup paddings are settings-store fields — subscribe instead of paying
    // an IPC getSettings round-trip on every context-menu open.
    const catchupStartPadding = useSettingsStore((s) => s.catchupStartPadding);
    const catchupEndPadding = useSettingsStore((s) => s.catchupEndPadding);
    const [showDownloadModal, setShowDownloadModal] = useState(false);
    const [downloadingCatchup, setDownloadingCatchup] = useState(false);
    const { showSuccess, showError, showInfo, showConfirm, showModal, ModalComponent } = useModal();

    useEffect(() => {
        async function loadDefaults() {
            try {
                const settings = await getDvrSettings();
                setDefaultStartPadding(settings.default_start_padding_sec);
                setDefaultEndPadding(settings.default_end_padding_sec);
            } catch (e) {
                console.error('Failed to load settings:', e);
            }
        }
        loadDefaults();
    }, []);

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

            // Prevent menu from going off right edge
            if (x + menuWidth > viewportWidth) {
                x = viewportWidth - menuWidth - 10;
            }

            // Prevent menu from going off left edge
            if (x < 10) x = 10;

            // Safety bounds for Y-axis (in case menu is extremely tall)
            if (y + menuHeight > viewportHeight) y = viewportHeight - menuHeight - 10;
            if (y < 10) y = 10;

            setAdjustedPosition({ x, y });
        }
    }, [position]);

    // Close on click outside (but not when modal is open)
    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (showWatchlistModal) return; // Don't close if watchlist modal is open
            if (showTVMazeModal) return; // Don't close if TVMaze modal is open
            if (showOptionsModal) return; // Don't close if options modal is open
            if (showDownloadModal) return; // Don't close if download modal is open
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose();
            }
        }

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose, showWatchlistModal, showTVMazeModal, showOptionsModal, showDownloadModal]);

    // Close on escape (but not when modal is open)
    useEffect(() => {
        function handleEscape(e: KeyboardEvent) {
            if (showWatchlistModal) return; // Don't close if watchlist modal is open
            if (showTVMazeModal) return; // Don't close if TVMaze modal is open
            if (showOptionsModal) return; // Don't close if options modal is open
            if (showDownloadModal) return; // Don't close if download modal is open
            if (e.key === 'Escape') {
                onClose();
            }
        }

        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
    }, [onClose, showWatchlistModal, showTVMazeModal, showOptionsModal, showDownloadModal]);

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
                setMenuHidden(true);
                showModal({
                    title: 'Error',
                    message: 'Channel not found',
                    type: 'error',
                    confirmText: 'OK',
                    onConfirm: () => onClose(),
                    onCancel: () => onClose(),
                });
                return;
            }

            const added = await addToWatchlist(program, channelForWatchlist, options);
            setMenuHidden(true);
            if (added) {
                const reminderText = options.reminder_enabled
                    ? options.reminder_minutes > 0
                        ? ` (Reminder: ${options.reminder_minutes} min before)`
                        : ' (Reminder at start time)'
                    : '';
                showModal({
                    title: 'Added to Watchlist',
                    message: `${program.title}${reminderText}`,
                    type: 'success',
                    confirmText: 'OK',
                    onConfirm: () => onClose(),
                    onCancel: () => onClose(),
                });
                // Dispatch event to refresh watchlist UI
                window.dispatchEvent(new CustomEvent('watchlist-updated'));
            } else {
                showModal({
                    title: 'Already in Watchlist',
                    message: `${program.title} is already in your watchlist`,
                    type: 'info',
                    confirmText: 'OK',
                    onConfirm: () => onClose(),
                    onCancel: () => onClose(),
                });
            }
        } catch (error: any) {
            console.error('Failed to add to watchlist:', error);
            setMenuHidden(true);
            showModal({
                title: 'Failed to Add',
                message: error?.message || 'Failed to add to watchlist',
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } finally {
            setAddingToWatchlist(false);
        }
    }

    async function handleScheduleRecording() {
        if (scheduling) return;
        setScheduling(true);

        try {
            // Get channel info to check if we need URL resolution
            const channel = await db.channels.get(channelId);
            let resolved: string | undefined;

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

                    resolved = await client.resolveStreamUrl(channel.direct_url);
                    console.log('[ProgramContextMenu] Resolved Stalker URL:', resolved);
                }
            }

            setResolvedUrl(resolved);
            setShowOptionsModal(true);
            setMenuHidden(true); // Hide the context menu since modal is opening
        } catch (error: any) {
            console.error('Failed to resolve stream URL:', error);
            showModal({
                title: i18n.t('contextMenu.schedulingFailed'),
                message: translateNativeError(error?.message) || i18n.t('contextMenu.failedResolveStreamUrl'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } finally {
            setScheduling(false);
        }
    }

    async function handleConfirmSchedule(options: {
        startPadding: number;
        endPadding: number;
        recurrence: string;
        title?: string;
    }) {
        setShowOptionsModal(false);
        setScheduling(true);
        try {
            const startTime = program.start instanceof Date ? program.start : new Date(program.start);
            const endTime = program.end instanceof Date ? program.end : new Date(program.end);

            const schedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'> = {
                source_id: sourceId,
                channel_id: channelId,
                channel_name: channelName,
                program_title: options.title?.trim() || program.title,
                scheduled_start: Math.floor(startTime.getTime() / 1000),
                scheduled_end: Math.floor(endTime.getTime() / 1000),
                start_padding_sec: options.startPadding,
                end_padding_sec: options.endPadding,
                series_match_title: undefined,
                recurrence: options.recurrence !== 'once' ? options.recurrence : undefined,
                stream_url: resolvedUrl,
            };

            // Check for conflicts
            const conflictResult = await detectScheduleConflicts(schedule);
            if (conflictResult.hasConflict) {
                const sourceMeta = await db.sourcesMeta.get(sourceId);
                const maxConnections = parseInt(sourceMeta?.max_connections || '1');

                if (maxConnections === 1) {
                    showConfirm(
                        i18n.t('contextMenu.oneConnectionLimit'),
                        i18n.t('contextMenu.oneConnectionLimitMsg'),
                        async () => {
                            try {
                                setScheduling(true);
                                await scheduleRecording(schedule);
                                showModal({
                                    title: i18n.t('contextMenu.recordingScheduled'),
                                    message: i18n.t('contextMenu.hasBeenScheduled', { name: program.title }),
                                    type: 'success',
                                    confirmText: 'OK',
                                    onConfirm: () => onClose(),
                                    onCancel: () => onClose(),
                                });
                            } catch (err: any) {
                                showModal({
                                    title: i18n.t('contextMenu.schedulingFailed'),
                                    message: translateNativeError(err?.message) || i18n.t('contextMenu.failedScheduleRecording'),
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
                        i18n.t('dvr:record'),
                        i18n.t('common:cancel')
                    );
                } else {
                    showModal({
                        title: i18n.t('contextMenu.schedulingConflict'),
                        message: translateNativeError(conflictResult.message) || i18n.t('contextMenu.conflictMessage'),
                        type: 'error',
                        confirmText: 'OK',
                        onConfirm: () => onClose(),
                        onCancel: () => onClose(),
                    });
                }
                return;
            }

            // Schedule the recording
            await scheduleRecording(schedule);
            showModal({
                title: i18n.t('contextMenu.recordingScheduled'),
                message: i18n.t('contextMenu.hasBeenScheduled', { name: program.title }),
                type: 'success',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } catch (error: any) {
            console.error('Failed to schedule recording:', error);
            showModal({
                title: i18n.t('contextMenu.schedulingFailed'),
                message: translateNativeError(error?.message) || i18n.t('contextMenu.failedScheduleRecording'),
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } finally {
            setScheduling(false);
        }
    }

    async function handleConfirmDownload(options: {
        startPadding: number;
        endPadding: number;
    }) {
        setShowDownloadModal(false);
        setDownloadingCatchup(true);
        try {
            const channel = await db.channels.get(channelId);
            if (!channel) {
                throw new Error('Channel not found');
            }

            let rawStreamId = (channel as any).xtream_stream_id;
            if (!rawStreamId) {
                const { extractXtreamStreamId } = await import('@ynotv/local-adapter');
                rawStreamId = extractXtreamStreamId(channel.direct_url) || channel.stream_id.replace(`${channel.source_id}_`, '');
            }

            const startTimeMs = program.raw_start 
                ? new Date(program.raw_start).getTime() 
                : (program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime());
            const progStartMs = program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime();
            const progEndMs = program.end instanceof Date ? program.end.getTime() : new Date(program.end).getTime();
            const durationMinutes = Math.round((progEndMs - progStartMs) / 60000);

            const startPaddingMs = options.startPadding * 60_000;
            const adjustedStartTimeMs = startTimeMs - startPaddingMs;
            const adjustedDurationMinutes = durationMinutes + options.startPadding + options.endPadding;

            const { resolvePlayUrl } = await import('../services/stream-resolver');
            const resolved = await resolvePlayUrl(channel.source_id, channel.direct_url, {
                rawStreamId,
                startTimeMs: adjustedStartTimeMs,
                durationMinutes: adjustedDurationMinutes,
                catchupSource: (channel as any).catchup_source,
                catchupType: (channel as any).catchup_type,
                catchupDays: (channel as any).catchup_days,
                epgChannelId: channel.epg_channel_id || channel.stream_id,
            });

            const schedule: Omit<DvrSchedule, 'id' | 'created_at' | 'status'> = {
                source_id: channel.source_id,
                channel_id: channelId,
                channel_name: channelName,
                program_title: program.title,
                scheduled_start: Math.floor(startTimeMs / 1000),
                scheduled_end: Math.floor((startTimeMs + durationMinutes * 60_000) / 1000),
                start_padding_sec: options.startPadding * 60,
                end_padding_sec: options.endPadding * 60,
                series_match_title: undefined,
                recurrence: undefined,
                stream_url: resolved.url,
            };

            await scheduleRecording(schedule);

            showModal({
                title: i18n.t('contextMenu.recordingStarted'),
                message: i18n.t('contextMenu.startedCatchupRecording', { name: program.title }),
                type: 'success',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } catch (error: any) {
            console.error('Failed to start catchup download:', error);
            showModal({
                title: 'Download Failed',
                message: error?.message || 'Failed to start catchup download',
                type: 'error',
                confirmText: 'OK',
                onConfirm: () => onClose(),
                onCancel: () => onClose(),
            });
        } finally {
            setDownloadingCatchup(false);
        }
    }

    return createPortal(
        <>
            <div
                ref={menuRef}
                className="program-context-menu"
                style={{
                    left: `${adjustedPosition.x}px`,
                    top: `${adjustedPosition.y}px`,
                    display: menuHidden ? 'none' : undefined,
                }}
            >
                <div className="context-menu-item" onClick={handleScheduleRecording}>
                    {scheduling ? '⏳ Scheduling...' : '📹 Schedule Recording'}
                </div>
                {isCatchupAvailable && (program.start instanceof Date ? program.start.getTime() : new Date(program.start).getTime()) < Date.now() && (
                    <div className="context-menu-item" onClick={() => {
                        setShowDownloadModal(true);
                        setMenuHidden(true);
                    }}>
                        {downloadingCatchup ? '⏳ Preparing Download...' : '📥 Download Catchup'}
                    </div>
                )}
                <div className="context-menu-item" onClick={handleAddToWatchlistClick}>
                    {addingToWatchlist ? '⏳ Adding...' : '⭐ Add to Watchlist'}
                </div>
                <div className="context-menu-separator" />
                <div className="context-menu-item" onClick={() => {
                    console.log('[ProgramContextMenu] Opening TVMaze modal for:', program.title);
                    setShowTVMazeModal(true);
                }}>
                    📺 Track Show
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
            {showTVMazeModal && (
                <TVMazeSearchModal
                    programTitle={program.title}
                    channelName={channelName}
                    channelId={channelId}
                    onClose={() => setShowTVMazeModal(false)}
                />
            )}
            <DvrScheduleOptionsModal
                isOpen={showOptionsModal}
                programTitle={program.title}
                channelName={channelName}
                timeString={`${formatTime(new Date(program.start), { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' })} - ${formatTime(new Date(program.end), { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' })}`}
                defaultStartPadding={defaultStartPadding}
                defaultEndPadding={defaultEndPadding}
                onConfirm={handleConfirmSchedule}
                onCancel={() => {
                    setShowOptionsModal(false);
                    onClose();
                }}
            />
            <CatchupDownloadModal
                isOpen={showDownloadModal}
                programTitle={program.title}
                channelName={channelName}
                timeString={`${formatTime(new Date(program.start), { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' })} - ${formatTime(new Date(program.end), { hour: '2-digit', minute: '2-digit', hour12: epgClockFormat !== '24h' })}`}
                defaultStartPadding={catchupStartPadding}
                defaultEndPadding={catchupEndPadding}
                onConfirm={handleConfirmDownload}
                onCancel={() => {
                    setShowDownloadModal(false);
                    onClose();
                }}
            />
        </>,
        document.body
    );
}
