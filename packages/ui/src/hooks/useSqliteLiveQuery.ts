import { useEffect, useState, useRef } from 'react';
import { dbEvents } from '../db/sqlite-adapter';

// Mimics useLiveQuery from dexie-react-hooks
export function useLiveQuery<T>(querier: () => Promise<T> | T, deps: any[] = [], defaultResult?: T): T | undefined {
    const [result, setResult] = useState<T | undefined>(defaultResult);
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingUpdateRef = useRef(false);

    useEffect(() => {
        let isMounted = true;

        const runQuery = async () => {
            try {
                const res = querier();
                if (res instanceof Promise) {
                    const val = await res;
                    if (isMounted) setResult(val);
                } else {
                    if (isMounted) setResult(res);
                }
            } catch (err) {
                console.error('useLiveQuery error:', err);
            }
        };

        // Initial run
        runQuery();

        // Debounced update function
        const debouncedUpdate = () => {
            pendingUpdateRef.current = true;

            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }

            debounceTimerRef.current = setTimeout(() => {
                if (pendingUpdateRef.current && isMounted) {
                    pendingUpdateRef.current = false;
                    runQuery();
                }
            }, 50); // 50ms debounce - faster UI updates
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
