import type { Channel, Category, Season, Episode } from '@ynotv/core';
import CryptoJS from 'crypto-js';
import { universalFetch, universalFetchJson } from './fetch-utils';
import {
    STALKER_MAX_RETRIES,
    STALKER_TIMEOUT_MS,
    STALKER_RETRY_BACKOFF_BASE_MS,
    STALKER_TOKEN_VALIDITY_SECONDS,
    STALKER_MAX_HANDSHAKE_ATTEMPTS,
    STALKER_HANDSHAKE_RETRY_DELAY_MS,
} from './stalker-constants';

export interface StalkerConfig {
    baseUrl: string;
    mac: string;
    userAgent?: string;
}

export interface StalkerHandshakeResponse {
    js: {
        token: string;
    };
}

interface StalkerResponse<T> {
    js: T;
}

/**
 * Progress reported while paginating a Stalker VOD/series category.
 * currentPage/totalPages are 1-indexed and only set once known — Stalker
 * portals that return `total_items`/`pages` metadata enable the "Page X of Y"
 * display; portals that don't get an indeterminate "Page X" instead.
 */
export type StalkerPageProgress = (
    percent: number,
    currentPage?: number,
    totalPages?: number
) => void;

interface StalkerGenre {
    id: string;
    title: string;
    alias?: string;
    censored?: string | number;
}

export interface StalkerCatchupOptions {
    startTimeMs: number;
    durationMinutes: number;
    programId?: string;
}

/**
 * Options for a portal-side VOD/series search.
 *
 * `fromPage`/`maxPages` are expressed in portal *pages*, not items. Stalker
 * portals page `get_ordered_list` at ~14 items (`max_page_items`), so a batch
 * of 4 pages is roughly 56 results — one row of posters is 6-8 items, which is
 * why a caller should never load a single page at a time.
 */
export interface StalkerSearchOptions {
    /** Category as stored by the app (`{sourceId}_vod_123`); undefined/`*` = the whole library. */
    categoryId?: string;
    /** 0-based data page to resume from (default 0). Use `nextPage` from a previous call. */
    fromPage?: number;
    /** Pages to fetch in this call (default 4). */
    maxPages?: number;
    /**
     * The phrase a previous call committed to (`phrase` from its result), needed when
     * `fromPage` > 0. The verbatim fallback below only runs on the first page, so a
     * resuming caller that omits this sends the user's words again — which is exactly
     * the phrase that returned nothing in the first place.
     */
    phrase?: string;
    /**
     * The endpoint a previous call committed to (`endpoint` from its result), needed when
     * `fromPage` > 0 and the caller is `searchSeries`. A series search falls back from
     * `type=series` to `type=vod` on the first page, and that choice has to survive the
     * resume: re-running the fallback would ask the VOD endpoint for its page N — a
     * different result set's page N — and on a portal with no `type=series` at all it
     * would spend a request proving that again on every page.
     */
    endpoint?: StalkerSearchEndpoint;
    onProgress?: (info: { page: number; loaded: number; total?: number }) => void;
}

/** Which portal endpoint a search walk ran against. */
export type StalkerSearchEndpoint = 'vod' | 'series';

/** One bounded walk of a searched `get_ordered_list` — internal to the search API. */
interface StalkerSearchWalk {
    items: any[];
    total: number;
    /** Items collected by this walk, before any local narrowing. */
    loadedCount: number;
    /** 0-based data page a caller should resume from. */
    nextPage: number;
    /** The last page fetched was a full page, so more pages may exist. */
    lastPageFull: boolean;
}

/** Result of one bounded search walk. */
export interface StalkerSearchResult {
    items: Channel[];
    /** The provider's own total for the phrase that was actually sent. */
    total: number;
    /** 0-based data page to pass back as `fromPage` to continue the walk. */
    nextPage: number;
    hasMore: boolean;
    /**
     * The portal answered as though no `search` were sent (its totals match an
     * unsearched call) — some middlewares simply ignore the parameter.
     */
    unsupported: boolean;
    /**
     * The phrase actually sent. Differs from the query when the full phrase
     * matched nothing and a wider form of it was retried instead, so the caller
     * can say what was searched — and pass it back as `phrase` to resume.
     */
    phrase: string;
    /**
     * How `phrase` relates to what the user typed, so a caller can say which one it got.
     *
     * - `verbatim`: the words as typed were found in that order, side by side.
     * - `all-words`: the same words found in that order with anything allowed between
     *   them (the portal's `%` wildcard did the filtering server-side).
     * - `word`: only the query's longest word was searched, and the rest were applied
     *   locally.
     */
    matchKind: StalkerSearchMatchKind;
    /**
     * Which endpoint this walk actually ran against, to pass back as `endpoint` to resume.
     * A series search settles this on its first page (see `searchSeries`) and must not be
     * guessed at again mid-walk.
     */
    endpoint: StalkerSearchEndpoint;
}

export type StalkerSearchMatchKind = 'verbatim' | 'all-words' | 'word';

export class StalkerClient {
    // Shared tokens and refresh promises across all client instances of a source
    private static globalTokens = new Map<string, { token: string; timestamp: number }>();
    private static globalRefreshPromises = new Map<string, Promise<void>>();

    private config: StalkerConfig;
    private sourceId: string;
    private token: string | null = null;
    private tokenTimestamp: number = 0;
    private random: string = '';
    private serial: string = '';
    private deviceId: string = ''; // SHA256 of MAC
    private deviceId2: string = '';
    private originalUrl: string = ''; // Store original URL for fallback attempts
    private fallbackUrls: string[] = []; // List of URLs to try
    private tokenRefreshPromise: Promise<void> | null = null; // Lock to prevent concurrent token refreshes
    // Learned page-numbering offset for get_ordered_list (0 = portal is 0-based, 1 = portal is
    // 1-based and coerces p=0 into page 1). null until the first fetch determines it.
    private pageOffset: 0 | 1 | null = null;
    /**
     * Whether this portal passes `%` through to its own `LIKE` (see `wildcardPhrase`).
     * `null` until something has actually been observed, so a portal that treats the
     * character literally pays for the discovery once rather than on every search.
     */
    private searchWildcards: boolean | null = null;

    /**
     * Normalize Stalker censored/lock fields to boolean.
     * Stalker APIs inconsistently return censored as "1", 1, 0, or "".
     */
    private isCensored(censored?: string | number, lock?: number): boolean {
        return censored === 1 || censored === '1' || lock === 1;
    }

    constructor(config: StalkerConfig, sourceId: string) {
        this.sourceId = sourceId;
        this.originalUrl = config.baseUrl.replace(/\/+$/, '');

        // Generate list of fallback URLs to try in order
        this.fallbackUrls = this.generateFallbackUrls(this.originalUrl);

        // Start with the first fallback URL
        this.config = {
            ...config,
            baseUrl: this.fallbackUrls[0],
        };

        console.log(`[Stalker] Original URL: ${this.originalUrl}`);
        console.log(`[Stalker] Trying: ${this.config.baseUrl}`);
        console.log(`[Stalker] Fallback URLs available: ${this.fallbackUrls.slice(1).join(', ') || 'none'}`);

        // Initialize device identity
        this.serial = this.generateSerial(this.config.mac);
        this.deviceId = this.generateDeviceId(this.config.mac);
        this.deviceId2 = this.deviceId;
    }

    private generateSerial(mac: string): string {
        return CryptoJS.MD5(mac).toString().substring(0, 13).toUpperCase();
    }

    private generateDeviceId(mac: string): string {
        return CryptoJS.SHA256(mac).toString().toUpperCase();
    }

    private generateSignature(): string {
        const data = `${this.config.mac}${this.serial}${this.deviceId}${this.deviceId2}`;
        return CryptoJS.SHA256(data).toString().toUpperCase();
    }

    private generateRandomValue(): string {
        return CryptoJS.lib.WordArray.random(20).toString(CryptoJS.enc.Hex);
    }

    /**
     * Generates a list of fallback URLs to try in order
     * This allows automatic failover when one endpoint returns 404
     */
    private generateFallbackUrls(url: string): string[] {
        const urlObj = new URL(url.startsWith('http') ? url : `http://${url}`);
        const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
        const path = urlObj.pathname;

        const fallbacks: string[] = [];

        // Pattern 1: If URL ends with /c or /c/, try /portal.php first
        if (path === '/c' || path === '/c/') {
            fallbacks.push(`${baseUrl}/portal.php`);
            fallbacks.push(`${baseUrl}/stalker_portal/server/load.php`);
        }
        // Pattern 2: If URL contains /stalker_portal, prioritize that path
        else if (path.includes('/stalker_portal')) {
            if (path === '/stalker_portal' || path === '/stalker_portal/') {
                fallbacks.push(`${baseUrl}/stalker_portal/server/load.php`);
            } else if (path.endsWith('/c')) {
                fallbacks.push(url.replace(/\/stalker_portal\/c$/, '/stalker_portal/server/load.php'));
            } else {
                fallbacks.push(url); // Already has a path, keep it
            }
            fallbacks.push(`${baseUrl}/portal.php`);
        }
        // Pattern 3: Bare domain or root path - try common patterns
        else if (!path || path === '/') {
            fallbacks.push(`${baseUrl}/stalker_portal/server/load.php`);
            fallbacks.push(`${baseUrl}/portal.php`);
            fallbacks.push(`${baseUrl}/c/`);
        }
        // Pattern 4: Custom path - keep it and add common fallbacks
        else {
            fallbacks.push(url);
            fallbacks.push(`${baseUrl}/stalker_portal/server/load.php`);
            fallbacks.push(`${baseUrl}/portal.php`);
        }

        // Remove duplicates while preserving order
        return [...new Set(fallbacks)];
    }

    /**
     * Try the next fallback URL if available
     * Returns true if a fallback was available and applied
     */
    private tryNextFallbackUrl(): boolean {
        const currentIndex = this.fallbackUrls.indexOf(this.config.baseUrl);
        if (currentIndex >= 0 && currentIndex < this.fallbackUrls.length - 1) {
            this.config.baseUrl = this.fallbackUrls[currentIndex + 1];
            console.log(`[Stalker] Trying fallback URL: ${this.config.baseUrl}`);
            return true;
        }
        return false;
    }

    /**
     * Extract items + page metadata from a get_ordered_list response.
     * Most Stalker portals return `{ data: [...], total_items, max_page_items, pages }`
     * (wrapped in `js` by fetchStalker), which lets us show "Page X of Y" while
     * lazy-loading a category. Portals that omit the metadata just get an
     * indeterminate page count.
     */
    private extractOrderedList(raw: any): {
        items: any[];
        total_items?: number;
        max_page_items?: number;
        pages?: number;
    } {
        let obj = raw;
        // fetchStalker unwraps `js`, but some portals double-wrap: { js: { data: [...] } }
        if (obj && obj.js && Array.isArray(obj.js.data)) {
            obj = obj.js;
        }
        if (Array.isArray(obj)) {
            return { items: obj };
        }
        if (obj && Array.isArray(obj.data)) {
            return {
                items: obj.data,
                total_items: obj.total_items != null ? Number(obj.total_items) : undefined,
                max_page_items: obj.max_page_items != null ? Number(obj.max_page_items) : undefined,
                pages: obj.pages != null ? Number(obj.pages) : undefined,
            };
        }
        return { items: [] };
    }

    /**
     * Safely extract array data from Stalker API response
     * Python equivalent: safe_json_list()
     */
    private safeJsonList<T>(data: any, expectedKey: string = 'js'): T[] {
        if (!data) {
            console.warn('[Stalker] safeJsonList: No data provided');
            return [];
        }

        // If data is already an array, return it
        if (Array.isArray(data)) {
            return data as T[];
        }

        // Extract from expected key (usually 'js')
        let extracted = data[expectedKey] ?? data;

        // Handle falsy values (false, null, undefined) as empty
        if (extracted === false || extracted === null || extracted === undefined) {
            console.warn(`[Stalker] ${expectedKey} field is ${extracted}, returning empty list`);
            return [];
        }

        // If extracted is an object (not array), it might be:
        // 1. Empty response: {} -> return []
        // 2. Single item: {id: "1", ...} -> return [{id: "1", ...}]
        if (typeof extracted === 'object' && !Array.isArray(extracted)) {
            // Check if it's an empty object
            if (Object.keys(extracted).length === 0) {
                console.warn(`[Stalker] ${expectedKey} field is empty object, returning []`);
                return [];
            }
            // Treat as single item
            console.warn(`[Stalker] ${expectedKey} field is a dictionary, converting to single-item list`);
            return [extracted] as T[];
        }

        // If it's an array, return it
        if (Array.isArray(extracted)) {
            return extracted as T[];
        }

        // Unknown format
        console.error(`[Stalker] ${expectedKey} field is neither a list nor a dictionary:`, extracted);
        return [];
    }

    /**
     * Detect if the current portal uses stalker_portal paths
     * (which require URL-encoded MAC and Europe/Paris timezone)
     */
    private isStalkerPortalEndpoint(): boolean {
        return this.config.baseUrl.includes('/stalker_portal');
    }

