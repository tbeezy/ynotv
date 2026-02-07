import type { Channel, Category, Season, Episode } from '@sbtltv/core';
import CryptoJS from 'crypto-js';

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
            'Connection': 'keep-alive',  // Match working player
            'Accept-Encoding': 'gzip, deflate'
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
        const TOKEN_VALIDITY = 3600; // 1 hour

        if (!this.token || (currentTimestamp - this.tokenTimestamp) > TOKEN_VALIDITY) {
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

        // baseUrl now includes the full path to server/load.php or portal.php
        const url = `${this.config.baseUrl}?${params.toString()}`;

        const headers = customHeaders || this.getHeaders(true, true);

        // Debug logging
        console.log(`[Stalker] Request: ${action}, URL: ${url}`);
        console.log(`[Stalker] Headers:`, {
            Authorization: headers['Authorization'] || 'none',
            Cookie: headers['Cookie'] || 'none'
        });

        // Add timeout to prevent hanging
        const TIMEOUT_MS = 60000; // 60 seconds

        const performRequest = async () => {
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`Request timeout after ${TIMEOUT_MS}ms for action: ${action}`)), TIMEOUT_MS);
            });

            let data: any;

            // Helper to process response
            const processResponse = (raw: any): T => {
                // Stalker API typically returns { js: ... }
                if (raw && raw.js) {
                    return raw.js as T;
                }
                // Some versions return { data: ... }
                if (raw && raw.data) {
                    return raw.data as T;
                }
                return raw as T;
            };

            const fetchLogic = async () => {
                if (typeof window !== 'undefined' && window.fetchProxy) {
                    if (!window.fetchProxy) throw new Error('fetchProxy not available');
                    const result = await window.fetchProxy.fetch(url, { headers });
                    if (!result.success || !result.data) {
                        throw new Error(result.error || 'Fetch failed');
                    }

                    if (!result.data.ok) {
                        if (result.data.status === 404) {
                            throw new Error('404 Not Found');
                        }
                        throw new Error(`Stalker API error: ${result.data.status} ${result.data.statusText}`);
                    }
                    try {
                        const text = result.data.text;
                        if (!text || text.trim() === '') return {};
                        const parsed = JSON.parse(text);

                        // Debug: Log FULL response for key actions to diagnose empty data issue
                        if (['get_genres', 'get_all_channels', 'get_categories', 'get_epg_info'].includes(action)) {
                            console.log(`[Stalker] Full response for ${action}:`, JSON.stringify(parsed));

                            // Specifically warn if we detect empty objects
                            if (parsed.js && typeof parsed.js === 'object' && !Array.isArray(parsed.js) && Object.keys(parsed.js).length === 0) {
                                console.warn(`[Stalker] ⚠️ ${action} returned EMPTY OBJECT: {"js":{}}`);
                            }
                            if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) && Object.keys(parsed.data).length === 0) {
                                console.warn(`[Stalker] ⚠️ ${action} returned EMPTY OBJECT: {"data":{}}`);
                            }
                        }
                        return parsed;
                    } catch (e) {
                        console.error('[Stalker] Failed to parse JSON:', result.data.text);
                        throw new Error('Invalid JSON response from Stalker portal');
                    }
                } else {
                    const response = await fetch(url, { headers });
                    if (!response.ok) {
                        if (response.status === 404) throw new Error('404 Not Found');
                        throw new Error(`Stalker API error: ${response.status} ${response.statusText}`);
                    }
                    const text = await response.text();
                    if (!text || text.trim() === '') return {};
                    try {
                        const parsed = JSON.parse(text);

                        // Debug: Log FULL response for key actions to diagnose empty data issue
                        if (['get_genres', 'get_all_channels', 'get_categories', 'get_epg_info'].includes(action)) {
                            console.log(`[Stalker] Full response for ${action}:`, JSON.stringify(parsed));

                            // Specifically warn if we detect empty objects
                            if (parsed.js && typeof parsed.js === 'object' && !Array.isArray(parsed.js) && Object.keys(parsed.js).length === 0) {
                                console.warn(`[Stalker] ⚠️ ${action} returned EMPTY OBJECT: {"js":{}}`);
                            }
                            if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) && Object.keys(parsed.data).length === 0) {
                                console.warn(`[Stalker] ⚠️ ${action} returned EMPTY OBJECT: {"data":{}}`);
                            }
                        }
                        return parsed;
                    } catch (e) {
                        console.error('[Stalker] Failed to parse JSON:', text);
                        throw new Error('Invalid JSON response from Stalker portal');
                    }
                }
            };

            data = await Promise.race([fetchLogic(), timeoutPromise]);
            return processResponse(data);
        };

        // Retry Logic
        const RETRIES = 3;
        let lastError: any;

        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            try {
                return await performRequest();
            } catch (error: any) {
                lastError = error;
                // Don't retry 404 (Handshake needs to see it, or resource broken)
                if (error.message === '404 Not Found') {
                    throw error;
                }

                console.warn(`[Stalker] Request failed (attempt ${attempt}/${RETRIES}): ${error.message}`);

                if (attempt < RETRIES) {
                    const backoff = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
                    await new Promise(resolve => setTimeout(resolve, backoff));
                }
            }
        }

        throw lastError;
    }


    async handshake(): Promise<void> {
        console.log('[Stalker] Starting handshake...');
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 500 * attempt));
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
        console.log('[Stalker] getVodStreams: fetching with pagination...');

        const catId = categoryId ? categoryId.replace(`${this.sourceId}_vod_`, '').replace(`${this.sourceId}_`, '') : '*';

        // Fetch ALL pages (server limit is 14 items per page)
        const allItems: any[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const response = await this.fetchStalker<any>('get_ordered_list', 'vod', {
                category: catId,
                p: page.toString()
            });

            let vodData = response?.data || response;
            if (vodData && vodData.js && vodData.js.data) {
                vodData = vodData.js.data;
            }

            if (!Array.isArray(vodData) || vodData.length === 0) {
                hasMore = false;
                break;
            }

            allItems.push(...vodData);

            // If less than 14, we've reached the last page
            if (vodData.length < 14) {
                hasMore = false;
            } else {
                page++;
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
            channel_num: 0,
            name: item.name,
            stream_icon: item.screenshot_uri || '',
            rating: item.rating_kinopoisk || item.rating_imdb || '',

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
        console.log('[Stalker] getSeriesStreams: fetching with pagination...');

        const catId = categoryId ? categoryId.replace(`${this.sourceId}_series_`, '').replace(`${this.sourceId}_`, '') : '*';

        // Fetch ALL pages (server limit is 14 items per page)
        const allItems: any[] = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const response = await this.fetchStalker<any>('get_ordered_list', 'series', {
                category: catId,
                p: page.toString()
            });

            let seriesData = response?.data || response;
            if (seriesData && seriesData.js && seriesData.js.data) {
                seriesData = seriesData.js.data;
            }

            if (!Array.isArray(seriesData) || seriesData.length === 0) {
                hasMore = false;
                break;
            }

            allItems.push(...seriesData);

            // If less than 14, we've reached the last page
            if (seriesData.length < 14) {
                hasMore = false;
            } else {
                page++;
            }
        }

        console.log(`[Stalker] Fetched ${allItems.length} total series items from ${page} page(s)`);

        return allItems.map(item => ({
            stream_id: `${this.sourceId}_series_${item.id}`,
            series_id: `${this.sourceId}_series_${item.id}`, // PRIMARY KEY for vodSeries table
            channel_num: 0,
            name: item.name,
            stream_icon: item.screenshot_uri || '',
            cover: item.screenshot_uri || '', // Required for series
            rating: item.rating_kinopoisk || item.rating_imdb || '',

            category_ids: categoryId ? [categoryId] : [],
            added: item.added || '',
            container_extension: 'mp4',
            // Store movie_id for series navigation
            direct_url: `stalker_series:${item.id}`,
            source_id: this.sourceId,
            epg_channel_id: '',
        }));
    }

    async getSeasons(seriesId: string): Promise<Season[]> {
        await this.ensureToken();

        // Extract raw movie ID (strip source prefix)
        // Input: "5adc2796-7893-4578-a711-7a9f5a96bcfc_series_25751:25751"
        // Output: "25751:25751"
        const rawMovieId = seriesId.replace(`${this.sourceId}_series_`, '').replace(`${this.sourceId}_`, '');

        console.log(`[Stalker] getSeasons: fetching for series ${seriesId} (raw: ${rawMovieId})...`);

        const response = await this.fetchStalker<any>('get_ordered_list', 'vod', {
            movie_id: rawMovieId,
            season_id: '0',
            episode_id: '0',
            p: '1'
        });

        let seasonsData = response?.data || response;
        if (seasonsData && seasonsData.js && seasonsData.js.data) {
            seasonsData = seasonsData.js.data;
        }

        if (!Array.isArray(seasonsData)) {
            console.warn('[Stalker] Seasons data is not an array');
            return [];
        }

        // Filter for seasons only (is_season=true)
        const seasons = seasonsData.filter((item: any) => item.is_season);

        return seasons.map(season => ({
            season_number: parseInt(season.id.toString()) || 0,
            episodes: [] // Episodes are fetched separately via getEpisodes
        }));
    }

    async getEpisodes(seriesId: string, seasonId: string): Promise<Episode[]> {
        await this.ensureToken();
        console.log(`[Stalker] getEpisodes: fetching for series ${seriesId}, season ${seasonId}...`);

        const response = await this.fetchStalker<any>('get_ordered_list', 'vod', {
            movie_id: seriesId,
            season_id: seasonId,
            episode_id: '0',
            p: '1'
        });

        let episodesData = response?.data || response;
        if (episodesData && episodesData.js && episodesData.js.data) {
            episodesData = episodesData.js.data;
        }

        if (!Array.isArray(episodesData)) {
            console.warn('[Stalker] Episodes data is not an array');
            return [];
        }

        return episodesData.map(episode => ({
            id: `${this.sourceId}_episode_${episode.id}`,
            title: episode.name || `Episode ${episode.series_number || episode.episode_num}`,
            episode_num: parseInt(episode.series_number || episode.episode_num) || 0,
            season_num: parseInt(seasonId) || 0,
            direct_url: `stalker_episode:${seriesId}:${seasonId}:${episode.series_number || episode.episode_num}`,
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
            if (parts.length < 4) {
                throw new Error('Invalid stalker_episode format');
            }
            const movieId = parts[1];
            const seasonId = parts[2];
            const episodeNum = parts[3];
            seriesEpisodeNum = episodeNum;

            console.log(`[Stalker] Resolving episode: Movie=${movieId}, Season=${seasonId}, Episode=${episodeNum}`);

            // Resolve episode's actual stream ID via get_ordered_list
            const listResp = await this.fetchStalker<any>('get_ordered_list', 'vod', {
                movie_id: movieId,
                season_id: seasonId,
                episode_id: '0',
                p: '1'
            });
            const listData = listResp?.data || listResp?.js?.data;

            if (!listData || !Array.isArray(listData)) {
                throw new Error('Failed to fetch episode list data');
            }

            if (listData.length > 0) {
                console.log('[Stalker] First item sample:', JSON.stringify(listData[0]));
            }

            const match = Array.isArray(listData) ? listData.find((i: any) =>
                i.series_number == episodeNum || i.episode_num == episodeNum
            ) : null;

            if (match) {
                console.log('[Stalker] Found match:', JSON.stringify(match));
                if (match.cmd) {
                    forcedCmd = match.cmd;
                } else if (match.id) {
                    forcedCmd = `/media/file_${match.id}.mpg`;
                }
            } else {
                console.warn('[Stalker] Episode match not found in list!');
                throw new Error(`Could not resolve episode ID for Series ${movieId} Season ${seasonId} Episode ${episodeNum}`);
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

    async getSeriesInfo(seriesId: string, category?: string): Promise<Season[]> {
        const seasons = await this.getSeasons(seriesId);
        const result: Season[] = [];

        for (const season of seasons) {
            const seasonNum = season.season_number;
            const episodes = await this.getEpisodes(seriesId, seasonNum.toString());
            result.push({
                season_number: seasonNum,
                episodes: episodes
            });
        }

        return result;
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
