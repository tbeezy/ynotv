/**
 * Portal-side ("server") search for Stalker sources.
 *
 * Stalker VOD browsing is lazy per category, so the local library only ever holds the
 * categories a user has opened — a local search can never cover a 100k-title portal.
 * This asks the portal itself, which is the only way to search the whole catalogue.
 *
 * Results are written through the same mapping the lazy loader uses
 * (`storeStalkerServerSearchHits`), which is what keeps them from duplicating what is
 * already cached: `vodMovies.stream_id` and `vodSeries.series_id` are derived from the
 * portal's own ids, so an already-known title is updated in place. It also means the
 * existing detail page, media-info probe and stream resolver work on a result unchanged.
 */

import { StalkerClient, type StalkerSearchEndpoint, type StalkerSearchMatchKind } from '@ynotv/local-adapter';
import { db, type StoredMovie, type StoredSeries } from '../db';
import { storeStalkerServerSearchHits } from '../db/sync';

/** Portal pages `get_ordered_list` at this size unless it says otherwise. */
export const STALKER_PAGE_SIZE = 14;
/** Pages loaded by a first search and by each "Show more" — about 56 titles. */
export const SEARCH_BATCH_PAGES = 4;
/** "Load all" is only offered while the whole result set fits in this many pages. */
export const SEARCH_LOAD_ALL_MAX_PAGES = 15;
/** Never walk further than this, however many times the user asks for more. */
export const SEARCH_HARD_MAX_PAGES = 40;

/**
 * Height the result cards' category line adds to their info strip.
 *
 * The grid sizes its rows from an estimate, so this has to equal the extra height
 * `.media-card--with-category .media-card__info` adds to `.media-card__info` in
 * MediaCard.css — a mismatch is the kind of thing that shows up as rows which shrink or
 * overlap until the user scrolls. Pinned by a test, since nothing else relates the two.
 */
export const SEARCH_CATEGORY_LINE_PX = 14;

export interface StalkerSearchSource {
    id: string;
    name: string;
    url: string;
    mac: string;
    userAgent?: string;
}

export interface StalkerSearchCategory {
    id: string;
    name: string;
}

export interface StalkerServerSearchPage {
    rows: Array<StoredMovie | StoredSeries>;
    /** The provider's total for the phrase searched — an upper bound while pages remain. */
    total: number;
    /** How many rows this call returned. */
    shown: number;
    nextPage: number;
    hasMore: boolean;
    /** The portal answered as though no `search` were sent. */
    unsupported: boolean;
    /**
     * The phrase actually sent. Differs from the query when it matched nothing and a wider
     * form was used, so it is also what a resumed walk has to send back.
     */
    phrase: string;
    /**
     * How `phrase` relates to the typed words, so the view can say which one it got:
     * the words side by side, the words in order with anything between them (the portal's
     * own `%` wildcard), or just the longest word with the rest applied locally.
     */
    matchKind: StalkerSearchMatchKind;
    /**
     * Which portal endpoint answered, from either search. Pass it back to resume: a series
     * search settles between `series` and `vod` on its first page, and a resumed page that
     * re-decided would splice the other endpoint's page N into the walk.
     */
    endpoint: StalkerSearchEndpoint;
    /** Non-empty if an individual source query failed during multi-source search. */
    error?: string;
}

export interface StalkerServerSearchParams {
    source: StalkerSearchSource;
    type: 'movies' | 'series';
    query: string;
    /** App-namespaced category id, or null for the whole library. */
    categoryId: string | null;
    fromPage?: number;
    maxPages?: number;
    /**
     * The phrase the first page settled on (`phrase` from that call), needed to resume.
     * The portal's retry with the query's longest word only happens on page 0, so a resume
     * without this sends the user's own words — the phrase that already found nothing.
     */
    phrase?: string;
    /** The endpoint the first page settled on (`endpoint` from that call), needed to resume. */
    endpoint?: StalkerSearchEndpoint;
    onProgress?: (info: { page: number; loaded: number; total?: number }) => void;
}

/**
 * One client per set of credentials, reused across searches.
 *
 * This matters beyond caching a session token: the client memoizes the portal's page
 * numbering (`p=0` and `p=1` can both mean the first page) and re-probes it per instance,
 * so a shared client keeps "Show more" from re-learning it on every click.
 *
 * Keyed on the credentials rather than the source id: a client holds the URL and MAC it was
 * built with, so editing a portal in Settings must not keep answering with the old ones —
 * including the session token it opened with the previous MAC — until the app restarts.
 */
