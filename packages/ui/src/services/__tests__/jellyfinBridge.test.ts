/**
 * Item-isolation tests for the Jellyfin media-hijack bridge.
 *
 * The bridge logic lives as a raw string (INIT_SCRIPT) inside
 * packages/app/src-tauri/src/jellyfin_web.rs. Rather than re-testing a copy,
 * these tests load the REAL embedded source via Vite's ?raw import, run it in a
 * minimal mocked browser context (new Function + hand-rolled mocks — no jsdom,
 * no node module types), and drive the internals the bridge exposes only when
 * window.__ynotvJfTestMode is set.
 *
 * Covered:
 *   - playbackInfoFor() must not leak another item's PlaybackInfo response.
 *   - Audio/subtitle stream indexes from a PlaybackInfo request are only used
 *     when the request belongs to the item being played (and is fresh).
 *   - The blob-URL fallback in buildPlayableUrl() recovers a stream URL from
 *     the cached PlaybackInfo, including the no-item-id media-source fallback.
 *   - Media-segment extraction skips reverse-proxy prefixes that literally
 *     contain a "Videos"/"Audio" segment, matching the Rust parser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// eslint-disable-next-line import/no-unresolved
import bridgeSource from '../../../../app/src-tauri/src/jellyfin_web.rs?raw';

interface BridgeInternals {
    playbackInfoFor: (targetItemId: string | null | undefined) => any;
    playbackInfoMeta: (elem: any, capturedSrc: string) => any;
    buildPlayableUrl: (rawUrl: string, elem?: any) => { url: string; position_ticks: number | null };
    resolveCapturedHlsUrl: (url: string) => string;
    readPlayQueue: (itemId: string | null | undefined) => any;
    rememberPlayQueue: (body: any) => void;
    rememberPlaylistItems: (url: string, body: any) => void;
    seedPlayQueue: (capture: any) => void;
    seedPlaylist: (capture: any) => void;
    resetQueueCaptures: () => void;
    findMediaSegment: (url: string) => { type: 'Videos' | 'Audio'; itemId: string } | null;
    extractMediaItemId: (url: string) => string | null;
    getMpvDeviceProfile: (baseProfile?: any) => any;
    injectMpvDeviceProfile: (body: any) => any;
    seedPlaybackInfo: (itemId: string | null, body: any) => void;
    seedPlaybackInfoReq: (req: any) => void;
    seedHlsStream: (s: any) => void;
}

interface LoadedBridge {
    internals: BridgeInternals;
    window: any;
    HTMLMediaElement: any;
    XMLHttpRequest: any;
}

/**
 * Test-scoped overrides for the mocked browser the bridge boots in. The
 * defaults keep the bridge's polling/timers inert so tests never hang; override
 * them when exercising code paths that schedule navigation or reloads.
 */
interface BridgeLoadOptions {
    location?: any;
    windowExtras?: Record<string, unknown>;
    setIntervalFn?: (fn: () => void) => number;
    setTimeoutFn?: (fn: () => void) => number;
}

const INIT_MARKER = 'const INIT_SCRIPT: &str = r##"';

function extractInitScript(source: string): string {
    const start = source.indexOf(INIT_MARKER);
    if (start < 0) throw new Error('INIT_SCRIPT marker not found in jellyfin_web.rs');
    const bodyStart = start + INIT_MARKER.length;
    const end = source.indexOf('"##;', bodyStart);
    if (end < 0) throw new Error('INIT_SCRIPT terminator not found in jellyfin_web.rs');
    return source.slice(bodyStart, end);
}

function makeStorage() {
    const m = new Map<string, string>();
    return {
        getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
        setItem: (k: string, v: string) => {
            m.set(k, String(v));
        },
        removeItem: (k: string) => {
            m.delete(k);
        },
        clear: () => m.clear(),
        key: (i: number) => Array.from(m.keys())[i] ?? null,
        get length() {
            return m.size;
        },
    };
}

