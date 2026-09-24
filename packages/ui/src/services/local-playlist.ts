/**
 * Local (imported) M3U playlists.
 *
 * Importing a playlist from a file used to be a one-shot copy: its channels were
 * parsed straight into SQLite and the source row kept only a placeholder
 * (`imported:<name>`), so nothing recorded which file it came from. Anything that
 * emptied the cache tables — a backup restore, Clear Cache — then left a source
 * that could never be refilled, because its "sync" only re-read channels that no
 * longer existed.
 *
 * A playlist imported now keeps two things instead:
 *
 * - the file it came from, in the source URL as `file:<path>`, so a sync can
 *   re-read it and pick up edits to the playlist;
 * - a copy of its text in the `prefs` table, which survives a cache clear (see
 *   clearAllCachedData) and rides along in a backup (see exportImport), so the
 *   playlist can be rebuilt when the file has moved, been deleted, or when the
 *   backup is restored on another machine.
 *
 * Reading the file goes through a Rust command rather than the JS fs plugin: the
 * plugin's permission for a dialog-picked path only lasts for the session it was
 * picked in, so a path restored from a backup couldn't be read again.
 *
 * Sources imported before this existed have a placeholder URL and no copy; they
 * still work while their channels are cached, and are reported as needing a
 * re-import once they are not (see resolveLocalPlaylist / sync.ts).
 */
import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n';
import { db } from '../db';

/** URL prefix marking a source whose playlist is a file on this machine. */
export const LOCAL_PLAYLIST_URL_PREFIX = 'file:';

/** Legacy prefix for a file import that never recorded where the file was. */
export const LEGACY_IMPORTED_URL_PREFIX = 'imported:';

/**
 * Largest playlist we will read from disk or keep a copy of. A playlist this
 * large is 64 MB of text; anything bigger is refused rather than held in memory
 * (the file itself still plays back fine, it just won't be rebuilt from a copy).
 */
export const LOCAL_PLAYLIST_MAX_BYTES = 64 * 1024 * 1024;

/** The prefs key holding the kept copy of an imported playlist. */
export function localPlaylistSnapshotKey(sourceId: string): string {
    return `local_m3u_snapshot:${sourceId}`;
}

/** Build the source URL that records where an imported playlist lives. */
export function localPlaylistUrl(filePath: string): string {
    return `${LOCAL_PLAYLIST_URL_PREFIX}${filePath}`;
}

/**
 * The file a source was imported from, or null when it wasn't imported from one.
 *
 * The app writes a plain `file:<path>`, but a real file URI (`file:///C:/x.m3u`,
 * which someone could hand-put in a backup) is accepted too and turned back into
 * an OS path, so it can't reach the filesystem layer as `///C:/x.m3u`.
 */
export function localPlaylistPath(source: { url?: string | null } | null | undefined): string | null {
    const url = source?.url;
    if (typeof url !== 'string') return null;
    if (!url.startsWith(LOCAL_PLAYLIST_URL_PREFIX)) return null;
    let path = url.slice(LOCAL_PLAYLIST_URL_PREFIX.length).trim();
    if (path.startsWith('//')) {
        // RFC 8089 form (`file:///C:/x.m3u`, `file:///home/x.m3u`): turn it into
        // the OS path the native reader expects.
        const match = /^\/\/([^/]*)(\/.*)?$/.exec(path);
        const authority = match?.[1] ?? '';
        const rest = match?.[2] ?? '';
        if (authority && authority.toLowerCase() !== 'localhost') {
            // A share rather than a drive or POSIX path: \\server\share.
            path = `\\\\${authority}${rest.replace(/\//g, '\\')}`;
        } else {
            path = /^\/[A-Za-z]:/.test(rest) ? rest.slice(1) : rest;
        }
        try {
            // Only the URI form is percent-decoded: a literal `%` in a plain
            // Windows path must survive untouched.
            path = decodeURIComponent(path);
        } catch {
            // Not a valid escape sequence: keep the text as it is.
        }
    }
    return path.length > 0 ? path : null;
}

/** Whether this source's playlist came from a file on this machine. */
export function isLocalPlaylistSource(source: { type?: string | null; url?: string | null } | null | undefined): boolean {
    return source?.type === 'm3u' && localPlaylistPath(source) !== null;
}

/** Whether this is a file import made before the path was recorded. */
export function isLegacyLocalImport(source: { type?: string | null; url?: string | null } | null | undefined): boolean {
    return (
        source?.type === 'm3u' &&
        typeof source.url === 'string' &&
        source.url.startsWith(LEGACY_IMPORTED_URL_PREFIX)
    );
}

/** Just the file name, for labels and logs. */
export function localPlaylistFileName(filePath: string): string {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
}

/**
 * Read a playlist file's text.
 *
 * Invalid UTF-8 (a Windows-1252 playlist, say) is decoded with replacement
 * characters rather than failing: a mangled name still matches nothing worse
 * than it did before, while a hard failure would lose the whole playlist.
 */
