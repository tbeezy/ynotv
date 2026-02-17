import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
    getScheduledRecordings,
    getCompletedRecordings,
    getActiveRecordings,
    cancelRecording,
    deleteRecording,
    updateSchedulePaddings,
    type DvrSchedule,
    type DvrRecording,
    type RecordingProgress,
} from '../db';
import { dbEvents } from '../db/sqlite-adapter';
import { useModal } from './Modal';
import './DvrDashboard.css';

interface DvrDashboardProps {
    onPlay?: (recording: DvrRecording) => void;
    onClose: () => void;
}

type DvrTab = 'scheduled' | 'recorded';

export function DvrDashboard({ onPlay, onClose }: DvrDashboardProps) {
    const [activeTab, setActiveTab] = useState<DvrTab>('scheduled');
    const [scheduled, setScheduled] = useState<DvrSchedule[]>([]);
    const [recorded, setRecorded] = useState<DvrRecording[]>([]);
    const [activeRecordings, setActiveRecordings] = useState<RecordingProgress[]>([]);
    const [loading, setLoading] = useState(true);

    // Edit schedule state
    const [editingSchedule, setEditingSchedule] = useState<DvrSchedule | null>(null);
    const [editStartPadding, setEditStartPadding] = useState(60);
    const [editEndPadding, setEditEndPadding] = useState(300);
    const [savingEdit, setSavingEdit] = useState(false);

    // Modal hook
    const { showConfirm, showError, showSuccess, ModalComponent } = useModal();

    async function loadData(showLoading = true) {
        if (showLoading) setLoading(true);
        try {
            const [schedData, recData] = await Promise.all([
                getScheduledRecordings(),
                getCompletedRecordings(),
            ]);
            setScheduled(schedData);
            setRecorded(recData);
        } catch (error) {
            console.error('Failed to load DVR data:', error);
        } finally {
            if (showLoading) setLoading(false);
        }
    }

    useEffect(() => {
        loadData();

        // Subscribe to database changes for live updates
        const unsubscribeSchedules = dbEvents.subscribe((event) => {
            if (event.tableName === 'dvr_schedules') {
                loadData();
            }
        });

        const unsubscribeRecordings = dbEvents.subscribe((event) => {
            if (event.tableName === 'dvr_recordings') {
                loadData();
            }
        });

        return () => {
            unsubscribeSchedules();
            unsubscribeRecordings();
        };
    }, []);

    // Poll for active recording progress every 1 second
    const prevActiveCountRef = useRef(0);
    useEffect(() => {
        const pollActiveRecordings = async () => {
            const active = await getActiveRecordings();
            setActiveRecordings(active);

            if (active.length !== prevActiveCountRef.current) {
                prevActiveCountRef.current = active.length;
                const schedData = await getScheduledRecordings();
                setScheduled(schedData);
            }
        };

        pollActiveRecordings();
        const interval = setInterval(pollActiveRecordings, 1000);
        return () => clearInterval(interval);
    }, []);

    // Listen for DVR events from backend
    useEffect(() => {
        let unlistenFn: (() => void) | undefined;

        const setupListener = async () => {
            try {
                const unlisten = await listen('dvr:event', (event) => {
                    const data = event.payload as {
                        event_type: string;
                        schedule_id: number;
                        recording_id?: number;
                        channel_name: string;
                        program_title: string;
                        message?: string;
                    };
                    console.log('[DVR Dashboard] Event received:', data.event_type, data);

                    if (data.event_type === 'started' || data.event_type === 'completed' || data.event_type === 'failed') {
                        loadData(false);
                        getActiveRecordings().then(setActiveRecordings);
                    }
                });
                unlistenFn = unlisten;
            } catch (error) {
                console.error('[DVR Dashboard] Failed to setup event listener:', error);
            }
        };

        setupListener();

        return () => {
            if (unlistenFn) {
                unlistenFn();
            }
        };
    }, []);

    async function handleCancel(id: number) {
        showConfirm(
            'Cancel Recording',
            'Are you sure you want to cancel this recording?',
            async () => {
                try {
                    await cancelRecording(id);
                    await loadData();
                } catch (error) {
                    console.error('Failed to cancel recording:', error);
                    showError('Error', 'Failed to cancel recording');
                }
            },
            undefined,
            'Cancel Recording',
            'Keep'
        );
    }

    function handleEditStart(item: DvrSchedule) {
        setEditingSchedule(item);
        setEditStartPadding(item.start_padding_sec || 60);
        setEditEndPadding(item.end_padding_sec || 300);
    }

    function handleEditCancel() {
        setEditingSchedule(null);
        setEditStartPadding(60);
        setEditEndPadding(300);
    }

    async function handleSaveEdit() {
        if (!editingSchedule?.id) return;

        setSavingEdit(true);
        try {
            await updateSchedulePaddings(
                editingSchedule.id,
                editStartPadding,
                editEndPadding
            );
            await loadData(false);
            setEditingSchedule(null);
        } catch (error) {
            console.error('Failed to update schedule:', error);
            showError('Error', 'Failed to update schedule padding');
        } finally {
            setSavingEdit(false);
        }
    }

    async function handleDelete(id: number, filePath?: string) {
        const title = filePath ? 'Delete Recording File' : 'Remove Recording';
        const message = filePath
            ? 'Are you sure you want to delete this recording file from disk? This action cannot be undone.'
            : 'Are you sure you want to remove this recording from the list?';

        showConfirm(
            title,
            message,
            async () => {
                try {
                    await deleteRecording(id);
                    await loadData();
                } catch (error) {
                    console.error('Failed to delete recording:', error);
                    showError('Error', 'Failed to delete recording');
                }
            },
            undefined,
            filePath ? 'Delete' : 'Remove',
            'Cancel'
        );
    }

    function formatDateTime(timestamp: number): string {
        return new Date(timestamp * 1000).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function formatDuration(start: number, end: number): string {
        const mins = Math.round((end - start) / 60);
        const hours = Math.floor(mins / 60);
        const remainingMins = mins % 60;
        if (hours > 0) {
            return `${hours}h ${remainingMins}m`;
        }
        return `${mins}m`;
    }

    function formatElapsed(seconds: number): string {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        if (hrs > 0) {
            return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function getRecordingProgress(scheduleId: number): RecordingProgress | undefined {
        return activeRecordings.find(r => r.schedule_id === scheduleId);
    }

    const activeCount = scheduled.filter(s => s.status === 'recording').length;
    const upcomingCount = scheduled.filter(s => s.status === 'scheduled').length;

    return (
        <div className="dvr-dashboard">
            {/* Sidebar */}
            <aside className="dvr-sidebar">
                <div className="dvr-sidebar-header">
                    <h2 className="dvr-sidebar-title">DVR</h2>
                    <p className="dvr-sidebar-subtitle">Digital Video Recorder</p>
                </div>

                <nav className="dvr-nav">
                    <button
                        className={`dvr-nav-item ${activeTab === 'scheduled' ? 'active' : ''}`}
                        onClick={() => setActiveTab('scheduled')}
                    >
                        <span className="dvr-nav-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                                <line x1="16" y1="2" x2="16" y2="6" />
                                <line x1="8" y1="2" x2="8" y2="6" />
                                <line x1="3" y1="10" x2="21" y2="10" />
                            </svg>
                        </span>
                        <span className="dvr-nav-label">Scheduled</span>
                        {upcomingCount > 0 && <span className="dvr-nav-badge">{upcomingCount}</span>}
                    </button>

                    <button
                        className={`dvr-nav-item ${activeTab === 'recorded' ? 'active' : ''}`}
                        onClick={() => setActiveTab('recorded')}
                    >
                        <span className="dvr-nav-icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polygon points="23 7 16 12 23 17 23 7" />
                                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                            </svg>
                        </span>
                        <span className="dvr-nav-label">Recordings</span>
                        {recorded.length > 0 && <span className="dvr-nav-badge">{recorded.length}</span>}
                    </button>
                </nav>

                <div className="dvr-sidebar-footer">
                    {activeCount > 0 && (
                        <div className="dvr-recording-indicator">
                            <span className="dvr-recording-pulse" />
                            <span className="dvr-recording-text">{activeCount} recording{activeCount !== 1 ? 's' : ''} active</span>
                        </div>
                    )}
                    <button className="dvr-back-btn" onClick={onClose}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M19 12H5M12 19l-7-7 7-7" />
                        </svg>
                        Back to TV
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="dvr-main">
                <header className="dvr-main-header">
                    <h1 className="dvr-main-title">
                        {activeTab === 'scheduled' ? 'Scheduled Recordings' : 'Your Recordings'}
                    </h1>
                </header>

                <div className="dvr-content">
                    {loading ? (
                        <div className="dvr-loading">
                            <div className="dvr-spinner" />
                            <span>Loading...</span>
                        </div>
                    ) : activeTab === 'scheduled' ? (
                        <ScheduledTab
                            scheduled={scheduled}
                            activeRecordings={activeRecordings}
                            onEdit={handleEditStart}
                            onCancel={handleCancel}
                            formatDateTime={formatDateTime}
                            formatDuration={formatDuration}
                            formatElapsed={formatElapsed}
                            getRecordingProgress={getRecordingProgress}
                        />
                    ) : (
                        <RecordedTab
                            recorded={recorded}
                            onPlay={onPlay}
                            onDelete={handleDelete}
                            formatDateTime={formatDateTime}
                        />
                    )}
                </div>
            </main>

            {/* Edit Modal */}
            {editingSchedule && (
                <EditModal
                    schedule={editingSchedule}
                    startPadding={editStartPadding}
                    endPadding={editEndPadding}
                    onStartPaddingChange={setEditStartPadding}
                    onEndPaddingChange={setEditEndPadding}
                    onSave={handleSaveEdit}
                    onCancel={handleEditCancel}
                    saving={savingEdit}
                    formatDateTime={formatDateTime}
                />
            )}

            {/* Themed Modal */}
            <ModalComponent />
        </div>
    );
}

// Scheduled Tab Component
interface ScheduledTabProps {
    scheduled: DvrSchedule[];
    activeRecordings: RecordingProgress[];
    onEdit: (item: DvrSchedule) => void;
    onCancel: (id: number) => void;
    formatDateTime: (timestamp: number) => string;
    formatDuration: (start: number, end: number) => string;
    formatElapsed: (seconds: number) => string;
    getRecordingProgress: (scheduleId: number) => RecordingProgress | undefined;
}

function ScheduledTab({
    scheduled,
    activeRecordings,
    onEdit,
    onCancel,
    formatDateTime,
    formatDuration,
    formatElapsed,
    getRecordingProgress,
}: ScheduledTabProps) {
    if (scheduled.length === 0) {
        return (
            <div className="dvr-empty-state">
                <div className="dvr-empty-icon">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                </div>
                <h3>No Scheduled Recordings</h3>
                <p>Right-click on programs in the TV Guide to schedule recordings</p>
            </div>
        );
    }

    const active = scheduled.filter(s => s.status === 'recording');
    const upcoming = scheduled.filter(s => s.status === 'scheduled');

    return (
        <div className="dvr-scheduled">
            {active.length > 0 && (
                <section className="dvr-section">
                    <h2 className="dvr-section-title">
                        <span className="dvr-status-dot recording" />
                        Currently Recording
                    </h2>
                    <div className="dvr-card-grid">
                        {active.map(item => (
                            <RecordingCard
                                key={item.id}
                                item={item}
                                progress={getRecordingProgress(item.id!)}
                                onEdit={() => onEdit(item)}
                                onCancel={() => onCancel(item.id!)}
                                formatDateTime={formatDateTime}
                                formatDuration={formatDuration}
                                formatElapsed={formatElapsed}
                            />
                        ))}
                    </div>
                </section>
            )}

            {upcoming.length > 0 && (
                <section className="dvr-section">
                    <h2 className="dvr-section-title">
                        <span className="dvr-status-dot scheduled" />
                        Upcoming
                    </h2>
                    <div className="dvr-card-grid">
                        {upcoming.map(item => (
                            <ScheduledCard
                                key={item.id}
                                item={item}
                                onEdit={() => onEdit(item)}
                                onCancel={() => onCancel(item.id!)}
                                formatDateTime={formatDateTime}
                                formatDuration={formatDuration}
                            />
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

// Recorded Tab Component
interface RecordedTabProps {
    recorded: DvrRecording[];
    onPlay?: (recording: DvrRecording) => void;
    onDelete: (id: number, filePath?: string) => void;
    formatDateTime: (timestamp: number) => string;
}

function RecordedTab({ recorded, onPlay, onDelete, formatDateTime }: RecordedTabProps) {
    // Store thumbnail URLs by recording ID
    const [thumbnails, setThumbnails] = useState<Record<number, string>>({});

    // Fetch thumbnails when recordings change
    useEffect(() => {
        const loadThumbnails = async () => {
            const newThumbnails: Record<number, string> = {};
            const prevThumbnails = { ...thumbnails };

            for (const item of recorded) {
                if (item.id && item.thumbnail_path) {
                    // Skip if we already have this thumbnail loaded
                    if (thumbnails[item.id]) {
                        newThumbnails[item.id] = thumbnails[item.id];
                        continue;
                    }

                    try {
                        const { getRecordingThumbnail } = await import('../db');
                        const data = await getRecordingThumbnail(item.id);
                        if (data) {
                            // Convert Uint8Array to Blob URL
                            const blob = new Blob([data.buffer as ArrayBuffer], { type: 'image/jpeg' });
                            newThumbnails[item.id] = URL.createObjectURL(blob);
                        }
                    } catch (error) {
                        console.error(`Failed to load thumbnail for recording ${item.id}:`, error);
                    }
                }
            }

            // Revoke URLs for recordings that are no longer present
            Object.entries(prevThumbnails).forEach(([id, url]) => {
                if (!newThumbnails[Number(id)]) {
                    URL.revokeObjectURL(url);
                }
            });

            setThumbnails(newThumbnails);
        };

        loadThumbnails();

        // Only cleanup on component unmount
        return () => {
            Object.values(thumbnails).forEach(url => URL.revokeObjectURL(url));
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recorded]);

    if (recorded.length === 0) {
        return (
            <div className="dvr-empty-state">
                <div className="dvr-empty-icon">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                </div>
                <h3>No Recordings Yet</h3>
                <p>Your completed recordings will appear here</p>
            </div>
        );
    }

    return (
        <div className="dvr-recorded-grid">
            {recorded.map(item => (
                <div key={item.id} className={`dvr-media-card ${item.status}`}>
                    <div className="dvr-media-thumbnail">
                        {item.id && thumbnails[item.id] ? (
                            <img
                                src={thumbnails[item.id]}
                                alt={item.program_title}
                                className="dvr-media-thumbnail-img"
                            />
                        ) : (
                            <div className="dvr-media-icon">
                                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                    <polygon points="5 3 19 12 5 21 5 3" />
                                </svg>
                            </div>
                        )}
                        <div className="dvr-media-overlay">
                            {(item.status === 'completed' || item.status === 'partial') && item.file_path && onPlay && (
                                <button
                                    className="dvr-play-btn"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        console.log('[DVR] Play button clicked for:', item.file_path);
                                        onPlay(item);
                                    }}
                                    title={item.status === 'partial' ? 'Play Partial Recording' : 'Play Recording'}
                                >
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                                        <polygon points="5 3 19 12 5 21 5 3" />
                                    </svg>
                                </button>
                            )}
                        </div>
                        <span className={`dvr-media-badge ${item.status}`}>
                            {item.status}
                        </span>
                    </div>
                    <div className="dvr-media-info">
                        <h3 className="dvr-media-title">{item.program_title}</h3>
                        <p className="dvr-media-channel">{item.channel_name}</p>
                        <p className="dvr-media-date">
                            {item.actual_end
                                ? formatDateTime(item.actual_end)
                                : item.actual_start
                                    ? formatDateTime(item.actual_start)
                                    : 'Unknown date'}
                        </p>
                        {item.duration_sec && (
                            <p className="dvr-media-duration">
                                {Math.round(item.duration_sec / 60)} min
                            </p>
                        )}
                    </div>
                    <button
                        className="dvr-media-delete"
                        onClick={() => onDelete(item.id!, item.file_path)}
                        title="Delete"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                    </button>
                </div>
            ))}
        </div>
    );
}

// Recording Card (for active recordings)
interface RecordingCardProps {
    item: DvrSchedule;
    progress?: RecordingProgress;
    onEdit: () => void;
    onCancel: () => void;
    formatDateTime: (timestamp: number) => string;
    formatDuration: (start: number, end: number) => string;
    formatElapsed: (seconds: number) => string;
}

function RecordingCard({ item, progress, onEdit, onCancel, formatDateTime, formatDuration, formatElapsed }: RecordingCardProps) {
    const percent = progress
        ? Math.min(100, (progress.elapsed_seconds / progress.scheduled_duration) * 100)
        : 0;

    return (
        <div className="dvr-card recording">
            <div className="dvr-card-header">
                <span className="dvr-card-status-badge recording">REC</span>
                <div className="dvr-card-actions">
                    <button className="dvr-btn-icon" onClick={onEdit} title="Edit padding">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                    </button>
                    <button className="dvr-btn-icon danger" onClick={onCancel} title="Stop recording">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        </svg>
                    </button>
                </div>
            </div>
            <div className="dvr-card-body">
                <h3 className="dvr-card-title">{item.program_title}</h3>
                <div className="dvr-card-meta">
                    <span className="dvr-meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                        {item.channel_name}
                    </span>
                    <span className="dvr-meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                        </svg>
                        {formatDateTime(item.scheduled_start)}
                    </span>
                    <span className="dvr-meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 16" />
                        </svg>
                        {formatDuration(item.scheduled_start, item.scheduled_end)}
                    </span>
                </div>
                {progress && (
                    <div className="dvr-card-progress">
                        <div className="dvr-progress-header">
                            <span className="dvr-progress-label">Recording in progress</span>
                            <span className="dvr-progress-time">{formatElapsed(progress.elapsed_seconds)}</span>
                        </div>
                        <div className="dvr-progress-bar">
                            <div className="dvr-progress-fill" style={{ width: `${percent}%` }} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// Scheduled Card (for upcoming recordings)
interface ScheduledCardProps {
    item: DvrSchedule;
    onEdit: () => void;
    onCancel: () => void;
    formatDateTime: (timestamp: number) => string;
    formatDuration: (start: number, end: number) => string;
}

function ScheduledCard({ item, onEdit, onCancel, formatDateTime, formatDuration }: ScheduledCardProps) {
    return (
        <div className="dvr-card scheduled">
            <div className="dvr-card-header">
                <span className="dvr-card-status-badge scheduled">SCHEDULED</span>
                <div className="dvr-card-actions">
                    <button className="dvr-btn-icon" onClick={onEdit} title="Edit padding">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                    </button>
                    <button className="dvr-btn-icon danger" onClick={onCancel} title="Cancel recording">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            </div>
            <div className="dvr-card-body">
                <h3 className="dvr-card-title">{item.program_title}</h3>
                <div className="dvr-card-meta">
                    <span className="dvr-meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                            <line x1="8" y1="21" x2="16" y2="21" />
                            <line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                        {item.channel_name}
                    </span>
                    <span className="dvr-meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 14" />
                        </svg>
                        {formatDateTime(item.scheduled_start)}
                    </span>
                    <span className="dvr-meta-item">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <polyline points="12 6 12 12 16 16" />
                        </svg>
                        {formatDuration(item.scheduled_start, item.scheduled_end)}
                    </span>
                </div>
                {(item.start_padding_sec > 0 || item.end_padding_sec > 0) && (
                    <div className="dvr-card-padding">
                        <span className="dvr-padding-label">Padding:</span>
                        <span className="dvr-padding-value">+{item.start_padding_sec}s start, +{item.end_padding_sec}s end</span>
                    </div>
                )}
            </div>
        </div>
    );
}

// Edit Modal Component
interface EditModalProps {
    schedule: DvrSchedule;
    startPadding: number;
    endPadding: number;
    onStartPaddingChange: (value: number) => void;
    onEndPaddingChange: (value: number) => void;
    onSave: () => void;
    onCancel: () => void;
    saving: boolean;
    formatDateTime: (timestamp: number) => string;
}

function EditModal({
    schedule,
    startPadding,
    endPadding,
    onStartPaddingChange,
    onEndPaddingChange,
    onSave,
    onCancel,
    saving,
    formatDateTime,
}: EditModalProps) {
    return (
        <div className="dvr-modal-overlay" onClick={onCancel}>
            <div className="dvr-modal" onClick={(e) => e.stopPropagation()}>
                <div className="dvr-modal-header">
                    <h3>Edit Recording</h3>
                    <button className="dvr-modal-close" onClick={onCancel}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="dvr-modal-body">
                    <div className="dvr-modal-info">
                        <h4>{schedule.program_title}</h4>
                        <p>{schedule.channel_name}</p>
                        <p>{formatDateTime(schedule.scheduled_start)}</p>
                    </div>

                    <div className="dvr-form-group">
                        <label>Start Padding</label>
                        <div className="dvr-form-control">
                            <input
                                type="range"
                                min="0"
                                max="300"
                                step="30"
                                value={startPadding}
                                onChange={(e) => onStartPaddingChange(Number(e.target.value))}
                            />
                            <span className="dvr-form-value">{startPadding}s</span>
                        </div>
                        <span className="dvr-form-hint">Record this many seconds before start time</span>
                    </div>

                    <div className="dvr-form-group">
                        <label>End Padding</label>
                        <div className="dvr-form-control">
                            <input
                                type="range"
                                min="0"
                                max="600"
                                step="30"
                                value={endPadding}
                                onChange={(e) => onEndPaddingChange(Number(e.target.value))}
                            />
                            <span className="dvr-form-value">{endPadding}s</span>
                        </div>
                        <span className="dvr-form-hint">Record this many seconds after end time</span>
                    </div>
                </div>

                <div className="dvr-modal-footer">
                    <button className="dvr-btn secondary" onClick={onCancel}>Cancel</button>
                    <button className="dvr-btn primary" onClick={onSave} disabled={saving}>
                        {saving ? 'Saving...' : 'Save Changes'}
                    </button>
                </div>
            </div>
        </div>
    );
}
