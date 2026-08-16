# Settings Store Migration — `useAppSettings` → zustand

Status: **All phases complete** (store shell + single boot load + write-queue persistence + consolidated DOM applier + full consumer conversion + old-machinery removal + Phase 6 tests). Direct-`getSettings` audit: `docs/settings-getsettings-audit.md`.
Owner: UI / settings
Scope: `packages/ui/src/hooks/useAppSettings.ts` and its 20 consumers

## Why

`useAppSettings()` is called by ~20 components. Each call creates a **private copy
of ~100 settings** in React state and runs its **own async load** from the Tauri
store on mount. Consequences:

- ~20 duplicate state copies + ~20 queued IPC `get_settings` round-trips at
  startup (they serialize behind each other and block the JS thread).
- Divergence is inherent: independent copies can disagree, which is why three
  mechanisms now exist to paper it over — the OLED module-global, the
  `settingsWriteStamps` stale-read guard, and `cachedSettings` cache mirroring.
- DOM side effects (theme, classes, styles) are applied by per-instance effects,
  the source of the mount-time race bugs.

The repo already has the target infrastructure: zustand `^5.0.10` is a
dependency, ~23 stores live in `src/stores/`, and `persistToKv.ts` /
`bindStoreToKv` provide the localStorage-bootstrap → SQLite-hydrate →
debounced-write persistence pattern.

## Persistence decision (read first)

Settings today persist through the Tauri **plugin-store** JSON file via
`window.storage.updateSettings`, serialized by an existing **write queue** in
`services/tauri-bridge.ts` (see `services/__tests__/settingsWriteQueue.test.ts`
— it fixed the non-atomic get→merge→set→save interleaving). Two options:

- **Option A (recommended): keep the plugin-store.** The zustand store's setters
  update store state synchronously (optimistic, single source of truth) and
  enqueue `updateSettings` through the existing write queue. No data migration,
  no export/import/backup format changes.
- **Option B: move settings to SQLite KV via `bindStoreToKv`** (like the league
  config stores). Consolidates all stores on one persistence layer, but requires
  migrating the existing plugin-store settings into KV and touching
  export/import/backup readers. Do this later, if at all.

All phases below assume Option A.

## Phases

### Phase 0 — Inventory & baseline (½ day) ✅

- [x] Enumerated every field of `AppSettings` (interface at
  `hooks/useAppSettings.ts:74`+) — the full shape now lives in
  `stores/settingsStore.ts` (`SettingsState`).
- [x] Recorded the 20 consumers (grep `useAppSettings()` per file).
- [x] Captured a baseline: `tsc --noEmit`, `pnpm css:audit`, locale parity,
  `settingsWriteQueue.test.ts`.
- [x] Noted the special cases before touching anything:
  - `epgView` already lives in the zustand `uiStore` — kept there; the adapter
    delegates through `useSetEpgView` and persists `epgView` via `updateSettings`.
  - `setShortcuts` does **not persist** (a pre-existing bug — deferred to Phase 4,
    unchanged here; noted in `settingsStore.ts`).
  - `language` is a dual-write (store + `i18next.changeLanguage`).
  - Hydration ordering: hydration applies `customThemeConfig` **before**
    `theme` so the theme effect never runs with an uninitialized config
    (preserved in `settingsStoreHydration.ts`).

### Phase 1 — Store shell + adapter hook (no behavior change) ✅

- [x] Create `stores/settingsStore.ts`: zustand `create` holding the full state
  shape (values + setters). Note: setters carry the DOM writes the old setters
  performed inline (ported verbatim) rather than being fully pure — Phase 3 is
  where DOM application gets consolidated into one idempotent applier; leaving
  the writes in the setters keeps Phase 1/2 behavior-identical.
- [x] Rewrite `useAppSettings()` as a **thin adapter**: it subscribes to the
  store (`useSettingsStore()` whole-state) and returns the whole state + the
  epgView delegation. All 20 consumers keep compiling and behave identically.
  This is a temporary bridge — do **not** leave it as the end state (whole-store
  subscription re-renders every consumer on any change; Phase 4 slice selectors
  restore render parity).
- [x] Add a one-time boot hydration module (`stores/settingsStoreHydration.ts`):
  seeds from `localStorage 'app-settings'` synchronously at store module load
  (preserves first-paint correctness), then a **single** `getSettings()` at
  startup reconciles the store. The adapter triggers it once via
  `ensureSettingsHydration()` (module-level latch). Per-instance loads are gone.
- [x] Gate: `tsc --noEmit` clean, consumers visually unchanged (mock-preview
  pass: LiveTV/Movies/Series/Strem/Nuvio), settings persist.

### Phase 2 — Persistence through the write queue ✅

- [x] Every setter persists through `window.storage.updateSettings` /
  `debouncedUpdateSettings` — which already route through the serialized write
  queue (`enqueueWrite` in `tauri-bridge.ts`) and mirror each patch to
  localStorage for synchronous hydration. No new helper was needed:
  `window.storage.updateSettings` *is* the public queue surface.
- [x] Setters are: optimistic `set({...})` + queued persist + (where today)
  DOM write + event dispatch (`ynotv:catchup-settings-changed` etc.).
