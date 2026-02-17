/**
 * LRU (Least Recently Used) Cache with size limits
 * Prevents unbounded memory growth
 */

export interface LRUCacheOptions {
  maxSize: number;
  maxAge?: number; // Optional TTL in ms
}

export class LRUCache<K, V> {
  private cache = new Map<K, { value: V; timestamp: number }>();
  private maxSize: number;
  private maxAge?: number;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.maxAge = options.maxAge;
  }

  /**
   * Get a value from cache
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (this.maxAge && Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Set a value in cache
   */
  set(key: K, value: V): void {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    while (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  /**
   * Check if key exists and hasn't expired
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (this.maxAge && Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete a specific key
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get all keys (for iteration)
   */
  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  /**
   * Get all entries (for iteration)
   */
  entries(): IterableIterator<[K, V]> {
    const result: [K, V][] = [];
    for (const [key, entry] of this.cache) {
      if (!this.maxAge || Date.now() - entry.timestamp <= this.maxAge) {
        result.push([key, entry.value]);
      }
    }
    return result[Symbol.iterator]();
  }

  /**
   * Execute a function for each entry
   */
  forEach(callback: (value: V, key: K) => void): void {
    for (const [key, entry] of this.cache) {
      if (!this.maxAge || Date.now() - entry.timestamp <= this.maxAge) {
        callback(entry.value, key);
      }
    }
  }
}
