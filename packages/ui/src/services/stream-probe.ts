/**
 * stream-probe.ts
 *
 * Frontend service bridge for channel stream probing, health verification,
 * and automatic channel metadata badge synchronization.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { db, type ChannelMetadata } from '../db';
import { dbEvents } from '../db/sqlite-adapter';

// ============================================================================
// Types
// ============================================================================

export type ChannelProbeStatus = 'alive' | 'dead' | 'geoblocked' | 'drm' | 'placeholder' | 'pending' | 'probing';

export interface ProbeChannelInput {
  stream_id: string;
  source_id: string;
  name: string;
  url: string;
  category_id?: string;
  category_name?: string;
  user_agent?: string;
}

export interface ProbeOptions {
  concurrency?: number;
  timeout_secs?: number;
  max_retries?: number;
  capture_screenshots?: boolean;
  screenshots_dir?: string;
  auto_save_badges?: boolean;
}

export interface ProbeChannelResult {
  stream_id: string;
  source_id: string;
  name: string;
  url: string;
  category_id?: string;
  category_name?: string;
  status: ChannelProbeStatus;
  http_status?: number;
  latency_ms?: number;
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  video_codec?: string;
  hdr_format?: string;
  audio_codec?: string;
  audio_channels?: string;
  quality_label?: string;
  bitrate_kbps?: number;
  screenshot_path?: string;
  error_reason?: string;
}

export interface ProbeProgress {
  current: number;
  total: number;
  alive: number;
  dead: number;
  geoblocked: number;
  drm: number;
  placeholder: number;
  channels_per_sec: number;
  elapsed_ms: u64number;
  eta_secs?: number;
  active_stream_name?: string;
}

type u64number = number;

export interface ProbeSummary {
  total: number;
  alive: number;
  dead: number;
  geoblocked: number;
  drm: number;
  placeholder: number;
  quality_4k: number;
  quality_1080p: number;
  quality_720p: number;
  quality_sd: number;
  avg_latency_ms?: number;
  elapsed_ms: number;
  health_score: number; // 0.0 - 10.0
}

export interface FfmpegStatus {
  available: boolean;
  binary_path?: string;
  version?: string;
}

export interface ProbeCallbacks {
  onProgress?: (progress: ProbeProgress) => void;
  onBatch?: (batch: ProbeChannelResult[]) => void;
  onFinished?: (summary: ProbeSummary) => void;
  onError?: (error: string) => void;
}

export interface ProbeSessionController {
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  cleanup: () => void;
}

// ============================================================================
// Service APIs
// ============================================================================

/**
 * Check if the bundled or system FFmpeg binary is available for stream probing
 */
export async function checkProbeFfmpegStatus(): Promise<FfmpegStatus> {
  try {
    return await invoke<FfmpegStatus>('check_probe_ffmpeg_status');
  } catch (err) {
    console.error('[StreamProbe] Failed to check FFmpeg status:', err);
    return { available: false };
  }
}

/**
 * Fast probe of a single stream URL
 */
export async function probeSingleStream(
  url: string,
  userAgent?: string,
  timeoutSecs?: number
): Promise<ProbeChannelResult> {
  return await invoke<ProbeChannelResult>('probe_single_stream', {
    url,
    userAgent,
    timeoutSecs,
  });
}

/**
 * Pause the active channel probe
 */
export async function pauseChannelProbe(): Promise<void> {
  await invoke('pause_channel_probe');
}

/**
 * Resume the paused channel probe
 */
export async function resumeChannelProbe(): Promise<void> {
  await invoke('resume_channel_probe');
}

/**
 * Cancel the active channel probe
 */
export async function cancelChannelProbe(): Promise<void> {
  await invoke('cancel_channel_probe');
}

/**
 * Start a multi-threaded batch channel probe session
 */
export async function startChannelProbe(
  channels: ProbeChannelInput[],
  options: ProbeOptions = {},
  callbacks: ProbeCallbacks = {}
): Promise<ProbeSessionController> {
  const unlistens: UnlistenFn[] = [];

  // Register Tauri event listeners
  if (callbacks.onProgress) {
    const unlistenProgress = await listen<ProbeProgress>('probe:progress', (event) => {
      callbacks.onProgress?.(event.payload);
    });
    unlistens.push(unlistenProgress);
  }

  const unlistenBatch = await listen<ProbeChannelResult[]>('probe:batch', async (event) => {
    const batch = event.payload;
    callbacks.onBatch?.(batch);

    // If auto-save badges is enabled, persist metadata directly
    if (options.auto_save_badges !== false) {
      saveProbedMetadataToDb(batch).catch((e) => {
        console.error('[StreamProbe] Error auto-saving batch metadata:', e);
      });
    }
  });
  unlistens.push(unlistenBatch);

  if (callbacks.onFinished) {
    const unlistenFinished = await listen<ProbeSummary>('probe:finished', (event) => {
      callbacks.onFinished?.(event.payload);
    });
    unlistens.push(unlistenFinished);
  }

  const cleanup = () => {
    for (const unlisten of unlistens) {
      unlisten();
    }
    unlistens.length = 0;
  };

  try {
    await invoke('start_channel_probe', {
      channels,
      options: {
        concurrency: options.concurrency ?? 1,
        timeout_secs: options.timeout_secs ?? 8.0,
        max_retries: options.max_retries ?? 3,
        capture_screenshots: options.capture_screenshots ?? false,
        screenshots_dir: options.screenshots_dir,
        auto_save_badges: options.auto_save_badges ?? true,
      },
    });
  } catch (err) {
    cleanup();
    const errMsg = typeof err === 'string' ? err : String(err);
    callbacks.onError?.(errMsg);
    throw err;
  }

  return {
    pause: pauseChannelProbe,
    resume: resumeChannelProbe,
    cancel: async () => {
      await cancelChannelProbe();
      cleanup();
    },
    cleanup,
  };
}