    /**
     * Resolve relative screenshot/poster URL to absolute URL
     * Stalker returns relative paths like "/stalker_portal/screenshots/..."
     */
    private resolvePosterUrl(screenshotUri: string | boolean | undefined): string {
        if (!screenshotUri || typeof screenshotUri !== 'string') {
            return '';
        }

        // Already absolute URL
        if (screenshotUri.match(/^https?:\/\//i)) {
            return screenshotUri;
        }

        // Relative path - prepend base URL origin
        if (screenshotUri.startsWith('/')) {
            const baseUrl = new URL(this.config.baseUrl);
            return `${baseUrl.origin}${screenshotUri}`;
        }

        return screenshotUri;
    }

    private generateMetrics(): string {
        return JSON.stringify({
            mac: this.config.mac,
            sn: this.serial,
            type: "STB",
            model: "MAG250",
            uid: "",
            random: this.random
        });
    }

    private getHeaders(includeAuth: boolean = false, includeToken: boolean = true): Record<string, string> {
        const headers: Record<string, string> = {
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
            'Referer': `${this.config.baseUrl}/stalker_portal/c/index.html`,
            'Accept-Language': 'en-US,en;q=0.5',
            'Pragma': 'no-cache',
            'X-User-Agent': 'Model: MAG250; Link: WiFi',
            // Host is handled by fetch environment
            'Connection': 'keep-alive'  // Match working player
        };

        if (includeAuth && this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        // CRITICAL FIX: For stalker_portal endpoints, ALWAYS URL-encode the MAC in cookies
        // The working player shows: Cookie: mac=00%3A1A%3A79%3A00%3A0C%3A01
        const macValue = this.isStalkerPortalEndpoint()
            ? encodeURIComponent(this.config.mac)
            : this.config.mac;

        // Timezone: Use user's actual local timezone instead of hardcoded European timezones
        // This ensures the Stalker server returns EPG data in the correct timezone
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const cookies = [
            `mac=${macValue}`,
            'stb_lang=en',
            `timezone=${timezone}`
        ];

        // CRITICAL: Token in cookie behavior (from packet capture analysis):
        // - portal.php: ALWAYS include token in cookie (when available)
        // - stalker_portal: Include token in cookie for ALL requests EXCEPT getProfile
        //   (getProfile uses only Authorization header, but get_genres, etc. need token in cookie too)
        if (includeToken && this.token) {
            cookies.push(`token=${this.token}`);
        }

        headers['Cookie'] = cookies.join('; ');

        return headers;
    }

    /**
    /**
     * Clear cached token globally for a given source or all sources
     */
    static clearTokenCache(sourceId?: string): void {
        if (sourceId) {
            StalkerClient.globalTokens.delete(sourceId);
            StalkerClient.globalRefreshPromises.delete(sourceId);
        } else {
            StalkerClient.globalTokens.clear();
            StalkerClient.globalRefreshPromises.clear();
        }
    }

    /**
     * Ensure we have a valid token (renew if expired or force requested)
     * Uses static promise-based locking to prevent concurrent token refresh operations across instances
     */
    async ensureToken(force: boolean = false): Promise<void> {
        const sourceId = this.sourceId;

        if (force) {
            StalkerClient.clearTokenCache(sourceId);
            this.token = null;
            this.tokenTimestamp = 0;
        }

        // 1. If a refresh is already in progress for this source, wait for it to complete
        const activePromise = StalkerClient.globalRefreshPromises.get(sourceId);
        if (activePromise) {
            console.log(`[Stalker] Token refresh already in progress for source ${sourceId}, waiting...`);
            await activePromise;
            // Sync current instance's local fields
            const shared = StalkerClient.globalTokens.get(sourceId);
            if (shared) {
                this.token = shared.token;
                this.tokenTimestamp = shared.timestamp;
            }
            console.log('[Stalker] Token refresh completed by another instance');
            return;
        }

        // 2. Sync local instance fields with global shared cache if available (unless forcing)
        if (!force) {
            const shared = StalkerClient.globalTokens.get(sourceId);
            if (shared) {
                this.token = shared.token;
                this.tokenTimestamp = shared.timestamp;
            }
        }

        const currentTimestamp = Date.now() / 1000;

        if (force || !this.token || (currentTimestamp - this.tokenTimestamp) > STALKER_TOKEN_VALIDITY_SECONDS) {
            console.log(`[Stalker] Token expired, missing, or force refreshed for source ${sourceId}. Starting refresh...`);

            // Create and store the refresh promise to block concurrent calls globally for this source
            const refreshPromise = (async () => {
                try {
                    await this.handshake();
                    await this.getProfile();
                    
                    // Store the newly obtained token in the global map
                    if (this.token) {
                        StalkerClient.globalTokens.set(sourceId, {
                            token: this.token,
                            timestamp: this.tokenTimestamp
                        });
                    }
                    console.log(`[Stalker] Token refresh completed successfully for source ${sourceId}`);
                } catch (error) {
                    console.error(`[Stalker] Token refresh failed for source ${sourceId}:`, error);
                    throw error;
                } finally {
                    // Always clear the lock when done
                    StalkerClient.globalRefreshPromises.delete(sourceId);
                }
            })();

            StalkerClient.globalRefreshPromises.set(sourceId, refreshPromise);
            await refreshPromise;
        }
    }

    /**
     * Process Stalker API response - extracts data from js/data wrapper
     */
    private processResponse<T>(raw: any, action: string): T {
        // Debug logging for key actions
        if (['get_genres', 'get_all_channels', 'get_categories', 'get_epg_info'].includes(action)) {
            console.log(`[Stalker] Full response for ${action}:`, JSON.stringify(raw));

            // Warn if we detect empty objects
            if (raw.js && typeof raw.js === 'object' && !Array.isArray(raw.js) && Object.keys(raw.js).length === 0) {
                console.warn(`[Stalker] ⚠️ ${action} returned EMPTY OBJECT: {"js":{}}`);
            }
            if (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) && Object.keys(raw.data).length === 0) {
                console.warn(`[Stalker] ⚠️ ${action} returned EMPTY OBJECT: {"data":{}}`);
            }
        }

        // Stalker API typically returns { js: ... }
        if (raw && raw.js) {
            return raw.js as T;
        }
        // Some versions return { data: ... }
        if (raw && raw.data) {
            return raw.data as T;
        }
        return raw as T;
    }

    /**
     * Fetch from Stalker API with retry logic and fallback URL support
     */
    private async fetchStalker<T>(
        action: string,
        type: string = 'itv',
        extraParams: Record<string, string> = {},
        customHeaders: Record<string, string> | null = null,
        isRetryAfterAuthRefresh: boolean = false
    ): Promise<T> {
        const params = new URLSearchParams({
            type,
            action,
            JsHttpRequest: '1-xml',
            ...extraParams,
        });

        // Try current config.baseUrl first, then all remaining fallback URLs
        const candidateBaseUrls = [
            this.config.baseUrl,
            ...this.fallbackUrls.filter(u => u !== this.config.baseUrl)
        ];

        let lastError: any;

        for (const baseUrl of candidateBaseUrls) {
            const url = `${baseUrl}?${params.toString()}`;
            const headers = customHeaders || this.getHeaders(true, true);

            console.log(`[Stalker] Request: ${action}, URL: ${url}`);

            for (let attempt = 1; attempt <= STALKER_MAX_RETRIES; attempt++) {
                try {
                    const response = await universalFetch(url, {
                        headers,
                        timeout: STALKER_TIMEOUT_MS,
                    });

                    if (!response.ok) {
                        if (response.status === 401 || response.status === 403) {
                            console.warn(`[Stalker] Auth/Token error (${response.status}). Clearing cached token for source ${this.sourceId}.`);
                            StalkerClient.clearTokenCache(this.sourceId);
                            this.token = null;
                            this.tokenTimestamp = 0;

                            if (!isRetryAfterAuthRefresh && action !== 'handshake' && action !== 'get_profile') {
                                console.log(`[Stalker] Retrying request ${action} with fresh token handshake...`);
                                await this.ensureToken(true);
                                return await this.fetchStalker<T>(action, type, extraParams, customHeaders, true);
                            }
                        }
                        if (response.status === 404) {
                            console.warn(`[Stalker] 404 Not Found from ${baseUrl}`);
                            break; // Try next fallback URL
                        }
                        throw new Error(`Stalker API error: ${response.status} ${response.statusText}`);
                    }

                    // Handle empty response — try next fallback URL if available
                    if (!response.text || response.text.trim() === '') {
                        console.warn(`[Stalker] Empty response body received from ${baseUrl} for ${action}`);
                        break; // Try next fallback URL
                    }

                    // Parse JSON
                    let parsed: any;
                    try {
                        parsed = JSON.parse(response.text);
                    } catch (e) {
                        console.warn(`[Stalker] Invalid JSON from ${baseUrl} for ${action}.`);

                        // Stalker servers often return HTTP 200 OK with HTML error page ("Authorization failed") when session expires on server.
                        // If we used a cached token, force a token refresh and retry once.
                        if (this.token && !isRetryAfterAuthRefresh && action !== 'handshake' && action !== 'get_profile') {
                            console.warn(`[Stalker] Cached token for source ${this.sourceId} returned invalid JSON/HTML from server (likely expired session). Refreshing token...`);
                            try {
                                await this.ensureToken(true);
                                return await this.fetchStalker<T>(action, type, extraParams, customHeaders, true);
                            } catch (refreshErr) {
                                console.error(`[Stalker] Automatic token refresh retry failed for ${action}:`, refreshErr);
                            }
                        }
                        break; // Try next fallback URL
                    }

                    // Successfully received valid response from fallback URL — remember it as primary
                    if (baseUrl !== this.config.baseUrl) {
                        console.log(`[Stalker] Switched working baseUrl to: ${baseUrl}`);
                        this.config.baseUrl = baseUrl;
                    }

                    return this.processResponse<T>(parsed, action);

                } catch (error: any) {
                    lastError = error;
                    if (attempt < STALKER_MAX_RETRIES) {
                        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
                    }
                }
            }
        }

        throw lastError || new Error(`Stalker request failed for ${action}`);
    }


    async handshake(): Promise<void> {
        console.log('[Stalker] Starting handshake...');
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= STALKER_MAX_HANDSHAKE_ATTEMPTS; attempt++) {
            try {
                this.random = this.generateRandomValue();

                // Note: fetchStalker's processResponse extracts the 'js' key, so response will be {token: "..."}
                // Working player doesn't send Authorization header in handshake, uses cookies instead
                const response = await this.fetchStalker<{ token: string }>(
                    'handshake',
                    'stb'
                    // No custom headers - let getHeaders handle it via cookies
                );

                // fetchStalker already extracted 'js' key, so check response.token directly
                if (response && response.token) {
                    this.token = response.token;
                    this.tokenTimestamp = Date.now() / 1000;
                    console.log(`[Stalker] Handshake successful (Attempt ${attempt}). Token: ${this.token}`);
                    return;
                } else {
                    console.warn(`[Stalker] Handshake attempt ${attempt} returned unexpected format:`, response);
                }
            } catch (error: any) {
                // Check if it's a 404 error and we have fallback URLs to try
                if (error.message?.includes('404') && this.tryNextFallbackUrl()) {
                    console.log(`[Stalker] 404 error, trying fallback URL...`);
                    // Reset attempt counter to give full retries for new URL
                    attempt = 0;
                    continue;
                }

                console.error(`[Stalker] Handshake attempt ${attempt} failed:`, error.message || error);

                if (attempt < STALKER_MAX_HANDSHAKE_ATTEMPTS) {
                    await new Promise(resolve => setTimeout(resolve, STALKER_HANDSHAKE_RETRY_DELAY_MS * attempt));
                } else {
                    throw new Error(error.message || 'Handshake failed');
                }
            }
        }

        throw new Error('Handshake failed after all attempts');
    }

    async getProfile(): Promise<void> {
        console.log('[Stalker] Getting profile to activate session...');
        if (!this.token) throw new Error('Cannot get profile without token');

        // VERIFIED FROM PACKET CAPTURE:
        // stalker_portal endpoints REQUIRE full device parameters
        // The working player sends ALL these params to /stalker_portal/server/load.php
        const params: Record<string, string> = this.isStalkerPortalEndpoint() ? {
            hd: '1',
            ver: 'ImageDescription: 0.2.18-r23-250; ImageDate: Thu Sep 13 11:31:16 EEST 2018; PORTAL version: 5.6.2; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c',
            num_banks: '2',
            sn: this.serial,
            stb_type: 'MAG250',
            client_type: 'STB',
            image_version: '218',
            video_out: 'hdmi',
            device_id: this.deviceId,
            device_id2: this.deviceId2,
            signature: this.generateSignature(),
            auth_second_step: '1',
            hw_version: '1.7-BD-00',
            not_valid_token: '0',
            metrics: this.generateMetrics(),
            hw_version_2: CryptoJS.SHA1(this.config.mac).toString(),
            timestamp: Math.floor(Date.now() / 1000).toString(),
            api_signature: '262',
            prehash: '',
        } : {};

        // CRITICAL: For stalker_portal, getProfile is the ONLY request that should NOT have token in cookie
        // All other stalker_portal requests need token in BOTH Authorization header AND cookie
        // - portal.php: ALWAYS includes token in cookie
        // - stalker_portal: Token in cookie for everything EXCEPT getProfile
        const includeTokenInCookie = !this.isStalkerPortalEndpoint(); // false for stalker_portal
        const headers = this.getHeaders(true, includeTokenInCookie);

        try {
            const data = await this.fetchStalker<{ token: string }>('get_profile', 'stb', params, headers);

            if (data && data.token) {
                this.token = data.token;
                this.tokenTimestamp = Date.now() / 1000;
                console.log('[Stalker] Profile activated. Token refreshed:', this.token);
            } else {
                console.log('[Stalker] Profile activated. Token unchanged.');
            }
        } catch (e) {
            console.error('[Stalker] getProfile failed:', e);
            // Some portals might fail get_profile but allow streaming? 
            // Better to throw if it's critical for session activation.
            // But let's log and proceed if token exists.
        }
    }


    async getLiveCategories(): Promise<Category[]> {
        await this.ensureToken();
        // include_censored=1 (and censored=1 fallback) ensures adult genres are returned by the server
        const rawData = await this.fetchStalker<any>('get_genres', 'itv', {
            include_censored: '1',
            censored: '1'
        });
        const genres = this.safeJsonList<StalkerGenre>(rawData);

        console.log(`[Stalker] Fetched ${genres.length} live categories`);

        return genres.map((genre, index) => ({
            category_id: `${this.sourceId}_${genre.id}`,
            category_name: genre.title,
            source_id: this.sourceId,
            display_order: index,
        }));
    }

