# ynoTV Sync System Documentation

## Overview

The sync system handles fetching and synchronizing IPTV data from various sources (M3U playlists, Xtream Codes, Stalker portals) and managing the local SQLite database.

**Key File:** `packages/ui/src/db/sync.ts` (1,666 lines)

## Architecture

### High-Level Flow

```
syncSource() / syncVodForSource()
    ├── fetchSourceData()          // Get data from remote
    ├── prepareIncrementalSync()   // Load existing state
    ├── persistSyncResults()       // Save to database
    └── syncEpg*()                 // Optional: Fetch EPG data
```

### Core Principles

1. **Incremental Sync**: Preserves user settings (favorites, enabled categories) during re-syncs
2. **Race Condition Prevention**: `deletedSourceIds` set prevents writes after source deletion
3. **Concurrent Operation Tracking**: Reference counting for TMDB matching operations
4. **UI Responsiveness**: All heavy operations yield to event loop periodically

## Function Reference

### Main Entry Points

#### `syncSource(source, onProgress?)`
**Purpose:** Main entry point for syncing live TV channels
**Location:** Line 629
**Returns:** `Promise<SyncResult>`

```typescript
interface SyncResult {
  success: boolean;
  channelCount: number;
  categoryCount: number;
  programCount: number;
  epgUrl?: string;
  error?: string;
}
```

**Phases:**
1. Fetch existing data for incremental sync
2. Connect to source and fetch channels/categories
3. Clear old data (preserving user settings)
4. Insert new data
5. Sync EPG if available
6. Update source metadata

**Important:** Uses `deletedSourceIds` to prevent race conditions

---

#### `syncVodForSource(source)`
**Purpose:** Sync VOD (movies and series) for a source
**Location:** Line 1577
**Returns:** `Promise<VodSyncResult>`

```typescript
interface VodSyncResult {
  success: boolean;
  movieCount: number;
  seriesCount: number;
  movieCategoryCount: number;
  seriesCategoryCount: number;
  error?: string;
}
```

**Flow:**
1. Calls `syncVodMovies()` - Fetches and stores movies
2. Calls `syncVodSeries()` - Fetches and stores series
3. Triggers TMDB matching in background (non-blocking)
4. Updates source metadata with counts

---

### EPG Functions

#### `syncEpgForSource(source, channels)`
**Purpose:** Sync EPG for any source type
**Location:** Line 438
**Returns:** `Promise<number>` (program count)

**Behavior:**
- Routes to specialized function based on source type
- Checks freshness before fetching (24h default)
- Supports multiple EPG URLs (comma-separated)

---

#### `syncEpgFromUrl(source, epgUrl, channels)`
**Purpose:** Fetch and parse EPG from a specific URL
**Location:** Line 356
**Returns:** `Promise<number>`

**Important Details:**
- Fetches XMLTV data via Tauri HTTP plugin
- Decompresses gzip if needed
- Parses in worker thread to avoid blocking UI
- Matches programs to channels by name or ID
- Compresses descriptions to save space
- Uses bulk insert for performance

---

#### `syncEpgForStalker(source, channels)`
**Purpose:** Stalker portal EPG sync (different API)
**Location:** Line 519
**Returns:** `Promise<number>`

---

### VOD Sync Functions

#### `syncVodMovies(source)`
**Purpose:** Sync movie library from source
**Location:** Line 1146
**Returns:** `Promise<{ count, categoryCount, skipped? }>`

**Flow:**
1. Check if sync needed (24h freshness check)
2. Fetch movies from adapter (Xtream/Stalker)
3. Preserve existing enrichments (TMDB matches)
4. Sanitize and insert in bulk
5. Remove movies no longer in source
6. Sync movie categories

**Key Pattern:** Uses field whitelist in `sanitizeMovie()`

---

#### `syncVodSeries(source)`
**Purpose:** Sync series library from source
**Location:** Line 1262
**Returns:** `Promise<{ count, categoryCount, skipped? }>`

**Important:** Does NOT fetch episodes (lazy loaded on demand)

---