- [x] The localStorage mirror is centralized in `Bridge.updateSettings`; the
  redundant per-setter mirror writes from the old hook were dropped.
- [x] The `settingsWriteStamps` guard (moved into the store as
  `stampSettingsWrite` / `hasSettingsWriteSince`) was belt-and-suspenders for
  the multi-load era; with the single boot load it was nearly dead code and is
  now removed (Phase 5). Hydration reads `theme`/`customThemeConfig`
  authoritatively from Tauri storage with a localStorage-mirror fallback.
- [x] Gate: `settingsWriteQueue.test.ts` 5/5 pass; live mock-preview verified
  theme change → exit → persists across all six pages with zero `data-theme`
  flips, and the OLED setter keeps `data-oled` + localStorage consistent with
  zero attribute flips.

### Phase 3 — DOM side-effect consolidation ✅

- [x] Created `stores/settingsDomApplier.ts` — ONE idempotent applier subscribed
  to the store that owns every settings-driven `documentElement` write:
  `data-theme` + custom-theme vars + `updateScrollbarHoverColor`,
  `--font-family` + custom font-face + CJK fallback, the optimization classList
  flags, `data-oled`, the logo/EPG classes and vars, custom scrollbar
  dataset/var, widget/sports scale vars, CIO sizing vars, and the EPG cosmetic
  classes. Per-section signature compare means a store change only touches the
  DOM sections whose inputs changed (no churn on unrelated settings), with the
  original DOM-compare guards kept as a second layer.
- [x] The OLED module-global is absorbed: `data-oled` is now purely derived from
  `state.oledBlack` by the applier — no `oledBlackGlobal` / `applyOledAttribute`
  anywhere.
- [x] The adapter's six per-instance effects are deleted; the store setters are
  now pure (no DOM writes); the hydration module is pure state reconciliation
  (no DOM writes). The only `documentElement` write left outside the applier is
  a read-only theme seed in the store's initializer.
- [x] The 5 EPG cosmetic booleans (`epgDarkenCurrent`, `epgHighlightBorderCurrent`,
  `epgBoldChannelNames`, `epgBoldTopCategories`, `epgBoldSourceCategories`) were
  previously load-time-only classes with no state — they now live in the store
  (hydrated, no setters) so the applier is the single source for them too.
- [x] Dead-write removal: `setChannelInfoOverlayOpacity`'s `--cio-bg-opacity`
  write was always shadowed by `--widget-bg-opacity` in the CSS fallback chain
  — dropped (visually identical).
- [x] Gate: `tsc` clean, `pnpm css:audit` OK, locale parity OK, write-queue
  tests pass. Live mock-preview (v3 + Dark): OLED toggle → `data-oled="true"`
  with **zero** attribute flips across LiveTV/Movies/Series/Strem/Nuvio (and
  back); theme → Dark Crimson → exactly one intended `data-theme` flip then
  zero across 7 navigations; `--bg-primary` pure black on OLED (no blob wash,
  accent on selected item only — verified by screenshot); all applier vars
  (`--channel-logo-size`, `--widget-scale`, `--sports-scale`, `--cio-font-size`)
  applied on boot; no console errors. Mock reverted, server stopped.

### Phase 4 — Convert consumers to slice selectors ✅