function loadBridge(opts: BridgeLoadOptions = {}): LoadedBridge {
    const location = opts.location ?? {
        origin: 'http://jf.test:8096',
        pathname: '/web/index.html',
        hash: '',
        href: 'http://jf.test:8096/web/index.html',
    };

    const win: any = {
        __ynotvJfTestMode: true,
        location,
        addEventListener: () => {},
        dispatchEvent: () => {},
        ...(opts.windowExtras || {}),
    };
    win.window = win;

    const doc: any = {
        title: 'Jellyfin',
        addEventListener: () => {},
        querySelectorAll: () => [],
        documentElement: {},
        body: { classList: { remove: () => {} } },
    };

    class MutationObserverMock {
        observe() {}
        disconnect() {}
        takeRecords() {
            return [];
        }
    }
    class HTMLMediaElementMock {}
    (HTMLMediaElementMock as any).prototype.play = function () {
        return Promise.resolve();
    };
    (HTMLMediaElementMock as any).prototype.canPlayType = function () {
        return '';
    };
    class XMLHttpRequestMock {
        _headers: Record<string, string> = {};
        open() {}
        send() {}
        addEventListener() {}
        setRequestHeader(name: string, value: string) {
            this._headers[String(name).toLowerCase()] = value;
        }
    }

    const factory = new Function(
        'window',
        'document',
        'location',
        'localStorage',
        'MutationObserver',
        'HTMLMediaElement',
        'XMLHttpRequest',
        'setInterval',
        'setTimeout',
        'CustomEvent',
        'URL',
        extractInitScript(bridgeSource),
    );
    factory(
        win,
        doc,
        location,
        makeStorage(),
        MutationObserverMock,
        HTMLMediaElementMock,
        XMLHttpRequestMock,
        opts.setIntervalFn ?? (() => 1), // no-op interval: polling must not keep the test alive
        opts.setTimeoutFn ?? (() => 0),
        (globalThis as any).CustomEvent ?? class CustomEventMock {},
        URL,
    );

    if (!win.__ynotvJfInternals) {
        throw new Error(
            'bridge internals not exposed — the init script likely threw at load; add the missing mock',
        );
    }
    return {
        internals: win.__ynotvJfInternals as BridgeInternals,
        window: win,
        HTMLMediaElement: HTMLMediaElementMock,
        XMLHttpRequest: XMLHttpRequestMock,
    };
}