const clients = new Map<string, StalkerClient>();

function clientFor(source: StalkerSearchSource): StalkerClient {
    const key = `${source.id}\u0000${source.url}\u0000${source.mac}\u0000${source.userAgent ?? ''}`;
    let client = clients.get(key);
    if (!client) {
        client = new StalkerClient(
            { baseUrl: source.url, mac: source.mac, userAgent: source.userAgent },
            source.id
        );
        clients.set(key, client);
    }
    return client;
}

/** Enabled Stalker sources — the only sources this feature means anything for. */
export async function getStalkerSearchSources(): Promise<StalkerSearchSource[]> {
    if (!window.storage) return [];
    try {
        const result = await window.storage.getSources();
        const sources = (result?.data ?? []) as any[];
        return sources
            .filter(s => s?.type === 'stalker' && s?.enabled !== false && s?.url)
            .map(s => ({
                id: s.id,
                name: s.name ?? s.url,
                url: s.url,
                mac: s.mac ?? '',
                userAgent: s.user_agent,
            }));
    } catch (e) {
        console.warn('[StalkerServerSearch] Could not list sources:', e);
        return [];
    }
}

/**
 * Categories already known for this source, for scoping a search.
 *
 * Only enabled categories are offered, matching what the VOD sidebar shows: a category
 * the user disabled in Manage VOD Categories is hidden there, so it should not be a
 * valid scope here either. The label comes from `name` (VodCategory), not the sidebar's
 * display alias, so this works without a second lookup.
 */
