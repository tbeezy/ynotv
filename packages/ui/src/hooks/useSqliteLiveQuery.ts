import { useEffect, useState, useRef, useCallback } from 'react';
import { dbEvents } from '../db/sqlite-adapter';

interface CacheEntry<T> {
    result: T;
    timestamp: number;
    depsKey: string;
}

// Global cache for live query results
const queryCache = new Map<string, CacheEntry<any>>();

// Mimics useLiveQuery from dexie-react-hooks with optional staleTime
export function useLiveQuery<T>(
    querier: () => Promise<T> | T, 
    deps: any[] = [], 
    defaultResult?: T,
    staleTime: number = 0 // Time in milliseconds to consider data fresh (0 = no caching)
): T | undefined {
    const [result, setResult] = useState<T | undefined>(defaultResult);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingUpdateRef = useRef(false);
    const hasRunInitialQuery = useRef(false);

    // Generate cache key from querier function and deps
    const getCacheKey = useCallback(() => {
        const depsKey = JSON.stringify(deps);
        return `${querier.toString().slice(0, 100)}_${depsKey}`;
    }, [deps, querier]);

    useEffect(() => {
        let isMounted = true;
        const cacheKey = getCacheKey();

        const runQuery = async () => {
            try {
                const res = querier();
                let val: T;
                if (res instanceof Promise) {
                    val = await res;
                } else {
                    val = res;
                }
                
                if (isMounted) {
                    setResult(val);
                    
                    // Update cache
                    if (staleTime > 0) {
                        queryCache.set(cacheKey, {
                            result: val,
                            timestamp: Date.now(),
                            depsKey: JSON.stringify(deps)
                        });
                    }
                }
            } catch (err) {
                console.error('useLiveQuery error:', err);
                // Don't update result on error, keep previous value
            }
        };

        // Always run on first mount or when deps change
        if (!hasRunInitialQuery.current) {
            hasRunInitialQuery.current = true;
            
            // Check cache first if staleTime is set
            if (staleTime > 0) {
                const cached = queryCache.get(cacheKey);
                if (cached && (Date.now() - cached.timestamp) < staleTime) {
                    // Use cached result immediately
                    setResult(cached.result);
                    // Don't run query - cache is fresh
                    return () => {
                        isMounted = false;
                        if (debounceTimerRef.current) {
                            clearTimeout(debounceTimerRef.current);
                        }
                    };
                }
            }
            
            runQuery();
        } else {
            // Deps changed - always re-run
            runQuery();
        }

        // Debounced update function for DB changes
        const debouncedUpdate = () => {
            pendingUpdateRef.current = true;

            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }

            debounceTimerRef.current = setTimeout(() => {
                if (pendingUpdateRef.current && isMounted) {
                    pendingUpdateRef.current = false;
                    // Always run query on DB events - staleTime only applies to init/deps changes
                    // Database changes should always refresh the UI
                    runQuery();
                }
            }, 50); // 50ms debounce - batch rapid DB events
        };

        const unsubscribe = dbEvents.subscribe((event) => {
            debouncedUpdate();
        });

        return () => {
            isMounted = false;
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
            unsubscribe();
        };
    }, deps);

    return result;
}

// Clear the cache (useful when switching users, clearing data, etc.)
export function clearLiveQueryCache(): void {
    queryCache.clear();
}
