/**
 * HlsMultiviewCell — Secondary slot cell for HLS engine mode.
 *
 * Instead of positioning a native MPV window behind an overlay div, this
 * component renders a real <video> element driven by hls.js. Because the
 * video is part of the React DOM, any overlays (badges, controls, widgets)
 * can freely sit on top of it using normal z-index stacking.
 *
 * The component:
 *  - Self-manages hls.js lifecycle (create/destroy on URL change or unmount).
 *  - Falls back to native <video src> for browsers with built-in HLS (Safari).
 *  - Shows an error badge if hls.js cannot load the stream.
 *  - Exposes the same visual API as MultiviewCell (badge, controls bar, swap-on-click).
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Hls from 'hls.js';
import { useSettingsStore } from '../../stores/settingsStore';
import './HlsMultiviewCell.css';

interface HlsMultiviewCellProps {
    slotId: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    sourceName: string | null;
    active: boolean;
    onSwapWithMain: () => void;
    onStop: () => void;
    onReload: () => void;
    hidden?: boolean;
}

export function HlsMultiviewCell({
    slotId,
    channelName,
    channelUrl,
    sourceName,
    active,
    onSwapWithMain,
    onStop,
    onReload,
    hidden,
}: HlsMultiviewCellProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<Hls | null>(null);
    const { t } = useTranslation('player');

    const [volume, setVolume] = useState(100);
    const [muted, setMuted] = useState(true);
    const [hlsError, setHlsError] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    // includeSourceInSearch is a settings-store field — subscribe instead of
    // paying an IPC getSettings round-trip on mount (mirrors MultiviewCell).
    const showSourceName = useSettingsStore((s) => s.includeSourceInSearch);

    // Destroy hls instance helper
    const destroyHls = useCallback(() => {
        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }
        if (videoRef.current) {
            const video = videoRef.current;
            video.pause();
            video.src = '';
            try {
                video.load();
            } catch (e) {
                // Ignore load errors on unmounted video
            }
        }
    }, []);

    // Load / reload whenever channelUrl or hidden status changes
    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;

        destroyHls();
        setHlsError(null);

        if (!channelUrl || !active || hidden) {
            video.pause();
            video.src = '';
            try {
                video.load();
            } catch (e) {
                // Ignore load errors
            }
            return;
        }

        // hls.js CANNOT play raw MPEG-TS (.ts) streams. It needs an HLS manifest (.m3u8).
        // Many IPTV providers (like Xtream Codes) use .ts by default but support .m3u8 
        // on the exact same path just by changing the extension.
        let streamUrl = channelUrl;
        try {
            const parsed = new URL(streamUrl);
            if (parsed.pathname.endsWith('.ts')) {
                parsed.pathname = parsed.pathname.replace(/\.ts$/, '.m3u8');
                streamUrl = parsed.toString();
            }
        } catch (e) {
            if (streamUrl.endsWith('.ts')) {
                streamUrl = streamUrl.replace(/\.ts$/, '.m3u8');
            }
        }

        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                backBufferLength: 30,
            });
            hlsRef.current = hls;

            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (data.fatal) {
                    console.warn('[HLS Error]', data.type, data.details);
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            // try to recover network error
                            console.log('fatal network error encountered, try to recover');
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('fatal media error encountered, try to recover');
                            hls.recoverMediaError();
                            break;
                        default:
                            // cannot recover
                            setHlsError(`Fatal stream error: ${data.details}`);
                            destroyHls();
                            break;
                    }
                }
            });

            hls.loadSource(streamUrl);
            hls.attachMedia(video);
            
            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                video.muted = true;
                video.play().catch(() => { /* autoplay blocked */ });
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari native HLS support
            video.src = streamUrl;
            video.muted = true;
            video.play().catch(() => { });
        } else {
            setHlsError('HLS is not supported in this environment.');
        }

        return () => {
            destroyHls();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [channelUrl, active, hidden]);

    // Reset volume & mute when new channel is loaded
    useEffect(() => {
        if (channelUrl && active) {
            setVolume(100);
            setMuted(true);
            setHlsError(null);
            if (videoRef.current) {
                videoRef.current.muted = true;
                videoRef.current.volume = 1;
            }
        }
    }, [channelUrl, active]);

    // Cleanup on unmount
    useEffect(() => {
        return () => { destroyHls(); };
    }, [destroyHls]);

    const handleMuteToggle = (e: React.MouseEvent) => {
        e.stopPropagation();
        const newMuted = !muted;
        setMuted(newMuted);
        if (videoRef.current) {
            videoRef.current.muted = newMuted;
            if (!newMuted && volume === 0) {
                setVolume(100);
                videoRef.current.volume = 1;
            }
        }
    };

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVol = parseInt(e.target.value, 10);
        setVolume(newVol);
        if (videoRef.current) {
            videoRef.current.volume = newVol / 100;
        }
        if (newVol > 0 && muted) {
            setMuted(false);
            if (videoRef.current) videoRef.current.muted = false;
        }
    };

    const handlePlay = (e: React.MouseEvent) => {
        e.stopPropagation();
        videoRef.current?.play().catch(() => { });
    };

    const handlePause = (e: React.MouseEvent) => {
        e.stopPropagation();
        videoRef.current?.pause();
    };

    const displayName = useMemo(() => {
        if (showSourceName && sourceName) return `[${sourceName}] ${channelName}`;
        return channelName;
    }, [showSourceName, sourceName, channelName]);

    return (
        <div className={`multiview-cell-container hls-cell-container${active ? ' hls-cell-active' : ''}`}>
            {/* Real <video> element — visible to the browser compositor */}
            <video
                ref={videoRef}
                className="hls-cell-video"
                muted
                playsInline
            />

            {/* Transparent interaction overlay — same id used by geometry helpers */}
            <div
                id={`mpv-video-rect-${slotId}`}
                className={`multiview-cell hls-cell-overlay ${active ? 'multiview-cell-active' : 'multiview-cell-empty'}`}
                onClick={() => { if (active) onSwapWithMain(); }}
                onContextMenu={(e) => { e.preventDefault(); if (active) setContextMenu({ x: e.clientX, y: e.clientY }); }}
                title={active ? t('clickToSwapMain', { name: displayName }) : t('sendToViewer')}
            >
                {/* Empty slot placeholder */}
                {!active && (
                    <div className="multiview-cell-overlay">
                        <div className="multiview-cell-slot-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <rect x="2" y="7" width="20" height="15" rx="2" />
                                <polyline points="17 2 12 7 7 2" />
                            </svg>
                        </div>
                        <span className="multiview-cell-slot-label">{t('viewerLabel', { slot: slotId })}</span>
                        <span className="multiview-cell-hint">{t('sendToViewer')}</span>
                        <span className="hls-badge">HLS</span>
                    </div>
                )}

                {/* Active: channel name badge (shows on hover via CSS) */}
                {active && !hlsError && (
                    <div className="multiview-cell-badge">
                        <span className="multiview-cell-name">{displayName}</span>
                        <span className="multiview-cell-swap-hint">{t('clickToSwap')}</span>
                        <span className="hls-badge">HLS</span>
                    </div>
                )}
            </div>

            {/* Error badge — sits above the video, below controls bar */}
            {active && hlsError && (
                <div className="hls-error-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span>{hlsError}</span>
                    <span className="hls-error-name">{displayName}</span>
                </div>
            )}

            {/* Controls bar (below video) */}
            {active && (
                <div className="multiview-cell-controls">
                    <span className="multiview-cell-controls-name">{displayName}</span>
                    <div className="multiview-cell-controls-buttons">
                        <div className="multiview-cell-controls-volume" onClick={e => e.stopPropagation()}>
                            <button className="multiview-cell-controls-btn" onClick={handleMuteToggle} title={muted ? t('unmute') : t('mute')}>
                                {muted || volume === 0 ? (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /></svg>
                                ) : (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" /></svg>
                                )}
                            </button>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={muted ? 0 : volume}
                                onChange={handleVolumeChange}
                                className="multiview-cell-volume-slider"
                                title={t('volume')}
                            />
                        </div>
                        <button className="multiview-cell-controls-btn" onClick={handlePlay} title={t('play')}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                        </button>
                        <button className="multiview-cell-controls-btn" onClick={handlePause} title={t('pause')}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                        </button>
                        <button className="multiview-cell-controls-btn" onClick={(e) => { e.stopPropagation(); onReload(); }} title={t('reloadStream')}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A8 8 0 1 0 19 12h-2a6 6 0 1 1-2.23-4.69l2.64-2.64 1.42 1.42-3.54 3.54-3.54-3.54 1.41-1.41L13.76 5.1a8 8 0 0 1 3.89 1.25z" /></svg>
                        </button>
                        <button className="multiview-cell-controls-btn danger" onClick={(e) => { e.stopPropagation(); onStop(); }} title={t('stopClearBox')}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z" /></svg>
                        </button>
                    </div>
                </div>
            )}

            {contextMenu && (
                <HlsCellContextMenu
                    position={contextMenu}
                    channelName={channelName}
                    onPlay={() => { videoRef.current?.play().catch(() => {}); setContextMenu(null); }}
                    onPause={() => { videoRef.current?.pause(); setContextMenu(null); }}
                    onReload={() => { onReload(); setContextMenu(null); }}
                    onStop={() => { onStop(); setContextMenu(null); }}
                    onClose={() => setContextMenu(null)}
                />
            )}
        </div>
    );
}

function HlsCellContextMenu({
    position,
    channelName,
    onPlay,
    onPause,
    onReload,
    onStop,
    onClose,
}: {
    position: { x: number; y: number };
    channelName: string | null;
    onPlay: () => void;
    onPause: () => void;
    onReload: () => void;
    onStop: () => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    const { t } = useTranslation('player');

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    return (
        <div
            ref={ref}
            className="cell-context-menu"
            style={{ position: 'fixed', left: position.x, top: position.y, zIndex: 9999 }}
        >
            {channelName && <div className="cell-context-header">{channelName}</div>}
            <button className="cell-context-item" onClick={onPlay}>▶ {t('playStream')}</button>
            <button className="cell-context-item" onClick={onPause}>⏸ {t('pauseStream')}</button>
            <button className="cell-context-item" onClick={onReload}>🔄 {t('reloadStream')}</button>
            <button className="cell-context-item cell-context-danger" onClick={onStop}>⏹ {t('stopClearSlot')}</button>
        </div>
    );
}
