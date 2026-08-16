import { useEffect, useState } from 'react';
import { getChannelMetadata } from '../services/video-metadata';
import type { ChannelMetadata } from '../db';
import { dbEvents } from '../db/sqlite-adapter';
import { useSettingsStore } from '../stores/settingsStore';
import './MetadataBadge.css';

interface MetadataBadgeProps {
    streamId: string;
    variant?: 'compact' | 'detailed';
    showResolution?: boolean;
    showFps?: boolean;
    showSound?: boolean;
}

// Normalize stored quality labels to a consistent short display form.
// Handles legacy values (e.g. "FHD", "1080P", "UHD") alongside current ones.
function normalizeQualityLabel(label: string): string {
    const value = (label || '').trim();
    const upper = value.toUpperCase();
    if (upper === '4K' || upper === 'UHD') return '4K';
    if (upper === 'FHD' || upper === '1080P' || upper === '1080' || upper === '1920X1080') return '1080p';
    if (upper === 'HD' || upper === '720P' || upper === '720' || upper === '1280X720') return '720p';
    if (upper === 'SD') return 'SD';
    return value;
}

// Normalize stored audio channel strings (e.g. "5.1(SIDE)CH", "STEREOCH", "5.1")
// to a short human-readable form: "5.1", "Stereo", "Mono".
function normalizeAudioChannels(channels: string): string {
    const value = (channels || '').trim();
    const clean = value
        .toUpperCase()
        .replace(/\(.*?\)/g, '') // strip layout detail: "(SIDE)", "(FRONT)"
        .replace(/CH$/i, '')     // strip trailing "CH"
        .trim();
    if (clean === 'STEREO' || clean === '2.0') return 'Stereo';
    if (clean === 'MONO' || clean === '1.0') return 'Mono';
    const match = clean.match(/^\d(?:\.\d+)?/);
    if (match) return match[0];
    return value;
}

/**
 * MetadataBadge - Displays video quality, FPS, and audio channel info
 * Automatically refreshes when metadata is updated in the database
 */
export function MetadataBadge({
    streamId,
    variant = 'compact',
    showResolution,
    showFps,
    showSound,
}: MetadataBadgeProps) {
    const [metadata, setMetadata] = useState<ChannelMetadata | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const epgMetadataBadgeResolution = useSettingsStore((s) => s.epgMetadataBadgeResolution) ?? true;
    const epgMetadataBadgeFps = useSettingsStore((s) => s.epgMetadataBadgeFps) ?? true;
    const epgMetadataBadgeFpsSuffix = useSettingsStore((s) => s.epgMetadataBadgeFpsSuffix) ?? true;
    const epgMetadataBadgeSound = useSettingsStore((s) => s.epgMetadataBadgeSound) ?? true;

    const effectiveShowResolution = showResolution ?? epgMetadataBadgeResolution;
    const effectiveShowFps = showFps ?? epgMetadataBadgeFps;
    const effectiveShowSound = showSound ?? epgMetadataBadgeSound;

    // Load metadata on mount and when streamId or refreshKey changes
    useEffect(() => {
        getChannelMetadata(streamId).then(setMetadata);
    }, [streamId, refreshKey]);

    // Listen to database updates for channelMetadata table only
    // Scoped subscription prevents re-renders on unrelated DB writes (e.g. EPG sync, favorites)
    useEffect(() => {
        const unsubscribe = dbEvents.subscribe('channelMetadata', () => {
            setRefreshKey(prev => prev + 1);
        });
        return unsubscribe;
    }, []);

    // Return null immediately - badge will pop in when data loads
    if (!metadata) return null;

    const { quality_label, fps, audio_channels } = metadata;
    const quality = normalizeQualityLabel(quality_label);
    const audio = normalizeAudioChannels(audio_channels);

    const hasRes = Boolean(effectiveShowResolution && quality);
    const hasFps = Boolean(effectiveShowFps && fps > 0);
    const hasSound = Boolean(effectiveShowSound && audio);

    if (!hasRes && !hasFps && !hasSound) return null;

    if (variant === 'compact') {
        return (
            <div className="metadata-badge compact">
                {hasRes && <span className="quality">{quality}</span>}
            </div>
        );
    }

    return (
        <div className="metadata-badge detailed">
            {hasRes && <span className="quality">{quality}</span>}
            {hasFps && <span className="fps">{Math.round(fps)}{epgMetadataBadgeFpsSuffix ? 'fps' : ''}</span>}
            {hasSound && <span className="audio">{audio}</span>}
        </div>
    );
}
