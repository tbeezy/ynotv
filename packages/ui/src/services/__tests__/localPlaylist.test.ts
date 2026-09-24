import { describe, it, expect, vi, beforeEach } from 'vitest';

// The service reads the file through Tauri and keeps its copy in SQLite; both
// are stubbed so the resolution rules (file first, kept copy second) can be
// driven directly.
const invokeMock = vi.fn();
const readFileMock = vi.fn();
const prefsGet = vi.fn();
const prefsPut = vi.fn();
const prefsDelete = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    readFile: (...args: unknown[]) => readFileMock(...args),
}));

vi.mock('../../db', () => ({
    db: {
        prefs: {
            get: (...args: unknown[]) => prefsGet(...args),
            put: (...args: unknown[]) => prefsPut(...args),
            delete: (...args: unknown[]) => prefsDelete(...args),
        },
    },
}));

vi.mock('../../i18n', () => ({
    default: {
        t: (key: string, opts?: { path?: string }) => (opts?.path ? `t:${key}:${opts.path}` : `t:${key}`),
    },
}));

import {
    LEGACY_IMPORTED_URL_PREFIX,
    LOCAL_PLAYLIST_MAX_BYTES,
    LOCAL_PLAYLIST_URL_PREFIX,
    clearLocalPlaylistSnapshot,
    isLegacyLocalImport,
    isLocalPlaylistSource,
    localPlaylistFileName,
    localPlaylistPath,
    localPlaylistSnapshotKey,
    localPlaylistUnreadableMessage,
    localPlaylistUrl,
    planLocalPlaylistSync,
    readLocalPlaylistSnapshot,
    resolveLocalPlaylist,
    writeLocalPlaylistSnapshot,
} from '../local-playlist';

const WINDOWS_PATH = 'C:\\Users\\user\\Music\\favourites.m3u';
const POSIX_PATH = '/home/user/favourites.m3u';

beforeEach(() => {
    invokeMock.mockReset();
    readFileMock.mockReset();
    prefsGet.mockReset();
    prefsPut.mockReset();
    prefsDelete.mockReset();
    (window as any).__TAURI__ = { core: { invoke: invokeMock } };
});

describe('local playlist source shapes', () => {
    it('round-trips a picked path through the source URL', () => {
        for (const path of [WINDOWS_PATH, POSIX_PATH]) {
            const url = localPlaylistUrl(path);
            expect(url).toBe(`${LOCAL_PLAYLIST_URL_PREFIX}${path}`);
            expect(localPlaylistPath({ url })).toBe(path);
            expect(isLocalPlaylistSource({ type: 'm3u', url })).toBe(true);
            expect(localPlaylistFileName(path)).toBe('favourites.m3u');
        }
    });

    it('does not claim remote or legacy sources', () => {
        for (const url of ['http://example.com/list.m3u', `${LEGACY_IMPORTED_URL_PREFIX}demo`, '']) {
            expect(localPlaylistPath({ url })).toBeNull();
            expect(isLocalPlaylistSource({ type: 'm3u', url })).toBe(false);
        }
        expect(localPlaylistPath(null)).toBeNull();
        expect(localPlaylistPath({ url: LOCAL_PLAYLIST_URL_PREFIX })).toBeNull();
        // Only M3U sources are imported from files.
        expect(isLocalPlaylistSource({ type: 'xtream', url: localPlaylistUrl(WINDOWS_PATH) })).toBe(false);
    });

    it('accepts an RFC 8089 file URI without leaving it as ///C:/…', () => {
        // A hand-edited backup could carry a real URI; the native reader needs a
        // plain OS path.
        expect(localPlaylistPath({ url: 'file:///C:/Users/user/list.m3u' })).toBe('C:/Users/user/list.m3u');
        expect(localPlaylistPath({ url: 'file:///home/user/list.m3u' })).toBe('/home/user/list.m3u');
        expect(localPlaylistPath({ url: 'file://localhost/C:/list.m3u' })).toBe('C:/list.m3u');
        expect(localPlaylistPath({ url: 'file://server/share/list.m3u' })).toBe('\\\\server\\share\\list.m3u');
        expect(localPlaylistPath({ url: 'file:///C:/My%20Lists/list.m3u' })).toBe('C:/My Lists/list.m3u');
        // A literal percent in a plain path must not be decoded or dropped.
        expect(localPlaylistPath({ url: 'file:C:\\100% lists\\list.m3u' })).toBe('C:\\100% lists\\list.m3u');
    });

    it('recognises the legacy marker so those imports can be reported', () => {
        expect(isLegacyLocalImport({ type: 'm3u', url: `${LEGACY_IMPORTED_URL_PREFIX}demo_playlist` })).toBe(true);
        expect(isLegacyLocalImport({ type: 'm3u', url: 'http://example.com/list.m3u' })).toBe(false);
        expect(isLegacyLocalImport({ type: 'xtream', url: `${LEGACY_IMPORTED_URL_PREFIX}x` })).toBe(false);
    });
});

