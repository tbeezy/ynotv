/**
 * Database helper utilities for normalizing SQLite values
 * and other common database operations
 */

/**
 * Normalize boolean values from SQLite (0/1) to true/false
 * SQLite stores booleans as integers, but TypeScript types expect booleans
 * 
 * @param value - The value from SQLite (0, 1, boolean, or undefined)
 * @returns Normalized boolean value
 */
export function normalizeBoolean(value: boolean | number | undefined | null): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  return value === 1;
}

/**
 * Check if a value represents "truthy" in SQLite terms
 * Useful for filtering or conditional logic
 * 
 * @param value - The value to check
 * @returns true if the value is truthy (1 or true)
 */
export function isTruthy(value: boolean | number | undefined | null): boolean {
  return normalizeBoolean(value);
}

/**
 * Convert a boolean to SQLite integer (1/0)
 * Use when inserting/updating boolean values
 * 
 * @param value - The boolean value
 * @returns 1 for true, 0 for false
 */
export function toSQLiteBoolean(value: boolean): number {
  return value ? 1 : 0;
}
