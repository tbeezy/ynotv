/**
 * stream-resolver.ts
 *
 * Shared utility for resolving IPTV stream URLs before handing them to MPV.
 *
 * Previously this logic was duplicated in 4 places inside App.tsx:
 *   - handleLoadStream   (Live TV)
 *   - handlePlayCatchup  (Live TV catchup / timeshift)
 *   - handlePlayVod      (VOD movies / series)
 *   - dvr:resolve_url_now event handler (DVR Stalker URL pre-resolution)
 *
 * All 4 callers now call resolvePlayUrl() instead.
 */

import { StalkerClient } from '@ynotv/local-adapter';
import { useSettingsStore } from '../stores/settingsStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The shape of a source as returned by window.storage.getSource() */
interface SourceData {
    id: string;
    type: 'xtream' | 'm3u' | 'stalker' | 'epg';
    url: string;
    username?: string;
    password?: string;
    mac?: string;
    user_agent?: string;
    name?: string;
}

/** Extra options for catchup / timeshift URLs */
export interface CatchupOptions {
    /** Raw stream ID (source-prefix already stripped, e.g. "12345") */
    rawStreamId: string;
    /** Start time of the programme in milliseconds */
    startTimeMs: number;
    /** Requested duration of the programme in minutes */
    durationMinutes: number;
    /** M3U catchup-source template string (e.g. "http://...?start={utc}") */
    catchupSource?: string;
    /** M3U catchup mode/type (e.g. "default", "append", "flussonic", "shift") */
    catchupType?: string;
    /** Number of catchup days available */
    catchupDays?: number;
    /** EPG channel ID or stream identifier for placeholder substitution */
    epgChannelId?: string;
}