describe('the copy kept in the app', () => {
    it('stores the playlist under the source id', async () => {
        prefsGet.mockResolvedValue(undefined);
        prefsPut.mockResolvedValue(undefined);

        await writeLocalPlaylistSnapshot('source-1', '#EXTM3U\n#EXTINF:-1,One\nhttp://x/1.ts\n');

        expect(prefsPut).toHaveBeenCalledWith({
            key: localPlaylistSnapshotKey('source-1'),
            value: '#EXTM3U\n#EXTINF:-1,One\nhttp://x/1.ts\n',
        });
    });

    it('leaves an unchanged copy alone, since a sync refreshes it every time', async () => {
        prefsGet.mockResolvedValue({ key: 'k', value: '#EXTM3U same' });
        prefsPut.mockResolvedValue(undefined);

        await writeLocalPlaylistSnapshot('source-1', '#EXTM3U same');

        expect(prefsPut).not.toHaveBeenCalled();
    });

    it('refuses to keep a copy larger than the cap', async () => {
        prefsGet.mockResolvedValue(undefined);
        prefsPut.mockResolvedValue(undefined);

        await writeLocalPlaylistSnapshot('source-1', 'x'.repeat(LOCAL_PLAYLIST_MAX_BYTES + 1));

        expect(prefsPut).not.toHaveBeenCalled();
    });

    it('reads back only a non-empty copy', async () => {
        prefsGet.mockResolvedValueOnce({ key: 'k', value: '#EXTM3U\n' });
        expect(await readLocalPlaylistSnapshot('source-1')).toBe('#EXTM3U\n');

        prefsGet.mockResolvedValueOnce({ key: 'k', value: '   ' });
        expect(await readLocalPlaylistSnapshot('source-1')).toBeNull();

        prefsGet.mockResolvedValueOnce(undefined);
        expect(await readLocalPlaylistSnapshot('source-1')).toBeNull();
    });

    it('deletes the copy with the source', async () => {
        prefsDelete.mockResolvedValue(undefined);

        await clearLocalPlaylistSnapshot('source-1');

        expect(prefsDelete).toHaveBeenCalledWith(localPlaylistSnapshotKey('source-1'));
    });
});