    async getLiveStreams(): Promise<Channel[]> {
        await this.ensureToken();
        console.log('[Stalker] getLiveStreams: Using get_all_channels for instant loading...');

        try {
            // Use get_all_channels to fetch ALL channels in ONE request
            // include_censored=1 ensures adult/locked channels are returned by the server
            const rawData = await this.fetchStalker<any>('get_all_channels', 'itv', {
                include_censored: '1',
                censored: '1'
            });

            // Use safeJsonList to handle both {js: []} and {js: {}} responses
            // For get_all_channels, data is often in 'data' key instead of 'js'
            const channelsData = this.safeJsonList<any>(rawData, 'data');

            console.log(`[Stalker] Received ${channelsData.length} channels from get_all_channels`);

            // Also fetch genres for category mapping
            const rawGenres = await this.fetchStalker<any>('get_genres', 'itv');
            const genres = this.safeJsonList<StalkerGenre>(rawGenres);
            const genreMap = new Map<string, string>();
            const censoredGenreIds: string[] = [];
            
            if (Array.isArray(genres)) {
                for (const genre of genres) {
                    genreMap.set(genre.id, `${this.sourceId}_${genre.id}`);
                    
                    // Identify adult genres (using flags or keyword matching)
                    const titleStr = (genre.title || '').toLowerCase();
                    const aliasStr = (genre.alias || '').toLowerCase();
                    const hasAdultKeyword = /(adult|xxx|18\+|\+18|\b18\b|18 rated|sex|porn|voksen|volwassen|aikuinen|erwachsene|dorosly|взрослый|vuxen|дорослий|£дорослий)/i.test(titleStr) || 
                                            /(adult|xxx|18\+|\+18|\b18\b|18 rated|sex|porn|voksen|volwassen|aikuinen|erwachsene|dorosly|взрослый|vuxen|дорослий|£дорослий)/i.test(aliasStr);
                    
                    if (this.isCensored(genre.censored, 0) || hasAdultKeyword) {
                        censoredGenreIds.push(genre.id);
                    }
                }
            }

            // CRITICAL: Stalker portals often hide adult channels from get_all_channels even with include_censored=1
            // We must explicitly fetch channels for each adult genre to bypass common-list hiding
            // We must ALSO paginate through them, as get_ordered_list often defaults to returning only 14 items (p=1)
            if (censoredGenreIds.length > 0) {
                console.log(`[Stalker] Fetching explicitly for ${censoredGenreIds.length} adult categories to bypass common-list hiding`);
                
                for (const genreId of censoredGenreIds) {
                    let page = 1;
                    let hasMore = true;
                    
                    while (hasMore) {
                        try {
                            const resp = await this.fetchStalker<any>('get_ordered_list', 'itv', {
                                genre: genreId,
                                force_ch_link_check: '0',
                                include_censored: '1',
                                censored: '1',
                                p: page.toString()
                            });
                            
                            const adultChannels = this.safeJsonList<any>(resp, 'data');
                            if (adultChannels && adultChannels.length > 0) {
                                // Force adult flag for these channels just in case the server marked them 0
                                for (const ac of adultChannels) {
                                    ac._forced_adult = true;
                                }
                                channelsData.push(...adultChannels);
                                page++;
                                
                                // Standard stalker page size is 14. If we get less, there are no more pages.
                                if (adultChannels.length < 14) {
                                    hasMore = false;
                                }
                            } else {
                                hasMore = false;
                            }
                        } catch (e) {
                            console.warn(`[Stalker] Failed to fetch adult category ${genreId} page ${page}:`, e);
                            hasMore = false;
                        }
                    }
                }
                console.log(`[Stalker] Total channels after adding adult categories: ${channelsData.length}`);
            }

            // Process all channels
            const allChannels: Channel[] = [];
            const seenChannelIds = new Set<string>();
            let providerOrder = 0;

            for (const ch of channelsData) {
                if (seenChannelIds.has(ch.id)) continue;
                seenChannelIds.add(ch.id);

                // Extract raw command
                const rawCmd = ch.cmd || ch.url || '';

                // Determine if we need to resolve this URL via create_link (Stalker token) or play directly
                // Logic based on STALKER PLAYER.py: if "/ch/" in cmd and cmd.endswith("_") -> needs create_link
                // We'll be slightly broader: if it contains /ch/ it's likely a token.
                // Dino source uses /play/live.php... which is direct and fails if passed to create_link.

                let url: string;
                if (rawCmd.includes('/ch/')) {
                    url = `stalker_ch:${rawCmd}`;
                } else {
                    url = this.sanitizeStreamUrl(rawCmd);
                }

                // Map categories
                const catIds = new Set<string>();
                if (ch.tv_genre_id && genreMap.has(ch.tv_genre_id)) {
                    catIds.add(genreMap.get(ch.tv_genre_id)!);
                }
                if (ch.genre_id && genreMap.has(ch.genre_id)) {
                    catIds.add(genreMap.get(ch.genre_id)!);
                }

                // Only enable catch-up (tv_archive) indicator for MAC portals that use direct stream URLs (e.g. /play/live.php)
                // Standard Stalker/Ministra STB portals (ffrt http://localhost/ch/...) use unsupported/broken TvArchive.php middleware
                const isMacDirectUrl = rawCmd.includes('/play/') || (rawCmd.startsWith('http') && !rawCmd.includes('/ch/'));
                const rawHasArchive = ch.tv_archive === 1 || ch.tv_archive === '1' || ch.tv_archive === true
                    || (ch.tv_archive_duration != null && Number(ch.tv_archive_duration) > 0);
                const hasArchive = isMacDirectUrl && rawHasArchive;
                const archiveDurationHours = hasArchive && ch.tv_archive_duration != null
                    ? Number(ch.tv_archive_duration) || 0
                    : undefined;

                const channel: Channel = {
                    stream_id: `${this.sourceId}_${ch.id}`,
                    channel_num: parseInt(ch.number || '0'),
                    name: ch.name,
                    stream_icon: ch.logo || '',

                    category_ids: catIds.size > 0 ? Array.from(catIds) : [],
                    direct_url: url,
                    source_id: this.sourceId,
                    epg_channel_id: ch.xmltv_id,
                    provider_order: providerOrder,
                    is_adult: this.isCensored(ch.censored, ch.lock) || ch._forced_adult === true,
                    tv_archive: hasArchive,
                    tv_archive_duration: archiveDurationHours,
                };
                providerOrder++;

                allChannels.push(channel);
            }

            console.log(`[Stalker] Processed ${allChannels.length} live channels`);
            return allChannels;
        } catch (error) {
            console.error('[Stalker] Error in getLiveStreams:', error);
            return [];
        }
    }

    async getVodCategories(): Promise<Category[]> {
        await this.ensureToken();
        const rawData = await this.fetchStalker<any>('get_categories', 'vod', { sortby: 'number' });
        const categories = this.safeJsonList<StalkerGenre>(rawData);

        console.log(`[Stalker] Fetched ${categories.length} raw VOD categories`);

        // Exclude categories that are series-related so they don't appear in the Movies tab
        const excludeKeywords = ['tv', 'series', 'serie', 'show', 'shows', 'season', 'seasons', 'drama', 'dramas', 'k-drama', 'k-dramas', 'anime', 'cartoon', 'cartoons'];

        const filteredData = categories.filter(cat => {
            const name = (cat.title || '').toLowerCase();
            return !excludeKeywords.some(keyword => name.includes(keyword));
        });

        console.log(`[Stalker] Filtered to ${filteredData.length} VOD categories`);

        return filteredData.map((cat, index) => ({
            category_id: `${this.sourceId}_vod_${cat.id}`,
            category_name: cat.title,
            parent_id: 0,
            source_id: this.sourceId,
            display_order: index,
        }));
    }