export async function getStalkerSearchCategories(
    sourceId: string,
    type: 'movies' | 'series'
): Promise<StalkerSearchCategory[]> {
    const rows = await db.vodCategories.where('type').equals(type === 'movies' ? 'movie' : 'series').toArray();
    return rows
        .filter((c) => c.source_id === sourceId && c.enabled !== false)
        .map((c) => ({ id: c.category_id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Category names for a source, keyed by the app-namespaced id a row carries.
 *
 * Deliberately not `getStalkerSearchCategories`: that one lists what a user may *pick*, so
 * it hides disabled categories. A result can come from one of those — a whole-library
 * search is not filtered by enabled state either — and a card that could name its
 * category but doesn't would look like a bug.
 */
export async function getStalkerSearchCategoryNames(
    sourceId: string,
    type: 'movies' | 'series'
): Promise<Record<string, string>> {
    const rows = await db.vodCategories.where('type').equals(type === 'movies' ? 'movie' : 'series').toArray();
    const names: Record<string, string> = {};
    for (const c of rows) {
        if (c.source_id !== sourceId || !c.category_id || !c.name) continue;
        names[c.category_id] = c.name;
    }
    return names;
}

/**
 * Category names for all Stalker sources of a given type.
 *
 * Used when searching across all sources so cards can resolve their category labels
 * regardless of which source they came from.
 */
export async function getAllStalkerSearchCategoryNames(
    type: 'movies' | 'series'
): Promise<Record<string, string>> {
    const rows = await db.vodCategories.where('type').equals(type === 'movies' ? 'movie' : 'series').toArray();
    const names: Record<string, string> = {};
    for (const c of rows) {
        if (!c.category_id || !c.name) continue;
        names[c.category_id] = c.name;
    }
    return names;
}

/** A row's category membership, from a stored JSON string or an in-memory array. */
function parseCategoryIds(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/**
 * The categories a result belongs to, as names, most relevant first.
 *
 * `preferredId` is the category the search was scoped to. Membership is stored as a union
 * that keeps whatever the cached row already had, so the order inside `category_ids` is
 * that row's history rather than this search's intent — when the scoped category is one
 * of them, that is the one the card should name.
 *
 * Ids with no name are dropped rather than printed: a category the source never synced has
 * no row to name it, and a raw `{source}_vod_150` on a card tells a user nothing.
 */
export function categoryLabelsFor(
    value: unknown,
    names: Record<string, string>,
    preferredId?: string | null
): string[] {
    const labels = [
        ...new Set(parseCategoryIds(value).map((id) => names[id]).filter((n): n is string => !!n)),
    ];
    const preferred = preferredId ? names[preferredId] : undefined;
    if (!preferred || labels.indexOf(preferred) <= 0) return labels;
    return [preferred, ...labels.filter((n) => n !== preferred)];
}

/**
 * A Stalker client needs the MAC. `getSources()` carries it, but if a build ever hands
 * back a redacted list, read the one source rather than failing the whole search with an
 * auth error the user cannot act on.
 */
async function withCredentials(source: StalkerSearchSource): Promise<StalkerSearchSource> {
    if (source.mac || !window.storage) return source;
    try {
        const res = await window.storage.getSource(source.id);
        const full = res?.data as any;
        if (full?.mac) {
            return { ...source, mac: full.mac, userAgent: source.userAgent ?? full.user_agent };
        }
    } catch (e) {
        console.warn('[StalkerServerSearch] Could not read the source credentials:', e);
    }
    return source;
}

/** Search the portal and store what comes back, so results are playable as-is. */
export async function searchStalkerServer(params: StalkerServerSearchParams): Promise<StalkerServerSearchPage> {
    const source = await withCredentials(params.source);
    const client = clientFor(source);
    const options = {
        categoryId: params.categoryId ?? undefined,
        fromPage: Math.max(0, Math.floor(params.fromPage ?? 0)),
        maxPages: Math.max(1, Math.floor(params.maxPages ?? SEARCH_BATCH_PAGES)),
        phrase: params.phrase,
        endpoint: params.endpoint,
        onProgress: params.onProgress,
    };


    const result = params.type === 'movies'
        ? await client.searchVod(params.query, options)
        : await client.searchSeries(params.query, options);

    const rows = await storeStalkerServerSearchHits(result.items, params.type, params.categoryId);

    return {
        rows,
        total: result.total,
        shown: rows.length,
        nextPage: result.nextPage,
        hasMore: result.hasMore,
        unsupported: result.unsupported,
        phrase: result.phrase,
        matchKind: result.matchKind,
        endpoint: result.endpoint,
    };
}

/**
 * Merge individual StalkerServerSearchPage results from multiple sources into a combined page.
 *
 * Rules:
 * - Omits rows and totals from portals where `unsupported === true` or where an error occurred.
 * - Deduplicates rows by stream_id / series_id.
 * - Sorts rows alphabetically by title.
 * - Aggregates matchKind: 'verbatim' if any portal found verbatim matches (so the UI doesn't
 *   falsely claim no exact matches were found); 'word' if all working portals used the same
 *   fallback phrase; 'all-words' if all working portals fell back to matching all words.
 * - `unsupported` is true only if ALL portals answered as unsupported.
 */
export function mergeStalkerServerSearchPages(
    sourceResults: Record<string, StalkerServerSearchPage>,
    query: string
): StalkerServerSearchPage {
    const pages = Object.values(sourceResults);
    const workingPages = pages.filter(p => !p.unsupported && !p.error);

    const mergedRows: Array<StoredMovie | StoredSeries> = [];
    const seenRowIds = new Set<string>();
    let totalCount = 0;
    let anyHasMore = false;

    for (const p of workingPages) {
        totalCount += p.total;
        if (p.hasMore) anyHasMore = true;
        for (const r of p.rows) {
            const id = (r as StoredSeries).series_id ?? (r as StoredMovie).stream_id;
            if (!seenRowIds.has(id)) {
                seenRowIds.add(id);
                mergedRows.push(r);
            }
        }
    }
    mergedRows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    let matchKind: StalkerSearchMatchKind = 'verbatim';
    let phrase = query;

    if (workingPages.length > 0) {
        const kinds = workingPages.map(p => p.matchKind);
        if (kinds.some(k => k === 'verbatim')) {
            matchKind = 'verbatim';
            phrase = query;
        } else if (kinds.every(k => k === 'word') && workingPages.every(p => p.phrase === workingPages[0].phrase)) {
            matchKind = 'word';
            phrase = workingPages[0].phrase;
        } else if (kinds.some(k => k === 'all-words' || k === 'word')) {
            matchKind = 'all-words';
            phrase = query;
        }
    }

    const allUnsupported = pages.length > 0 && pages.every(p => p.unsupported);

    return {
        rows: mergedRows,
        total: totalCount,
        shown: mergedRows.length,
        nextPage: 1,
        hasMore: anyHasMore,
        unsupported: allUnsupported,
        phrase,
        matchKind,
        endpoint: workingPages[0]?.endpoint ?? 'vod',
    };
}
