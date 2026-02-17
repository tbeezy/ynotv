/**
 * Database Worker Hook
 * 
 * Provides an easy-to-use interface for offloading database operations to a Web Worker
 * Automatically falls back to main thread if workers aren't supported
 */

import { useCallback, useRef, useEffect } from 'react';

interface WorkerRequest {
  id: string;
  type: 'bulkInsert' | 'bulkUpdate' | 'bulkDelete' | 'query';
  payload: any;
}

interface WorkerResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

export function useDbWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  const idCounterRef = useRef(0);

  // Initialize worker
  useEffect(() => {
    // Check if workers are supported
    if (typeof Worker === 'undefined') {
      console.warn('[DbWorker] Web Workers not supported, will use main thread');
      return;
    }

    try {
      // Create worker
      const worker = new Worker(new URL('../workers/db.worker.ts', import.meta.url), {
        type: 'module',
      });

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const { id, success, data, error } = event.data;
        const pending = pendingRequestsRef.current.get(id);
        
        if (pending) {
          pendingRequestsRef.current.delete(id);
          if (success) {
            pending.resolve(data);
          } else {
            pending.reject(new Error(error || 'Worker operation failed'));
          }
        }
      };

      worker.onerror = (error) => {
        console.error('[DbWorker] Worker error:', error);
      };

      workerRef.current = worker;
    } catch (error) {
      console.warn('[DbWorker] Failed to initialize worker:', error);
    }

    // Cleanup
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Send message to worker
  const sendMessage = useCallback(<T>(type: WorkerRequest['type'], payload: any): Promise<T> => {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${++idCounterRef.current}`;
      
      // Store pending request
      pendingRequestsRef.current.set(id, { resolve, reject });
      
      // Send to worker if available
      if (workerRef.current) {
        workerRef.current.postMessage({
          id,
          type,
          payload,
        } as WorkerRequest);
      } else {
        // Fallback to main thread - reject to indicate worker not available
        pendingRequestsRef.current.delete(id);
        reject(new Error('Worker not available'));
      }
    });
  }, []);

  // Bulk insert operation
  const bulkInsert = useCallback(async (table: string, items: any[]) => {
    try {
      return await sendMessage('bulkInsert', { table, items });
    } catch (error) {
      // Fallback to main thread
      console.log('[DbWorker] Falling back to main thread for bulkInsert');
      const { bulkAddToTable } = await import('../db/db-operations');
      return bulkAddToTable(table, items);
    }
  }, [sendMessage]);

  // Bulk update operation
  const bulkUpdate = useCallback(async (table: string, items: any[]) => {
    try {
      return await sendMessage('bulkUpdate', { table, items });
    } catch (error) {
      // Fallback to main thread
      console.log('[DbWorker] Falling back to main thread for bulkUpdate');
      const { bulkPutToTable } = await import('../db/db-operations');
      return bulkPutToTable(table, items);
    }
  }, [sendMessage]);

  // Bulk delete operation
  const bulkDelete = useCallback(async (table: string, keys: any[]) => {
    try {
      return await sendMessage('bulkDelete', { table, keys });
    } catch (error) {
      // Fallback to main thread
      console.log('[DbWorker] Falling back to main thread for bulkDelete');
      const { bulkDeleteFromTable } = await import('../db/db-operations');
      return bulkDeleteFromTable(table, keys);
    }
  }, [sendMessage]);

  // Raw SQL query
  const query = useCallback(async (sql: string, params?: any[]) => {
    try {
      return await sendMessage('query', { sql, params });
    } catch (error) {
      // Fallback to main thread
      console.log('[DbWorker] Falling back to main thread for query');
      const { rawQuery } = await import('../db/db-operations');
      return rawQuery(sql, params);
    }
  }, [sendMessage]);

  return {
    bulkInsert,
    bulkUpdate,
    bulkDelete,
    query,
    isWorkerAvailable: !!workerRef.current,
  };
}
