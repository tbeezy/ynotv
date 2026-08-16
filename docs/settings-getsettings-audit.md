# Audit: direct `window.storage.getSettings()` call sites

Status: **audit complete + Tier 1 converted + subtitleSettings migrated** (see
update below). Companion to `docs/settings-store-migration.md` (Phases 0–6
landed; the settings store is the single source of truth).

## Why this matters

Every `window.storage.getSettings()` is an **async IPC round-trip** through the
serialized plugin-store. ~100 of them fire across the app — on mount, on every
modal open, and inside playback/search/sync hot paths. Each one:
- pays a queued store read (they serialize behind each other — the same
  bottleneck the migration removed from settings loading),
- is **stale-prone** (it snapshots at call time; a setting changed moments
  earlier in the same session may not have landed),
- forces the caller to handle `undefined data`, `.catch`, and defaulting —
  the store already owns all of that.

The store exposes `useSettingsStore.getState()` for non-React code and
`useSettingsStore(s => s.field)` for React components — both synchronous and
kept current by the setters + single boot hydration.

## The rule

A call site can be converted **iff the setting(s) it reads are fields of the
settings store** (they were migrated in Phase 1–4). Anything the store does not
hold must keep the direct read until the field is added to the store — reading
the store for a missing field would silently return the store default.

Store fields confirmed present: `maxSearchResults`, `categorySortOrder`,
`catchupStartPadding/EndPadding`, `catchupContinuePlaying`,
`includeSourceInSearch`, `globalLiveTvUserAgent`, `externalPlayerPath/Reuse/Args`,
`popoutAlwaysOnTop/StopMain/MpvParams/MpvParamsEnabled`,
`failoverGroupShowSource`, `channelInfoOverlay*`, `hideDisabledSources`,
`useAdvancedSearchForRegular`, `advancedSearch*`, `subtitleSettings` (+ setter),
`theme`, `language`, etc. (the full Phase 1–6 surface).

Not in the store (verified): `channelAudioDelays`, `streamMaxRetries`, `streamWatchdogSeconds`,
`globalEpgLinks`, `trailerSource`, `trailerPlayerMode`, `downloadsPath`,
`autoBackup*`, `trakt*` / `simkl*`, `tmdbApiKey`, `posterDbApiKey`,
`rpdbBackdropsEnabled`, `vodRefreshHours`, `epgRefreshHours`,
`epgSyncConcurrency`, `socks5Proxy*`, `allowLanSources`, `streamingCatalogsEnabled`,
`enabledStreamingServices`, `collapseSourceCategoriesOnStartup`,
`showAllChannels/ShowFavorites/ShowWatchlist/ShowRecentlyViewed`,
`tvCalendarAutoSync`, `streamingNuvioCatalogsEnabled`, `epgView` (lives in
`uiStore`), `modernUiEnabled`/`v3DefaultMigrated`/`uiScale` (nav/ui concern).

---

## Tier 1 — convert now (reads only store fields)

Low-risk: replace the `getSettings()` await with `useSettingsStore.getState()`
(services) or a selector (components). No freshness regression — the store is
the writer in this session.

| File | Reads | Verdict |
|---|---|---|
| `components/AdvancedSearchModal.tsx` | `categorySortOrder` | ✅ converted → selector |
| `components/ChannelSelectorModal.tsx` | `maxSearchResults` | ✅ converted → selector |
| `components/CustomGroupManager.tsx` | `maxSearchResults` | ✅ converted → selector |
| `components/FailoverGroupManager.tsx` | `maxSearchResults` | ✅ converted → selector |
| `components/ProgramContextMenu.tsx` | `catchupStartPadding`, `catchupEndPadding` | ✅ converted → selector |
| `components/MultiviewCell/*.tsx` | `includeSourceInSearch` | ✅ converted → selector |
| `App.tsx` (2442, 2487) | `externalPlayerPath/Reuse/Args` | ✅ converted → `getState()` in handlers |
| `App.tsx` (2702) | `subtitleSettings.defaultLanguage` | ✅ converted → `getState()` (blob now in store) |
| `App.tsx` (2415) | `channelAudioDelays` | ⚠️ not in store — keep |
| `App.tsx` (3762 autosync) | v3 migration + refresh hours + design | ⚠️ keep (owns migration) |
| `hooks/usePopoutPlayer.ts` | `popoutAlwaysOnTop/StopMain/MpvParams*` | ✅ converted → `getState()` |
| `db/sync.ts` (65) | `globalLiveTvUserAgent` | ✅ converted → `getState()` |
| `services/stream-resolver.ts` (107) | `globalLiveTvUserAgent` | ✅ converted → `getState()` |

(`components/EpgEditorModal.tsx` line 360 reads `globalEpgLinks` — Tier 2,
not here; line 280 reads `globalEpgLinks` too. Its store-backed reads were
converted to selectors in Phase 4.)

## Tier 2 — convert after the field lands in the store

These read settings the store does not yet hold. The right move is adding the
field to the store (hydrate + setter), then converting the call site. Until
then the direct read is correct.

