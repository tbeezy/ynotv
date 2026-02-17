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

interface StalkerGenre {
    id: string;
    title: string;
    alias?: string;
}

export class StalkerClient {
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
        let extracted = data[expectedKey] || data;

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

        // Timezone: stalker_portal uses Europe/Paris, portal.php uses Europe/London
        const timezone = this.isStalkerPortalEndpoint() ? 'Europe/Paris' : 'Europe/London';
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
     * Ensure we have a valid token (renew if expired)
     * Uses promise-based locking to prevent concurrent token refresh operations
     */
    private async ensureToken(): Promise<void> {
        // If a refresh is already in progress, wait for it to complete
        if (this.tokenRefreshPromise) {
            console.log('[Stalker] Token refresh already in progress, waiting...');
            await this.tokenRefreshPromise;
            console.log('[Stalker] Token refresh completed by another call');
            return;
        }

        const currentTimestamp = Date.now() / 1000;

        if (!this.token || (currentTimestamp - this.tokenTimestamp) > STALKER_TOKEN_VALIDITY_SECONDS) {
            console.log('[Stalker] Token expired or missing. Starting refresh...');

            // Create and store the refresh promise to block concurrent calls
            this.tokenRefreshPromise = (async () => {
                try {
                    await this.handshake();
                    await this.getProfile();
                    console.log('[Stalker] Token refresh completed successfully');
                } catch (error) {
                    console.error('[Stalker] Token refresh failed:', error);
                    throw error;
                } finally {
                    // Always clear the lock when done
                    this.tokenRefreshPromise = null;
                }
            })();

            await this.tokenRefreshPromise;
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
        customHeaders: Record<string, string> | null = null
    ): Promise<T> {
        const params = new URLSearchParams({
            type,
            action,
            JsHttpRequest: '1-xml',
            ...extraParams,
        });

        const url = `${this.config.baseUrl}?${params.toString()}`;
        const headers = customHeaders || this.getHeaders(true, true);

        // Debug logging
        console.log(`[Stalker] Request: ${action}, URL: ${url}`);
        console.log(`[Stalker] Headers:`, {
            Authorization: headers['Authorization'] || 'none',
            Cookie: headers['Cookie'] || 'none'
        });

        // Retry logic with exponential backoff
        let lastError: any;
        for (let attempt = 1; attempt <= STALKER_MAX_RETRIES; attempt++) {
            try {
                const response = await universalFetch(url, {
                    headers,
                    timeout: STALKER_TIMEOUT_MS,
                });

                if (!response.ok) {
                    if (response.status === 404) {
                        throw new Error('404 Not Found');
                    }
                    throw new Error(`Stalker API error: ${response.status} ${response.statusText}`);
                }

                // Handle empty response
                if (!response.text || response.text.trim() === '') {
                    console.warn('[Stalker] Empty response body received');
                    return {} as T;
                }

                // Parse JSON
                let parsed: any;
                try {
                    parsed = JSON.parse(response.text);
                } catch (e) {
                    console.error('[Stalker] Failed to parse JSON:', response.text.substring(0, 500));
                    throw new Error('Invalid JSON response from Stalker portal');
                }

                return this.processResponse<T>(parsed, action);

            } catch (error: any) {
                lastError = error;

                // Don't retry 404 errors (let handshake handle URL fallback)
                if (error.message === '404 Not Found') {
                    throw error;
                }

                console.warn(`[Stalker] Request failed (attempt ${attempt}/${STALKER_MAX_RETRIES}): ${error.message}`);

                // Exponential backoff before retry
                if (attempt < STALKER_MAX_RETRIES) {
                    const backoff = STALKER_RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, backoff));
                }
            }
        }

        throw lastError;
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
        const rawData = await this.fetchStalker<any>('get_genres', 'itv');
        const genres = this.safeJsonList<StalkerGenre>(rawData);

        console.log(`[Stalker] Fetched ${genres.length} live categories`);