export async function readLocalPlaylistFile(filePath: string): Promise<string> {
    let nativeError: string | null = null;
    if (typeof window !== 'undefined' && (window as any).__TAURI__) {
        try {
            return await invoke<string>('read_local_playlist_file', { path: filePath });
        } catch (e) {
            // Fall through to the plugin: only the Rust command applies the size
            // cap, so a large file can still be read in the session the user
            // picked it in (which is also what grants the plugin its access).
            nativeError = e instanceof Error ? e.message : String(e);
            console.warn('[LocalPlaylist] Native read failed, trying the fs plugin:', nativeError);
        }
    }
    try {
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const bytes = await readFile(filePath);
        if (bytes.byteLength > LOCAL_PLAYLIST_MAX_BYTES) {
            throw new Error(`Playlist file is larger than ${Math.round(LOCAL_PLAYLIST_MAX_BYTES / (1024 * 1024))} MB`);
        }
        return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
        // Report the native reason (missing, too large): the plugin normally
        // fails only because its permission doesn't outlive the session that
        // picked the file, which says nothing about the file itself.
        throw new Error(nativeError ?? (e instanceof Error ? e.message : String(e)));
    }
}

/** The copy of an imported playlist kept in the app, if one was stored. */
export async function readLocalPlaylistSnapshot(sourceId: string): Promise<string | null> {
    try {
        const row = await db.prefs.get(localPlaylistSnapshotKey(sourceId));
        const value = (row as any)?.value;
        return typeof value === 'string' && value.trim().length > 0 ? value : null;
    } catch (e) {
        console.warn('[LocalPlaylist] Failed to read the kept copy:', e);
        return null;
    }
}

/** Keep a copy of an imported playlist so it can be rebuilt without the file. */
export async function writeLocalPlaylistSnapshot(sourceId: string, content: string): Promise<void> {
    try {
        if (!content || content.trim().length === 0) return;
        if (content.length > LOCAL_PLAYLIST_MAX_BYTES) {
            console.warn(
                `[LocalPlaylist] Playlist is ${Math.round(content.length / (1024 * 1024))} MB — too large to keep a copy of; ` +
                    'a restore will need the file to be re-imported'
            );
            return;
        }
        // A sync refreshes this whenever the file was read, so skip a rewrite
        // when the file hasn't changed: the copy can be megabytes.
        if ((await readLocalPlaylistSnapshot(sourceId)) === content) return;
        await db.prefs.put({ key: localPlaylistSnapshotKey(sourceId), value: content } as any);
    } catch (e) {
        console.warn('[LocalPlaylist] Failed to store a copy of the playlist:', e);
    }
}

/** Drop the kept copy (the source was deleted). */
export async function clearLocalPlaylistSnapshot(sourceId: string): Promise<void> {
    try {
        await db.prefs.delete(localPlaylistSnapshotKey(sourceId));
    } catch (e) {
        console.warn('[LocalPlaylist] Failed to drop the kept copy:', e);
    }
}

export interface ResolvedLocalPlaylist {
    /** The playlist text to parse, or null when nothing could be read. */
    content: string | null;
    /** The file this source points at, when it recorded one. */
    filePath: string | null;
    /** Where `content` came from; 'none' means the caller has nothing to parse. */
    source: 'file' | 'kept-copy' | 'none';
    /** Why the file couldn't be read, when it was tried and failed. */
    error: string | null;
}

/**
 * Resolve a local source's playlist text: the file on disk when it is still
 * there (so edits are picked up), else the copy kept in the app.
 */
export async function resolveLocalPlaylist(
    source: { id: string; url?: string | null } | null | undefined
): Promise<ResolvedLocalPlaylist> {
    const filePath = localPlaylistPath(source);
    let error: string | null = null;

    if (filePath) {
        try {
            const content = await readLocalPlaylistFile(filePath);
            if (content && content.trim().length > 0) {
                return { content, filePath, source: 'file', error: null };
            }
            error = 'the file is empty';
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
    }

    const kept = source?.id ? await readLocalPlaylistSnapshot(source.id) : null;
    if (kept) {
        return { content: kept, filePath, source: 'kept-copy', error };
    }

    return { content: null, filePath, source: 'none', error };
}

export interface LocalPlaylistPlan {
    /** What the sync should write for this source. */
    use: 'parsed' | 'cached' | 'none';
    /** Whether the kept copy should be replaced with what was just parsed. */
    refreshCopy: boolean;
    /**
     * Whether the source should stay marked stale, so the next auto-sync cycle
     * tries again: the playlist was rebuilt from the kept copy rather than the
     * file, or nothing usable could be parsed at all.
     */
    keepStale: boolean;
}

/**
 * Decide what a local playlist's sync should do with what it read.
 *
 * The one rule worth stating: a file that parses to *no* channels never
 * replaces the kept copy. A playlist file that has been truncated, replaced by
 * an error page, or re-linked to the wrong file parses to zero channels, and
 * writing that over the copy would destroy the only good copy the app has —
 * while the sync deletes the channels it can no longer see. Cached channels win
 * instead, and the source stays stale so it is retried once the file is back.
 */
export function planLocalPlaylistSync(args: {
    /** Where the text came from (see ResolvedLocalPlaylist.source). */
    from: ResolvedLocalPlaylist['source'];
    parsedChannelCount: number;
    cachedChannelCount: number;
}): LocalPlaylistPlan {
    if (args.parsedChannelCount > 0) {
        return {
            use: 'parsed',
            refreshCopy: args.from === 'file',
            // Rebuilt from the kept copy: the playlist works, but its file is
            // still missing, so keep retrying for it.
            keepStale: args.from !== 'file',
        };
    }
    if (args.cachedChannelCount > 0) {
        return { use: 'cached', refreshCopy: false, keepStale: true };
    }
    return { use: 'none', refreshCopy: false, keepStale: true };
}

/** The message shown when a local playlist can't be rebuilt at all. */
export function localPlaylistUnreadableMessage(filePath: string | null): string {
    return i18n.t('common:localPlaylistUnreadable', {
        path: filePath || i18n.t('common:localPlaylistUnknownFile'),
    });
}
