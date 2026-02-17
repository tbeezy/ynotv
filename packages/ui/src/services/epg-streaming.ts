/**
 * Streaming EPG Parser Service
 *
 * Provides high-performance EPG parsing with real-time progress updates.
 * Replaces the old synchronous EPG parsing that blocked the UI.
 *
 * Features:
 * - Streaming download and parse
 * - Real-time progress callbacks
 * - Batch database insertion
 * - Memory efficient (no loading entire XML into RAM)
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { bulkOps } from './bulk-ops';

// Re-export types from Rust
export interface ChannelMapping {
  epg_channel_id: string;
  stream_id: string;
}

export interface EpgParseProgress {
  source_id: string;
  phase: 'downloading' | 'parsing' | 'inserting' | 'complete';
  bytes_downloaded: number;
  total_bytes: number | null;
  programs_parsed: number;
  programs_matched: number;
  programs_inserted: number;
  estimated_remaining_seconds: number | null;
}

export interface EpgParseResult {
  source_id: string;
  total_programs: number;
  matched_programs: number;
  inserted_programs: number;
  unmatched_channels: number;
  duration_ms: number;
  bytes_processed: number;
}

// Progress callback type
export type EpgProgressCallback = (progress: EpgParseProgress) => void;

/**
 * Stream parse EPG from URL with progress updates
 *
 * @param sourceId - Source identifier
 * @param epgUrl - URL to the EPG XML file
 * @param channelMappings - Map of EPG channel IDs to stream_ids
 * @param onProgress - Optional callback for progress updates
 * @returns Parse result with statistics
 *
 * @example
 * ```typescript
 * const result = await streamParseEpg(
 *   'source123',
 *   'http://example.com/epg.xml',
 *   [{ epg_channel_id: 'bbc1', stream_id: 'source123_1' }],
 *   (progress) => console.log(`${progress.programs_parsed} programs parsed`)
 * );
 * ```
 */
export async function streamParseEpg(
  sourceId: string,
  epgUrl: string,
  channelMappings: ChannelMapping[],
  onProgress?: EpgProgressCallback
): Promise<EpgParseResult> {
  // Set up progress listener
  let unsubscribe: (() => void) | null = null;

  if (onProgress) {
    const listener = await listen<EpgParseProgress>('epg:parse_progress', (event) => {
      if (event.payload.source_id === sourceId) {
        onProgress(event.payload);
      }
    });
    unsubscribe = listener;
  }

  try {
    console.time(`stream-parse-epg-${sourceId}`);

    const result = await invoke<EpgParseResult>('stream_parse_epg', {
      sourceId,
      epgUrl,
      channelMappings,
    });

    console.timeEnd(`stream-parse-epg-${sourceId}`);
    console.log(
      `[Streaming EPG] Complete: ${result.matched_programs}/${result.total_programs} programs ` +
      `matched and ${result.inserted_programs} inserted in ${result.duration_ms}ms`
    );

    return result;
  } finally {
    if (unsubscribe) {
      unsubscribe();
    }
  }
}

/**
 * Parse EPG from local file with progress updates
 *
 * @param sourceId - Source identifier
 * @param filePath - Path to the local EPG XML file
 * @param channelMappings - Map of EPG channel IDs to stream_ids
 * @param onProgress - Optional callback for progress updates
 * @returns Parse result with statistics
 */
export async function parseEpgFile(
  sourceId: string,
  filePath: string,
  channelMappings: ChannelMapping[],
  onProgress?: EpgProgressCallback
): Promise<EpgParseResult> {
  // Set up progress listener
  let unsubscribe: (() => void) | null = null;

  if (onProgress) {
    const listener = await listen<EpgParseProgress>('epg:parse_progress', (event) => {
      if (event.payload.source_id === sourceId) {
        onProgress(event.payload);
      }
    });
    unsubscribe = listener;
  }

  try {
    console.time(`parse-epg-file-${sourceId}`);

    const result = await invoke<EpgParseResult>('parse_epg_file', {
      sourceId,
      filePath,
      channelMappings,
    });

    console.timeEnd(`parse-epg-file-${sourceId}`);
    console.log(
      `[Local EPG] Complete: ${result.matched_programs}/${result.total_programs} programs ` +
      `matched and ${result.inserted_programs} inserted in ${result.duration_ms}ms`
    );

    return result;
  } finally {
    if (unsubscribe) {
      unsubscribe();
    }
  }
}

/**
 * Create channel mappings from channels array
 * Extracts epg_channel_id from channels and maps to stream_id
 */
export function createChannelMappings(
  channels: Array<{ stream_id: string; epg_channel_id?: string }>
): ChannelMapping[] {
  return channels
    .filter((ch) => ch.epg_channel_id)
    .map((ch) => ({
      epg_channel_id: ch.epg_channel_id!,
      stream_id: ch.stream_id,
    }));
}

/**
 * Format progress for display
 * Creates a human-readable progress message
 */
export function formatProgress(progress: EpgParseProgress): string {
  const phaseLabels: Record<string, string> = {
    downloading: 'Downloading',
    parsing: 'Parsing XML',
    inserting: 'Inserting to DB',
    complete: 'Complete',
  };

  const phase = phaseLabels[progress.phase] || progress.phase;
  const percent = progress.total_bytes
    ? Math.round((progress.bytes_downloaded / progress.total_bytes) * 100)
    : null;

  let message = `[${phase}]`;

  if (percent !== null) {
    message += ` ${percent}%`;
  }

  message += ` ${progress.programs_parsed.toLocaleString()} programs parsed`;

  if (progress.programs_matched > 0) {
    message += `, ${progress.programs_matched.toLocaleString()} matched`;
  }

  if (progress.programs_inserted > 0) {
    message += `, ${progress.programs_inserted.toLocaleString()} inserted`;
  }

  if (
    progress.estimated_remaining_seconds !== null &&
    progress.estimated_remaining_seconds > 0
  ) {
    const mins = Math.ceil(progress.estimated_remaining_seconds / 60);
    message += ` (~${mins}m remaining)`;
  }

  return message;
}

// Export all functions as a namespace
export const epgStreaming = {
  streamParseEpg,
  parseEpgFile,
  createChannelMappings,
  formatProgress,
};

export default epgStreaming;