Conversion order (each step independently shippable; after each, delete that
consumer's `useAppSettings()` import):

1. **Leaf, read-only, single setting** (prove the pattern, lowest risk):
   - `NowPlayingBar` → `showVolumePercent`
   - `HorizontalCarousel`, `RecentView` → `vodShowSourceBadge`
   - `ChannelLogo` → logo cache/smart-trim settings
   - `MetadataBadge` → EPG badge toggles
   - `FailoverGroupOverlay` → `failoverGroupShowSource`
2. **Leaf, small writes:**
   - `EpgEditorModal` → EPG logo display / source logo overrides
   - `VodBrowse` → `includeSourceInVodSearch`, `vodShowSourceBadge`
3. **Shortcuts consumers** (convert together; also fix `setShortcuts` to persist
   here — it's the natural point and the change is contained):
   - `VodPage`, `StremioPage`, `NuvioPage`
4. **Settings tabs** (write-heavy — this is where setters get exercised broadly;
   convert before `Settings.tsx` so the root becomes thin):
   - `SourcesTab`, `OptimizationTab`, `UITab`, `ThemeTab`
     (ThemeTab also owns the `oledBlack` toggle + font settings + the OLED
     checkbox props threaded from `Settings.tsx` — convert together with
     Settings step to keep prop-drilling simple)
5. **Shared hook:** `useChannels` → EPG-logo prefs
6. **Settings root:** `Settings.tsx` — the largest destructure; becomes a thin
   orchestrator passing slices down.
7. **App.tsx last** (highest risk — it consumes the most and coordinates
   view/theme/startup behavior).
8. [x] Delete the adapter hook and any remaining `useAppSettings()` call sites
   (enforce with a grep in CI).

All 21 consumers converted ([x]): NowPlayingBar, HorizontalCarousel, RecentView,
ChannelLogo, MetadataBadge, FailoverGroupOverlay, ChannelPanel, useChannels,
EpgEditorModal, VodBrowse, VodPage, StremioPage, NuvioPage, SourcesTab,
OptimizationTab, UITab, ThemeTab, Settings.tsx, App.tsx, StartupTab, EpgEditor.
`useAppSettings.ts` is deleted. The `setShortcuts` persistence fix landed in the
store (it now writes through the serialized queue like every other setter).

Two wiring notes from the conversion:

- The applier's side-effect import moved from the (deleted) adapter to
  `main.tsx`, AFTER the store modules — importing it from the store itself
  deadlocks (circular: the applier reads `useSettingsStore` at module scope).
- `ensureSettingsHydration()` moved from the adapter to `main.tsx`, invoked
  before React mounts so the single boot load starts immediately. Pre-existing
  one-off `getSettings()` reads (App autosync v3-migration, event-handler
  reads) are untouched — they were never `useAppSettings` consumers.

Selector discipline is mandatory: `useSettingsStore(s => s.theme)` style
per-consumer slices so components re-render only on their slice — this is what
keeps render cost *equal or better* than today.

### Phase 5 — Remove the old machinery ✅

- [x] Delete the adapter hook (`useAppSettings.ts` — done in Phase 4).
- [x] Grep-verify zero `useAppSettings()` imports remain (done in Phase 4).
- [x] Remove the `settingsWriteStamps` guard (`stampSettingsWrite` /
  `hasSettingsWriteSince`) and the setter stamps. With one boot load there is
  no second writer that could clobber a user change, so the guard was dead
  code. Hydration now reads `theme`/`customThemeConfig` authoritatively from
  Tauri storage with the localStorage mirror as fallback (no timestamp
  comparison).
- [x] Run the full audit suite + a full mock-preview pass (theme, OLED, EPG,
  LiveTV/Movies/Series/Strem/Nuvio navigation) after the stamp removal.

### Phase 6 — Tests & hardening ✅

- [x] **Hydration test** (`stores/__tests__/settingsHydration.test.ts`):
  localStorage seed → boot load → store state; storage is authoritative;
  missing values keep defaults; corrupted shapes rejected (added a shape
  sanitizer to the hydration — the test caught two real gaps: an empty
  `result.data` blob skipped the localStorage fallback, and type-corrupted
  theme/boolean values hydrated straight through).
- [x] **Write-path test** (`stores/__tests__/settingsWritePath.test.ts`):
  setters update state optimistically and persist through the bridge
  (debounced vs immediate), merge partial configs, and never touch the DOM.
- [x] **DOM applier test** (`stores/__tests__/settingsDomApplier.test.ts`):
  idempotent — re-applying the same state is a no-op (zero writes), only the
  changed section writes, OLED toggles exactly once per change, custom-theme
  vars apply and get removed. Uses a tracked fake DOM (Proxy-backed dataset —
  a naive accessor fake silently breaks under `delete el.dataset.oled`).
- [ ] **Consumer contract test:** every consumer's selector resolves (catches
  typos in slice paths) — not written; the full-suite tsc pass covers the
  selector field names statically.
- [ ] Optional: render-perf sanity check comparing re-render counts before/after
  on the EPG (Virtuoso rows were the pathological case) — deferred.

Gates after Phase 6: `tsc --noEmit` clean; **87 vitest tests pass** (was 5);
`pnpm css:audit` 129 files OK; locale parity OK.

## Post-migration follow-up: direct `getSettings()` audit

`docs/settings-getsettings-audit.md` classifies the ~100 remaining direct
`window.storage.getSettings()` call sites across 46 files: Tier 1 (convert to
store reads now — reads only store fields), Tier 2 (convert after the field
lands in the store — `subtitleSettings`, `globalEpgLinks`, auto-backup,
streaming-catalog, trakt/metadata fields), Tier 3 (keep direct by design — the
bridge definition, the Settings editor, the autosync v3 migration). No
conversions applied yet; Tier 1 is the low-risk mechanical pass (~14 files,
~20 calls).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Render-perf regression if slices not used | Selector discipline enforced by review + Phase 6 perf check; the adapter is explicitly temporary |
| Data loss during persistence switch | Option A keeps the exact same plugin-store keys/shape — no migration |
| Coexistence bugs (hook + store both live) | The adapter keeps one source; convert consumers in order and delete the adapter before adding new features |
| Hydration ordering (custom config before theme) | Preserve the existing order in the single boot hydration; covered by the DOM applier test |
| `epgView` double-source (uiStore vs settings) | Keep it in `uiStore`; the settings store delegates through `useSetEpgView` |
| Export/import/backup formats | Untouched under Option A; if Option B is ever chosen, do it as a separate plan |

## Interop with recent fixes

- The **OLED module-global** was a stopgap for the per-instance architecture;
  Phase 3 absorbed it into the DOM applier (data-oled is now purely derived
  from store state). The **stamp guard** (`settingsWriteStamps`) was the
  analogous stopgap for the multi-load era and is removed in Phase 5 — with
  one boot load there is no second writer that could clobber a user change.
