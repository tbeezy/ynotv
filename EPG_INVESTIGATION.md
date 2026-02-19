# EPG Sync Investigation & Fixes

**Date:** February 2026  
**Status:** Fixes implemented, awaiting testing

---

## User-Reported Problem

### Symptoms
1. **Auto-refresh EPG not updating**: On app startup, the EPG sync runs (user sees "Updating EPG..." in status), but the EPG data doesn't actually update in the UI
2. **EPG cuts off after ~24 hours**: After a fresh manual sync, EPG shows properly. But the next day (after ~23 hours), only 1 hour of EPG remains visible, then blank
3. **Manual sync fixes it temporarily**: Going to Settings → Sources → Sync source manually restores EPG data
4. **Affects all source types**: Xtream, M3U, and Stalker portals all exhibit the same behavior
5. **Opening/closing app doesn't help**: User frequently opens/closes during testing, but EPG still shows stale

### User's Source Types
- **Mixed**: Xtream, M3U, and Stalker portals

---

## Investigation: How EPG Sync Works

### Entry Points for EPG Sync

| Trigger | Location | When |
|---------|----------|------|
| App Startup | `App.tsx:1018-1160` | When app loads and sources are stale |
| Manual Sync | `SourcesTab.tsx:462-488` | User clicks sync button per source |
| Clear Cache | `DataRefreshTab.tsx:30-48` | After clearing all cached data |

### NO Background Auto-Refresh
**Critical Finding**: There is **NO background interval-based EPG refresh**. The `epgRefreshHours` setting only controls the **staleness check on app startup**, not a background timer.

```typescript
// App.tsx:1064-1074 - Only runs ONCE on app load
const staleSources = [];
for (const source of enabledSources) {
  const stale = await isEpgStale(source.id, epgRefreshHours);
  if (stale) {
    staleSources.push(source);
  }
}
```

### EPG Data Flow

```
App Startup / Manual Sync
         │
         ▼
   isEpgStale() check
   (checks last_synced vs epgRefreshHours)
         │
         ▼
   syncSource() in sync.ts
         │
         ├─→ Xtream: syncEpgForSource()
         │       └─→ fetchXmltvFromUrls() → match channels → bulkOps.replacePrograms()
         │
         ├─→ M3U: syncEpgFromUrl()
         │       └─→ epgStreaming.streamParseEpg() → Rust streaming parser
         │
         └─→ Stalker: syncEpgForStalker()
                 └─→ client.getEpg(72) → bulkOps.replacePrograms()
```

### Database Storage

**Table:** `programs`
```sql
CREATE TABLE programs (
    id TEXT PRIMARY KEY,        -- ${stream_id}_${start_timestamp}
    stream_id TEXT,             -- Channel's stream_id (e.g., "sourceId_123")
    title TEXT,
    description TEXT,
    start TEXT,
    end TEXT,
    source_id TEXT
)
```

**Replace Strategy:**
- Xtream/Stalker: Uses `bulkOps.replacePrograms()` which **DELETES old programs first**, then inserts new
- M3U (Streaming): Was **ONLY INSERTING** (no delete!) - **BUG FOUND**

---

## Bugs Found

### Bug #1: Streaming EPG Parser Uses Wrong stream_id (CRITICAL - M3U Sources)

**File:** `packages/app/src-tauri/src/epg_streaming.rs:180-182, 356`

**Problem:**
```rust
// Line 180-182: Program matched, but pushed with ORIGINAL channel_id
if let Some(stream_id) = channel_map.get(&program.channel_id) {
    total_matched += 1;
    batch.push(program);  // BUG: pushes original program with channel_id="BBC1"
}

// Line 356: Uses wrong value
let stream_id = program.channel_id.clone(); // BUG: This is "BBC1", not "sourceId_123"!
```

**Impact:** Programs were stored with `stream_id = "BBC1"` (the EPG channel ID from XMLTV) instead of `stream_id = "sourceId_123"` (the actual channel stream_id). When the UI queries programs by channel `stream_id`, **no programs are found** because the stored `stream_id` doesn't match!

**Fix Applied:**
```rust
for (idx, mut program) in programs.into_iter().enumerate() {
    if let Some(stream_id) = channel_map.get(&program.channel_id) {
        total_matched += 1;
        // FIX: Replace EPG channel_id with actual stream_id for database storage
        program.channel_id = stream_id.clone();
        batch.push(program);
    }
}
```

---

### Bug #2: Streaming EPG Never Deletes Old Programs (M3U Sources)

**File:** `packages/app/src-tauri/src/epg_streaming.rs`

**Problem:** The streaming parser only did `INSERT OR IGNORE` - it never deleted old programs first. This caused:
- Stale/expired programs to remain in database forever
- Accumulation of duplicate/outdated EPG data
- No way to clear old "future" programs that are now in the past

**Fix Applied:** Added `delete_programs_for_source()` function called before inserting new programs:
```rust
// Delete old programs for this source FIRST (before parsing)
info!("[EPG] Deleting old programs for source {}", source_id);
let deleted_count = delete_programs_for_source(db, source_id)?;
info!("[EPG] Deleted {} old programs for source {}", deleted_count, source_id);
```

