import { useEffect, useState } from 'react';
import { getChannelMetadata } from '../services/video-metadata';
import type { ChannelMetadata } from '../db';
import { dbEvents } from '../db/sqlite-adapter';
import './MetadataBadge.css';

interface MetadataBadgeProps {
    streamId: string;
    variant?: 'compact' | 'detailed';
}

/**
 * MetadataBadge - Displays video quality, FPS, and audio channel info
 * Automatically refreshes when metadata is updated in the database
 */
export function MetadataBadge({ streamId, variant = 'compact' }: MetadataBadgeProps) {
    const [metadata, setMetadata] = useState<ChannelMetadata | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    // Load metadata on mount and when streamId or refreshKey changes
    useEffect(() => {
        getChannelMetadata(streamId).then(setMetadata);
    }, [streamId, refreshKey]);

    // Listen to database updates for channelMetadata table
    useEffect(() => {
        const handleDbUpdate = (event: { tableName: string; type: string }) => {
            if (event.tableName === 'channelMetadata') {
                // Trigger a refresh by incrementing the key
                setRefreshKey(prev => prev + 1);
            }
        };

        const unsubscribe = dbEvents.subscribe(handleDbUpdate);
        return unsubscribe;
    }, []);

    if (!metadata) return null;

    const { quality_label, fps, audio_channels } = metadata;

    if (variant === 'compact') {
        return (
            <div className="metadata-badge compact">
                <span className="quality">{quality_label}</span>
            </div>
        );
    }

    return (
        <div className="metadata-badge detailed">
            <span className="quality">{quality_label}</span>
            {fps > 0 && <span className="fps">{Math.round(fps)}fps</span>}
            {audio_channels && <span className="audio">{audio_channels}</span>}
        </div>
    );
}
