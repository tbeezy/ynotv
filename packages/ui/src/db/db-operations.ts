/**
 * Database Operations
 * 
 * Direct database operations for fallback when Web Workers aren't available
 */

import { db } from './index';

export async function bulkAddToTable(table: string, items: any[]) {
  switch (table) {
    case 'channels':
      return db.channels.bulkAdd(items);
    case 'categories':
      return db.categories.bulkAdd(items);
    case 'programs':
      return db.programs.bulkAdd(items);
    case 'vodMovies':
      return db.vodMovies.bulkAdd(items);
    case 'vodSeries':
      return db.vodSeries.bulkAdd(items);
    case 'vodEpisodes':
      return db.vodEpisodes.bulkAdd(items);
    default:
      throw new Error(`Unknown table: ${table}`);
  }
}

export async function bulkPutToTable(table: string, items: any[]) {
  switch (table) {
    case 'channels':
      return db.channels.bulkPut(items);
    case 'categories':
      return db.categories.bulkPut(items);
    case 'programs':
      return db.programs.bulkPut(items);
    case 'vodMovies':
      return db.vodMovies.bulkPut(items);
    case 'vodSeries':
      return db.vodSeries.bulkPut(items);
    case 'vodEpisodes':
      return db.vodEpisodes.bulkPut(items);
    default:
      throw new Error(`Unknown table: ${table}`);
  }
}

export async function bulkDeleteFromTable(table: string, keys: any[]) {
  switch (table) {
    case 'channels':
      return db.channels.bulkDelete(keys);
    case 'categories':
      return db.categories.bulkDelete(keys);
    case 'programs':
      return db.programs.bulkDelete(keys);
    case 'vodMovies':
      return db.vodMovies.bulkDelete(keys);
    case 'vodSeries':
      return db.vodSeries.bulkDelete(keys);
    case 'vodEpisodes':
      return db.vodEpisodes.bulkDelete(keys);
    default:
      throw new Error(`Unknown table: ${table}`);
  }
}

export async function rawQuery(sql: string, params?: any[]) {
  const dbInstance = await (db as any).dbPromise;
  return dbInstance.select(sql, params || []);
}