| File | Reads | What to add |
|---|---|---|
| ~~`SubtitleControlModal.tsx` (×9)~~ | ~~`subtitleSettings.*`~~ | ✅ **converted — blob now in store** |
| ~~`TrackSelectionModal.tsx` (×11)~~ | ~~`subtitleSettings.audioDevice`~~ | ✅ **converted — blob now in store** |
| `hooks/usePlayback.ts` (518, 1016) | `streamMaxRetries`, `streamWatchdogSeconds`, `channelAudioDelays` | keep (not in store); `subtitleSettings` (28, 1774) converted |
| `components/VodPage.tsx`, `stremio/StremioHome.tsx` (×2), `stremio/CatalogDetailView.tsx` (×2), `stremio/StremioDetail.tsx`, `stremio/CloudCatalogDetailView.tsx`, `nuvio/NuvioPage.tsx`, `nuvio/NuvioDetailView.tsx`, `components/vod/VerticalSidebar.tsx`, `components/vod/SeriesDetail.tsx` | `streamingCatalogsEnabled`, `enabledStreamingServices`, `streamingNuvioCatalogsEnabled`, `trailerSource`, `trailerPlayerMode` | streaming-catalog + trailer fields |
| `components/settings/ImportExportTab.tsx`, `services/autoBackup.ts` | `autoBackup*` | auto-backup fields (or read via `readAutoBackupSettings()` which already abstracts them) |
| `components/settings/SourcesTab.tsx` (×4) | `globalEpgLinks` | `globalEpgLinks` blob |
| `components/EpgEditorModal.tsx` (280, 360) | `globalEpgLinks` | `globalEpgLinks` |
| `components/settings/DvrTab.tsx` | `downloadsPath` | `downloadsPath` |
| `hooks/useRpdbSettings.ts` | `posterDbApiKey`, `rpdbBackdropsEnabled` | metadata-API fields |
| `hooks/useTmdbLists.ts` (×3) | `tmdbApiKey` | `tmdbApiKey` |
| `components/settings/ScrobblingTab.tsx`, `SimklTab.tsx`, `NuvioTab.tsx`, `TVCalendarTab.tsx`, `TraktCatalogsModal.tsx`, `stores/downloadStore.ts` | `trakt*`, `simkl*`, `tvCalendarAutoSync`, `downloadsPath` | respective fields |
| `components/settings/ChannelManager.tsx` | per-source fields | keep direct (management context) |
| `hooks/useChannels.ts` (1397) | `globalEpgLinks` | `globalEpgLinks` |
| `services/epg-overrides.ts` (613, 709) | `globalEpgLinks` | `globalEpgLinks` |
| `services/opensubtitles.ts`, `services/scrobbler.ts` (wrapper + 2) | `trakt*` | respective fields |

## Tier 3 — keep direct (by design)

- `services/tauri-bridge.ts` (913) — **the definition** of `getSettings`.
- `services/scrobbler.ts` (199) — private wrapper around the bridge (internal).
- `components/Settings.tsx` (819) — the settings editor itself reads the full
  blob (including non-store fields like API keys) to seed its form; converting
  would couple the editor to a store it is actively writing.
- `components/CategoryStrip.tsx` (1559) — reads `collapseSourceCategoriesOnStartup`
  + `showAllChannels/ShowFavorites/ShowWatchlist/ShowRecentlyViewed` +
  `favoritesMode` — none of these are store fields yet (nav/category flags).
  If/when they are migrated, convert then.
- `App.tsx` autosync block (3762) — owns the v3-default migration +
  `applyUiDesign`; not a plain read.
- Anything already using the store's `getState()` pattern (e.g. `useToastStore`).

---

## Caveats (before anyone mass-converts)

1. **Freshness**: the store is hydrated once at boot and written by setters.
   A service that reads `getState()` mid-session sees the current in-memory
   value — correct for everything that goes through a setter. If a field is
   still written by a *direct* `updateSettings` somewhere (no store setter),
   the store goes stale; convert those writes too (the write-queue tests cover
   the bridge side).
2. **Boot ordering**: `ensureSettingsHydration()` starts before React mounts,
   but a service module imported before hydration resolves would see seed
   defaults. Prefer converting **event-handler / mount-time** reads first;
   leave one-shot module-load reads until hydration ordering is proven.
3. **Nested blobs** (`subtitleSettings` — done, `globalEpgLinks` — remaining)
   are single store fields in practice — migrate them as whole values
   (hydrate + setter) rather than deep-merging.
4. **Don't convert the Settings editor itself** — it is the writer; it needs
   the authoritative blob including non-store fields.

## Update — Tier 1 + subtitleSettings done (this pass)

- **Tier 1 fully converted** (≈14 files, ~20 calls): search modals, multiview
  cells, ProgramContextMenu, external-player handlers, popout, sync,
  stream-resolver all read the store now.
- **`subtitleSettings` migrated into the store**: `SettingsState.subtitleSettings`
  + `setSubtitleSettings` (debounced persist), hydration merges the stored blob
  over `DEFAULT_SUBTITLE_SETTINGS` (single source of truth shared with
  `SubtitlesTab`). All 16+ reads/writes in `SubtitleControlModal`,
  `TrackSelectionModal`, `usePlayback`, and `App.tsx` (2702) converted.
- **New consumer contract test** (`stores/__tests__/settingsStoreContract.test.ts`)
  scans every source file for `useSettingsStore((s) => s.x)` / `.getState().x`
  and asserts each key is real — catches selector typos tsc can't.

## Recommended order (remaining)

1. **Tier 2, high-value first**: `globalEpgLinks` (4 files), auto-backup fields
   (already abstracted behind `readAutoBackupSettings()` — make that the
   single reader).
2. Re-run the audit afterward — the count dropped from ~100 to **74 (38 files)**
   with this pass, and the remaining calls are either non-store settings or the
   editor.