/**
 * Save probed metadata directly to SQLite channelMetadata table and notify UI
 */
export async function saveProbedMetadataToDb(results: ProbeChannelResult[]): Promise<number> {
  const validItems = results.filter(
    (r) => r.status === 'alive' && (r.quality_label || r.resolution || (r.width && r.height) || r.fps || r.audio_channels)
  );

  if (validItems.length === 0) return 0;

  const nowIso = new Date().toISOString();
  const dbItems = validItems.map((r) => ({
    stream_id: r.stream_id,
    source_id: r.source_id,
    resolution_width: r.width ?? (r.resolution === '4K' ? 3840 : r.resolution === '1080p' ? 1920 : r.resolution === '720p' ? 1280 : null),
    resolution_height: r.height ?? (r.resolution === '4K' ? 2160 : r.resolution === '1080p' ? 1080 : r.resolution === '720p' ? 720 : null),
    fps: r.fps ?? null,
    audio_channels: r.audio_channels ?? 'Stereo',
    quality_label: r.quality_label || r.resolution || (r.width && r.height ? (r.width >= 3840 ? '4K' : r.width >= 1920 ? '1080p' : r.width >= 1280 ? '720p' : 'SD') : 'SD'),
    last_updated: nowIso,
  }));

  try {
    // Try fast Rust bulk upsert first
    await invoke('bulk_upsert_channel_metadata', { items: dbItems });
  } catch (err) {
    // Fall back to SqliteTable bulk put in JS adapter
    console.warn('[StreamProbe] Rust bulk upsert fallback to JS SQLite put:', err);
    for (const item of dbItems) {
      await db.channelMetadata.put(item as ChannelMetadata);
    }
  }

  // Emit event so all MetadataBadge components re-render immediately
  dbEvents.notify('channelMetadata', 'update');
  return dbItems.length;
}

/**
 * Calculate Playlist / Channel Score (0.0 to 10.0) from probe results
 */
export function computeProbeHealthScore(results: ProbeChannelResult[]): {
  overall: number;
  pingScore: number;
  qualityScore: number;
  livenessScore: number;
  statusLabel: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Critical';
} {
  if (results.length === 0) {
    return { overall: 0, pingScore: 0, qualityScore: 0, livenessScore: 0, statusLabel: 'Critical' };
  }

  const total = results.length;
  const alive = results.filter((r) => r.status === 'alive');
  const aliveRatio = alive.length / total;
  const livenessScore = Math.round(aliveRatio * 100) / 10;

  // Latency score
  const latencies = alive.map((r) => r.latency_ms).filter((l): l is number => typeof l === 'number');
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 1200;
  const pingScore = Math.max(0, Math.min(10, Math.round(((1200 - avgLatency) / 110) * 10) / 10));

  // Quality score
  let qualityScore = 0;
  if (alive.length > 0) {
    const q4k = alive.filter((r) => r.quality_label === '4K' || r.resolution === '4K').length;
    const q1080 = alive.filter((r) => r.quality_label === '1080p' || r.resolution === '1080p').length;
    const q720 = alive.filter((r) => r.quality_label === '720p' || r.resolution === '720p').length;
    const highFps = alive.filter((r) => (r.fps ?? 0) >= 50).length;

    const hdRatio = (q4k * 1.0 + q1080 * 0.9 + q720 * 0.75) / alive.length;
    const fpsRatio = highFps / alive.length;
    qualityScore = Math.min(10, Math.round((hdRatio * 0.7 + fpsRatio * 0.3) * 100) / 10);
  }

  const overall = Math.max(0, Math.min(10, Math.round((livenessScore * 0.5 + qualityScore * 0.3 + pingScore * 0.2) * 10) / 10));

  let statusLabel: 'Excellent' | 'Good' | 'Fair' | 'Poor' | 'Critical' = 'Critical';
  if (overall >= 8.5) statusLabel = 'Excellent';
  else if (overall >= 7.0) statusLabel = 'Good';
  else if (overall >= 5.0) statusLabel = 'Fair';
  else if (overall >= 3.0) statusLabel = 'Poor';

  return {
    overall,
    pingScore,
    qualityScore,
    livenessScore,
    statusLabel,
  };
}