#### `syncSeriesEpisodes(source, seriesId)`
**Purpose:** Fetch episodes for a specific series (called when user opens series)
**Location:** Line 1374
**Returns:** `Promise<number>` (episode count)

**Behavior:**
- Called on-demand from UI when viewing series detail
- Fetches from Xtream/Stalker API
- Clears old episodes first (atomic transaction)
- Stores with series_id reference

---

#### `syncStalkerCategory(sourceId, categoryId, type, onProgress?)`
**Purpose:** Lazy-load Stalker category (movies/series)
**Location:** Line 1015
**Returns:** `Promise<number>`

**Use Case:** Stalker portals return empty category lists initially. This fetches content when user clicks a category.

---

### TMDB Matching Functions

#### `matchMoviesWithTmdb(sourceId, force?)`
**Purpose:** Match movies against TMDB exports
**Location:** Line 1551
**Returns:** `Promise<number>` (match count)

**Important:**
- Only matches items not yet attempted (incremental)
- Uses enriched exports with year data for accuracy
- Updates `match_attempted` timestamp on all items
- Runs in background (doesn't block sync completion)
- Uses `startTmdbMatching()` / `endTmdbMatching()` for UI state

**Batch Size:** 500 movies per batch
**Yield:** Every batch yields to event loop

---

#### `matchSeriesWithTmdb(sourceId, force?)`
**Purpose:** Match series against TMDB exports
**Location:** Line 1564
**Returns:** `Promise<number>`

**Same patterns as movie matching**

---

#### `matchVodWithTmdb<T>(items, exports, type)`
**Purpose:** Generic matcher for both movies and series
**Location:** Line 1432
**Returns:** `Promise<number>`

**Internal use only** - Called by specialized functions above

---

### Helper Functions

#### `sanitizeMovie(movie, existingMovie?)`
**Purpose:** Clean and validate movie data before storage
**Location:** Line 93
**Returns:** `any` (cleaned movie object)

**Field Whitelist:** `VOD_MOVIE_FIELDS` (line 78)
**Important:**
- Maps `title` → `name` if needed
- Converts arrays to strings (category_ids, genre)
- Preserves existing enrichments (TMDB data)
- Sets defaults for missing fields

**Common Issue:** If URL missing, check whitelist includes `direct_url`

---

#### `isEpgStale(sourceId, refreshHours?)`
**Purpose:** Check if EPG needs refresh
**Location:** Line 598
**Returns:** `Promise<boolean>`

**Default:** 6 hours

---

#### `isVodStale(sourceId, refreshHours?)`
**Purpose:** Check if VOD needs refresh
**Location:** Line 611
**Returns:** `Promise<boolean>`

**Default:** 24 hours

---

#### `markSourceDeleted(sourceId)`
**Purpose:** Prevent race condition when deleting source during sync
**Location:** Line 46

**Use Case:** If user deletes source while sync is running, ongoing sync will detect this and skip writing results.

---

## Data Flow Examples

### Live TV Sync (Xtream)

```
syncSource(source)
  ├─> Load existing categories/channels (for incremental)
  ├─> new XtreamClient()
  ├─> client.testConnection()
  ├─> client.getUserInfo()      // Expiry, connections
  ├─> client.getLiveCategories()
  ├─> client.getLiveStreams()
  ├─> clearSourceData()         // Clear old, preserve settings
  ├─> db.categories.bulkPut()   // Insert categories
  ├─> db.channels.bulkPut()     // Insert channels
  ├─> syncEpgForSource()        // Optional EPG sync
  └─> Update sourcesMeta        // Timestamps, counts
```

### VOD Sync (Xtream)

```
syncVodForSource(source)
  ├─> syncVodMovies(source)
  │   ├─> client.getVodCategories()
  │   ├─> client.getVodStreams()
  │   ├─> Load existing movies (preserve enrichments)
  │   ├─> movies.map(sanitizeMovie)
  │   ├─> db.vodMovies.bulkPut()
  │   └─> db.vodCategories.bulkPut()
  ├─> syncVodSeries(source)     // Similar flow
  ├─> matchMoviesWithTmdb()     // Background TMDB matching
  ├─> matchSeriesWithTmdb()
  └─> Update sourcesMeta
```

### Series Episode Loading (On-Demand)

```
User clicks series → syncSeriesEpisodes(source, seriesId)
  ├─> client.getSeriesInfo(seriesId)
  ├─> Flatten episodes from seasons array
  ├─> db.transaction()
  │   ├─> db.vodEpisodes.where('series_id').delete()
  │   └─> db.vodEpisodes.bulkPut(episodes)
  └─> Return episode count
```

## Database Schema Integration

### Tables Used

- **`channels`** - Live TV channels
- **`categories`** - Channel categories
- **`programs`** - EPG program data
- **`sourcesMeta`** - Sync timestamps and counts
- **`vodMovies`** - VOD movie library
- **`vodSeries`** - TV series library
- **`vodEpisodes`** - Series episodes
- **`vodCategories`** - VOD categories

### Key Fields

**Channels:**
- `stream_id` (PK), `source_id`, `category_ids`, `name`, `direct_url`
- `is_favorite`, `tmdb_id`, `match_attempted`

**Movies:**
- `stream_id` (PK), `direct_url`, `tmdb_id`, `popularity`
- `backdrop_path`, `imdb_id`, `match_attempted`

**Episodes:**
- `id` (PK), `series_id`, `season_num`, `episode_num`
- `direct_url`, `plot`, `duration`

## Common Patterns

### 1. Incremental Sync Pattern

```typescript
// 1. Load existing data
const existing = await db.table.where('source_id').equals(id).toArray();
const existingMap = new Map(existing.map(e => [e.id, e]));

// 2. Process new data
const toInsert = newData.map(item => ({
  ...item,
  // Preserve user settings from existing
  is_favorite: existingMap.get(item.id)?.is_favorite ?? false,
  enabled: existingMap.get(item.id)?.enabled ?? true,
}));

// 3. Clear old data
await db.table.where('source_id').equals(id).delete();

// 4. Insert new
await db.table.bulkPut(toInsert);
```

### 2. Race Condition Prevention

```typescript
// Before writing, check if source was deleted
if (isSourceDeleted(sourceId)) {
  console.log('Source deleted during operation, skipping write');
  return;
}
```

### 3. UI Responsiveness

```typescript
// Yield every N iterations
for (let i = 0; i < items.length; i++) {
  process(items[i]);
  
  if (i % 1000 === 0) {
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}
```

### 4. Batch Operations

```typescript
const BATCH_SIZE = 500;

for (let i = 0; i < items.length; i += BATCH_SIZE) {
  const batch = items.slice(i, i + BATCH_SIZE);
  await db.table.bulkPut(batch);
  
  // Report progress
  onProgress?.(`${i + batch.length}/${items.length}`);
  
  // Yield to event loop
  await new Promise(resolve => requestAnimationFrame(resolve));
}
```

## Testing Guidelines

### Unit Test Patterns

```typescript
// Test incremental sync preserves favorites
const source = { id: 'test', type: 'm3u', url: '...' };

// 1. Initial sync
await syncSource(source);
const channel = await db.channels.get('test_1');
await db.channels.update('test_1', { is_favorite: true });

// 2. Re-sync
await syncSource(source);
const reloaded = await db.channels.get('test_1');

// 3. Assert favorite preserved
expect(reloaded.is_favorite).toBe(true);
```

### Integration Test Patterns

```typescript
// Test full VOD sync flow
const result = await syncVodForSource(xtreamSource);

expect(result.success).toBe(true);
expect(result.movieCount).toBeGreaterThan(0);

// Verify movies have URLs
const movies = await db.vodMovies.where('source_id').equals(id).toArray();
movies.forEach(m => {
  expect(m.direct_url).toBeTruthy();
});
```

## Common Issues & Solutions

### Issue: "URL is null" for VOD

**Cause:** Field whitelist in `sanitizeMovie()` missing `direct_url`

**Fix:**
```typescript
const VOD_MOVIE_FIELDS = [
  // ... other fields
  'direct_url',  // Must be included!
];
```

---

### Issue: "table X has no column named Y"

**Cause:** TypeScript interface has field but database schema doesn't

**Fix:**
1. Update schema in `packages/ui/src/db/index.ts`
2. Add migration in `initializeDatabase()`
3. Clear app data or handle migration

---

### Issue: Sync freezes UI

**Cause:** Long-running loop without yielding

**Fix:** Add `await new Promise(resolve => requestAnimationFrame(resolve))` every 100-1000 iterations

---

### Issue: TMDB matching doesn't run

**Cause:**
1. Less than 24h since last run (freshness check)
2. `tmdbMatchingEnabled` setting is false
3. All items already have `match_attempted` timestamp

**Debug:** Add logging in `matchMoviesWithTmdb()` to see why it returns early

---

### Issue: Race condition - deleted source reappears

**Cause:** Sync completes after source deletion

**Fix:** Already handled via `markSourceDeleted()` / `isSourceDeleted()` - ensure all writes check this

---

## Adding New Features

### Adding New Source Type

1. Create adapter in `packages/local-adapter/src/`
2. Add type check in `syncSource()`:
```typescript
else if (source.type === 'newtype') {
  const client = new NewClient(...);
  // Fetch categories, channels
}
```
3. Handle EPG in `syncEpgForSource()` if applicable

### Adding New Field to Sync

1. **Add to TypeScript interface** in `packages/core/src/types.ts`
2. **Add to database schema** in `packages/ui/src/db/index.ts`
3. **Add to field whitelist** in `sync.ts` (VOD_MOVIE_FIELDS, etc.)
4. **Add migration** if existing databases need it
5. **Update adapter** to fetch the field

### Adding Background Task

Pattern:
```typescript
// Start tracking
useUIStore.getState().setSomeOperation(true);

try {
  await doBackgroundWork();
} finally {
  // Always reset state
  useUIStore.getState().setSomeOperation(false);
}
```

## External Dependencies

### Adapters (`@sbtltv/local-adapter`)
- `XtreamClient` - Xtream Codes API
- `StalkerClient` - Stalker/MAC portal API
- `fetchAndParseM3U` - M3U playlist parser

### Services (`../services/`)
- `tmdb-exports` - TMDB matching exports
- `tauri-bridge` - Native bridge for Electron/Tauri

### Database (`./index`)
- `db` - Main database instance
- Type definitions: `StoredMovie`, `StoredSeries`, etc.

## File Organization

```
packages/ui/src/db/
├── index.ts           # Database setup, schema, migrations
├── sync.ts            # Main sync logic (THIS FILE)
├── sqlite-adapter.ts  # Dexie-like adapter for SQLite
├── db-operations.ts   # Bulk operations (worker bridge)
└── utils/
    └── lru-cache.ts   # LRU cache utility
```

## Performance Considerations

1. **Batch Size:** 500 items is optimal for bulk operations
2. **Worker Threads:** EPG parsing happens in worker to avoid blocking
3. **Incremental Sync:** Only fetches unmatched TMDB items
4. **Lazy Loading:** Series episodes loaded on-demand
5. **Compression:** EPG descriptions compressed to save space

## Concurrency Model

- **Single sync per source** at a time (enforced by UI)
- **Multiple TMDB matches** can run concurrently (reference counting)
- **EPG + Channel sync** can happen in parallel
- **VOD + Live sync** are separate operations

---

## Quick Reference: Adding Debug Logging

```typescript
import { useUIStore } from '../stores/uiStore';

// In any sync function:
debugLog(`Starting operation for ${sourceId}`, 'sync');

// To show in UI:
useUIStore.getState().setSyncStatus(`Syncing ${source.name}...`);

// Timing:
console.time('operation-name');
await doWork();
console.timeEnd('operation-name');
```

---

## Version History

- **v1.0** - Initial implementation (monolithic)
- **v2.0** - Refactored into smaller functions
- **v2.1** - Added race condition prevention
- **v2.2** - Added TMDB matching
- **v2.3** - Added Stalker portal support
- **v2.4** - Fixed schema mismatches, added LRU cache

---

**Last Updated:** 2026-02-13
**Maintainer:** Claude Code
**Next Review:** When adding new source types or major schema changes
