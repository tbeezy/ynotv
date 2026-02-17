/**
 * Shared constants for sync operations
 */

// TMDB Matching
export const TMDB_BATCH_SIZE = 500;
export const TMDB_24H_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// EPG Sync
export const EPG_YIELD_EVERY = 10000; // Yield to event loop every N programs
export const EPG_BATCH_SIZE = 5; // Fetch EPG for N channels at a time

// Sync Performance
export const CHANNEL_CHUNK_SIZE = 100; // Process channels in chunks for UI responsiveness
