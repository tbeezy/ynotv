import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18n from '../../i18n';
import type { StoredMovie, StoredSeries } from '../../db';
import { MediaCard } from './MediaCard';
import { VirtualGrid } from '../common/VirtualGrid';
import { useStalkerSearchStore, type StalkerSearchType } from '../../stores/stalkerSearchStore';
import {
    categoryLabelsFor,
    getAllStalkerSearchCategoryNames,
    getStalkerSearchCategories,
    getStalkerSearchCategoryNames,
    getStalkerSearchSources,
    mergeStalkerServerSearchPages,
    searchStalkerServer,
    SEARCH_BATCH_PAGES,
    SEARCH_CATEGORY_LINE_PX,
    SEARCH_HARD_MAX_PAGES,
    SEARCH_LOAD_ALL_MAX_PAGES,
    STALKER_PAGE_SIZE,
    type StalkerSearchCategory,
    type StalkerSearchSource,
    type StalkerServerSearchPage,
} from '../../services/stalkerServerSearch';
import './StalkerServerSearchView.css';

interface StalkerServerSearchViewProps {
    type: StalkerSearchType;
    onOpenItem: (item: StoredMovie | StoredSeries) => void;
}

const rowId = (row: StoredMovie | StoredSeries) =>
    (row as StoredSeries).series_id ?? (row as StoredMovie).stream_id;


/** A portal that ignored `search` returned its normal catalogue — never present that as matches. */
function unsupportedResult(result: StalkerServerSearchPage): boolean {
    return result.unsupported;
}

/**
 * Search a Stalker portal's own catalogue, rendered inline on the Movies/Series page.
 *
 * Deliberately separate from the normal search box: that one is an instant local DB query
 * whose result set the browse grid treats as its identity (and remembers scroll for), while
 * this is a paginated network walk with its own progress, count and failure states — and it
 * only exists for MAC portals, so it is opt-in per install.
 *
 * Selection and results live in `useStalkerSearchStore` (session-scoped), so opening a
 * detail page, playing and stopping, or switching categories and coming back all restore
 * the exact result set instead of re-walking the portal.
 */
