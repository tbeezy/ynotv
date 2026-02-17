/**
 * Database Worker
 * 
 * Offloads heavy database operations from the main thread
 * Uses postMessage to communicate with the main thread
 */

import { db, type StoredChannel, type StoredCategory, type StoredProgram } from '../db';

// Worker message types
interface WorkerMessage {
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

// Handle messages from main thread
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { id, type, payload } = event.data;
  
  try {
    let result: any;
    
    switch (type) {
      case 'bulkInsert':
        result = await handleBulkInsert(payload);
        break;
      case 'bulkUpdate':
        result = await handleBulkUpdate(payload);
        break;
      case 'bulkDelete':
        result = await handleBulkDelete(payload);
        break;
      case 'query':
        result = await handleQuery(payload);
        break;
      default:
        throw new Error(`Unknown worker message type: ${type}`);
    }
    
    const response: WorkerResponse = {
      id,
      success: true,
      data: result,
    };
    
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
    
    self.postMessage(response);
  }
};

async function handleBulkInsert(payload: { table: string; items: any[] }) {
  const { table, items } = payload;
  
  switch (table) {
    case 'channels':
      await db.channels.bulkAdd(items);
      break;
    case 'categories':
      await db.categories.bulkAdd(items);
      break;
    case 'programs':
      await db.programs.bulkAdd(items);
      break;
    case 'vodMovies':
      await db.vodMovies.bulkAdd(items);
      break;
    case 'vodSeries':
      await db.vodSeries.bulkAdd(items);
      break;
    case 'vodEpisodes':
      await db.vodEpisodes.bulkAdd(items);
      break;
    default:
      throw new Error(`Unknown table: ${table}`);
  }
  
  return { inserted: items.length };
}

async function handleBulkUpdate(payload: { table: string; items: any[] }) {
  const { table, items } = payload;
  
  switch (table) {
    case 'channels':
      await db.channels.bulkPut(items);
      break;
    case 'categories':
      await db.categories.bulkPut(items);
      break;
    case 'programs':
      await db.programs.bulkPut(items);
      break;
    case 'vodMovies':
      await db.vodMovies.bulkPut(items);
      break;
    case 'vodSeries':
      await db.vodSeries.bulkPut(items);
      break;
    case 'vodEpisodes':
      await db.vodEpisodes.bulkPut(items);
      break;
    default:
      throw new Error(`Unknown table: ${table}`);
  }
  
  return { updated: items.length };
}

async function handleBulkDelete(payload: { table: string; keys: any[] }) {
  const { table, keys } = payload;
  
  switch (table) {
    case 'channels':
      await db.channels.bulkDelete(keys);
      break;
    case 'categories':
      await db.categories.bulkDelete(keys);
      break;
    case 'programs':
      await db.programs.bulkDelete(keys);
      break;
    case 'vodMovies':
      await db.vodMovies.bulkDelete(keys);
      break;
    case 'vodSeries':
      await db.vodSeries.bulkDelete(keys);
      break;
    case 'vodEpisodes':
      await db.vodEpisodes.bulkDelete(keys);
      break;
    default:
      throw new Error(`Unknown table: ${table}`);
  }
  
  return { deleted: keys.length };
}

async function handleQuery(payload: { sql: string; params?: any[] }) {
  const dbInstance = await (db as any).dbPromise;
  const result = await dbInstance.select(payload.sql, payload.params || []);
  return result;
}

export {};