---

### Bug #3: EPG Channel ID Mismatch (Potential - All Sources)

**File:** `packages/local-adapter/src/xtream-client.ts:251`

```typescript
epg_channel_id: stream.epg_channel_id || '',
```

If the Xtream server doesn't provide `epg_channel_id` for channels, it's set to empty string and won't match any EPG data from the XMLTV.

**No fix applied yet** - Need to diagnose with new logging to see if this is actually happening.

---

## Fixes Implemented

### 1. Streaming EPG Parser (`epg_streaming.rs`)
- ✅ Replace `channel_id` with mapped `stream_id` before database insertion
- ✅ Delete old programs before inserting new ones
- ✅ Added detailed logging for diagnostics

### 2. EPG Sync Logging (`sync.ts`)
Added comprehensive logging to all EPG sync functions:

```typescript
console.log(`[EPG] Starting Xtream EPG sync for source: ${source.name}`);
console.log(`[EPG] Total channels: ${channels.length}`);
console.log(`[EPG] Channels with epg_channel_id: ${channelsWithEpgId}/${channels.length}`);
console.log(`[EPG] Sample channel EPG IDs:`, samples...);
console.log(`[EPG] Sample XMLTV channel IDs:`, xmltvSamples...);
console.log(`[EPG] Matched ${storedPrograms.length}/${xmltvPrograms.length} programs`);
console.log(`[EPG] Xtream EPG sync COMPLETE: ${result.inserted} inserted, ${result.deleted} deleted`);
```

---

## What to Check During Testing

### 1. Open DevTools Console (F12) During EPG Sync

Look for these log patterns:

**Good signs:**
```
[EPG] Channels with epg_channel_id: 450/500
[EPG] Matched 15000/20000 programs
[EPG] Xtream EPG sync COMPLETE: 15000 programs inserted, 14000 old programs deleted
```

**Warning signs:**
```
[EPG] Channels with epg_channel_id: 0/500
→ Your playlist doesn't have tvg-id attributes for channels

[EPG] Matched 0/20000 programs  
→ EPG channel IDs don't match channel tvg-id values
→ Check "Sample channel EPG IDs" vs "Sample XMLTV channel IDs"

[EPG] No programs found in XMLTV
→ EPG URL is empty or failing to download
```

### 2. Check Database Directly (if needed)

```sql
-- Count programs per source
SELECT source_id, COUNT(*) FROM programs GROUP BY source_id;

-- Check sample programs for a channel
SELECT * FROM programs WHERE stream_id LIKE 'sourceId_%' LIMIT 10;

-- Check if stream_id format looks correct (should be "sourceId_channelNum")
SELECT DISTINCT stream_id FROM programs LIMIT 20;
```

---

## Remaining Questions / Potential Issues

### 1. Why did manual sync "work" but auto-refresh didn't?

**Theory:** Both use the same `syncSource()` function, so they should behave identically. The new logging will help confirm whether:
- Programs are actually being inserted during auto-refresh
- The issue was the stream_id mismatch (Bug #1) making programs invisible to queries
- Or something else entirely

### 2. Stalker EPG Limited to 72 Hours

**File:** `packages/ui/src/db/sync.ts`
```typescript
const epgMap = await client.getEpg(72); // Only fetches 72 hours!
```

If Stalker portals only provide 72 hours of EPG data, users will see empty EPG after 3 days. This is a limitation of the Stalker API, not a bug.

### 3. EPG Refresh Hours Setting Confusion

The UI says "EPG (TV Guide): Every X hours" but this only affects **staleness checking on app startup**, not background polling. Users might expect it to refresh while the app is running.

**Potential future improvement:** Add actual background refresh while app is open.

---

## Files Modified

| File | Changes |
|------|---------|
| `packages/app/src-tauri/src/epg_streaming.rs` | Fixed stream_id mapping, added delete before insert, improved logging |
| `packages/ui/src/db/sync.ts` | Added comprehensive logging to syncEpgFromUrl, syncEpgForSource, syncEpgForStalker |

---

## Testing Checklist

- [ ] Open app, check console for EPG sync logs
- [ ] Verify "Channels with epg_channel_id" count is > 0
- [ ] Verify "Matched X/Y programs" shows matches
- [ ] Verify "X programs inserted, Y old programs deleted"
- [ ] Browse to a channel, check if EPG shows programs
- [ ] Wait for auto-refresh threshold (user's setting), verify stale sources trigger sync
- [ ] Check EPG still shows after 24+ hours

---

## Next Steps If Issues Persist

1. **Check EPG channel ID matching**: Compare "Sample channel EPG IDs" with "Sample XMLTV channel IDs" in logs
2. **Verify EPG URL is accessible**: Try opening the XMLTV URL in a browser
3. **Check for empty epg_channel_id**: If many channels show empty EPG IDs, the source may not provide them
4. **Consider background refresh**: If staleness checking on startup isn't enough, implement interval-based refresh