export function StalkerServerSearchView({ type, onOpenItem }: StalkerServerSearchViewProps) {
    const slice = useStalkerSearchStore((s) => s.byType[type]);
    const patch = useStalkerSearchStore((s) => s.patch);

    const [sources, setSources] = useState<StalkerSearchSource[] | null>(null);
    const [categories, setCategories] = useState<StalkerSearchCategory[]>([]);
    /** Every category name this source has (disabled ones included) — see the loader. */
    const [categoryNames, setCategoryNames] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    /** Newest search wins; a slower in-flight one can no longer patch the store over it. */
    const requestIdRef = useRef(0);

    const { sourceId, categoryId, query, result, sourceResults, activeTab = 'all', pagesLoaded } = slice;
    const isAllSources = sourceId === '*';
    const source = useMemo(() => (!isAllSources ? sources?.find(s => s.id === sourceId) ?? null : null), [sources, sourceId, isAllSources]);
    const sourcesMap = useMemo(() => new Map((sources ?? []).map(s => [s.id, s.name])), [sources]);

    // Load the portal list once; keep the last pick so a reopen lands where the user left off.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const list = await getStalkerSearchSources();
            if (cancelled) return;
            setSources(list);
            if (list.length > 0) {
                const current = useStalkerSearchStore.getState().byType[type].sourceId;
                const next = current && (current === '*' || list.some(s => s.id === current))
                    ? current
                    : list[0].id;
                if (next !== current) patch(type, { sourceId: next });
            }
        })();
        return () => { cancelled = true; };
    }, [type, patch]);

    // Categories for the chosen portal, scoped to movies or series.
    useEffect(() => {
        let cancelled = false;
        if (!sourceId || isAllSources) {
            if (!sourceId) setCategories([]);
            return;
        }
        (async () => {
            const list = await getStalkerSearchCategories(sourceId, type);
            if (cancelled) return;
            setCategories(list);
            const current = useStalkerSearchStore.getState().byType[type].categoryId;
            if (current !== '*' && !list.some(c => c.id === current)) {
                patch(type, { categoryId: '*' });
            }
        })().catch(e => {
            console.warn('[StalkerServerSearch] Could not list categories:', e);
            if (!cancelled) setCategories([]);
        });
        return () => { cancelled = true; };
    }, [sourceId, isAllSources, type, patch]);

    // Names for the labels under each result. Unlike the picker's list this keeps disabled
    // categories: a result can legitimately come from one, and an unnamed card would read
    // as the feature being broken rather than the category being hidden.
    useEffect(() => {
        let cancelled = false;
        if (!sourceId) {
            setCategoryNames({});
            return;
        }
        const loader = isAllSources
            ? getAllStalkerSearchCategoryNames(type)
            : getStalkerSearchCategoryNames(sourceId, type);

        loader
            .then(names => { if (!cancelled) setCategoryNames(names); })
            .catch(e => {
                console.warn('[StalkerServerSearch] Could not read category names:', e);
                if (!cancelled) setCategoryNames({});
            });
        return () => { cancelled = true; };
    }, [sourceId, isAllSources, type]);

    const runSearch = useCallback(
        async (opts: { fromPage: number; maxPages: number; append: boolean }) => {
            const current = useStalkerSearchStore.getState().byType[type];
            const allAvailableSources = sources ?? [];
            const isAll = current.sourceId === '*';
            const activeSource = isAll ? null : allAvailableSources.find(s => s.id === current.sourceId) ?? null;
            const q = current.query.trim();
            if ((!isAll && !activeSource) || (isAll && allAvailableSources.length === 0) || !q) return;

            // Two searches can be in flight at once (a slow "Load all" and a new query).
            // Only the newest one may touch the store or the loading flags, otherwise the
            // slower answer overwrites the newer result set on arrival.
            const requestId = ++requestIdRef.current;
            setLoading(true);
            setError(null);

            if (!isAll && activeSource) {
                setProgress(i18n.t('common:searching'));
                try {
                    const page = await searchStalkerServer({
                        source: activeSource,
                        type,
                        query: q,
                        // Resuming has to stay on the phrase the first page settled on: the
                        // verbatim→longest-word retry only runs on page 0, so sending the raw
                        // query again would ask for the phrase that already returned nothing.
                        phrase: opts.append ? current.result?.phrase : undefined,
                        // Same reasoning as `phrase`: a series search decides between the
                        // `series` and `vod` endpoints on page 0, so a resume that let it
                        // decide again could splice the other endpoint's page into the walk.
                        endpoint: opts.append ? current.result?.endpoint : undefined,
                        categoryId: current.categoryId === '*' ? null : current.categoryId,
                        fromPage: opts.fromPage,
                        maxPages: opts.maxPages,
                        onProgress: info => {
                            if (requestId !== requestIdRef.current) return;
                            setProgress(
                                info.total != null
                                    ? i18n.t('vod:loadingPageOf', { current: info.page, total: Math.max(1, Math.ceil(info.total / STALKER_PAGE_SIZE)) })
                                    : i18n.t('vod:loadingPage', { current: info.page })
                            );
                        },
                    });

                    if (requestId !== requestIdRef.current) return;

                    const prev = useStalkerSearchStore.getState().byType[type].result;
                    let nextResult = page;
                    let nextPages = opts.maxPages;
                    if (opts.append && prev) {
                        const seen = new Set(prev.rows.map(rowId));
                        const rows = [...prev.rows, ...page.rows.filter(r => !seen.has(rowId(r)))];
                        nextResult = { ...page, rows, shown: rows.length };
                        nextPages = useStalkerSearchStore.getState().byType[type].pagesLoaded + opts.maxPages;
                    }
                    patch(type, {
                        result: nextResult,
                        sourceResults: { [activeSource.id]: nextResult },
                        sourcePagesLoaded: { [activeSource.id]: nextPages },
                        activeTab: 'all',
                        pagesLoaded: nextPages,
                    });
                } catch (e: any) {
                    if (requestId !== requestIdRef.current) return;
                    setError(e?.message || i18n.t('common:noResultsFound'));
                } finally {
                    if (requestId === requestIdRef.current) {
                        setLoading(false);
                        setProgress(null);
                    }
                }
            } else {
                // Multi-source search across all Stalker sources
                try {
                    const curTab = current.activeTab ?? 'all';
                    const prevSourcesMap = current.sourceResults ?? {};
                    const prevPagesMap = current.sourcePagesLoaded ?? {};

                    if (opts.append) {
                        const effectiveCurTab = (curTab !== 'all' && prevSourcesMap[curTab]) ? curTab : 'all';
                        const targetSources = (effectiveCurTab !== 'all'
                            ? allAvailableSources.filter(s => s.id === effectiveCurTab)
                            : allAvailableSources
                        ).filter(s => prevSourcesMap[s.id]?.hasMore && !prevSourcesMap[s.id]?.unsupported);

                        if (targetSources.length === 0) {
                            setLoading(false);
                            return;
                        }

                        let completed = 0;
                        const updatePagingProgress = () => {
                            if (requestId !== requestIdRef.current) return;
                            setProgress(
                                i18n.t('vod:stalkerServerSearchProgressSources', {
                                    current: completed,
                                    total: targetSources.length,
                                    defaultValue: `Searching servers (${completed}/${targetSources.length})...`,
                                })
                            );
                        };
                        updatePagingProgress();

                        const settled = await Promise.allSettled(
                            targetSources.map(async src => {
                                const prior = prevSourcesMap[src.id];
                                try {
                                    const page = await searchStalkerServer({
                                        source: src,
                                        type,
                                        query: q,
                                        phrase: prior?.phrase,
                                        endpoint: prior?.endpoint,
                                        categoryId: null,
                                        fromPage: prior?.nextPage ?? 0,
                                        maxPages: opts.maxPages,
                                    });
                                    return { source: src, page, error: null };
                                } catch (e: any) {
                                    return { source: src, page: null, error: e?.message || 'Failed' };
                                } finally {
                                    completed++;
                                    updatePagingProgress();
                                }
                            })
                        );

                        if (requestId !== requestIdRef.current) return;

                        const nextSourceResults: Record<string, StalkerServerSearchPage> = { ...prevSourcesMap };
                        const nextSourcePages: Record<string, number> = { ...prevPagesMap };
                        const appendErrors: string[] = [];

                        for (const res of settled) {
                            if (res.status === 'fulfilled') {
                                const { source: src, page, error: srcError } = res.value;
                                if (page) {
                                    const prevPage = prevSourcesMap[src.id];
                                    if (prevPage) {
                                        const seen = new Set(prevPage.rows.map(rowId));
                                        const rows = [...prevPage.rows, ...page.rows.filter(r => !seen.has(rowId(r)))];
                                        nextSourceResults[src.id] = { ...page, rows, shown: rows.length };
                                    } else {
                                        nextSourceResults[src.id] = page;
                                    }
                                    nextSourcePages[src.id] = (nextSourcePages[src.id] ?? current.pagesLoaded) + opts.maxPages;
                                } else if (srcError) {
                                    appendErrors.push(`${src.name}: ${srcError}`);
                                    const prevPage = prevSourcesMap[src.id];
                                    if (prevPage) {
                                        nextSourceResults[src.id] = { ...prevPage, error: srcError, hasMore: false };
                                    }
                                }
                            } else if (res.status === 'rejected') {
                                const reason = (res as PromiseRejectedResult).reason;
                                const msg = reason?.message || 'Failed';
                                appendErrors.push(msg);
                            }
                        }

                        const anyAppended = settled.some(r => r.status === 'fulfilled' && !!r.value.page);
                        if ((effectiveCurTab !== 'all' || !anyAppended) && appendErrors.length > 0) {
                            setError(appendErrors.join('; '));
                        }

                        const mergedResult = mergeStalkerServerSearchPages(nextSourceResults, q);
                        const maxPagesLoaded = Math.max(
                            ...Object.values(nextSourcePages),
                            current.pagesLoaded + (effectiveCurTab === 'all' ? opts.maxPages : 0)
                        );

                        patch(type, {
                            result: mergedResult,
                            sourceResults: nextSourceResults,
                            sourcePagesLoaded: nextSourcePages,
                            pagesLoaded: maxPagesLoaded,
                        });
                    } else {
                        // Initial search across all sources
                        let completed = 0;
                        const updateSearchProgress = () => {
                            if (requestId !== requestIdRef.current) return;
                            setProgress(
                                i18n.t('vod:stalkerServerSearchProgressSources', {
                                    current: completed,
                                    total: allAvailableSources.length,
                                    defaultValue: `Searching servers (${completed}/${allAvailableSources.length})...`,
                                })
                            );
                        };
                        updateSearchProgress();

                        const settled = await Promise.allSettled(
                            allAvailableSources.map(async src => {
                                try {
                                    const page = await searchStalkerServer({
                                        source: src,
                                        type,
                                        query: q,
                                        categoryId: null,
                                        fromPage: 0,
                                        maxPages: opts.maxPages,
                                    });
                                    return { source: src, page, error: null };
                                } catch (e: any) {
                                    return { source: src, page: null, error: e?.message || 'Failed' };
                                } finally {
                                    completed++;
                                    updateSearchProgress();
                                }
                            })
                        );

                        if (requestId !== requestIdRef.current) return;

                        const nextSourceResults: Record<string, StalkerServerSearchPage> = {};
                        const nextSourcePages: Record<string, number> = {};
                        const errorMsgs: string[] = [];
                        let anySuccess = false;

                        for (const res of settled) {
                            if (res.status === 'fulfilled') {
                                const { source: src, page, error: srcError } = res.value;
                                if (page) {
                                    nextSourceResults[src.id] = page;
                                    nextSourcePages[src.id] = opts.maxPages;
                                    anySuccess = true;
                                } else if (srcError) {
                                    errorMsgs.push(`${src.name}: ${srcError}`);
                                    nextSourceResults[src.id] = {
                                        rows: [],
                                        total: 0,
                                        shown: 0,
                                        nextPage: 0,
                                        hasMore: false,
                                        unsupported: false,
                                        phrase: q,
                                        matchKind: 'all-words',
                                        endpoint: 'vod',
                                        error: srcError,
                                    };
                                    nextSourcePages[src.id] = 0;
                                }
                            }
                        }

                        if (!anySuccess && errorMsgs.length > 0) {
                            setError(errorMsgs.join('; '));
                        } else {
                            const mergedResult = mergeStalkerServerSearchPages(nextSourceResults, q);
                            patch(type, {
                                result: mergedResult,
                                sourceResults: nextSourceResults,
                                sourcePagesLoaded: nextSourcePages,
                                activeTab: 'all',
                                pagesLoaded: opts.maxPages,
                            });
                        }
                    }
                } catch (e: any) {
                    if (requestId !== requestIdRef.current) return;
                    setError(e?.message || i18n.t('common:noResultsFound'));
                } finally {
                    if (requestId === requestIdRef.current) {
                        setLoading(false);
                        setProgress(null);
                    }
                }
            }
        },
        [sources, type, patch]
    );

    const onSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        patch(type, { result: null, sourceResults: {}, sourcePagesLoaded: {}, activeTab: 'all', pagesLoaded: 0 });
        void runSearch({ fromPage: 0, maxPages: SEARCH_BATCH_PAGES, append: false });
    };

    const effectiveTab = (isAllSources && activeTab !== 'all' && sourceResults?.[activeTab])
        ? activeTab
        : 'all';

    const displayResult = useMemo(() => {
        if (!result) return null;
        if (!isAllSources || effectiveTab === 'all') {
            return result;
        }
        return sourceResults?.[effectiveTab] ?? result;
    }, [result, isAllSources, effectiveTab, sourceResults]);

    const currentPagesLoaded = useMemo(() => {
        if (!isAllSources) return pagesLoaded;
        if (effectiveTab === 'all') {
            const values = Object.values(slice.sourcePagesLoaded ?? {});
            return values.length > 0 ? Math.max(pagesLoaded, ...values) : pagesLoaded;
        }
        return slice.sourcePagesLoaded?.[effectiveTab] ?? pagesLoaded;
    }, [isAllSources, effectiveTab, pagesLoaded, slice.sourcePagesLoaded]);

    const loadAllOfferable =
        !!displayResult && displayResult.hasMore && !loading && currentPagesLoaded < SEARCH_LOAD_ALL_MAX_PAGES &&
        Math.ceil(displayResult.total / STALKER_PAGE_SIZE) <= SEARCH_LOAD_ALL_MAX_PAGES;

    const tooManyToLoad =
        !!displayResult && displayResult.hasMore && !unsupportedResult(displayResult) &&
        Math.ceil(displayResult.total / STALKER_PAGE_SIZE) > SEARCH_LOAD_ALL_MAX_PAGES;

    const hitHardCap = currentPagesLoaded >= SEARCH_HARD_MAX_PAGES;

    const showMore = () => {
        if (!displayResult || !displayResult.hasMore) return;
        void runSearch({ fromPage: displayResult.nextPage, maxPages: SEARCH_BATCH_PAGES, append: true });
    };

    const loadAll = () => {
        if (!displayResult) return;
        const budget = SEARCH_LOAD_ALL_MAX_PAGES - currentPagesLoaded;
        if (budget <= 0) return;
        void runSearch({ fromPage: displayResult.nextPage, maxPages: budget, append: true });
    };

    if (sources !== null && sources.length === 0) {
        return (
            <div className="stalker-search-view">
                <div className="stalker-search-empty">{i18n.t('vod:stalkerServerSearchNoSources')}</div>
            </div>
        );
    }

    return (
        <div className="stalker-search-view">
            <form className="stalker-search-controls" onSubmit={onSubmit}>
                <label className="stalker-search-field">
                    <span>{i18n.t('vod:stalkerServerSearchSource')}</span>
                    <select
                        value={sourceId}
                        onChange={e => {
                            const next = e.target.value;
                            patch(type, {
                                sourceId: next,
                                result: null,
                                sourceResults: {},
                                sourcePagesLoaded: {},
                                activeTab: 'all',
                                pagesLoaded: 0,
                            });
                        }}
                    >
                        {sources && sources.length > 1 && (
                            <option value="*">{i18n.t('vod:stalkerServerSearchAllSources')}</option>
                        )}
                        {(sources ?? []).map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </label>

                <label className="stalker-search-field">
                    <span>{i18n.t('vod:stalkerServerSearchCategory')}</span>
                    <select
                        value={isAllSources ? '*' : categoryId}
                        disabled={isAllSources}
                        onChange={e => patch(type, { categoryId: e.target.value, result: null, sourceResults: {}, sourcePagesLoaded: {}, activeTab: 'all', pagesLoaded: 0 })}
                    >
                        <option value="*">{i18n.t('common:all')}</option>
                        {!isAllSources && categories.map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                </label>

                <label className="stalker-search-field stalker-search-query">
                    <span>{i18n.t('vod:stalkerServerSearchQuery')}</span>
                    <input
                        type="text"
                        value={query}
                        onChange={e => patch(type, { query: e.target.value })}
                        placeholder={type === 'movies' ? i18n.t('vod:searchMovies') : i18n.t('vod:searchSeries')}
                        autoFocus
                    />
                </label>

                <button
                    type="submit"
                    className="stalker-search-go"
                    disabled={loading || !query.trim() || (isAllSources ? (sources ?? []).length === 0 : !source)}
                >
                    {loading ? progress ?? i18n.t('common:searching') : i18n.t('vod:editMetadataTmdbSearchBtn')}
                </button>
            </form>

            <div className="stalker-search-status">
                {error && <span className="stalker-search-error">{error}</span>}
                {!error && displayResult?.error && (
                    <span className="stalker-search-error">{displayResult.error}</span>
                )}
                {!error && !displayResult?.error && displayResult && unsupportedResult(displayResult) && (
                    <span className="stalker-search-warning">{i18n.t('vod:stalkerServerSearchUnsupported')}</span>
                )}
                {!error && !displayResult?.error && displayResult && !unsupportedResult(displayResult) && (
                    <>
                        {/* Only ever one count, and it is the rows the grid holds. Quoting the
                            provider's own total alongside it is what made this confusing: that
                            number counts every matching row, including the `is_series` entries a
                            movie list filters out, so it is an upper bound the grid can never
                            reach (61 against a real 49 on the portal this was measured on).
                            "More matches" says the same thing without a figure to reconcile. */}
                        <span>{i18n.t('common:resultsCount', { count: displayResult.shown })}</span>
                        {displayResult.hasMore && (
                            <span className="stalker-search-note">
                                {i18n.t('vod:stalkerServerSearchMoreOnServer')}
                            </span>
                        )}
                        {/* The words as typed matched nothing, so say which wider form answered:
                            the same words with anything between them (server-side), or just the
                            longest one with the rest applied here. */}
                        {displayResult.matchKind === 'all-words' && (
                            <span className="stalker-search-note">
                                {i18n.t('vod:stalkerServerSearchMatchingAllWords')}
                            </span>
                        )}
                        {displayResult.matchKind === 'word' && (
                            <span className="stalker-search-note">
                                {i18n.t('vod:stalkerServerSearchMatchingPhrase', { phrase: displayResult.phrase })}
                            </span>
                        )}
                        {displayResult.shown === 0 && (
                            <span className="stalker-search-note">
                                {i18n.t('vod:stalkerServerSearchNoMatches', { query: query.trim() })}
                            </span>
                        )}
                        {(tooManyToLoad || hitHardCap) && (
                            <span className="stalker-search-note">{i18n.t('vod:stalkerServerSearchTooMany')}</span>
                        )}
                    </>
                )}
            </div>

            {isAllSources && result && (sources ?? []).length > 1 && (
                <div className="stalker-search-tabs" role="tablist" aria-label={i18n.t('vod:stalkerServerSearchSource')}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={effectiveTab === 'all'}
                        className={`stalker-search-tab ${effectiveTab === 'all' ? 'active' : ''}`}
                        onClick={() => {
                            patch(type, { activeTab: 'all' });
                            if (scrollRef.current) scrollRef.current.scrollTop = 0;
                        }}
                    >
                        <span>{i18n.t('common:all')}</span>
                        <span className="stalker-search-tab-count">{result.shown}</span>
                    </button>
                    {(sources ?? []).map(s => {
                        const sRes = slice.sourceResults?.[s.id];
                        const hasError = !!sRes?.error;
                        const isUnsupported = !!sRes?.unsupported;
                        const count = sRes?.shown ?? 0;
                        const badgeClass = hasError ? 'error' : isUnsupported ? 'warning' : '';
                        const badgeText = hasError ? '!' : isUnsupported ? '—' : count;
                        const tooltip = hasError ? sRes.error : isUnsupported ? i18n.t('vod:stalkerServerSearchUnsupported') : undefined;
                        return (
                            <button
                                key={s.id}
                                type="button"
                                role="tab"
                                aria-selected={effectiveTab === s.id}
                                className={`stalker-search-tab ${effectiveTab === s.id ? 'active' : ''}`}
                                title={tooltip}
                                onClick={() => {
                                    patch(type, { activeTab: s.id });
                                    if (scrollRef.current) scrollRef.current.scrollTop = 0;
                                }}
                            >
                                <span>{s.name}</span>
                                <span className={`stalker-search-tab-count ${badgeClass}`}>
                                    {badgeText}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="stalker-search-results" ref={scrollRef}>
                {displayResult && !unsupportedResult(displayResult) && !displayResult.error && displayResult.rows.length > 0 && (
                    <VirtualGrid
                        items={displayResult.rows}
                        scrollRef={scrollRef}
                        minColumnWidth={150}
                        // The category line makes a card one line taller, and rows are sized
                        // from this number: see SEARCH_CATEGORY_LINE_PX.
                        estimateRowHeight={280 + SEARCH_CATEGORY_LINE_PX}
                        getKey={item => rowId(item)}
                        surface="stalker-server-search"
                        renderItem={(item, index) => (
                            <MediaCard
                                item={item}
                                type={type === 'movies' ? 'movie' : 'series'}
                                index={index}
                                onClick={onOpenItem}
                                size="medium"
                                sourceName={sourcesMap.get(item.source_id) ?? source?.name}
                                // The scoped category is preferred so a card agrees with the
                                // picker above it when the row is also in other categories.
                                categoryLabels={categoryLabelsFor(
                                    (item as StoredMovie).category_ids,
                                    categoryNames,
                                    categoryId === '*' ? null : categoryId
                                )}
                            />
                        )}
                    />
                )}
                {displayResult && unsupportedResult(displayResult) && (
                    <div className="stalker-search-empty">
                        <span className="stalker-search-warning">{i18n.t('vod:stalkerServerSearchUnsupported')}</span>
                    </div>
                )}
                {displayResult?.error && (
                    <div className="stalker-search-empty">
                        <span className="stalker-search-error">{displayResult.error}</span>
                    </div>
                )}
            </div>

            <div className="stalker-search-footer">
                {/* No count here on purpose: while pages remain the provider's total is an
                    over-count (it includes rows this list filters out), so naming it would
                    promise a number the results can never reach. */}
                {loadAllOfferable && (
                    <button className="stalker-search-more" onClick={loadAll} disabled={loading}>
                        {i18n.t('vod:stalkerServerSearchLoadAllResults')}
                    </button>
                )}
                {!!displayResult && displayResult.hasMore && !hitHardCap && (
                    <button className="stalker-search-more" onClick={showMore} disabled={loading}>
                        {i18n.t('vod:stalkerServerSearchMore')}
                    </button>
                )}
            </div>
        </div>
    );
}

export default StalkerServerSearchView;