        return genres.map(genre => ({
            category_id: `${this.sourceId}_${genre.id}`,
            category_name: genre.title,
            source_id: this.sourceId,
        }));
    }

    async getLiveStreams(): Promise<Channel[]> {
        await this.ensureToken();
        console.log('[Stalker] getLiveStreams: Using get_all_channels for instant loading...');

        try {
            // Use get_all_channels to fetch ALL channels in ONE request
            const rawData = await this.fetchStalker<any>('get_all_channels', 'itv');

            // Use safeJsonList to handle both {js: []} and {js: {}} responses
            // For get_all_channels, data is often in 'data' key instead of 'js'
            const channelsData = this.safeJsonList<any>(rawData, 'data');

            console.log(`[Stalker] Received ${channelsData.length} channels from get_all_channels`);

            // Also fetch genres for category mapping
            const rawGenres = await this.fetchStalker<any>('get_genres', 'itv');
            const genres = this.safeJsonList<StalkerGenre>(rawGenres);
            const genreMap = new Map<string, string>();
            if (Array.isArray(genres)) {
                for (const genre of genres) {
                    genreMap.set(genre.id, `${this.sourceId}_${genre.id}`);
                }
            }

            // Process all channels
            const allChannels: Channel[] = [];
            const seenChannelIds = new Set<string>();

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

                const channel: Channel = {
                    stream_id: `${this.sourceId}_${ch.id}`,
                    channel_num: parseInt(ch.number || '0'),
                    name: ch.name,
                    stream_icon: ch.logo || '',

                    category_ids: catIds.size > 0 ? Array.from(catIds) : [],
                    direct_url: url,
                    source_id: this.sourceId,
                    epg_channel_id: ch.xmltv_id,
                };

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
        const rawData = await this.fetchStalker<any>('get_categories', 'vod');
        const categories = this.safeJsonList<StalkerGenre>(rawData);

        console.log(`[Stalker] Fetched ${categories.length} raw VOD categories`);

        // Python logic: Exclude categories with keywords 'tv', 'series', 'show'
        const excludeKeywords = ['tv', 'series', 'show'];

        const filteredData = categories.filter(cat => {
            const name = (cat.title || '').toLowerCase();
            return !excludeKeywords.some(keyword => name.includes(keyword));
        });

        console.log(`[Stalker] Filtered to ${filteredData.length} VOD categories`);

        return filteredData.map(cat => ({
            category_id: `${this.sourceId}_vod_${cat.id}`,
            category_name: cat.title,
            parent_id: 0,
            source_id: this.sourceId,
        }));
    }

    async getVodStreams(categoryId?: string): Promise<Channel[]> {
        await this.ensureToken();
        console.log('[Stalker] getVodStreams: fetching with parallel pagination...');

        const catId = categoryId ? categoryId.replace(`${this.sourceId}_vod_`, '').replace(`${this.sourceId}_`, '') : '*';

        // Fetch pages in parallel batches of 4 for faster loading
        const allItems: any[] = [];
        let page = 1;
        let hasMore = true;
        const BATCH_SIZE = 4;

        while (hasMore) {
            // Fetch BATCH_SIZE pages in parallel
            const batchPromises = [];
            for (let i = 0; i < BATCH_SIZE; i++) {
                batchPromises.push(
                    this.fetchStalker<any>('get_ordered_list', 'vod', {
                        category: catId,
                        p: (page + i).toString()
                    })
                );
            }

            const responses = await Promise.all(batchPromises);
            let itemsInBatch = 0;

            for (let i = 0; i < responses.length; i++) {
                const response = responses[i];
                let vodData = response?.data || response;
                if (vodData && vodData.js && vodData.js.data) {
                    vodData = vodData.js.data;
                }

                if (Array.isArray(vodData) && vodData.length > 0) {
                    allItems.push(...vodData);
                    itemsInBatch += vodData.length;

                    // If any page has less than 14 items, we've reached the end
                    if (vodData.length < 14) {
                        hasMore = false;
                    }
                } else {
                    // Empty response means no more pages
                    hasMore = false;
                }
            }

            // If we got no items in this batch, stop
            if (itemsInBatch === 0) {
                hasMore = false;
            } else {
                page += BATCH_SIZE;
            }
        }

        console.log(`[Stalker] Fetched ${allItems.length} total VOD items from ${page} page(s)`);

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
            stream_icon: item.screenshot_uri || '',
            rating: item.rating_kinopoisk || item.rating_imdb || '',

            // Metadata from provider
            plot: item.description || '',
            genre: item.genre || '',
            cast: item.actors || '',
            director: item.director || '',
            year: item.year || '',
            release_date: item.year ? `${item.year}-01-01` : '',

            category_ids: categoryId ? [categoryId] : [],
            added: item.added || '',
            container_extension: item.container_extension || 'mp4',
            direct_url: `stalker_vod:${item.id}:${item.cmd || ''}`,
            source_id: this.sourceId,
            epg_channel_id: '',
        }));
    }

    async getSeriesCategories(): Promise<Category[]> {
        await this.ensureToken();
        // This portal uses type='series' to fetch series categories (not type='vod')
        const rawData = await this.fetchStalker<any>('get_categories', 'series');
        const categories = this.safeJsonList<StalkerGenre>(rawData);

        console.log(`[Stalker] Fetched ${categories.length} raw series categories`);

        // FIXED: Series and Movies share the same categories in Stalker portals.
        // The distinction is made at the content level via the 'is_series' flag, not category names.
        // Some portals use keywords like 'tv', 'series', but many don't (e.g., "VOD - NETFLIX [MULTISUB]").
        // So we should return ALL VOD categories as potential series categories.
        const filteredData = categories;

        console.log(`[Stalker] Returning ${filteredData.length} series categories (all VOD categories)`);

        return filteredData.map(cat => ({
            category_id: `${this.sourceId}_series_${cat.id}`,
            category_name: cat.title,
            parent_id: 0,
            source_id: this.sourceId,
            epg_channel_id: '',
            is_category: true,
            category_type: 'series',
        }));
    }

    async getSeriesStreams(categoryId?: string): Promise<Channel[]> {
        await this.ensureToken();
        console.log('[Stalker] getSeriesStreams: fetching with parallel pagination...');

        const catId = categoryId ? categoryId.replace(`${this.sourceId}_series_`, '').replace(`${this.sourceId}_`, '') : '*';

        // Fetch pages in parallel batches of 4 for faster loading
        const allItems: any[] = [];
        let page = 1;
        let hasMore = true;
        const BATCH_SIZE = 4;

        while (hasMore) {
            // Fetch BATCH_SIZE pages in parallel
            const batchPromises = [];
            for (let i = 0; i < BATCH_SIZE; i++) {
                batchPromises.push(
                    this.fetchStalker<any>('get_ordered_list', 'series', {
                        category: catId,
                        p: (page + i).toString()
                    })
                );
            }

            const responses = await Promise.all(batchPromises);
            let itemsInBatch = 0;

            for (let i = 0; i < responses.length; i++) {
                const response = responses[i];
                let seriesData = response?.data || response;
                if (seriesData && seriesData.js && seriesData.js.data) {
                    seriesData = seriesData.js.data;
                }

                if (Array.isArray(seriesData) && seriesData.length > 0) {
                    allItems.push(...seriesData);
                    itemsInBatch += seriesData.length;

                    // If any page has less than 14 items, we've reached the end
                    if (seriesData.length < 14) {
                        hasMore = false;
                    }
                } else {
                    // Empty response means no more pages
                    hasMore = false;
                }
            }

            // If we got no items in this batch, stop
            if (itemsInBatch === 0) {
                hasMore = false;
            } else {
                page += BATCH_SIZE;
            }
        }

        console.log(`[Stalker] Fetched ${allItems.length} total series items from ${page} page(s)`);

        return allItems.map(item => ({
            stream_id: `${this.sourceId}_series_${item.id}`, // Required for Channel type
            series_id: `${this.sourceId}_series_${item.id}`, // PRIMARY KEY for vodSeries table
            name: item.name,
            stream_icon: item.screenshot_uri || '',
            cover: item.screenshot_uri || '', // Required for series
            rating: item.rating_kinopoisk || item.rating_imdb || '',

            // Metadata from provider
            plot: item.description || '',
            genre: item.genre || '',
            cast: item.actors || '',
            director: item.director || '',
            year: item.year || '',
            releaseDate: item.year ? `${item.year}-01-01` : '',

            category_ids: categoryId ? [categoryId] : [],
            added: item.added || '',
            // Store movie_id for series navigation
            direct_url: `stalker_series:${item.id}`,
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

        // Use type='series' for series content (not 'vod')
        const response = await this.fetchStalker<any>('get_ordered_list', 'series', {
            movie_id: rawMovieId,
            season_id: '0',
            episode_id: '0',
            p: '0'
        });

        let seasonsData = response?.data || response;
        console.log('[Stalker] Raw response:', JSON.stringify(response).substring(0, 500));
        if (seasonsData && seasonsData.js && seasonsData.js.data) {
            seasonsData = seasonsData.js.data;
        }

        console.log('[Stalker] seasonsData type:', typeof seasonsData, 'isArray:', Array.isArray(seasonsData));
        if (Array.isArray(seasonsData)) {
            console.log('[Stalker] seasonsData length:', seasonsData.length);
            if (seasonsData.length > 0) {
                console.log('[Stalker] First item sample:', JSON.stringify(seasonsData[0]).substring(0, 300));
                console.log('[Stalker] First item keys:', Object.keys(seasonsData[0]));
            }
        }

        if (!Array.isArray(seasonsData)) {
            console.warn('[Stalker] Seasons data is not an array, returning empty');
            return [];
        }

        // Filter for seasons only - in Stalker API, seasons have is_series=1 and series array contains episode numbers
        // Looking at packet capture: items have "is_series":1 and "series":[1,2,3...] for episodes
        const seasons = seasonsData.filter((item: any) => item.is_series === 1 && item.series && Array.isArray(item.series));

        console.log(`[Stalker] Total items: ${seasonsData.length}, Seasons found: ${seasons.length}`);

        // Map seasons - episodes are just numbers in the 'series' array
        return seasons.map(season => {
            // Season ID format is like "17105:1" - extract season number from name or id
            const seasonName = season.name || '';
            const seasonNumMatch = seasonName.match(/Season\s*(\d+)/i);
            const seasonNum = seasonNumMatch ? parseInt(seasonNumMatch[1]) : 1;

            // Episodes are just numbers in the 'series' array (e.g., [1,2,3,4,5,6,7,8,9])
            const episodeNumbers: number[] = season.series || [];
            console.log(`[Stalker] Season ${seasonNum} (${seasonName}) has ${episodeNumbers.length} episodes`);

            const episodes: Episode[] = episodeNumbers.map((epNum: number) => ({
                id: `${this.sourceId}_episode_${season.id}_${epNum}`,
                title: `Episode ${epNum}`,
                episode_num: epNum,
                season_num: seasonNum,
                // Use the cmd from the season for create_link - it contains series_id and season_num
                direct_url: `stalker_episode:${rawMovieId}:${seasonNum}:${epNum}:${season.cmd || ''}`,
                info: { season_name: seasonName }
            }));

            return {
                season_number: seasonNum,
                episodes: episodes
            };
        });
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

        // Use type='series' for series content
        const response = await this.fetchStalker<any>('get_ordered_list', 'series', {
            movie_id: rawMovieId,
            season_id: seasonId,
            episode_id: '0',
            p: '0'
        });

        let episodesData = response?.data || response;
        if (episodesData && episodesData.js && episodesData.js.data) {
            episodesData = episodesData.js.data;
        }

        if (!Array.isArray(episodesData)) {
            console.warn('[Stalker] Episodes data is not an array');
            return [];
        }

        // Use rawMovieId in direct_url so resolveStreamUrl gets the correct ID
        return episodesData.map(episode => ({
            id: `${this.sourceId}_episode_${episode.id}`,
            title: episode.name || `Episode ${episode.series_number || episode.episode_num}`,
            episode_num: parseInt(episode.series_number || episode.episode_num) || 0,
            season_num: parseInt(seasonId) || 0,
            direct_url: `stalker_episode:${rawMovieId}:${seasonId}:${episode.series_number || episode.episode_num}`,
            info: episode
        }));
    }

    async resolveStreamUrl(cmd: string): Promise<string> {
        console.log('[Stalker] resolveStreamUrl called with:', cmd);

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
            const parts = cmd.split(':');
            if (parts.length < 5) {
                throw new Error('Invalid stalker_episode format');
            }
            const movieId = parts[1];
            const seasonId = parts[2];
            const episodeNum = parts[3];
            const seasonCmd = parts[4]; // Base64 encoded cmd from season
            seriesEpisodeNum = episodeNum;

            console.log(`[Stalker] Resolving episode: Movie=${movieId}, Season=${seasonId}, Episode=${episodeNum}`);
            console.log(`[Stalker] Using season cmd: ${seasonCmd}`);

            // Use the cmd from the season directly - no need to fetch episode list
            // The create_link API uses the season cmd + series parameter for episode number
            if (seasonCmd) {
                forcedCmd = seasonCmd;
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
                    p: '1'
                });
                const listData = listResp?.data || listResp?.js?.data;
                if (Array.isArray(listData) && listData.length > 0) {
                    // FIXED: Don't blindly use listData[0] - find the item that matches our movie_id
                    // The response may contain multiple items or cached results
                    const item = listData.find((i: any) => String(i.id) === String(movieId)) || listData[0];
                    console.log(`[Stalker] VOD item for movie_id ${movieId}:`, JSON.stringify(item).substring(0, 200));
                    forcedCmd = item.cmd || `/media/file_${item.id}.mpg`;
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
            console.warn('[Stalker] Unknown cmd format, passing through:', cmd);
            return cmd;
        }

        try {
            console.log(`[Stalker] Calling create_link. Type=${type}, Cmd=${forcedCmd}`);

            const params: Record<string, string> = {
                cmd: forcedCmd,
                type: type,
            };

            if (seriesEpisodeNum) {
                params['series'] = seriesEpisodeNum;
            }

            const response = await this.fetchStalker<any>('create_link', type, params);
            // fetchStalker returns unwrapped JS/Data

            let resultUrl = response.url;
            if (!resultUrl && response.cmd) {
                resultUrl = response.cmd;
            }

            if (!resultUrl) {
                throw new Error(`create_link returned no URL. Resp: ${JSON.stringify(response)}`);
            }

            // Cleanup URL
            if (typeof resultUrl === 'string') {
                // 1. Remove ffmpeg prefix
                resultUrl = resultUrl.replace(/^(ffmpeg|ffrt)\s*/i, '').trim();

                // 2. Resolve relative URL
                if (!resultUrl.match(/^https?:\/\//i)) {
                    // Check if it starts with /
                    if (resultUrl.startsWith('/')) {
                        const baseUrl = new URL(this.config.baseUrl);
                        resultUrl = `${baseUrl.origin}${resultUrl}`;
                    } else {
                        // Relative to vod path?
                        // Guide says: stream_base_url = portal_url + ...
                        // Let's assume absolute from base
                        const baseUrl = new URL(this.config.baseUrl);
                        // If safe, join
                        resultUrl = new URL(resultUrl, baseUrl.href).toString();
                    }
                }
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
            let cleanUrl = url.replace(/^(ffmpeg|ffrt) /i, '').trim();

            // If it's a relative path, prepend base URL
            if (cleanUrl.startsWith('/')) {
                const baseUrlObj = new URL(this.config.baseUrl);
                cleanUrl = `${baseUrlObj.protocol}//${baseUrlObj.host}${cleanUrl}`;
            }

            // Fix localhost/127.0.0.1
            const urlObj = new URL(cleanUrl);
            if (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1') {
                const baseUrlObj = new URL(this.config.baseUrl);
                urlObj.hostname = baseUrlObj.hostname;
                urlObj.port = baseUrlObj.port;
                console.log(`[Stalker] Rewrote localhost URL to: ${urlObj.toString()}`);
                cleanUrl = urlObj.toString();
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
    async getEpg(periodHours: number = 72): Promise<Map<string, any[]>> {
        await this.ensureToken();
        try {
            const response = await this.fetchStalker<any>('get_epg_info', 'itv', {
                period: periodHours.toString()
            });

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

            console.log(`[Stalker] Retrieved EPG for ${epgMap.size} channels`);
            return epgMap;
        } catch (err) {
            console.error('[Stalker] Failed to fetch EPG:', err);
            return new Map();
        }
    }

    /**
     * Get account information including expiry date
     */
    async getAccountInfo(): Promise<{ mac: string; expiry?: string }> {
        await this.ensureToken();
        try {
            const response = await this.fetchStalker<any>('get_main_info', 'account_info');

            const mac = response?.mac || this.config.mac;
            const expiry = response?.phone;

            console.log(`[Stalker] Account info: MAC=${mac}, Expiry=${expiry || 'N/A'}`);

            return { mac, expiry };
        } catch (err) {
            console.error('[Stalker] Failed to fetch account info:', err);
            return { mac: this.config.mac };
        }
    }

    // Methods expected by sync.ts
    async getCategoryItems(categoryId: string, type: 'vod' | 'series', onProgress?: (percent: number, message: string) => void): Promise<Channel[]> {
        if (type === 'vod') {
            return this.getVodStreams(categoryId);
        } else {
            return this.getSeriesStreams(categoryId);
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
}
