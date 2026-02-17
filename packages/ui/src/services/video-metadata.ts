import { Bridge } from './tauri-bridge';
import { db, ChannelMetadata } from '../db';

/**
 * Video metadata capture service
 * Captures resolution, fps, and audio information from MPV player
 */

export interface VideoMetadata {
    width: number;
    height: number;
    fps: number;
    audioChannels: number;
}

/**
 * Capture current video metadata from MPV
 */
export async function captureVideoMetadata(): Promise<VideoMetadata | null> {
    try {
        // Get video properties from MPV
        const width = await Bridge.getProperty('width');
        const height = await Bridge.getProperty('height');
        const fps = await Bridge.getProperty('estimated-vf-fps');
        const audioParams = await Bridge.getProperty('audio-params');

        // audio-params might be null if audio isn't loaded yet
        const audioChannels = audioParams?.channels || 2;

        return {
            width: width || 0,
            height: height || 0,
            fps: fps || 0,
            audioChannels
        };
    } catch (error) {
        console.error('[VideoMetadata] Failed to capture:', error);
        return null;
    }
}

/**
 * Convert resolution to quality label
 */
export function getQualityLabel(width: number, height: number): string {
    if (width >= 3840 || height >= 2160) return '4K';
    if (width >= 1920 || height >= 1080) return '1080p';
    if (width >= 1280 || height >= 720) return '720p';
    return 'SD';
}

/**
 * Format audio channels to human-readable string
 */
export function formatAudioChannels(channels: number): string {
    if (channels >= 6) return '5.1';
    if (channels === 2) return 'STEREO';
    if (channels === 1) return 'MONO';
    return `${channels}CH`;
}

/**
 * Save channel metadata to database
 */
export async function saveChannelMetadata(
    streamId: string,
    sourceId: string,
    metadata: VideoMetadata
): Promise<void> {
    const channelMetadata: ChannelMetadata = {
        stream_id: streamId,
        source_id: sourceId,
        resolution_width: metadata.width,
        resolution_height: metadata.height,
        fps: metadata.fps,
        audio_channels: formatAudioChannels(metadata.audioChannels),
        quality_label: getQualityLabel(metadata.width, metadata.height),
        last_updated: new Date().toISOString()
    };

    await db.channelMetadata.put(channelMetadata);
    console.log(`[VideoMetadata]  Saved for ${streamId}:`, channelMetadata);
}

/**
 * Get channel metadata from database
 */
export async function getChannelMetadata(streamId: string): Promise<ChannelMetadata | null> {
    try {
        const metadata = await db.channelMetadata.get(streamId);
        return metadata || null;
    } catch (error) {
        console.error('[VideoMetadata] Failed to get metadata:', error);
        return null;
    }
}

/**
 * Capture and save metadata for currently playing channel
 * Should be called after video starts playing successfully
 */
export async function captureAndSaveMetadata(streamId: string, sourceId: string): Promise<void> {
    // Wait a bit for video to load and properties to be available
    await new Promise(resolve => setTimeout(resolve, 2000));

    const metadata = await captureVideoMetadata();
    if (metadata && metadata.width > 0) {
        await saveChannelMetadata(streamId, sourceId, metadata);
    } else {
        console.warn('[VideoMetadata] No valid metadata captured for', streamId);
    }
}