describe('jellyfin bridge item isolation', () => {
    let bridge: LoadedBridge;

    beforeEach(() => {
        bridge = loadBridge();
    });

    // Real Jellyfin item ids are hex GUIDs (optionally dashed); the bridge's
    // media-segment extraction accepts hex/dash-only tokens of >= 8 chars.
    const ITEM_A = '5b12f80a4f3c4a2c9f1e1a2b3c4d5e6f';
    const ITEM_A_CLEAN = ITEM_A.replace(/-/g, '');
    const ITEM_B = '6c23f90b5a4d5b3daf2e3b4c5d6e7f70';
    const ITEM_B_CLEAN = ITEM_B.replace(/-/g, '');

    // A minimal PlaybackInfo-style response body.
    const playbackInfoBody = (over: any = {}) => ({
        Id: ITEM_A,
        PlaySessionId: 'ps-1',
        MediaSources: [
            {
                Id: 'ms-1',
                MediaStreams: [
                    { Type: 'Audio', Index: 0, Language: 'eng', DisplayTitle: 'English' },
                    { Type: 'Audio', Index: 1, Language: 'spa', DisplayTitle: 'Spanish' },
                    { Type: 'Subtitle', Index: 0, Language: 'eng', DisplayTitle: 'English' },
                    { Type: 'Subtitle', Index: 1, Language: 'spa', DisplayTitle: 'Spanish' },
                ],
                DefaultAudioStreamIndex: 1,
                DefaultSubtitleStreamIndex: -1,
            },
        ],
        ...over,
    });

    describe('playbackInfoFor', () => {
        it('returns the cached response for the requested item', () => {
            const { internals } = bridge;
            internals.seedPlaybackInfo(ITEM_A, playbackInfoBody({ Id: ITEM_A }));
            internals.seedPlaybackInfo(ITEM_B, playbackInfoBody({ Id: ITEM_B }));
            const got = internals.playbackInfoFor(ITEM_A);
            expect(got.Id).toBe(ITEM_A);
            expect(internals.playbackInfoFor(ITEM_B).Id).toBe(ITEM_B);
        });

        it('returns null for a requested item with no cached response — no cross-item leak', () => {
            const { internals } = bridge;
            internals.seedPlaybackInfo(ITEM_B, playbackInfoBody({ Id: ITEM_B }));
            expect(internals.playbackInfoFor(ITEM_A)).toBeNull();
        });

        it('still falls back to the latest global response when no item is requested', () => {
            const { internals } = bridge;
            const b = playbackInfoBody({ Id: ITEM_B });
            internals.seedPlaybackInfo(ITEM_B, b);
            expect(internals.playbackInfoFor(null)).toBe(b);
            expect(internals.playbackInfoFor(undefined)).toBe(b);
            expect(internals.playbackInfoFor('')).toBe(b);
        });
    });

    describe('stream index scoping (audio + subtitle)', () => {
        const videoUrl = `/Videos/${ITEM_A}/stream.mkv?api_key=k`;

        it('ignores request stream indexes when the request belongs to a different item', () => {
            const { internals } = bridge;
            internals.seedPlaybackInfo(ITEM_A, playbackInfoBody());
            internals.seedPlaybackInfoReq({
                itemId: ITEM_B,
                audioStreamIndex: 0,
                subtitleStreamIndex: 0,
                at: Date.now(),
            });
            const meta = internals.playbackInfoMeta({}, videoUrl);
            // Falls back to the server defaults from THIS item's PlaybackInfo.
            expect(meta.audioStreamId).toBe(1);
            expect(meta.subtitleStreamId).toBe(-1);
        });

        it('applies request stream indexes when the request belongs to the same item', () => {
            const { internals } = bridge;
            internals.seedPlaybackInfo(ITEM_A, playbackInfoBody());
            internals.seedPlaybackInfoReq({
                itemId: ITEM_A,
                audioStreamIndex: 0,
                subtitleStreamIndex: 1,
                at: Date.now(),
            });
            const meta = internals.playbackInfoMeta({}, videoUrl);
            expect(meta.audioStreamId).toBe(0);
            expect(meta.subtitleStreamId).toBe(1);
        });

        it('ignores stale request hints older than 15 seconds', () => {
            const { internals } = bridge;
            internals.seedPlaybackInfo(ITEM_A, playbackInfoBody());
            internals.seedPlaybackInfoReq({
                itemId: ITEM_A,
                audioStreamIndex: 0,
                subtitleStreamIndex: 1,
                at: Date.now() - 20_000,
            });
            const meta = internals.playbackInfoMeta({}, videoUrl);
            expect(meta.audioStreamId).toBe(1);
            expect(meta.subtitleStreamId).toBe(-1);
        });
    });

    describe('media segment extraction (reverse-proxy prefix hardening)', () => {
        it('extracts the item id from a plain /Videos/{id}/stream URL', () => {
            const { internals } = bridge;
            expect(internals.extractMediaItemId(`http://jf.test:8096/Videos/${ITEM_A}/stream.mkv?api_key=k`)).toBe(
                ITEM_A_CLEAN,
            );
        });

        it('skips a reverse-proxy prefix literally named Videos and uses the real segment', () => {
            const { internals } = bridge;
            const url = `http://jf.test:8096/media/Videos/proxy/Videos/${ITEM_A}/master.m3u8`;
            expect(internals.extractMediaItemId(url)).toBe(ITEM_A_CLEAN);
        });

        it('does not treat a word-like token after Videos as an item id', () => {
            const { internals } = bridge;
            expect(internals.extractMediaItemId('http://jf.test:8096/Videos/proxy/stream.mkv')).toBeNull();
        });

        it('returns the media type alongside the item id', () => {
            const { internals } = bridge;
            expect(internals.findMediaSegment(`http://jf.test:8096/Audio/${ITEM_A}/stream.flac`)).toEqual({
                type: 'Audio',
                itemId: ITEM_A_CLEAN,
            });
        });

        it('strips dashes from GUID-style ids but keeps hex/dash-only short tokens', () => {
            const { internals } = bridge;
            expect(internals.extractMediaItemId('/Videos/abcdef12/stream')).toBe('abcdef12');
        });
    });

    describe('captured HLS URL resolution', () => {
        it('preserves the reverse-proxy base for root-relative URLs', () => {
            const { internals } = bridge;
            expect(internals.resolveCapturedHlsUrl(`/Videos/${ITEM_A}/master.m3u8`)).toBe(
                `http://jf.test:8096/Videos/${ITEM_A}/master.m3u8`,
            );
        });

        it('resolves bare-relative URLs to the server base', () => {
            const { internals } = bridge;
            expect(internals.resolveCapturedHlsUrl(`hls/${ITEM_A}/master.m3u8`)).toBe(
                `http://jf.test:8096/hls/${ITEM_A}/master.m3u8`,
            );
        });
    });

    describe('buildPlayableUrl blob fallback', () => {
        it('recovers the stream URL from the cached PlaybackInfo when the item id is known', () => {
            const { internals } = bridge;
            internals.seedPlaybackInfo(ITEM_A, {
                MediaSources: [{ Id: 'ms-1', DirectStreamUrl: `/Videos/${ITEM_A}/stream?Static=true` }],
            });
            internals.seedPlaybackInfoReq({
                itemId: ITEM_A,
                audioStreamIndex: null,
                subtitleStreamIndex: null,
                at: Date.now(),
            });
            const result = internals.buildPlayableUrl('blob:http://jf.test:8096/abc', {});
            expect(result.url).toContain(`/Videos/${ITEM_A}/stream`);
        });

        it('falls back to the media-source id when no item id can be recovered', () => {
            const { internals } = bridge;
            internals.seedPlaybackInfo(null, { MediaSources: [{ Id: 'ms-1' }] });
            internals.seedPlaybackInfoReq({
                itemId: null,
                audioStreamIndex: null,
                subtitleStreamIndex: null,
                at: Date.now(),
            });
            const result = internals.buildPlayableUrl('blob:http://jf.test:8096/abc', {});
            // The path segment uses the dash-stripped id; mediaSourceId keeps dashes.
            expect(result.url).toContain('/Videos/ms1/stream');
            expect(result.url).toContain('mediaSourceId=ms-1');
            expect(result.url.startsWith('http://jf.test:8096')).toBe(true);
        });

        it('rewrites a reverse-proxy HLS URL to the direct stream using the real item id', () => {
            const { internals } = bridge;
            const url = `http://jf.test:8096/media/Videos/proxy/Videos/${ITEM_A}/master.m3u8?api_key=k`;
            const result = internals.buildPlayableUrl(url, {});
            // The proxy prefix must be skipped: the direct stream is built from
            // the REAL item id (dash-stripped), never the word-like 'proxy'.
            expect(result.url).toContain(`/Videos/${ITEM_A_CLEAN}/stream`);
            expect(result.url).not.toContain('proxy');
            expect(result.url.startsWith('http://jf.test:8096')).toBe(true);
        });

        it('normalizes a bare-relative HLS URL before converting it to direct play', () => {
            const { internals } = bridge;
            const result = internals.buildPlayableUrl(`Videos/${ITEM_A}/master.m3u8?api_key=k`, {});
            expect(result.url).toContain(`/Videos/${ITEM_A_CLEAN}/stream`);
            expect(result.url).toContain('Static=true');
            expect(result.url.startsWith('http://jf.test:8096')).toBe(true);
        });

        it('uses the captured HLS stream URL when it matches the candidate item', () => {
            const { internals } = bridge;
            internals.seedPlaybackInfo(ITEM_A, { MediaSources: [{ Id: 'ms-1' }] });
            internals.seedPlaybackInfoReq({
                itemId: ITEM_A,
                audioStreamIndex: null,
                subtitleStreamIndex: null,
                at: Date.now(),
            });
            internals.seedHlsStream({
                url: `http://jf.test:8096/Videos/${ITEM_A}/master.m3u8?api_key=k`,
                itemId: ITEM_A,
                at: Date.now(),
            });
            const result = internals.buildPlayableUrl('blob:http://jf.test:8096/abc', {});
            // HLS playlists are rewritten to the direct static stream for mpv;
            // the path id is dash-stripped.
            expect(result.url).toContain(`/Videos/${ITEM_A_CLEAN}/stream`);
        });
    });

    describe('__ynotvOnPlaybackEnded target navigation (series details)', () => {
        interface NavRecorder {
            location: any;
            shown: string[];
            reloads: number;
            intervals: Array<() => void>;
            timeouts: Array<() => void>;
        }

        function loadNavBridge(): NavRecorder & LoadedBridge {
            // A single mutable holder: the sandbox's reload/intervals/timeouts
            // callbacks must observe the same state the assertions read, so the
            // recorder is returned with a live getter instead of a value copy.
            const rec: NavRecorder = {
                location: {
                    origin: 'http://jf.test:8096',
                    pathname: '/web/index.html',
                    hash: '',
                    href: 'http://jf.test:8096/web/index.html',
                    reload: () => {
                        rec.reloads += 1;
                    },
                },
                shown: [],
                reloads: 0,
                intervals: [],
                timeouts: [],
            };
            const loaded = loadBridge({
                location: rec.location,
                windowExtras: {
                    AppRouter: {
                        showItem: (id: string) => {
                            rec.shown.push(id);
                        },
                    },
                },
                setIntervalFn: (fn: () => void) => {
                    rec.intervals.push(fn);
                    return rec.intervals.length;
                },
                setTimeoutFn: (fn: () => void) => {
                    rec.timeouts.push(fn);
                    return rec.timeouts.length;
                },
            });
            return {
                ...loaded,
                location: rec.location,
                shown: rec.shown,
                intervals: rec.intervals,
                timeouts: rec.timeouts,
                get reloads() {
                    return rec.reloads;
                },
            } as NavRecorder & LoadedBridge;
        }

        // The bridge installs its own background polling at boot, so only the
        // intervals/timers scheduled DURING __ynotvOnPlaybackEnded belong to the
        // navigation-under-test. Record a baseline before invoking it.
        function navBaseline(rec: NavRecorder): { intervalsStart: number; timeoutsStart: number } {
            return { intervalsStart: rec.intervals.length, timeoutsStart: rec.timeouts.length };
        }

        it('passes the dash-stripped id to AppRouter.showItem and reloads only once the details route commits', () => {
            const rec = loadNavBridge();
            const { intervalsStart, timeoutsStart } = navBaseline(rec);
            // Series id arrives raw (dashed GUID) from the app; the bridge strips
            // dashes before handing it to the router.
            rec.window.__ynotvOnPlaybackEnded('9f2c8a14-5b6d-4e7a-9c01-2d3e4f5a6b7c');
            expect(rec.shown).toEqual(['9f2c8a145b6d4e7a9c012d3e4f5a6b7c']);
            // No reload before the (async) router navigation has committed.
            expect(rec.reloads).toBe(0);
            expect(rec.timeouts.length).toBe(timeoutsStart);
            // Exactly one new poll interval was scheduled.
            expect(rec.intervals.length).toBe(intervalsStart + 1);

            // AppRouter.showItem resolves the item over the network, then the
            // SPA pushes the details route — simulate that landing.
            rec.location.pathname = '/web/details';
            rec.location.href = 'http://jf.test:8096/web/details?id=9f2c8a145b6d4e7a9c012d3e4f5a6b7c';
            for (const fn of rec.intervals.slice(intervalsStart)) fn();
            // The deferred reload was scheduled, exactly once.
            expect(rec.timeouts.length).toBe(timeoutsStart + 1);
            rec.timeouts.slice(timeoutsStart).forEach((fn) => fn());
            expect(rec.reloads).toBe(1);
        });

        it('does not double-reload if a stale poll tick fires after the navigation committed', () => {
            const rec = loadNavBridge();
            const { intervalsStart, timeoutsStart } = navBaseline(rec);
            rec.window.__ynotvOnPlaybackEnded('9f2c8a145b6d4e7a9c012d3e4f5a6b7c');
            rec.location.pathname = '/web/details?id=9f2c8a145b6d4e7a9c012d3e4f5a6b7c';
            for (const fn of rec.intervals.slice(intervalsStart)) fn();
            expect(rec.timeouts.length).toBe(timeoutsStart + 1);
            rec.timeouts.slice(timeoutsStart).forEach((fn) => fn());
            expect(rec.reloads).toBe(1);
            // A late tick must not schedule another reload.
            for (const fn of rec.intervals.slice(intervalsStart)) fn();
            expect(rec.timeouts.length).toBe(timeoutsStart + 1);
            expect(rec.reloads).toBe(1);
        });
    });

    describe('MPV DeviceProfile & DirectPlay injection', () => {
        it('injects unrestricted DirectPlayProfiles and high bitrate into PlaybackInfo payload', () => {
            const b = loadBridge();
            const rawBody = JSON.stringify({
                UserId: 'user-123',
                DeviceProfile: {
                    Name: 'Jellyfin Web',
                    DirectPlayProfiles: [{ Container: 'mp4', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac' }],
                },
            });

            const mutated = b.internals.injectMpvDeviceProfile(rawBody);
            expect(typeof mutated).toBe('string');
            const parsed = JSON.parse(mutated);

            expect(parsed.UserId).toBe('user-123');
            expect(parsed.MaxStreamingBitrate).toBeGreaterThanOrEqual(1000000000);
            expect(parsed.DeviceProfile.Name).toBe('ynoTV (MPV)');
            expect(parsed.DeviceProfile.MaxStaticBitrate).toBe(1000000000);
            // Must contain unrestricted Video/Audio/Photo DirectPlayProfiles
            expect(parsed.DeviceProfile.DirectPlayProfiles).toEqual([
                { Type: 'Audio' },
                { Type: 'Photo' },
                { Type: 'Video' },
            ]);
            // SubtitleProfiles must include all common formats with Embed and External
            const subs = parsed.DeviceProfile.SubtitleProfiles;
            expect(subs.some((s: any) => s.Format === 'ass' && s.Method === 'Embed')).toBe(true);
            expect(subs.some((s: any) => s.Format === 'ass' && s.Method === 'External')).toBe(true);
            expect(subs.some((s: any) => s.Format === 'pgs' && s.Method === 'Embed')).toBe(true);
            expect(subs.some((s: any) => s.Format === 'srt' && s.Method === 'Embed')).toBe(true);
        });

        it('handles object input and sets direct play flags when present', () => {
            const b = loadBridge();
            const input = {
                Id: 'item-123',
                EnableDirectPlay: false,
                EnableDirectStream: false,
            };

            const mutated = b.internals.injectMpvDeviceProfile(input);
            expect(mutated.Id).toBe('item-123');
            expect(mutated.EnableDirectPlay).toBe(true);
            expect(mutated.EnableDirectStream).toBe(true);
            expect(mutated.DeviceProfile.DirectPlayProfiles).toEqual([
                { Type: 'Audio' },
                { Type: 'Photo' },
                { Type: 'Video' },
            ]);
        });

        it('patches canPlayType to return probably for MKV, HEVC, and DTS formats', () => {
            const b = loadBridge();
            const canPlay = b.HTMLMediaElement.prototype.canPlayType;

            expect(canPlay('video/x-matroska')).toBe('probably');
            expect(canPlay('video/mp4; codecs="hevc,hvc1"')).toBe('probably');
            expect(canPlay('video/mp4; codecs="av01"')).toBe('probably');
            expect(canPlay('audio/mp4; codecs="dts"')).toBe('probably');
            expect(canPlay('audio/mp4; codecs="truehd"')).toBe('probably');
            expect(canPlay('audio/unknown-codec')).toBe('');
        });
    });

    describe('play queue capture (playlist playback)', () => {
        const Q_A = '5b12f80a4f3c4a2c9f1e1a2b3c4d5e6f';
        const Q_B = '6c23f90b5a4d5b3daf2e3b4c5d6e7f70';
        const Q_C = '7d34a01c6b5e6c4eb03f4c5d6e7f8081';
        const guid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

        /** The /Sessions/Playing body Jellyfin Web sends for a 3-item playlist. */
        const playingReport = (currentIndex: number) => ({
            ItemId: guid([Q_A, Q_B, Q_C][currentIndex]),
            PlaylistItemId: `pl-${currentIndex + 1}`,
            NowPlayingQueue: [
                { Id: guid(Q_A), PlaylistItemId: 'pl-1' },
                { Id: guid(Q_B), PlaylistItemId: 'pl-2' },
                { Id: guid(Q_C), PlaylistItemId: 'pl-3' },
            ],
        });

        it('captures the reported queue and reports the playing item', () => {
            const b = loadBridge();
            b.internals.rememberPlayQueue(JSON.stringify(playingReport(1)));
            const q = b.internals.readPlayQueue(Q_B);
            expect(q.index).toBe(1);
            expect(q.items.map((i: any) => i.id)).toEqual([Q_A, Q_B, Q_C]);
            // No playlist was loaded in this page, so the queue is reported
            // without a playlist identity (still enough to walk it).
            expect(q.playlistId).toBeNull();
            expect(q.playlistName).toBe('');
        });

        it('accepts an object body as well as a JSON string', () => {
            const b = loadBridge();
            b.internals.rememberPlayQueue(playingReport(0));
            expect(b.internals.readPlayQueue(Q_A).index).toBe(0);
        });

        it('returns null for a single-item queue or for an item outside it', () => {
            const b = loadBridge();
            b.internals.rememberPlayQueue(JSON.stringify({ ItemId: guid(Q_A), NowPlayingQueue: [{ Id: guid(Q_A) }] }));
            expect(b.internals.readPlayQueue(Q_A)).toBeNull();

            b.internals.rememberPlayQueue(JSON.stringify(playingReport(0)));
            // An item that is not in the queue: the caller must fall back to
            // series-episode navigation instead of inventing a queue position.
            expect(b.internals.readPlayQueue('ffffffffffffffffffffffffffffffff')).toBeNull();
        });

        it('returns null when the page never reported a queue', () => {
            const b = loadBridge();
            expect(b.internals.readPlayQueue(Q_A)).toBeNull();
        });

        it('labels the queue with the playlist the page loaded', () => {
            const b = loadBridge();
            b.internals.rememberPlaylistItems('http://jf.test:8096/Playlists/abc123/Items?userId=u1', {
                Items: [
                    { Id: guid(Q_A), Name: 'First Movie', Type: 'Movie', PlaylistItemId: 'pl-1' },
                    { Id: guid(Q_B), Name: 'Second Episode', Type: 'Episode', SeriesName: 'Some Show', ParentIndexNumber: 2, IndexNumber: 3, PlaylistItemId: 'pl-2' },
                    { Id: guid(Q_C), Name: 'Third Movie', Type: 'Movie', PlaylistItemId: 'pl-3' },
                ],
            });
            b.internals.rememberPlayQueue(JSON.stringify(playingReport(1)));

            const q = b.internals.readPlayQueue(Q_B);
            expect(q.playlistId).toBe('abc123');
            expect(q.index).toBe(1);
            // Playlist entries carry full DTOs, so the queue list can show real
            // names instead of "item 2 of 3".
            expect(q.items[0].name).toBe('First Movie');
            expect(q.items[1].name).toBe('Second Episode');
            expect(q.items[1].parentIndexNumber).toBe(2);
            expect(q.items[2].name).toBe('Third Movie');
        });

        it('does not claim a playlist when the reported queue belongs to someone else', () => {
            const b = loadBridge();
            b.internals.rememberPlaylistItems('http://jf.test:8096/Playlists/abc123/Items', {
                Items: [
                    { Id: guid(Q_A), Name: 'Playlist Item', PlaylistItemId: 'pl-1' },
                    { Id: guid(Q_B), Name: 'Other Playlist Item', PlaylistItemId: 'pl-2' },
                ],
            });
            // A queue the page built itself (synthetic playlistItem ids) that
            // happens to share items must not be attributed to that playlist.
            b.internals.rememberPlayQueue(JSON.stringify({
                ItemId: guid(Q_A),
                NowPlayingQueue: [
                    { Id: guid(Q_A), PlaylistItemId: 'playlistItem0' },
                    { Id: guid(Q_C), PlaylistItemId: 'playlistItem1' },
                ],
            }));
            const q = b.internals.readPlayQueue(Q_A);
            expect(q.playlistId).toBeNull();
            expect(q.items.map((i: any) => i.id)).toEqual([Q_A, Q_C]);
        });

        it('falls back to the playlist the page loaded when no queue report arrived', () => {
            const b = loadBridge();
            b.internals.rememberPlaylistItems('http://jf.test:8096/Playlists/pl-1/Items', {
                Items: [
                    { Id: guid(Q_A), Name: 'First Movie', Type: 'Movie', PlaylistItemId: 'pl-1' },
                    { Id: guid(Q_B), Name: 'Second Episode', Type: 'Episode', PlaylistItemId: 'pl-2' },
                    { Id: guid(Q_C), Name: 'Third Movie', Type: 'Movie', PlaylistItemId: 'pl-3' },
                ],
            });
            // Starting a playlist item is the same as handing the whole playlist
            // to the player, so the loaded playlist IS the play order even if the
            // page's own session report has not reached the bridge yet.
            const q = b.internals.readPlayQueue(Q_B);
            expect(q.playlistId).toBe('pl-1');
            expect(q.index).toBe(1);
            expect(q.items.map((i: any) => i.id)).toEqual([Q_A, Q_B, Q_C]);
            expect(q.items[1].name).toBe('Second Episode');
        });

        it('ignores a loaded playlist the playing item is not part of, or a stale one', () => {
            const b = loadBridge();
            b.internals.rememberPlaylistItems('http://jf.test:8096/Playlists/pl-1/Items', {
                Items: [
                    { Id: guid(Q_A), Name: 'First Movie', PlaylistItemId: 'pl-1' },
                    { Id: guid(Q_B), Name: 'Second Episode', PlaylistItemId: 'pl-2' },
                ],
            });
            // Q_C is not in that playlist: series-episode navigation must remain
            // in charge for playback the playlist has nothing to do with.
            expect(b.internals.readPlayQueue(Q_C)).toBeNull();

            b.internals.seedPlaylist({
                id: 'pl-2',
                name: 'Long forgotten',
                items: [{ id: Q_A, name: 'First Movie', playlistItemId: 'pl-1' }],
                byPlaylistItemId: {},
                at: Date.now() - 31 * 60 * 1000,
            });
            expect(b.internals.readPlayQueue(Q_A)).toBeNull();
        });

        it('ignores playlist responses that are not a playlist item list', () => {
            const b = loadBridge();
            b.internals.rememberPlaylistItems('http://jf.test:8096/Playlists', { Items: [] });
            b.internals.rememberPlaylistItems('http://jf.test:8096/Shows/s1/Episodes', {
                Items: [{ Id: guid(Q_A), Name: 'Episode', PlaylistItemId: 'pl-1' }],
            });
            b.internals.rememberPlayQueue(JSON.stringify(playingReport(0)));
            expect(b.internals.readPlayQueue(Q_A).playlistId).toBeNull();
        });
    });

    describe('client identity (Authorization rewrite)', () => {
        // jellyfin-apiclient 1.11 (web 10.11) sends the identity under
        // "Authorization"; older clients (10.8/10.9 era) use "X-Emby-Authorization".
        const AUTH_HEADER = 'MediaBrowser Client="Jellyfin Web", Device="Edge Chromium", DeviceId="abc123", Version="10.11.11"';
        const identityExtras = {
            __YNOTV_APP_VERSION__: '2.5.3',
            __YNOTV_DEVICE_NAME__: 'DESKTOP-TEST',
        };

        it.each(['Authorization', 'X-Emby-Authorization'])(
            'rewrites the %s header set via XHR setRequestHeader',
            (headerName) => {
                const b = loadBridge({ windowExtras: identityExtras });
                const xhr = new b.XMLHttpRequest();
                xhr.open('POST', 'http://jf.test:8096/Items/5b12f80a4f3c4a2c9f1e1a2b3c4d5e6f/PlaybackInfo');
                xhr.setRequestHeader(headerName, AUTH_HEADER);

                const sent = xhr._headers[headerName.toLowerCase()];
                expect(sent).toContain('Client="ynoTV"');
                expect(sent).toContain('Device="DESKTOP-TEST"');
                expect(sent).toContain('Version="2.5.3"');
                // DeviceId must be preserved — sessions/playstate depend on it.
                expect(sent).toContain('DeviceId="abc123"');
                expect(sent).not.toContain('Jellyfin Web');
            });

        it('leaves the header untouched when identity globals are missing', () => {
            const b = loadBridge();
            const xhr = new b.XMLHttpRequest();
            xhr.open('POST', 'http://jf.test:8096/System/Info');
            xhr.setRequestHeader('Authorization', AUTH_HEADER);

            expect(xhr._headers['authorization']).toBe(AUTH_HEADER);
        });

        it('leaves non-MediaBrowser Authorization headers untouched', () => {
            const b = loadBridge({ windowExtras: identityExtras });
            const xhr = new b.XMLHttpRequest();
            xhr.open('POST', 'http://jf.test:8096/System/Info');
            xhr.setRequestHeader('Authorization', 'Bearer some-token');

            expect(xhr._headers['authorization']).toBe('Bearer some-token');
        });

        it('rewrites a Headers object on outgoing fetch calls', async () => {
            const calls: { url: string; init: any }[] = [];
            const fetchMock = (url: string, init: any) => {
                calls.push({ url, init });
                return Promise.resolve({});
            };
            const b = loadBridge({ windowExtras: { ...identityExtras, fetch: fetchMock } });

            const headers = new Headers({ Authorization: AUTH_HEADER });
            await b.window.fetch('http://jf.test:8096/System/Info', { method: 'GET', headers });

            expect(calls).toHaveLength(1);
            const sent = calls[0].init.headers;
            expect(sent.get('Authorization')).toContain('Client="ynoTV"');
            expect(sent.get('Authorization')).toContain('Device="DESKTOP-TEST"');
            expect(sent.get('Authorization')).toContain('Version="2.5.3"');
            expect(sent.get('Authorization')).toContain('DeviceId="abc123"');
        });

        it('rewrites a plain-object headers map (the real jellyfin-apiclient shape) on fetch calls', async () => {
            const calls: { url: string; init: any }[] = [];
            const fetchMock = (url: string, init: any) => {
                calls.push({ url, init });
                return Promise.resolve({});
            };
            const b = loadBridge({ windowExtras: { ...identityExtras, fetch: fetchMock } });

            await b.window.fetch('http://jf.test:8096/Users/authenticatebyname', {
                method: 'POST',
                headers: { Authorization: AUTH_HEADER, 'Content-Type': 'application/json' },
            });

            expect(calls[0].init.headers.Authorization).toContain('Client="ynoTV"');
            expect(calls[0].init.headers.Authorization).toContain('Version="2.5.3"');
            expect(calls[0].init.headers['Content-Type']).toBe('application/json');
        });
    });
});