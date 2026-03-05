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

/** Extra options for catchup / timeshift URLs (Xtream only) */
export interface CatchupOptions {
    /** Raw stream ID (source-prefix already stripped, e.g. "12345") */
    rawStreamId: string;
    /** Start time of the programme in milliseconds */
    startTimeMs: number;
    /** Requested duration of the programme in minutes */
    durationMinutes: number;
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
 * Resolve a raw stream URL (which may be a Stalker opaque token or a Xtream
 * catchup URL) into a concrete, playable HTTP URL.
 *
 * @param sourceId   The source ID to look up from window.storage
 * @param rawUrl     The direct_url / URL string to resolve
 * @param catchup    Pass this for Xtream catchup (timeshift) URLs only
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

    const userAgent: string | undefined = sourceData.user_agent || undefined;
    const sourceName: string | null = sourceData.name ?? null;
    let resolvedUrl = rawUrl;

    // ── Stalker sources ──────────────────────────────────────────────────────
    // Stalker URLs are opaque tokens like "stalker_ch:12345" or "/media/…"
    // and must be resolved to a real HTTP URL via the Stalker portal API.
    if (
        sourceData.type === 'stalker' &&
        (rawUrl.startsWith('stalker_') || rawUrl.startsWith('/media/'))
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
        resolvedUrl = await client.resolveStreamUrl(rawUrl);
        return { url: resolvedUrl, userAgent, sourceName };
    }

    // ── Xtream catchup / timeshift ───────────────────────────────────────────
    // For catchup playback on Xtream sources, we must build a special timeshift
    // URL. This only applies when the caller provides `catchup` options.
    if (sourceData.type === 'xtream' && catchup) {
        const { XtreamClient } = await import('@ynotv/local-adapter');
        const { rawStreamId, startTimeMs, durationMinutes } = catchup;

        // Re-calculate the maximum allowed duration (EPG start → now, capped)
        const endMs = startTimeMs + durationMinutes * 60_000;
        const actualDurationMinutes = Math.ceil(
            (Math.min(endMs, Date.now()) - startTimeMs) / 60_000,
        );

        resolvedUrl = XtreamClient.buildTimeshiftUrl(
            rawStreamId,
            sourceData.url,
            sourceData.username || '',
            sourceData.password || '',
            actualDurationMinutes,
            new Date(startTimeMs),
        );
        return { url: resolvedUrl, userAgent, sourceName };
    }

    // ── All other source types (M3U, plain Xtream live) ─────────────────────
    // No URL transformation needed; just return with the userAgent + name.
    return { url: resolvedUrl, userAgent, sourceName };
}