/** Result returned by resolvePlayUrl */
export interface ResolvedUrl {
    /** The final, playable URL to pass to MPV */
    url: string;
    /** Custom User-Agent, if the source defines one */
    userAgent?: string;
    /** Source name (for multiview display label) */
    sourceName?: string | null;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a raw stream URL (which may be a Stalker opaque token, Xtream catchup URL,
 * or M3U catchup template) into a concrete, playable HTTP URL.
 *
 * @param sourceId   The source ID to look up from window.storage
 * @param rawUrl     The direct_url / URL string to resolve
 * @param catchup    Pass this for catchup (timeshift) URLs only
 * @returns          Resolved URL + optional userAgent + optional sourceName
 *
 * @throws           If the Stalker client cannot resolve the URL (callers
 *                   should catch and show an error to the user).
 */
export async function resolvePlayUrl(
    sourceId: string | null | undefined,
    rawUrl: string,
    catchup?: CatchupOptions,
): Promise<ResolvedUrl> {
    // No storage API → nothing to resolve
    if (!window.storage || !sourceId) {
        return { url: rawUrl };
    }

    (window as any).isPlaybackResolving = true;
    (window as any).lastPlaybackTime = Date.now();

    try {
        let sourceData: SourceData | undefined;
        try {
            const sourceRes = await window.storage.getSource(sourceId);
            sourceData = sourceRes.data ?? undefined;
        } catch (e) {
            console.error('[stream-resolver] Failed to fetch source:', e);
            return { url: rawUrl };
        }

        if (!sourceData) {
            return { url: rawUrl };
        }

        let userAgent: string | undefined = sourceData.user_agent || undefined;
        if (!userAgent) {
            try {
                // globalLiveTvUserAgent is a settings-store field — read it
                // synchronously instead of an IPC round-trip per stream resolve.
                const globalUa = useSettingsStore.getState().globalLiveTvUserAgent;
                if (globalUa && globalUa.trim()) {
                    userAgent = globalUa.trim();
                }
            } catch (e) {
                console.error('[stream-resolver] Failed to load global user agent settings:', e);
            }
        }
        if (!userAgent) {
            if (sourceData.type === 'stalker') {
                userAgent = 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3';
            } else if (sourceData.type === 'xtream' || sourceData.type === 'm3u') {
                userAgent = 'VLC/3.0.18 LibVLC/3.0.18';
            }
        }
        const sourceName: string | null = sourceData.name ?? null;
        let resolvedUrl = rawUrl;

        // ── Stalker sources ──────────────────────────────────────────────────────
        // Stalker URLs are opaque tokens like "stalker_ch:12345" or "/media/…"
        // and must be resolved to a real HTTP URL via the Stalker portal API.
        if (
            sourceData.type === 'stalker' &&
            (rawUrl.startsWith('stalker_') || rawUrl.startsWith('/media/') || catchup != null)
        ) {
            const client = new StalkerClient(
                {
                    baseUrl: sourceData.url,
                    mac: sourceData.mac || '',
                    userAgent: sourceData.user_agent,
                },
                sourceData.id,
            );

            // resolveStreamUrl() throws on network / auth failure — caller handles it
            const stalkerCatchup = catchup
                ? {
                      startTimeMs: catchup.startTimeMs,
                      durationMinutes: catchup.durationMinutes,
                  }
                : undefined;
            resolvedUrl = await client.resolveStreamUrl(rawUrl, stalkerCatchup);
            return { url: resolvedUrl, userAgent, sourceName };
        }

        // ── M3U Catchup (catchup-source template or catchup type) ────────────────
        if (catchup && catchup.catchupSource && catchup.catchupSource.trim().length > 0) {
            const { buildM3uCatchupUrl } = await import('@ynotv/local-adapter');
            resolvedUrl = buildM3uCatchupUrl({
                catchupSource: catchup.catchupSource,
                catchupType: catchup.catchupType,
                directUrl: rawUrl,
                startTimeMs: catchup.startTimeMs,
                durationMinutes: catchup.durationMinutes,
                epgChannelId: catchup.epgChannelId,
            });
            console.log(`[stream-resolver] M3U Catchup resolved URL via catchup-source: ${resolvedUrl}`);
            return { url: resolvedUrl, userAgent, sourceName };
        }

        // ── Xtream catchup / timeshift ───────────────────────────────────────────
        // For catchup playback on non-Stalker sources, build a timeshift URL when catchup options are provided.
        if (catchup && sourceData.type !== 'stalker') {
            const { XtreamClient } = await import('@ynotv/local-adapter');
            const { rawStreamId, startTimeMs, durationMinutes } = catchup;

            // Determine XC credentials:
            // 1. From xtream_catchup config on M3U source
            // 2. From source properties (Xtream source)
            // 3. Fallback: extract credentials & stream_id from rawUrl (e.g. http://server:port/live/user/pass/stream_id.ts or /user/pass/stream_id)
            const xtreamCatchup = (sourceData as any).xtream_catchup;
            let xcUrl = xtreamCatchup?.url || sourceData.url || '';
            let xcUsername = xtreamCatchup?.username || sourceData.username || '';
            let xcPassword = xtreamCatchup?.password || sourceData.password || '';
            let streamId = rawStreamId;

            if ((!xcUsername || !xcPassword || !xcUrl) && rawUrl.includes('://')) {
                const match = rawUrl.match(/^(https?:\/\/[^/]+)(?:\/live)?\/([^/]+)\/([^/]+)\/(\d+)(?:\.(?:ts|m3u8|m3u))?/i);
                if (match) {
                    xcUrl = xcUrl || match[1];
                    xcUsername = xcUsername || match[2];
                    xcPassword = xcPassword || match[3];
                    streamId = streamId || match[4];
                }
            }

            if (xcUrl && xcUsername && xcPassword && streamId) {
                // Use the requested program duration (plus any padding configured by caller)
                const actualDurationMinutes = Math.max(1, Math.ceil(durationMinutes));

                // Fetch server_info to calculate the precise timezone offset of the server
                let offsetMs = 0;
                try {
                    const client = new XtreamClient({
                        baseUrl: xcUrl,
                        username: xcUsername,
                        password: xcPassword,
                        userAgent: sourceData.user_agent,
                    }, sourceData.id);

                    const auth = await client.authenticate();
                    if (auth?.server_info?.time_now && auth?.server_info?.timestamp_now) {
                        // Parse time_now ("YYYY-MM-DD HH:MM:SS") assuming it's UTC to find the exact drift
                        const timeNowUtcStr = auth.server_info.time_now.replace(' ', 'T') + 'Z';
                        const timeNowUtcMs = new Date(timeNowUtcStr).getTime();
                        const actualUtcMs = auth.server_info.timestamp_now * 1000;

                        if (!isNaN(timeNowUtcMs) && !isNaN(actualUtcMs)) {
                            offsetMs = timeNowUtcMs - actualUtcMs;
                            console.log(`[stream-resolver] Calculated Xtream server timezone offset: ${offsetMs / 3600000} hours`);
                        }
                    }
                } catch (e) {
                    console.warn('[stream-resolver] Failed to fetch server info for timezone offset:', e);
                }

                const serverTimeMs = startTimeMs + offsetMs;

                resolvedUrl = XtreamClient.buildTimeshiftUrl(
                    streamId,
                    xcUrl,
                    xcUsername,
                    xcPassword,
                    actualDurationMinutes,
                    new Date(serverTimeMs),
                );
                console.log(`[stream-resolver] Catchup URL: ${resolvedUrl}`);
                console.log(`[stream-resolver] Catchup details:`, {
                    sourceType: sourceData.type,
                    xcUrl,
                    streamId,
                    actualDurationMinutes,
                    serverTimeMs: new Date(serverTimeMs).toISOString(),
                    originalStartMs: new Date(startTimeMs).toISOString(),
                    offsetMs,
                });
                return { url: resolvedUrl, userAgent, sourceName };
            }

            // Fallback for non-Xtream M3U sources with catchupType (e.g. append, shift, flussonic)
            if (catchup.catchupType || sourceData.type === 'm3u') {
                const { buildM3uCatchupUrl } = await import('@ynotv/local-adapter');
                resolvedUrl = buildM3uCatchupUrl({
                    catchupSource: catchup.catchupSource,
                    catchupType: catchup.catchupType,
                    directUrl: rawUrl,
                    startTimeMs: catchup.startTimeMs,
                    durationMinutes: catchup.durationMinutes,
                    epgChannelId: catchup.epgChannelId,
                });
                console.log(`[stream-resolver] M3U Catchup resolved URL via catchupType fallback: ${resolvedUrl}`);
                return { url: resolvedUrl, userAgent, sourceName };
            }
        }

        // ── All other source types (M3U, plain Xtream live) ─────────────────────
        // No URL transformation needed; just return with the userAgent + name.
        return { url: resolvedUrl, userAgent, sourceName };
    } finally {
        (window as any).isPlaybackResolving = false;
    }
}