describe('resolveLocalPlaylist', () => {
    it('prefers the file, so edits are picked up', async () => {
        invokeMock.mockResolvedValue('#EXTM3U fresh');
        prefsGet.mockResolvedValue({ key: 'k', value: '#EXTM3U stale' });

        const resolved = await resolveLocalPlaylist({ id: 'source-1', url: localPlaylistUrl(WINDOWS_PATH) });

        expect(resolved).toEqual({
            content: '#EXTM3U fresh',
            filePath: WINDOWS_PATH,
            source: 'file',
            error: null,
        });
        expect(invokeMock).toHaveBeenCalledWith('read_local_playlist_file', { path: WINDOWS_PATH });
        expect(prefsGet).not.toHaveBeenCalled();
    });

    it('falls back to the fs plugin when the native read is unavailable', async () => {
        invokeMock.mockRejectedValue(new Error('command not found'));
        readFileMock.mockResolvedValue(new TextEncoder().encode('#EXTM3U via plugin'));

        const resolved = await resolveLocalPlaylist({ id: 'source-1', url: localPlaylistUrl(POSIX_PATH) });

        expect(resolved.source).toBe('file');
        expect(resolved.content).toBe('#EXTM3U via plugin');
    });

    it('falls back to the kept copy when the file cannot be read at all', async () => {
        invokeMock.mockRejectedValue(new Error('Cannot open the playlist file: not found'));
        readFileMock.mockRejectedValue(new Error('forbidden path'));
        prefsGet.mockResolvedValue({ key: 'k', value: '#EXTM3U kept' });

        const resolved = await resolveLocalPlaylist({ id: 'source-1', url: localPlaylistUrl(WINDOWS_PATH) });

        expect(resolved.source).toBe('kept-copy');
        expect(resolved.content).toBe('#EXTM3U kept');
        expect(resolved.filePath).toBe(WINDOWS_PATH);
        expect(resolved.error).toContain('not found');
    });

    it('reports nothing to parse for a legacy import', async () => {
        prefsGet.mockResolvedValue(undefined);

        const resolved = await resolveLocalPlaylist({ id: 'source-1', url: `${LEGACY_IMPORTED_URL_PREFIX}demo` });

        expect(resolved).toEqual({ content: null, filePath: null, source: 'none', error: null });
        expect(invokeMock).not.toHaveBeenCalled();
    });

    it('treats an empty file as no content rather than an error', async () => {
        invokeMock.mockResolvedValue('\n\n');
        prefsGet.mockResolvedValue(undefined);

        const resolved = await resolveLocalPlaylist({ id: 'source-1', url: localPlaylistUrl(WINDOWS_PATH) });

        expect(resolved.source).toBe('none');
        expect(resolved.content).toBeNull();
        expect(resolved.error).toBe('the file is empty');
    });

    it('keeps the source stale only when the playlist was not read from its file', () => {
        // Read from the file and parsed: fresh.
        expect(planLocalPlaylistSync({ from: 'file', parsedChannelCount: 12, cachedChannelCount: 0 })).toEqual({
            use: 'parsed',
            refreshCopy: true,
            keepStale: false,
        });
        // Rebuilt from the kept copy: usable, but the file is still missing.
        expect(planLocalPlaylistSync({ from: 'kept-copy', parsedChannelCount: 12, cachedChannelCount: 9 })).toEqual({
            use: 'parsed',
            refreshCopy: false,
            keepStale: true,
        });
    });

    it('never overwrites the kept copy with a file that lists no channels', () => {
        // A truncated file, an error page, or the wrong file re-linked: the
        // cached channels and the good copy both survive it.
        expect(planLocalPlaylistSync({ from: 'file', parsedChannelCount: 0, cachedChannelCount: 40 })).toEqual({
            use: 'cached',
            refreshCopy: false,
            keepStale: true,
        });
        expect(planLocalPlaylistSync({ from: 'kept-copy', parsedChannelCount: 0, cachedChannelCount: 40 })).toEqual({
            use: 'cached',
            refreshCopy: false,
            keepStale: true,
        });
        // Nothing cached either: the caller reports it instead of writing zero.
        expect(planLocalPlaylistSync({ from: 'none', parsedChannelCount: 0, cachedChannelCount: 0 })).toEqual({
            use: 'none',
            refreshCopy: false,
            keepStale: true,
        });
    });

    it('names the file in the message shown when nothing can be rebuilt', () => {
        expect(localPlaylistUnreadableMessage(WINDOWS_PATH)).toBe(
            `t:common:localPlaylistUnreadable:${WINDOWS_PATH}`
        );
        expect(localPlaylistUnreadableMessage(null)).toBe(
            't:common:localPlaylistUnreadable:t:common:localPlaylistUnknownFile'
        );
    });
});