    /**
     * Fetch paginated ordered list items in parallel batches with per-page error tolerance,
     * bounded batch size, and an end-of-batch retry pass for any pages that failed during
     * initial parallel execution.
     *
     * The first page is probed on its own first so `totalPages` (when the portal reports it) is
     * known before any fan-out: every later batch is then clamped to the real end of the
     * category, so out-of-range pages are never requested or appended. Returns the whole
     * category or throws — callers must never cache a partially-fetched category as if it
     * were complete.
     *
     * Portals disagree on `p`: 0-based portals treat p=0 as the first page, while 1-based
     * portals coerce p=0 into page 1 (so p=0 and p=1 return identical items — and naive cycle
     * detection then collapses a whole category to its first page). The offset is probed once
     * and cached on the client so every later category walks the real page range.
     */
    private async fetchOrderedListPages(
        type: 'vod' | 'series',
        baseParams: Record<string, string>,
        concurrency: number,
        onProgress?: StalkerPageProgress
    ): Promise<any[]> {
        const pageItemsMap = new Map<number, any[]>();
        const pendingFailedPages = new Set<number>();
        const seenItemIds = new Set<string | number>();
        // Keys above are always zero-based page *indices*; the page number sent to the portal is
        // `index + pOffset`. pOffset starts from whatever this portal already taught us.
        let pOffset = this.pageOffset ?? 0;
        const BATCH_SIZE = Math.max(1, Math.min(12, Math.floor(concurrency) || 4));
        // Runaway bound for buggy metadata-free portals that never report total_items.
        // Kept deliberately high because the category='*' fallback legitimately walks an
        // entire portal; the cycle detection below stops well before this in practice.
        const MAX_PAGES_SAFETY_CAP = 10000;

        const fetchPage = (p: number): Promise<any> =>
            this.fetchStalker<any>('get_ordered_list', type, {
                ...baseParams,
                p: p.toString(),
            });

        // --- Probe the first page (mandatory). A retry here means a transient failure doesn't
        // abort before we know whether there is anything else to fetch. ---
        let page0Response: any = null;
        for (let attempt = 0; attempt < 2 && page0Response == null; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 250));
            try {
                page0Response = await fetchPage(pOffset);
            } catch (err) {
                console.warn(`[Stalker] Failed to fetch page ${pOffset} (${type}) attempt ${attempt + 1}:`, err);
            }
        }
        if (page0Response == null) {
            throw new Error(`Failed to load ${type} category: page 0 could not be retrieved`);
        }

        let { items: page0Items, total_items: page0Total, max_page_items: page0Max, pages: page0Pages } =
            this.extractOrderedList(page0Response);

        // A strictly 1-based portal can reject p=0 outright instead of coercing it to page 1.
        // Before treating the category as empty (or single-page), retry the first page as p=1.
        if (page0Items.length === 0 && pOffset === 0) {
            try {
                const firstPageResponse = await fetchPage(1);
                const firstPage = this.extractOrderedList(firstPageResponse);
                if (firstPage.items.length > 0) {
                    console.log('[Stalker] p=0 returned nothing but p=1 has items; using 1-based page numbering');
                    pOffset = 1;
                    this.pageOffset = 1;
                    page0Items = firstPage.items;
                    page0Total = firstPage.total_items;
                    page0Max = firstPage.max_page_items;
                    page0Pages = firstPage.pages;
                }
            } catch (err) {
                console.warn(`[Stalker] Failed to probe p=1 after an empty p=0 (${type}):`, err);
            }
        }

        const page0Size = page0Max || 14;
        let totalPages: number | undefined;
        if (page0Pages) totalPages = page0Pages;
        else if (page0Total != null) totalPages = Math.max(1, Math.ceil(page0Total / page0Size));

        let pagesFetched = 0;
        if (page0Items.length > 0) {
            pageItemsMap.set(0, page0Items);
            for (const item of page0Items) {
                if (item?.id != null) seenItemIds.add(item.id);
            }
            pagesFetched++;
        }

        const page0ItemCount = page0Items.length;

        // A short (or empty) first page means there is nothing more to fetch.
        let nextIndex = 1;
        let hasMore = page0Items.length > 0 && page0Items.length >= page0Size;
        if (totalPages != null && nextIndex >= totalPages) hasMore = false;

        // --- Learn this portal's page numbering before fanning out (once per client). ---
        // Probe the second page on its own: if it repeats the first page verbatim the portal is
        // 1-based and every later request must be shifted by one, otherwise the category would
        // be cut off after its first page.
        if (hasMore && pOffset === 0 && this.pageOffset === null) {
            let secondPageResponse: any = null;
            for (let attempt = 0; attempt < 2 && secondPageResponse == null; attempt++) {
                if (attempt > 0) await new Promise(r => setTimeout(r, 250));
                try {
                    secondPageResponse = await fetchPage(1);
                } catch (err) {
                    console.warn(`[Stalker] Failed to probe page 1 (${type}) attempt ${attempt + 1}:`, err);
                }
            }

            if (secondPageResponse == null) {
                // Offset stays unknown: let the walk hit the page again and decide there.
                pendingFailedPages.add(1);
            } else {
                const { items: secondItems, max_page_items: secondMax } = this.extractOrderedList(secondPageResponse);
                const secondSize = secondMax || page0Size;
                const secondDuplicates = secondItems.filter((item: any) => item?.id != null && seenItemIds.has(item.id)).length;

                if (secondItems.length > 0 && secondItems.length === page0ItemCount && secondDuplicates === secondItems.length) {
                    // Shift for this walk, but only memoize it once the shifted page proves it
                    // returns real (non-duplicate) items — a single-page category on a 0-based
                    // portal can also answer p=1 with a repeat, and caching that would make
                    // every later category skip its first page.
                    console.log('[Stalker] Portal looks 1-based (p=0 repeats as p=1); shifting page offsets by one');
                    pOffset = 1;
                } else if (secondItems.length === 0) {
                    hasMore = false;
                } else {
                    this.pageOffset = 0;
                    pageItemsMap.set(1, secondItems);
                    for (const item of secondItems) {
                        if (item?.id != null) seenItemIds.add(item.id);
                    }
                    pagesFetched++;
                    nextIndex = 2;
                    if (secondItems.length < secondSize) hasMore = false;
                }
            }
        }

        while (hasMore) {
            // Safety bound: if totalPages is known and we've reached it, terminate
            if (totalPages != null && nextIndex >= totalPages) {
                hasMore = false;
                break;
            }

            // Ultimate runaway bound for buggy metadata-free portals
            if (nextIndex >= MAX_PAGES_SAFETY_CAP) {
                console.warn(`[Stalker] Reached safety cap of ${MAX_PAGES_SAFETY_CAP} pages with no provider total_items; stopping pagination.`);
                hasMore = false;
                break;
            }

            // Never request more pages in the batch than remain before the real end.
            const pagesToFetch = totalPages != null
                ? Math.max(1, Math.min(BATCH_SIZE, totalPages - nextIndex))
                : BATCH_SIZE;

            const pageIndices: number[] = [];
            const batchPromises = [];
            for (let i = 0; i < pagesToFetch; i++) {
                const index = nextIndex + i;
                pageIndices.push(index);
                batchPromises.push(fetchPage(index + pOffset));
            }

            const results = await Promise.allSettled(batchPromises);
            let itemsInBatch = 0;
            let restartWithShiftedOffset = false;

            for (let i = 0; i < results.length; i++) {
                const res = results[i];
                const index = pageIndices[i];

                if (res.status === 'rejected') {
                    console.warn(`[Stalker] Failed to fetch page ${index + pOffset} (${type}):`, res.reason);
                    pendingFailedPages.add(index);
                    continue;
                }

                const { items: pageItems, max_page_items } = this.extractOrderedList(res.value);
                const pageSize = max_page_items || page0Size;

                // The page resolved, so it is no longer missing — drop any earlier failure
                // recorded for it (the page 1 probe records one) so the retry pass doesn't
                // re-request it. An empty response counts as resolved too: it means the page
                // holds no items, which is how a category past its end answers.
                pendingFailedPages.delete(index);

                if (pageItems.length === 0) {
                    // Empty response means no more pages
                    hasMore = false;
                    break;
                }

                // Cycle / duplicate detection: a page made up entirely of items we've already
                // seen means the portal wrapped around or is repeating a default page for an
                // out-of-range offset — stop instead of appending duplicates.
                const duplicateCount = pageItems.filter((item: any) => item?.id != null && seenItemIds.has(item.id)).length;
                if (duplicateCount === pageItems.length) {
                    // Exception: when the portal's page numbering is still unknown and the first
                    // page after the probe repeats it verbatim, the portal is 1-based and coerced
                    // p=0 into page 1. Shift every later request by one and re-walk from here
                    // instead of stopping, otherwise the category is cut off after page 1.
                    if (pOffset === 0 && index === 1 && pagesFetched === 1 && pageItems.length === page0ItemCount) {
                        console.log('[Stalker] Detected 1-based portal page numbering (p=0 repeated as p=1); shifting page offsets by one');
                        pOffset = 1;
                        restartWithShiftedOffset = true;
                        break;
                    }
                    console.warn(`[Stalker] Detected repeated page at offset p=${index + pOffset} (${duplicateCount} duplicate items); stopping pagination.`);
                    hasMore = false;
                    break;
                }

                // Drop any individual items already seen on an earlier page so the flattened
                // result never contains duplicates.
                const newItems = pageItems.filter((item: any) => item?.id == null || !seenItemIds.has(item.id));
                for (const item of newItems) {
                    if (item?.id != null) seenItemIds.add(item.id);
                }

                pageItemsMap.set(index, newItems);
                itemsInBatch += newItems.length;
                pagesFetched++;

                // The shifted offset is only memoized once it has demonstrably reached a real
                // second page, so an ambiguous probe can never poison later categories.
                if (this.pageOffset === null && pOffset === 1 && index === 1 && newItems.length > 0) {
                    this.pageOffset = 1;
                }

                // If any page has less than a full page of items, we've reached the end
                if (pageItems.length < pageSize) {
                    hasMore = false;
                    break;
                }
            }

            if (restartWithShiftedOffset) {
                // Nothing from the aborted batch was stored (only the probe page is in the map),
                // so re-running the same indices with the corrected offset fetches real pages.
                continue;
            }

            // If we got no items in this batch, stop forward pagination and let retry pass handle any failed pages
            if (itemsInBatch === 0) {
                hasMore = false;
            } else {
                nextIndex += pagesToFetch;
            }

            // Safety check against totalPages
            if (totalPages != null && nextIndex >= totalPages) {
                hasMore = false;
            }

            // Report progress so the UI can show "Page X of Y" while lazy-loading
            if (onProgress) {
                const percent = totalPages ? Math.min(100, Math.round((pagesFetched / totalPages) * 100)) : 0;
                onProgress(percent, pagesFetched, totalPages);
            }
        }

        // Retry any failed pages at the end with a small delay and low concurrency
        // to avoid overwhelming a rate-limited or congested portal
        if (pendingFailedPages.size > 0) {
            const failedList = Array.from(pendingFailedPages).sort((a, b) => a - b);
            console.log(`[Stalker] Retrying ${failedList.length} failed page(s): ${failedList.join(', ')}...`);
            const RETRY_CONCURRENCY = 2;
            for (let i = 0; i < failedList.length; i += RETRY_CONCURRENCY) {
                const retryBatch = failedList.slice(i, i + RETRY_CONCURRENCY);
                await new Promise(r => setTimeout(r, 250));
                const retryResults = await Promise.allSettled(
                    retryBatch.map(index => fetchPage(index + pOffset))
                );

                for (let j = 0; j < retryResults.length; j++) {
                    const res = retryResults[j];
                    const index = retryBatch[j];
                    if (res.status === 'fulfilled') {
                        const { items: pageItems } = this.extractOrderedList(res.value);
                        if (pageItems.length > 0) {
                            const newItems = pageItems.filter((item: any) => item?.id == null || !seenItemIds.has(item.id));
                            for (const item of newItems) {
                                if (item?.id != null) seenItemIds.add(item.id);
                            }
                            // Never clobber a page that the walk (or a shifted re-walk) already
                            // stored — a retry can legitimately come back as pure duplicates.
                            if (!pageItemsMap.has(index) || newItems.length > 0) {
                                pageItemsMap.set(index, newItems);
                                pagesFetched++;
                            }
                            console.log(`[Stalker] Retry succeeded for page ${index} (${newItems.length} items)`);
                        }
                        // Resolved either way: an empty page holds no items (typically past the
                        // end of a category whose total the portal never reported), so it is not
                        // a gap that should fail the whole category.
                        pendingFailedPages.delete(index);
                    } else {
                        console.error(`[Stalker] Retry failed permanently for page ${index}:`, res.reason);
                    }
                }
            }
        }

        // Integrity validation: a category is only ever returned whole. Any page still
        // missing after the retry pass aborts the fetch. This includes a failed *trailing*
        // page, which a walk up to the highest fetched page would silently ignore and thus
        // let callers cache a truncated category as if it were complete.
        if (pendingFailedPages.size > 0) {
            const missing = Array.from(pendingFailedPages).sort((a, b) => a - b);
            const label = missing.length === 1 ? `page ${missing[0]}` : `pages ${missing.join(', ')}`;
            throw new Error(`Failed to load ${type} category: ${label} could not be retrieved after retries`);
        }

        // Flatten map in natural page order (0, 1, 2, ...) so items stay in proper sequence
        const allItems: any[] = [];
        const sortedPages = Array.from(pageItemsMap.keys()).sort((a, b) => a - b);
        for (const index of sortedPages) {
            const pItems = pageItemsMap.get(index);
            if (pItems) allItems.push(...pItems);
        }

        return allItems;
    }

    /**
     * Fetch every page of a `get_ordered_list` response that is a fixed list rather than a
     * browsable category: a series' season list, or the episode list of one season.
     *
     * The portal pages these responses at `max_page_items` (14 on the portal that reported
     * this), so reading only `p=0` truncates them — a 24-episode season showed its first 14
     * episodes and looked complete. Walking them through `fetchOrderedListPages` gives them
     * the same retry pass, 1-based portal handling and repeat detection as a category.
     *
     * A list that can't be walked whole falls back to its first page (the previous behaviour)
     * rather than returning nothing, so one flaky page costs the extra pages at most and never
     * the items that were already reachable.
     */
    private async fetchOrderedListAllItems(
        type: 'vod' | 'series',
        baseParams: Record<string, string>,
        label: string
    ): Promise<any[]> {
        const PAGE_CONCURRENCY = 4;
        try {
            return await this.fetchOrderedListPages(type, baseParams, PAGE_CONCURRENCY);
        } catch (err) {
            console.warn(`[Stalker] ${label}: could not page through the whole list, keeping the first page:`, err);
        }

        try {
            const { items } = this.extractOrderedList(
                await this.fetchStalker<any>('get_ordered_list', type, {
                    ...baseParams,
                    p: String(this.pageOffset ?? 0)
                })
            );
            if (items.length > 0) {
                console.log(`[Stalker] ${label}: recovered ${items.length} item(s) from the first page`);
            }
            return items;
        } catch (err) {
            console.warn(`[Stalker] ${label}: first page could not be retrieved either:`, err);
            return [];
        }
    }

    async getVodStreams(categoryId?: string, onProgress?: StalkerPageProgress, concurrency = 4): Promise<Channel[]> {
        await this.ensureToken();
        console.log('[Stalker] getVodStreams: fetching with parallel pagination...');

        const catId = categoryId ? categoryId.replace(`${this.sourceId}_vod_`, '').replace(`${this.sourceId}_`, '') : '*';

        const allItems = await this.fetchOrderedListPages(
            'vod',
            {
                category: catId,
                sortby: 'number',
                include_censored: '1',
                censored: '1'
            },
            concurrency,
            onProgress
        );

        console.log(`[Stalker] Fetched ${allItems.length} total VOD items`);

        // Filter for movies only (is_series!="1")
        const filteredMovies = allItems.filter((item: any) => {
            const isSeries = item.is_series;
            return isSeries !== "1" && isSeries !== 1 && isSeries !== true;
        });

        console.log(`[Stalker] Filtered to ${filteredMovies.length} movies (excluding series)`);

        return filteredMovies.map(item => ({
            stream_id: `${this.sourceId}_vod_${item.id}`,
            name: item.name,
            title: item.name,
            stream_icon: this.resolvePosterUrl(item.screenshot_uri),
            rating: item.rating_kinopoisk || item.rating_imdb || '',

            // Metadata from provider
            plot: item.description || '',
            genre: item.genre || '',
            cast: item.actors || '',
            director: item.director || '',
            year: item.year || '',
            release_date: item.year ? `${item.year}-01-01` : '',

            category_ids: categoryId ? [categoryId] : [],
            added: item.added || item.time_added || item.added_time || '',
            container_extension: item.container_extension || 'mp4',
            direct_url: `stalker_vod:${item.id}:${item.cmd || ''}`,
            source_id: this.sourceId,
            epg_channel_id: '',
        }));
    }

    async getSeriesCategories(): Promise<Category[]> {
        await this.ensureToken();
        let categories: StalkerGenre[] = [];
        let isFallback = false;

        // Try type='series' first for series categories
        try {
            const rawData = await this.fetchStalker<any>('get_categories', 'series', { sortby: 'number' });
            categories = this.safeJsonList<StalkerGenre>(rawData);
            console.log(`[Stalker] Fetched ${categories.length} raw series categories`);
        } catch (err) {
            console.warn('[Stalker] Failed to fetch series categories (type=series), will try falling back to VOD categories:', err);
        }

        // If no series categories returned, fall back to VOD categories
        // Many portals share categories between movies and series
        if (categories.length === 0) {
            console.log('[Stalker] No series categories found or fetch failed, falling back to VOD categories');
            try {
                isFallback = true;
                const rawData = await this.fetchStalker<any>('get_categories', 'vod', { sortby: 'number' });
                categories = this.safeJsonList<StalkerGenre>(rawData);
                console.log(`[Stalker] Fetched ${categories.length} VOD categories as fallback for series`);
            } catch (err) {
                console.error('[Stalker] Failed to fetch VOD categories as fallback for series:', err);
            }
        }

        let filteredCategories = categories;
        if (isFallback) {
            // Only keep series-related categories or general categories, filter out explicitly movie-related categories
            const seriesKeywords = ['series', 'serie', 'show', 'shows', 'tv', 'season', 'seasons', 'drama', 'dramas', 'k-drama', 'k-dramas', 'anime', 'cartoon', 'cartoons'];
            const movieKeywords = ['movie', 'movies', 'film', 'films', 'cinema', 'cinemas', 'short movie', 'short movies', 'pre-dvd', 'predvd', 'latest', 'collection', '4k'];
            
            filteredCategories = categories.filter(cat => {
                const title = (cat.title || '').toLowerCase();
                const alias = (cat.alias || '').toLowerCase();
                
                if (seriesKeywords.some(kw => title.includes(kw) || alias.includes(kw))) {
                    return true;
                }
                if (movieKeywords.some(kw => title.includes(kw) || alias.includes(kw))) {
                    return false;
                }
                return true;
            });
            console.log(`[Stalker] Filtered fallback VOD categories to ${filteredCategories.length} series categories`);
        }

        return filteredCategories.map((cat, index) => ({
            category_id: `${this.sourceId}_series_${cat.id}`,
            category_name: cat.title,
            parent_id: 0,
            source_id: this.sourceId,
            epg_channel_id: '',
            is_category: true,
            category_type: 'series',
            display_order: index,
        }));
    }

    async getSeriesStreams(categoryId?: string, onProgress?: StalkerPageProgress, concurrency = 4): Promise<Channel[]> {
        await this.ensureToken();
        console.log('[Stalker] getSeriesStreams: fetching with parallel pagination...');

        const catId = categoryId ? categoryId.replace(`${this.sourceId}_series_`, '').replace(`${this.sourceId}_`, '') : '*';

        // Helper: fetch all pages from a given endpoint+type+category combo
        let lastError: any = null;
        const fetchAllPages = async (type: 'series' | 'vod', cat: string): Promise<any[]> => {
            const extraParams: Record<string, string> = {
                category: cat,
                sortby: 'number',
                include_censored: '1',
                censored: '1'
            };
            if (type === 'series') {
                extraParams.movie_id = '0';
                extraParams.season_id = '0';
                extraParams.episode_id = '0';
            }
            try {
                const res = await this.fetchOrderedListPages(type, extraParams, concurrency, onProgress);
                lastError = null;
                return res;
            } catch (err) {
                lastError = err;
                console.warn(`[Stalker] fetchAllPages failed for type=${type}, category=${cat}:`, err);
                return [];
            }
        };

        // --- Attempt 1: type=series, specific category ---
        let activeType: 'series' | 'vod' = 'series';
        let allItems = await fetchAllPages('series', catId);
        console.log(`[Stalker] Fetched ${allItems.length} total series items via type=series, category=${catId}`);

        // --- Attempt 2: type=vod, specific category (is_series=1 portals) ---
        if (allItems.length === 0 && catId !== '*') {
            console.log('[Stalker] getSeriesStreams: No results via type=series, falling back to type=vod...');
            allItems = await fetchAllPages('vod', catId);
            console.log(`[Stalker] Fetched ${allItems.length} items via type=vod, category=${catId}`);
            if (allItems.length > 0) {
                activeType = 'vod';
            }
        }

        // --- Attempt 3: type=series, category=* then filter client-side ---
        // Some portals have valid series categories but don't support per-category filtering;
        // get_ordered_list ignores the category param and only works with '*'.
        if (allItems.length === 0 && catId !== '*') {
            console.log('[Stalker] getSeriesStreams: No results for specific category. Trying category=* with type=series and filtering client-side...');
            const allSeries = await fetchAllPages('series', '*');
            console.log(`[Stalker] Fetched ${allSeries.length} items via type=series, category=*`);
            if (allSeries.length > 0) {
                // Filter by matching the raw category ID on each item's category/genre_id field
                const filtered = allSeries.filter((item: any) => {
                    const itemCat = String(item.category_id ?? item.genre_id ?? item.cat_id ?? '');
                    return itemCat === catId;
                });
                console.log(`[Stalker] Client-side filtered to ${filtered.length} items for category ${catId} from ${allSeries.length} total`);
                // If filtering by catId yields nothing but we know this category exists,
                // return the unfiltered set so all series are visible in any category
                allItems = filtered.length > 0 ? filtered : allSeries;
                if (allItems.length > 0) {
                    activeType = 'series';
                }
            }
        }

        // --- Attempt 4: type=vod, category=* then filter client-side (is_series=1 portals) ---
        // Runs for ANY category (including '*' = All): portals that serve series
        // under the VOD endpoint with is_series=1 return nothing for type=series,
        // so the All view previously came back empty even though every specific
        // category loaded fine. The client-side category filter below only applies
        // to non-'*' categories; for '*' the is_series filter at the end decides.
        if (allItems.length === 0) {
            console.log('[Stalker] getSeriesStreams: Trying category=* with type=vod and filtering client-side...');
            const allVod = await fetchAllPages('vod', '*');
            console.log(`[Stalker] Fetched ${allVod.length} items via type=vod, category=*`);
            if (allVod.length > 0) {
                let selected = allVod;
                if (catId !== '*') {
                    const filtered = allVod.filter((item: any) => {
                        const itemCat = String(item.category_id ?? item.genre_id ?? item.cat_id ?? '');
                        return itemCat === catId;
                    });
                    console.log(`[Stalker] Client-side filtered to ${filtered.length} items for category ${catId} from ${allVod.length} total VOD`);
                    selected = filtered.length > 0 ? filtered : allVod;
                }
                allItems = selected;
                if (allItems.length > 0) {
                    activeType = 'vod';
                }
            }
        }

        if (allItems.length === 0 && lastError) {
            throw lastError;
        }

        console.log(`[Stalker] Fetched ${allItems.length} total items (before series filter, activeType=${activeType})`);

        // Filter for series: discard items explicitly marked as movies or not series (only applied if we fell back to VOD endpoints)
        const filteredSeries = allItems.filter((item: any) => {
            if (activeType === 'series') {
                return true;
            }
            
            // If we are looking for items in a specific category (not '*'),
            // keep all items returned for that category (since it has already been filtered as a Series category)
            if (catId !== '*') {
                return true;
            }
            
            // If we are querying globally (category='*'), only keep items that are explicitly series
            const isSeries = item.is_series;
            return isSeries === "1" || isSeries === 1 || isSeries === true;
        });

        const uniqueIds = new Set(filteredSeries.map(item => item.id));
        console.log(`[Stalker] Returning ${filteredSeries.length} series items. Unique IDs count: ${uniqueIds.size}`);

        return filteredSeries.map(item => ({
            stream_id: `${this.sourceId}_series_${item.id}`, // Required for Channel type
            series_id: `${this.sourceId}_series_${item.id}`, // PRIMARY KEY for vodSeries table
            name: item.name,
            stream_icon: this.resolvePosterUrl(item.screenshot_uri),
            cover: this.resolvePosterUrl(item.screenshot_uri), // Required for series
            rating: item.rating_kinopoisk || item.rating_imdb || '',

            // Metadata from provider
            plot: item.description || '',
            genre: item.genre || '',
            cast: item.actors || '',
            director: item.director || '',
            year: item.year || '',
            releaseDate: item.year ? `${item.year}-01-01` : '',

            category_ids: categoryId ? [categoryId] : [],
            added: item.added || item.time_added || item.added_time || '',
            // Store movie_id for series navigation
            direct_url: `stalker_series:${item.id}:${item.cmd || `/media/${item.id}.mpg`}`,
            source_id: this.sourceId,
            epg_channel_id: '', // Required for Channel type
        }));
    }

    async getSeasons(seriesId: string): Promise<Season[]> {
        await this.ensureToken();

        // Extract raw movie ID from seriesId
        // seriesId can be either:
        // 1. "{sourceId}_series_{rawId}" (from syncStalkerCategory)
        // 2. "stalker_series:{rawId}" (from direct_url)
        // 3. Raw ID already (from _stalker_raw_id)
        // Note: Some portals use compound IDs like "15754:15754" where first part is the movie_id
        let rawMovieId: string;

        if (seriesId.startsWith('stalker_series:')) {
            // Extract from direct_url format: "stalker_series:12345" or "stalker_series:12345:12345"
            const idPart = seriesId.substring('stalker_series:'.length);
            // Use first part if compound ID
            rawMovieId = idPart.split(':')[0];
        } else if (seriesId.includes('_series_')) {
            // Extract from prefixed ID format: "{sourceId}_series_12345" or "{sourceId}_series_12345:12345"
            const prefix = `${this.sourceId}_series_`;
            const idPart = seriesId.replace(prefix, '').replace(`${this.sourceId}_`, '');
            // Use first part if compound ID
            rawMovieId = idPart.split(':')[0];
        } else {
            // Already a raw ID - use first part if compound ID
            rawMovieId = seriesId.split(':')[0];
        }

        console.log(`[Stalker] getSeasons: fetching for series ${seriesId} (raw: ${rawMovieId})...`);

        const seasonListParams = {
            season_id: '0',
            episode_id: '0',
            include_censored: '1',
            censored: '1'
        };

        let typeUsed: 'series' | 'vod' = 'series';
        let seasonsData = await this.fetchOrderedListAllItems(
            'series',
            { movie_id: rawMovieId, ...seasonListParams },
            `getSeasons series ${rawMovieId}`
        );
        console.log(`[Stalker] getSeasons: ${seasonsData.length} item(s) via type=series`);

        if (seasonsData.length === 0) {
            console.log('[Stalker] getSeasons: No seasons found via type=series, falling back to type=vod...');
            typeUsed = 'vod';
            seasonsData = await this.fetchOrderedListAllItems(
                'vod',
                { movie_id: rawMovieId, ...seasonListParams },
                `getSeasons series ${rawMovieId} (type=vod fallback)`
            );
            console.log(`[Stalker] getSeasons: ${seasonsData.length} item(s) via type=vod`);
        }

        if (seasonsData.length > 0) {
            console.log('[Stalker] seasonsData length:', seasonsData.length);
            console.log('[Stalker] First item sample:', JSON.stringify(seasonsData[0]).substring(0, 300));
            console.log('[Stalker] First item keys:', Object.keys(seasonsData[0]));
        }

        // Filter for seasons only
        // 1. Standard Ministra: is_series=1 and series array of episode numbers
        // 2. Custom/Fallback: is_season=true or season_number present
        const seasons = seasonsData.filter((item: any) => 
            (item.is_series === 1 && item.series && Array.isArray(item.series)) ||
            (item.is_season === true || item.is_season === 'true' || item.season_number !== undefined)
        );

        console.log(`[Stalker] Total items: ${seasonsData.length}, Seasons found: ${seasons.length}`);

        const seasonsList: Season[] = [];

        for (const season of seasons) {
            const seasonName = season.name || season.season_name || '';
            const seasonNumMatch = seasonName.match(/Season\s*(\d+)/i);
            const seasonNum = seasonNumMatch ? parseInt(seasonNumMatch[1]) : (parseInt(season.season_number) || 1);

            let episodes: Episode[] = [];

            if (season.series && Array.isArray(season.series)) {
                // Scenario A: Episodes are embedded in the 'series' array of the season
                const episodeNumbers: number[] = season.series;
                episodes = episodeNumbers.map((epNum: number) => ({
                    id: `${this.sourceId}_episode_${season.id}_${epNum}`,
                    title: `Episode ${epNum}`,
                    episode_num: epNum,
                    season_num: seasonNum,
                    direct_url: `stalker_episode:${JSON.stringify({
                        movieId: rawMovieId,
                        seasonId: season.id,
                        episodeId: String(epNum),
                        cmd: season.cmd || `/media/file_${season.id}.mpg`
                    })}`,
                    info: { season_name: seasonName }
                }));
            } else {
                // Scenario B: Episodes need to be fetched from the server using the season ID (e.g. "22753")
                console.log(`[Stalker] getSeasons: Fetching episodes from server for season ${season.id} (number ${seasonNum})...`);
                try {
                    // Paged: a season longer than the portal's page size (24 episodes on a
                    // 14-item portal) used to come back as its first page only.
                    const epData = await this.fetchOrderedListAllItems(
                        typeUsed,
                        {
                            movie_id: rawMovieId,
                            season_id: season.id,
                            episode_id: '0',
                            include_censored: '1',
                            censored: '1'
                        },
                        `getSeasons episodes (series ${rawMovieId}, season ${season.id})`
                    );

                    if (epData.length > 0) {
                        console.log(`[Stalker] getSeasons: Fetched ${epData.length} episodes for season ${seasonNum}`);
                        episodes = epData.map((ep: any, index: number) => {
                            const epNum = parseInt(ep.series_number || ep.episode_num) || (index + 1);
                            const epCmd = ep.cmd || `/media/file_${ep.id}.mpg`;
                            return {
                                id: `${this.sourceId}_episode_${ep.id}`,
                                title: ep.name || `Episode ${epNum}`,
                                episode_num: epNum,
                                season_num: seasonNum,
                                // Embed the episode ID and play command in direct_url so resolveStreamUrl can extract and play it directly
                                direct_url: `stalker_episode:${JSON.stringify({
                                    movieId: rawMovieId,
                                    seasonId: season.id,
                                    episodeId: ep.id,
                                    cmd: epCmd
                                })}`,
                                info: { season_name: seasonName }
                            };
                        });
                    } else {
                        console.warn(`[Stalker] getSeasons: Episodes response for season ${seasonNum} holds no episodes`);
                    }
                } catch (err) {
                    console.error(`[Stalker] getSeasons: Failed to fetch episodes for season ${seasonNum}:`, err);
                }
            }

            seasonsList.push({
                season_number: seasonNum,
                episodes: episodes
            });
        }

        return seasonsList;
    }

    async getEpisodes(seriesId: string, seasonId: string): Promise<Episode[]> {
        await this.ensureToken();

        // Extract raw movie ID from seriesId (same logic as getSeasons)
        let rawMovieId: string;

        if (seriesId.startsWith('stalker_series:')) {
            // Extract from direct_url format: "stalker_series:12345" or "stalker_series:12345:12345"
            const idPart = seriesId.substring('stalker_series:'.length);
            rawMovieId = idPart.split(':')[0];
        } else if (seriesId.includes('_series_')) {
            // Extract from prefixed ID format: "{sourceId}_series_12345" or "{sourceId}_series_12345:12345"
            const prefix = `${this.sourceId}_series_`;
            const idPart = seriesId.replace(prefix, '').replace(`${this.sourceId}_`, '');
            rawMovieId = idPart.split(':')[0];
        } else {
            // Already a raw ID - use first part if compound ID
            rawMovieId = seriesId.split(':')[0];
        }

        console.log(`[Stalker] getEpisodes: fetching for series ${seriesId}, season ${seasonId} (raw: ${rawMovieId})...`);

        let typeUsed: 'series' | 'vod' = 'series';
        let episodesData = await this.fetchOrderedListAllItems(
            'series',
            {
                movie_id: rawMovieId,
                season_id: seasonId,
                episode_id: '0',
                include_censored: '1',
                censored: '1'
            },
            `getEpisodes (series ${rawMovieId}, season ${seasonId})`
        );

        if (episodesData.length === 0) {
            console.log('[Stalker] getEpisodes: No episodes found via type=series, falling back to type=vod...');
            typeUsed = 'vod';
            episodesData = await this.fetchOrderedListAllItems(
                'vod',
                {
                    movie_id: rawMovieId,
                    season_id: seasonId,
                    episode_id: '0',
                    include_censored: '1',
                    censored: '1'
                },
                `getEpisodes (series ${rawMovieId}, season ${seasonId}) (type=vod fallback)`
            );
        }

        console.log(`[Stalker] getEpisodes: ${episodesData.length} episode(s) via type=${typeUsed}`);

        // Use rawMovieId in direct_url so resolveStreamUrl gets the correct ID.
        // IMPORTANT: Each episode has its own cmd which must be used when calling create_link.
        // Using the season cmd + series number results in the wrong video playing because
        // create_link returns results based on the cmd, not the episode number.
        return episodesData.map((episode, index) => {
            const epNum = parseInt(episode.series_number || episode.episode_num) || 0;
            const epCmd = episode.cmd || `/media/file_${episode.id}.mpg`;
            const directUrl = `stalker_episode:${JSON.stringify({
                movieId: rawMovieId,
                seasonId: seasonId,
                episodeId: String(episode.id),
                cmd: epCmd
            })}`;
            return {
                id: `${this.sourceId}_episode_${episode.id}`,
                title: episode.name || `Episode ${epNum}`,
                episode_num: epNum,
                season_num: parseInt(seasonId) || 0,
                // Store the episode's own cmd so resolveStreamUrl passes it directly to create_link
                direct_url: directUrl,
                info: episode
            };
        });
    }

    async resolveStreamUrl(cmd: string, catchup?: StalkerCatchupOptions): Promise<string> {
        console.log('[Stalker] resolveStreamUrl called with:', cmd, 'catchup:', catchup);

        // Ensure we have a valid token before resolving stream URLs
        await this.ensureToken();

        if (!cmd || typeof cmd !== 'string') {
            throw new Error('Invalid cmd parameter');
        }

        let forcedCmd = '';
        let type: 'vod' | 'itv' = 'vod';
        let seriesEpisodeNum: string | undefined = undefined;

        // Handle different command formats
        if (cmd.startsWith('stalker_episode:')) {
            let config: { movieId: string; seasonId: string; episodeId: string; cmd: string };
            const jsonStr = cmd.substring('stalker_episode:'.length);
            try {
                config = JSON.parse(jsonStr);
            } catch (e) {
                // Backwards compatibility for old format: stalker_episode:movie_id:season_id:episode_id:cmd
                const parts = cmd.split(':');
                if (parts.length < 5) {
                    throw new Error('Invalid stalker_episode format');
                }
                config = {
                    movieId: parts[1],
                    seasonId: parts[2],
                    episodeId: parts[3],
                    cmd: parts.slice(4).join(':')
                };
            }

            const movieId = config.movieId;
            let seasonId = config.seasonId;
            const episodeNum = config.episodeId;
            let episodeCmd = config.cmd;

            console.log(`[Stalker] Resolving episode: Movie=${movieId}, Season=${seasonId}, EpisodeId=${episodeNum}`);

            // Determine if the episodeId is a sequential episode number (1, 2, 3...) or a
            // database episode ID (large integer like 931146). This affects how we call create_link:
            //  - Sequential number: use season cmd + series param (old approach)
            //  - Database ID: use the episode's own cmd directly (no series param needed)
            const episodeNumInt = parseInt(episodeNum);
            const isSequentialEpisodeNum = !isNaN(episodeNumInt) && episodeNumInt < 1000 && episodeNumInt > 0;

            if (isSequentialEpisodeNum) {
                // Old-style: season cmd + series episode number
                seriesEpisodeNum = episodeNum;
            }
            // If it's a database ID, we use episodeCmd directly without series param

            // If seasonId is a small sequential number (like 1, 2, 3) or not present,
            // resolve it on-the-fly for backwards compatibility.
            // Avoid resolving if the ID has colons, underscores or hyphens since those are database IDs.
            if (seasonId && parseInt(seasonId) < 100 && !seasonId.includes(':') && !seasonId.includes('_') && !seasonId.includes('-')) {
                console.log(`[Stalker] resolveStreamUrl: Detected season number ${seasonId} instead of database ID. Resolving season ID on-the-fly...`);
                try {
                    const seasons = await this.getSeasons(movieId);
                    const matchedSeason = seasons.find(s => String(s.season_number) === String(seasonId)) || seasons[0];
                    if (matchedSeason && matchedSeason.episodes.length > 0) {
                        const ep = matchedSeason.episodes[0];
                        if (ep.direct_url.startsWith('stalker_episode:')) {
                            const epJsonStr = ep.direct_url.substring('stalker_episode:'.length);
                            try {
                                const epConfig = JSON.parse(epJsonStr);
                                if (epConfig.seasonId && (parseInt(epConfig.seasonId) >= 100 || epConfig.seasonId.includes(':') || epConfig.seasonId.includes('_') || epConfig.seasonId.includes('-'))) {
                                    seasonId = epConfig.seasonId;
                                    episodeCmd = epConfig.cmd;
                                    console.log(`[Stalker] resolveStreamUrl: Resolved season number ${config.seasonId} to season ID ${seasonId} with command ${episodeCmd}`);
                                }
                            } catch (err) {
                                // Fallback if first ep direct_url is also old format
                                const epParts = ep.direct_url.split(':');
                                if (epParts.length >= 5 && epParts[2] && (parseInt(epParts[2]) >= 100 || epParts[2].includes(':') || epParts[2].includes('_') || epParts[2].includes('-'))) {
                                    seasonId = epParts[2];
                                    episodeCmd = epParts.slice(4).join(':');
                                    console.log(`[Stalker] resolveStreamUrl: Resolved season number ${config.seasonId} to season ID ${seasonId} with command ${episodeCmd}`);
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('[Stalker] resolveStreamUrl: Failed to resolve season ID on-the-fly:', e);
                }
            }

            // For database episode IDs, we MUST fetch get_ordered_list with the specific episode_id
            // to get the real cmd before calling create_link. This is because:
            //  1. The episode list fetch (episode_id=0) may not return the correct per-episode cmd
            //  2. The fallback /media/file_{episodeId}.mpg uses the episode's DB ID which often
            //     does NOT match the actual media file ID on the server
            // This matches the correct flow: get_ordered_list(episode_id=X) → cmd → create_link(cmd)
            if (!isSequentialEpisodeNum && episodeNum && seasonId) {
                console.log(`[Stalker] resolveStreamUrl: Fetching real cmd via get_ordered_list for episode_id=${episodeNum} (movie=${movieId}, season=${seasonId})...`);
                try {
                    // Try series type first, then vod
                    let epListResp: any = null;
                    for (const epType of ['vod', 'series'] as const) {
                        try {
                            epListResp = await this.fetchStalker<any>('get_ordered_list', epType, {
                                movie_id: movieId,
                                season_id: seasonId,
                                episode_id: episodeNum,
                                p: '0',
                                include_censored: '1',
                                censored: '1'
                            });
                            let epData = epListResp?.data || epListResp;
                            if (epData?.js?.data) epData = epData.js.data;
                            if (Array.isArray(epData) && epData.length > 0) {
                                const matched = epData.find((e: any) => String(e.id) === String(episodeNum)) || epData[0];
                                if (matched.cmd) {
                                    episodeCmd = matched.cmd;
                                    console.log(`[Stalker] resolveStreamUrl: Using real cmd from episode fetch: ${episodeCmd}`);
                                    break;
                                }
                            }
                        } catch (epErr) {
                            console.warn(`[Stalker] resolveStreamUrl: get_ordered_list(type=${epType}) for episode_id failed:`, epErr);
                        }
                    }
                } catch (e) {
                    console.error('[Stalker] resolveStreamUrl: Failed to fetch real episode cmd:', e);
                    // Fall through and use whatever cmd we have
                }
            }

            // Use the episode's cmd directly. For per-episode cmds this is the episode-specific
            // stream path. For season-level cmds the series param (set above) selects the episode.
            if (episodeCmd) {
                forcedCmd = episodeCmd;
            } else {
                throw new Error('No cmd available for episode resolution');
            }

        } else if (cmd.startsWith('stalker_vod:')) {
            // Standalone VOD
            const parts = cmd.split(':');
            const movieId = parts[1];
            const storedCmd = parts[2];  // cmd from category fetch

            // If we have cmd stored, use it directly (more reliable)
            if (storedCmd) {
                console.log(`[Stalker] Using stored cmd for movie_id ${movieId}`);
                forcedCmd = storedCmd;
            } else {
                // Fallback: try get_ordered_list (less reliable on some portals)
                console.log(`[Stalker] No stored cmd, fetching via get_ordered_list for movie_id ${movieId}`);
                const listResp = await this.fetchStalker<any>('get_ordered_list', 'vod', {
                    movie_id: movieId,
                    p: '1',
                    include_censored: '1',
                    censored: '1'
                });
                const listData = listResp?.data || listResp?.js?.data;
                if (Array.isArray(listData) && listData.length > 0) {
                    // FIXED: Don't blindly use listData[0] - find the item that matches our movie_id
                    // The response may contain multiple items or cached results
                    const item = listData.find((i: any) => String(i.id) === String(movieId)) || listData[0];
                    console.log(`[Stalker] VOD item for movie_id ${movieId}:`, JSON.stringify(item).substring(0, 200));
                    forcedCmd = item.cmd || `/media/${item.id}.mpg`;
                } else {
                    throw new Error('VOD movie not found');
                }
            }
        } else if (cmd.startsWith('stalker_ch:')) {
            type = 'itv';
            forcedCmd = cmd.substring('stalker_ch:'.length);
        } else if (cmd.startsWith('/media/')) {
            forcedCmd = cmd;
            type = 'vod';
        } else {
            // Default to live ITV stream for direct URLs (e.g. /play/live.php?stream=12345)
            type = 'itv';
            forcedCmd = cmd;
        }

        // If catchup options are provided for a live TV channel:
        if (catchup && type === 'itv') {
            // Fast-path for Dino / MAC / Xtream portals that use direct stream URLs (e.g. /play/live.php)
            if (forcedCmd.includes('/play/') || forcedCmd.startsWith('http://') || forcedCmd.startsWith('https://')) {
                const startDate = new Date(catchup.startTimeMs);
                const year = startDate.getUTCFullYear();
                const month = String(startDate.getUTCMonth() + 1).padStart(2, '0');
                const day = String(startDate.getUTCDate()).padStart(2, '0');
                const hour = String(startDate.getUTCHours()).padStart(2, '0');
                const minute = String(startDate.getUTCMinutes()).padStart(2, '0');
                const formattedStart = `${year}-${month}-${day}:${hour}-${minute}`;
                const durationMinutes = catchup.durationMinutes;

                let cleanBase = forcedCmd.replace('/play/live.php', '/play/timeshift.php');
                cleanBase = cleanBase.replace(/([?&])(start|duration|utc|lutc)=[^&]*/gi, '');
                cleanBase = cleanBase.replace(/[?&]+$/, '').replace(/&+/g, '&');
                const sep = cleanBase.includes('?') ? '&' : '?';

                const timeshiftUrl = `${cleanBase}${sep}start=${formattedStart}&duration=${durationMinutes}`;
                console.log(`[Stalker] Resolved MAC portal timeshift URL directly: ${timeshiftUrl}`);
                return timeshiftUrl;
            }

            const startSec = Math.floor(catchup.startTimeMs / 1000);
            const endSec = startSec + Math.floor(catchup.durationMinutes * 60);

            // Extract numeric stream ID from forcedCmd if present (e.g., from stream=45619 or /ch/45619 or 45619)
            let streamId: string | null = null;
            const streamParamMatch = forcedCmd.match(/[?&]stream=(\d+)/i);
            const chMatch = forcedCmd.match(/\/ch\/(\d+)/i);
            const numOnlyMatch = forcedCmd.match(/^\d+$/);

            if (streamParamMatch) {
                streamId = streamParamMatch[1];
            } else if (chMatch) {
                streamId = chMatch[1];
            } else if (numOnlyMatch) {
                streamId = numOnlyMatch[0];
            }

            // Build candidate archive commands to handle all Stalker/Ministra server DB schema variants
            const archiveCmdCandidates: string[] = [];

            // Candidate 1: exact original forcedCmd if present (e.g. ffrt http://localhost/ch/97)
            if (forcedCmd) {
                archiveCmdCandidates.push(forcedCmd);
                if (!forcedCmd.endsWith('_')) {
                    archiveCmdCandidates.push(`${forcedCmd}_`);
                }
            }

            // Candidate 2: standard Stalker/Ministra formats with streamId
            if (streamId) {
                archiveCmdCandidates.push(`ffmpeg http://localhost/ch/${streamId}_`);
                archiveCmdCandidates.push(`ffrt http://localhost/ch/${streamId}`);
                archiveCmdCandidates.push(`ffrt http://localhost/ch/${streamId}_`);
                archiveCmdCandidates.push(`http://localhost/ch/${streamId}_`);
                archiveCmdCandidates.push(`http://localhost/ch/${streamId}`);
                archiveCmdCandidates.push(`/ch/${streamId}_`);
                archiveCmdCandidates.push(`/ch/${streamId}`);
            }

            const uniqueCandidates = [...new Set(archiveCmdCandidates)];

            console.log(`[Stalker] Requesting TV Archive link (streamId=${streamId || 'unknown'}), start=${startSec}, end=${endSec}, candidates=${uniqueCandidates.length}`);

            for (const archiveCmd of uniqueCandidates) {
                const archiveParams: Record<string, string> = {
                    cmd: archiveCmd,
                    type: 'tv_archive',
                    utc: startSec.toString(),
                    lutc: endSec.toString(),
                    start: startSec.toString(),
                    end: endSec.toString(),
                };
                if (streamId) {
                    archiveParams['ch_id'] = streamId;
                }
                if (catchup.programId) {
                    archiveParams['series'] = catchup.programId;
                }

                try {
                    const response = await this.fetchStalker<any>('create_link', 'tv_archive', archiveParams);
                    let resultUrl = response?.url || response?.cmd || response;

                    if (resultUrl && typeof resultUrl === 'string') {
                        resultUrl = this.sanitizeStreamUrl(resultUrl);

                        if (
                            resultUrl &&
                            !resultUrl.startsWith('?token=') &&
                            !resultUrl.includes('load.php?token=') &&
                            !resultUrl.includes('19691231')
                        ) {
                            console.log(`[Stalker] Resolved TV Archive stream URL (cmd: ${archiveCmd}): ${resultUrl}`);
                            return resultUrl;
                        }
                    }
                } catch (err) {
                    console.warn(`[Stalker] TV Archive create_link failed for cmd (${archiveCmd}):`, err);
                }
            }
        }

        // Helper to request create_link, cleanup and resolve relative URLs
        const requestLink = async (command: string): Promise<string | undefined> => {
            try {
                const params: Record<string, string> = {
                    cmd: command,
                    type: type,
                };
                if (seriesEpisodeNum) {
                    params['series'] = seriesEpisodeNum;
                }

                const response = await this.fetchStalker<any>('create_link', type, params);
                let resultUrl = response?.url || response?.cmd || response;

                if (resultUrl && typeof resultUrl === 'string') {
                    resultUrl = this.sanitizeStreamUrl(resultUrl);
                    return resultUrl;
                }
            } catch (err) {
                console.error('[Stalker] requestLink failed for cmd:', command, err);
            }
            return undefined;
        };

        try {
            console.log(`[Stalker] Calling create_link. Type=${type}, Cmd=${forcedCmd}`);
            let resultUrl = await requestLink(forcedCmd);

            // If the resolved URL starts with '?token=' or matches the portal load.php page,
            // it means the command format was incorrect and the portal fell back to a login token.
            // We attempt to toggle the cmd format (between /media/file_id.mpg and /media/id.mpg) and retry.
            if (!resultUrl || resultUrl.startsWith('?token=') || resultUrl.includes('load.php?token=')) {
                console.log(`[Stalker] resolveStreamUrl: Initial command ${forcedCmd} returned invalid token link: ${resultUrl}. Attempting fallback format...`);
                
                // Extract the numerical ID from forcedCmd
                const idMatch = forcedCmd.match(/(\d+)/);
                if (idMatch) {
                    const entityId = idMatch[1];
                    let alternativeCmd = '';
                    if (forcedCmd.includes('/media/file_')) {
                        alternativeCmd = `/media/${entityId}.mpg`;
                    } else if (forcedCmd.includes('/media/')) {
                        alternativeCmd = `/media/file_${entityId}.mpg`;
                    }

                    if (alternativeCmd && alternativeCmd !== forcedCmd) {
                        console.log(`[Stalker] resolveStreamUrl: Retrying create_link with alternative cmd: ${alternativeCmd}`);
                        const retryUrl = await requestLink(alternativeCmd);
                        if (retryUrl && !retryUrl.startsWith('?token=') && !retryUrl.includes('load.php?token=')) {
                            resultUrl = retryUrl;
                            console.log(`[Stalker] resolveStreamUrl: Fallback command succeeded! Stream URL: ${resultUrl}`);
                        }
                    }
                }
            }

            if (!resultUrl) {
                throw new Error(`create_link returned no URL for cmd ${forcedCmd}`);
            }

            console.log(`[Stalker] Stream URL: ${resultUrl}`);
            return resultUrl;
        } catch (e) {
            console.error('[Stalker] create_link failed:', e);
            throw e;
        }
    }

    private sanitizeStreamUrl(url: string): string {
        try {
            // Remove ffmpeg prefixes
            let cleanUrl = url.replace(/^(ffmpeg|ffrt)\s*/i, '').trim();

            const baseUrlObj = new URL(this.config.baseUrl);

            // Fix http://:/ or https://:/ or http://:8080/ (missing hostname from Stalker storage)
            if (cleanUrl.match(/^https?:\/\/:/i)) {
                cleanUrl = cleanUrl.replace(/^https?:\/\/:(\d+)?/i, `${baseUrlObj.protocol}//${baseUrlObj.host}`);
            }

            // If it's a relative path, prepend base URL
            if (cleanUrl.startsWith('/')) {
                cleanUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${cleanUrl}`;
            }

            // Fix localhost/127.0.0.1
            if (cleanUrl.startsWith('http')) {
                const urlObj = new URL(cleanUrl);
                if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
                    urlObj.hostname = baseUrlObj.hostname;
                    urlObj.port = baseUrlObj.port;
                    console.log(`[Stalker] Rewrote localhost URL to: ${urlObj.toString()}`);
                    cleanUrl = urlObj.toString();
                }
            }

            return cleanUrl;
        } catch (e) {
            console.warn('[Stalker] URL sanitization failed for:', url, e);
            return url;
        }
    }

    async testConnection(): Promise<{ success: boolean; error?: string }> {
        try {
            await this.handshake();
            // Working player calls get_profile immediately after handshake to activate session
            await this.getProfile();
            return { success: true };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
        }
    }

    /**
     * Get EPG data for all channels
     */
    async getEpg(periodHours: number = 72, pastHours: number = 24): Promise<Map<string, any[]>> {
        await this.ensureToken();
        try {
            // The Stalker `period` parameter covers only FUTURE hours from now.
            // To also retrieve past programs (needed for catch-up display), we attempt
            // to request with explicit `from`/`to` unix timestamps covering:
            //   from = now - pastHours  →  to = now + futureHours
            // Many Stalker portals honour `from`/`to`; others fall back to `period`.
            const nowSec = Math.floor(Date.now() / 1000);
            const futureHours = Math.max(periodHours, 48);
            const fromSec = nowSec - pastHours * 3600;
            const toSec = nowSec + futureHours * 3600;

            // Try with from/to first, fall back to period-only
            let response: any;
            try {
                response = await this.fetchStalker<any>('get_epg_info', 'itv', {
                    period: futureHours.toString(),
                    from: fromSec.toString(),
                    to: toSec.toString(),
                });
            } catch (_e) {
                response = await this.fetchStalker<any>('get_epg_info', 'itv', {
                    period: futureHours.toString(),
                });
            }

            const epgData = response?.data || response;
            const epgMap = new Map<string, any[]>();

            if (!epgData || typeof epgData !== 'object') {
                console.warn('[Stalker] get_epg_info returned invalid data');
                return epgMap;
            }

            for (const [chId, programs] of Object.entries(epgData)) {
                if (Array.isArray(programs)) {
                    epgMap.set(`${this.sourceId}_${chId}`, programs);
                }
            }

            console.log(`[Stalker] Retrieved EPG for ${epgMap.size} channels (window: -${pastHours}h to +${futureHours}h)`);
            return epgMap;
        } catch (err) {
            console.error('[Stalker] Failed to fetch EPG:', err);
            return new Map();
        }
    }

    /**
     * Get short EPG for a specific channel
     */
    async getShortEpg(channelId: string, size: number = 10, archiveDurationHours: number = 24): Promise<any[]> {
        await this.ensureToken();
        // Request a larger window so the list includes recently-aired programmes.
        // Some Stalker portals also accept `from` as a unix timestamp; include it
        // as a hint for portals that support it (ignored by those that don't).
        const fromSec = Math.floor(Date.now() / 1000) - archiveDurationHours * 3600;
        const response = await this.fetchStalker<any>('get_short_epg', 'itv', {
            ch_id: channelId,
            size: Math.max(size, 20).toString(),
            from: fromSec.toString(),
        });

        return this.safeJsonList<any>(response);
    }

    /**
     * Get account information including expiry date
     */
    async getAccountInfo(): Promise<{ mac: string; expiry?: string; error?: string }> {
        await this.ensureToken();
        try {
            const response = await this.fetchStalker<any>('get_main_info', 'account_info');

            const mac = response?.mac || this.config.mac;
            const expiry = response?.phone;

            console.log(`[Stalker] Account info: MAC=${mac}, Expiry=${expiry || 'N/A'}`);

            return { mac, expiry };
        } catch (err: any) {
            console.error('[Stalker] Failed to fetch account info:', err);
            return { mac: this.config.mac, error: err?.message || String(err) };
        }
    }

    /**
     * Search the portal's own VOD library.
     *
     * Stalker has no search action: `search=<phrase>` rides on the ordinary
     * `get_ordered_list` call, and it is a literal, case-insensitive substring
     * test against the stored title. A colon, a dash or a doubled space inside
     * the phrase is enough to return nothing (`avatar way` finds no
     * `Avatar: The Way of Water`), so a query is tried verbatim first and only
     * then retried as its longest single word, with the other words applied
     * locally. Series entries served by the VOD endpoint are filtered out here,
     * exactly as `getVodStreams` does.
     */
    async searchVod(query: string, options: StalkerSearchOptions = {}): Promise<StalkerSearchResult> {
        // The VOD endpoint also serves `is_series` entries, and `runSearch` is told which of
        // them this list can show — otherwise a wider phrase form could be accepted on the
        // strength of a row that is then filtered away, and the user would see nothing.
        const result = await this.runSearch('vod', query, options, item => !this.isSeriesItem(item));
        const items = result.items
            .filter(item => !this.isSeriesItem(item))
            .map(item => this.mapSearchMovie(item, options.categoryId));
        return { ...result, items, total: this.reconcileTotal(result, items.length) };
    }

    /**
     * Search the portal's own series library.
     *
     * Uses `type=series` when the portal serves it and falls back to the VOD
     * endpoint filtered to `is_series`, mirroring `getSeriesStreams` — some
     * portals return nothing at all for `type=series`.
     *
     * The fallback is a first-page decision. Which endpoint answered comes back as
     * `endpoint` and is honoured on a resume, so paging a series search can neither
     * splice the VOD endpoint's page N into the walk nor re-probe an endpoint the
     * portal has already answered with nothing.
     */
    async searchSeries(query: string, options: StalkerSearchOptions = {}): Promise<StalkerSearchResult> {
        // Settle the endpoint on page 0 and stay on it: this is the same rule `phrase`
        // follows, and `if (result.items.length === 0)` cannot tell "this portal serves no
        // `type=series`" from "this page of the series walk was empty", so a resume that
        // re-ran it would switch endpoints mid-walk.
        const committed = (options.fromPage ?? 0) > 0 ? options.endpoint : undefined;
        const canShow = committed === 'vod'
            ? (item: any) => this.isSeriesItem(item)
            : () => true;
        let result = await this.runSearch(committed ?? 'series', query, options, canShow);
        if (!committed && result.items.length === 0) {
            const vodResult = await this.runSearch('vod', query, options, item => this.isSeriesItem(item));
            if (vodResult.items.some(item => this.isSeriesItem(item))) {
                result = vodResult;
            }
        }
        // `canShow` chooses which walk to *accept*; it never removes rows from what a walk
        // returns. So a walk served by the VOD list — which carries films and `is_series`
        // entries side by side — has to be filtered here, on the first page and on every
        // resumed one alike, or films get mapped and stored as series.
        const items = (result.endpoint === 'vod'
            ? result.items.filter(item => this.isSeriesItem(item))
            : result.items
        ).map(item => this.mapSearchSeries(item, options.categoryId));
        return { ...result, items, total: this.reconcileTotal(result, items.length) };
    }

    /**
     * Keep `total` honest once a walk is finished.
     *
     * The portal counts everything its phrase matched, which is not what a caller can
     * display: a VOD search for "avatar" on a portal tested here reported 61 matches, 12 of
     * which were `is_series` entries this API drops, and local narrowing removes rows too.
     * When the walk is complete the shown count *is* the answer, so report that; while
     * pages remain the provider's number is a truthful upper bound and stays as-is.
     */
    private reconcileTotal(
        result: { total: number; hasMore: boolean },
        shownCount: number
    ): number {
        return result.hasMore ? result.total : shownCount;
    }

    /**
     * Try the query verbatim, fall back to its longest word, narrow locally and
     * decide whether the portal honoured `search` at all.
     */
    private async runSearch(
        type: 'vod' | 'series',
        query: string,
        options: StalkerSearchOptions,
        canShow: (item: any) => boolean
    ): Promise<{ items: any[]; total: number; nextPage: number; hasMore: boolean; unsupported: boolean; phrase: string; matchKind: StalkerSearchMatchKind; endpoint: StalkerSearchEndpoint }> {
        await this.ensureToken();

        const wanted = query.trim();
        const terms = wanted.split(/\s+/).filter(Boolean);
        const fromPage = Math.max(0, Math.floor(options.fromPage ?? 0));
        const maxPages = Math.max(1, Math.floor(options.maxPages ?? 4));

        // A resumed walk must stay on the phrase the caller already committed to —
        // switching phrases mid-walk would splice two different result sets together.
        // It is not optional: the fallback is first-page-only, so a resume that fell back
        // to the user's own words would ask for a phrase the portal has already answered
        // with nothing, get an empty page, and end the walk with results still unloaded.
        const committed = fromPage > 0 ? (options.phrase ?? '').trim() : '';
        const phrases = committed ? [committed] : [wanted];
        // Both wider forms are first-page-only, like the fallback they extend.
        const joined = !committed && fromPage === 0 ? this.wildcardPhrase(terms) : '';
        if (joined && joined.toLowerCase() !== wanted.toLowerCase()) phrases.push(joined);
        const fallbackWord = this.longestUsableTerm(terms);
        if (!committed && fromPage === 0 && terms.length > 1 && fallbackWord) {
            if (fallbackWord.toLowerCase() !== wanted.toLowerCase()) phrases.push(fallbackWord);
        }

        if (phrases.every(p => p.length === 0)) {
            return { items: [], total: 0, nextPage: 0, hasMore: false, unsupported: false, phrase: '', matchKind: 'verbatim', endpoint: type };
        }

        let walk: StalkerSearchWalk | null = null;
        let phrase = wanted;
        let accepted = false;
        for (const candidate of phrases) {
            walk = await this.walkSearchPages(type, candidate, options.categoryId, fromPage, maxPages, options.onProgress);
            phrase = candidate;
            if (walk.items.length === 0) continue;

            // Only rows this list can actually show count as an answer. Measured on a portal:
            // `water%avatar` is answered by a single `is_series` row, so a movie search that
            // treated that as "the wildcard found something" would show nothing at all, where
            // the longest-word form still has the out-of-order titles the user meant.
            const usable = walk.items.filter(canShow);
            if (usable.length === 0) continue;

            // The wildcard form widens the match (this portal also tests plot summaries), so
            // it only counts when a title's own name carries every word the user typed.
            if (candidate === joined && !usable.some(item => terms.every(term => this.itemNameMatches(item, term)))) {
                continue;
            }

            accepted = true;
            break;
        }
        if (!walk || !accepted) {
            return { items: [], total: 0, nextPage: fromPage, hasMore: false, unsupported: false, phrase, matchKind: 'verbatim', endpoint: type };
        }

        if (joined && phrase === joined) this.searchWildcards = true;

        let items = walk.items;
        const fellBack = phrase.toLowerCase() !== wanted.toLowerCase();
        if (fellBack) {
            // Narrowing is a convenience, never a filter that empties a real result set:
            // when no loaded item carries every word we keep the broader list and let
            // `phrase` explain what was actually searched.
            const narrowed = items.filter(item => terms.every(term => this.itemNameMatches(item, term)));
            if (narrowed.length > 0) {
                items = narrowed;
            } else {
                console.log(
                    `[Stalker] Search "${wanted}": no loaded result carries every word; ` +
                    `showing the ${items.length} item(s) matching "${phrase}" instead`
                );
            }
        }

        // A portal that ignores `search` returns its normal catalogue, so nothing it
        // sent back contains the phrase. Confirm against an unsearched call before
        // telling the user the portal cannot search — a term could legitimately match
        // titles whose names we do not compare (portals that match on description).
        let unsupported = false;
        if (!fellBack && items.length > 0 && !items.some(item => this.itemNameMatches(item, wanted))) {
            unsupported = await this.portalIgnoresSearch(type, options.categoryId, walk.total);
            if (unsupported) {
                console.warn(
                    `[Stalker] ${type} search: portal returned its unfiltered catalogue for "${wanted}" ` +
                    `(total ${walk.total}) — this middleware does not support search`
                );
            }
        }

        // Base this on what the walk actually collected, not on the narrowed list: local
        // narrowing legitimately drops rows the portal counted, and that must not look
        // like "there is another page to fetch".
        const hasMore = walk.lastPageFull && (walk.total === 0 || walk.loadedCount < walk.total);

        // `joined` sits between `wanted` and the longest word, so a winner that is neither of
        // those two is the wildcard form having been tried and lost. That says nothing about
        // whether this portal honours `%` — the words may simply not appear in that order —
        // so settle it once, against a phrase already known to match something, rather than
        // spending the request again on every later search.
        const joinedTried = joined !== '' && phrase !== wanted && phrase !== joined;
        if (joinedTried && this.searchWildcards === null) {
            await this.probeWildcardSupport(type, options.categoryId, phrase);
        }

        const matchKind: StalkerSearchMatchKind = !fellBack
            ? 'verbatim'
            : phrase === joined
                ? 'all-words'
                : phrase === fallbackWord ? 'word' : 'verbatim';

        return { items, total: walk.total, nextPage: walk.nextPage, hasMore, unsupported, phrase, matchKind, endpoint: type };
    }

    /**
     * The longest word of the query that is made of something other than punctuation.
     *
     * A term of pure wildcards is the one shape the fallback must not be allowed to pick:
     * `%%` interpolated into a `LIKE` is the same query as `%`, which returns every title on
     * the portal (measured: 100,560), so a two-word query of `%% __` would walk the whole
     * catalogue and could even read back as "this portal ignores search".
     */
    private longestUsableTerm(terms: string[]): string {
        return terms
            .filter(term => this.normalizeSearchText(term).length > 0)
            .sort((a, b) => b.length - a.length)[0] ?? '';
    }

    /**
     * The query's words joined by `%`, or `''` when that cannot be built.
     *
     * Some middlewares interpolate `search` raw into their own `LIKE '%…%'`, so `%` reaches
     * the query as a wildcard: `avatar%way` finds "Avatar: The Way of Water" where the
     * literal pair finds nothing, and it does the all-words filtering server-side instead of
     * us walking a wider set to narrow locally. Confirmed on one of the two portals measured
     * (7 rows for `avatar%way`, 0 for `avatar way`); the other treats the character literally.
     *
     * Two traps come with it. A bare `%` matches the entire catalogue on a portal like that
     * (100,560 titles measured), so the words are stripped of `%`, `_` and `\` before being
     * joined — a user typing `%` must not turn a search into a full-library walk. And only
     * `%` survives: `_` is escaped by the middleware (`avatar__way` returned 0 where `_` as a
     * single-character wildcard would have matched), so patterns are built from `%` alone.
     */
    private wildcardPhrase(terms: string[]): string {
        if (terms.length < 2) return '';
        // Only worth it on a portal we have not already seen ignore the wildcard.
        if (this.searchWildcards === false) return '';
        const safe = terms
            .map(term => term.replace(/[%_\\]/g, '').trim())
            .filter(term => term.length > 0);
        return safe.length > 1 ? safe.join('%') : '';
    }

    /**
     * Set `searchWildcards` from one request, using a phrase already known to match rows.
     *
     * `<phrase>` and `%<phrase>%` are the same query to a portal that expands the wildcard
     * (its `LIKE '%%phrase%%'` is `LIKE '%phrase%'`), and a portal that treats `%` literally
     * finds nothing, because no title contains those percent signs. So any rows at all mean
     * the wildcard is live, and none means it is inert — no false reading either way.
     *
     * The provider's count is the primary signal, but it is not always there: a middleware
     * that answers with a bare array (or omits `total_items`) reports `undefined`, and
     * reading that as zero would mark a wildcard-honouring portal inert for the rest of the
     * session, quietly costing every later multi-word search its precise walk. When there is
     * no count to read, the rows that came back are the only evidence, and they are enough:
     * a literal portal cannot return a row for a pattern containing `%`.
     */
    private async probeWildcardSupport(
        type: 'vod' | 'series',
        categoryId: string | undefined,
        knownToMatch: string
    ): Promise<void> {
        try {
            const raw = await this.fetchStalker<any>('get_ordered_list', type, {
                category: this.portalCategoryId(categoryId),
                search: `%${knownToMatch}%`,
                include_censored: '1',
                censored: '1',
                p: String(this.pageOffset ?? 0),
            });
            const parsed = this.extractOrderedList(raw);
            this.searchWildcards = (parsed.total_items ?? parsed.items.length) > 0;
        } catch (err) {
            // Leave it unknown: the cost of asking again later is one request.
            console.warn('[Stalker] Could not check whether this portal honours the % wildcard:', err);
        }
    }

    /**
     * Walk up to `maxPages` pages of a `search`ed `get_ordered_list`.
     *
     * Page numbering is the same trap as an ordinary category: an unsearched and a
     * searched list both answer identically for `p=0` and `p=1` on the portals we
     * measured, so the first walk probes whether the portal is 0- or 1-based and
     * memoizes the answer, exactly like `fetchOrderedListPages`.
     *
     * Only the first page is mandatory — a later page that fails ends the walk with
     * what was already loaded rather than throwing away results the user can see.
     */
    private async walkSearchPages(
        type: 'vod' | 'series',
        phrase: string,
        categoryId: string | undefined,
        fromPage: number,
        maxPages: number,
        onProgress?: StalkerSearchOptions['onProgress']
    ): Promise<StalkerSearchWalk> {
        const baseParams: Record<string, string> = {
            category: this.portalCategoryId(categoryId),
            search: phrase,
            include_censored: '1',
            censored: '1',
        };

        const fetchPage = async (p: number) =>
            this.extractOrderedList(
                await this.fetchStalker<any>('get_ordered_list', type, { ...baseParams, p: String(p) })
            );

        let pOffset = this.pageOffset ?? 0;
        const seen = new Set<string | number>();
        const items: any[] = [];
        let total = 0;
        let pageSize = 14;
        let lastPageFull = false;
        let pagesFetched = 0;
        let dataIndex = fromPage;
        let learnOffset = this.pageOffset === null && fromPage === 0;
        // Search pages on some portals overlap (measured: a 61-result search
        // came back 49 unique items across six pages), so a page that adds nothing new
        // is not proof the walk is finished. Only two in a row means the portal is
        // repeating itself; `maxPages` is the hard bound either way.
        let consecutiveEmptyPages = 0;

        while (pagesFetched < maxPages) {
            let page: Awaited<ReturnType<typeof fetchPage>>;
            try {
                page = await fetchPage(dataIndex + pOffset);
            } catch (err) {
                if (pagesFetched === 0) throw err;
                console.warn(`[Stalker] Search "${phrase}": page ${dataIndex + pOffset} failed; stopping with what loaded:`, err);
                break;
            }

            if (page.max_page_items) pageSize = page.max_page_items;
            if (page.total_items != null) total = page.total_items;

            const fresh = page.items.filter((item: any) => item?.id == null || !seen.has(item.id));
            for (const item of fresh) {
                if (item?.id != null) seen.add(item.id);
            }
            items.push(...fresh);
            pagesFetched++;
            dataIndex++;
            lastPageFull = page.items.length > 0 && page.items.length >= pageSize;

            if (onProgress) onProgress({ page: dataIndex, loaded: items.length, total });

            if (!lastPageFull) break;

            if (fresh.length === 0) {
                consecutiveEmptyPages++;
                if (consecutiveEmptyPages >= 2) {
                    console.warn(`[Stalker] Search "${phrase}": pages ${dataIndex + pOffset - 2}-${dataIndex + pOffset - 1} added nothing new; stopping.`);
                    lastPageFull = false;
                    break;
                }
            } else {
                consecutiveEmptyPages = 0;
            }

            if (learnOffset) {
                learnOffset = false;
                try {
                    const probe = await fetchPage(1);
                    const repeatsFirstPage =
                        probe.items.length > 0 && probe.items.every((item: any) => item?.id != null && seen.has(item.id));
                    if (repeatsFirstPage) {
                        pOffset = 1;
                        this.pageOffset = 1;
                    } else {
                        // The probe was a real second page: keep it, and treat the portal as 0-based.
                        pOffset = 0;
                        this.pageOffset = 0;
                        if (probe.max_page_items) pageSize = probe.max_page_items;
                        if (probe.total_items != null) total = probe.total_items;
                        const probeFresh = probe.items.filter((item: any) => item?.id == null || !seen.has(item.id));
                        for (const item of probeFresh) {
                            if (item?.id != null) seen.add(item.id);
                        }
                        items.push(...probeFresh);
                        pagesFetched++;
                        dataIndex++;
                        lastPageFull = probe.items.length > 0 && probe.items.length >= pageSize;
                        if (onProgress) onProgress({ page: dataIndex, loaded: items.length, total });
                        if (probeFresh.length === 0) break;
                    }
                } catch (err) {
                    // Leave the offset unlearned: the next multi-page search retries the probe.
                    console.warn(`[Stalker] Search "${phrase}": could not probe page numbering:`, err);
                }
            }
        }

        return { items, total, loadedCount: items.length, nextPage: dataIndex, lastPageFull };
    }

    /**
     * Confirm that a portal ignored `search`, by comparing the searched total with the
     * same call made without it. Only called when nothing the portal returned carries
     * the phrase, so the extra request is rare.
     */
    private async portalIgnoresSearch(
        type: 'vod' | 'series',
        categoryId: string | undefined,
        searchTotal: number
    ): Promise<boolean> {
        try {
            const raw = await this.fetchStalker<any>('get_ordered_list', type, {
                category: this.portalCategoryId(categoryId),
                include_censored: '1',
                censored: '1',
                p: String(this.pageOffset ?? 0),
            });
            const unsearched = this.extractOrderedList(raw);
            return unsearched.total_items != null && unsearched.total_items === searchTotal;
        } catch (err) {
            console.warn('[Stalker] Could not verify whether the portal supports search:', err);
            return false;
        }
    }

    /** Strip this client's source prefix so the portal sees its own category id. */
    private portalCategoryId(categoryId?: string): string {
        if (!categoryId) return '*';
        return (
            categoryId
                .replace(`${this.sourceId}_vod_`, '')
                .replace(`${this.sourceId}_series_`, '')
                .replace(`${this.sourceId}_`, '') || '*'
        );
    }

    private isSeriesItem(item: any): boolean {
        const isSeries = item?.is_series;
        return isSeries === '1' || isSeries === 1 || isSeries === true;
    }

    /**
     * Compare a title against a search word the way a user reads it: case-insensitive
     * and ignoring punctuation, so local narrowing is not defeated by the colon that
     * defeated the portal's own substring match.
     */
    private itemNameMatches(item: any, term: string): boolean {
        const name = this.normalizeSearchText(String(item?.name ?? ''));
        const needle = this.normalizeSearchText(term);
        return needle.length > 0 && name.includes(needle);
    }

    /**
     * Fold a title or query down to comparable words: case-insensitive, accent-insensitive
     * and punctuation-blind, but Unicode-aware.
     *
     * An ASCII-only class (`[^a-z0-9]+`) erases non-Latin text entirely — a Cyrillic, Greek,
     * Arabic or CJK query normalised to an empty needle, which made every comparison fail
     * and left this narrowing with nothing to narrow by.
     */
    private normalizeSearchText(value: string): string {
        return value
            .normalize('NFD')
            .replace(/\p{M}+/gu, '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
    }

    /**
     * Category membership for a search hit.
     *
     * `get_ordered_list` answers every row with its own `category_id` / `category_id_1`,
     * and those are the only thing that lets a hit be browsed from the categories list
     * instead of existing only inside a search result. The caller's scoped category (when
     * the search ran inside one) is included too. These portals use "0" for "none".
     */
    private searchCategoryIds(item: any, categoryId: string | undefined, isSeries: boolean): string[] {
        const ids = new Set<string>();
        if (categoryId) ids.add(categoryId);
        const prefix = isSeries ? `${this.sourceId}_series_` : `${this.sourceId}_vod_`;
        for (const raw of [item?.category_id, item?.category_id_1]) {
            const value = String(raw ?? '').trim();
            if (value && value !== '0' && value !== '*') ids.add(`${prefix}${value}`);
        }
        return [...ids];
    }

    /** Item → movie, mirroring `getVodStreams` so a search hit is the same row shape. */
    private mapSearchMovie(item: any, categoryId?: string): Channel {
        // The movie row carries fields the `Channel` surface does not declare (title etc.);
        // `getVodStreams` returns the same literal from a loosely typed map, so assert here.
        return {
            stream_id: `${this.sourceId}_vod_${item.id}`,
            name: item.name,
            title: item.name,
            stream_icon: this.resolvePosterUrl(item.screenshot_uri),
            rating: item.rating_kinopoisk || item.rating_imdb || '',
            plot: item.description || '',
            genre: item.genre || '',
            cast: item.actors || '',
            director: item.director || '',
            year: item.year || '',
            release_date: item.year ? `${item.year}-01-01` : '',
            category_ids: this.searchCategoryIds(item, categoryId, false),
            added: item.added || item.time_added || item.added_time || '',
            container_extension: item.container_extension || 'mp4',
            direct_url: `stalker_vod:${item.id}:${item.cmd || ''}`,
            source_id: this.sourceId,
            epg_channel_id: '',
        } as Channel;
    }

    /** Item → series, mirroring `getSeriesStreams` so a search hit is the same row shape. */
    private mapSearchSeries(item: any, categoryId?: string): Channel {
        return {
            stream_id: `${this.sourceId}_series_${item.id}`,
            series_id: `${this.sourceId}_series_${item.id}`,
            name: item.name,
            stream_icon: this.resolvePosterUrl(item.screenshot_uri),
            cover: this.resolvePosterUrl(item.screenshot_uri),
            rating: item.rating_kinopoisk || item.rating_imdb || '',
            plot: item.description || '',
            genre: item.genre || '',
            cast: item.actors || '',
            director: item.director || '',
            year: item.year || '',
            releaseDate: item.year ? `${item.year}-01-01` : '',
            category_ids: this.searchCategoryIds(item, categoryId, true),
            added: item.added || item.time_added || item.added_time || '',
            direct_url: `stalker_series:${item.id}:${item.cmd || `/media/${item.id}.mpg`}`,
            source_id: this.sourceId,
            epg_channel_id: '',
        } as Channel;
    }

    // Methods expected by sync.ts
    async getCategoryItems(categoryId: string, type: 'vod' | 'series', onProgress?: StalkerPageProgress, concurrency?: number): Promise<Channel[]> {
        if (type === 'vod') {
            return this.getVodStreams(categoryId, onProgress, concurrency);
        } else {
            return this.getSeriesStreams(categoryId, onProgress, concurrency);
        }
    }

    async getVods(): Promise<{ categories: Category[]; streams: Channel[] }> {
        const categories = await this.getVodCategories();
        const streams = await this.getVodStreams();
        return { categories, streams };
    }

    async getSeries(): Promise<{ categories: Category[]; streams: Channel[] }> {
        const categories = await this.getSeriesCategories();
        const streams = await this.getSeriesStreams();
        return { categories, streams };
    }

    async getSeriesInfo(seriesId: string): Promise<Season[]> {
        // seriesId can be:
        // 1. Raw Stalker ID (e.g., "12345" or "12345:12345") - passed from syncSeriesEpisodes
        // 2. Prefixed ID (e.g., "{sourceId}_series_12345") - legacy format
        // 3. direct_url format (e.g., "stalker_series:12345") - from stored series
        // getSeasons now returns seasons with episodes already populated (like Python)
        return this.getSeasons(seriesId);
    }
}

interface StalkerGenre {
    id: string;
    title: string;
    censored?: string | number;
}

interface StalkerChannel {
    id: string;
    name: string;
    number: string;
    tv_genre_id?: string;
    genre_id?: string;
    logo: string;
    url?: string;
    cmd?: string;
    xmltv_id: string;
    censored?: string | number;
    lock?: number;
}
