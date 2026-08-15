# Contributing to ynoTV

## UI strings (i18n)

New user-facing UI strings must be added to `packages/ui/src/i18n/locales/en.json` **first**, following the existing namespace structure (`common`, `settings`, `nav`). `en.json` is the hand-authored source of truth — there is no auto-extraction tooling.

- Localized labels are referenced from components via `useTranslation('<ns>')` and literal key strings (e.g. `t('tabs.sources')`). Dynamic keys are materialized through literal key lookup tables like `SETTINGS_TAB_LABEL_KEYS` in `SettingsSidebar.tsx` so every key stays greppable.
- The TypeScript typed-key layer (`packages/ui/src/i18n/i18next.d.ts`) is the safety net: a typo in a key name fails `typecheck`. The locale allowlist is enforced by `pnpm --filter @ynotv/ui i18n:check`.

### Correcting translations

Translation corrections are welcome — native speakers are the best reviewers of their own language.

**The 23 supported locales** (all at `packages/ui/src/i18n/locales/`): `en`, `fr`, `ar`, `tr`, `es`, `pt-BR`, `it`, `de`, `pl`, `sr`, `hr`, `bs`, `sq`, `ru`, `el`, `nl`, `fa`, `hi`, `ur`, `zh-CN`, `zh-TW`, `vi`, `hu`.

To fix a string:

1. **Find the key.** Locate the text in the app, then search the component source for the nearest `t('...')` call — that key names the string in every locale file. Descriptive keys (e.g. `settings.livetv.logos.logoPreferencesSub`) live in the same namespace structure as `en.json`.
2. **Edit only the value** in the target locale file — never add, remove, or rename keys there. `en.json` is the sole source of truth for the key structure; other locales must mirror it exactly.
3. **Keep `{{placeholders}}` intact.** Interpolation tokens like `{{name}}` or `{{count}}` must appear in the translation exactly as they do in English — reordering them within the sentence is fine, changing or dropping them breaks rendering.
4. **Keep plural forms consistent.** English carries `_one`/`_other` suffixes (e.g. `willAutoAdd_one`/`willAutoAdd_other`); the app's pluralization follows the English schema, so every locale must keep the same key pairs even if the target language has additional plural categories.
5. **Verify.** Run `pnpm --filter @ynotv/ui typecheck` (runs the locale check) or `node scripts/check-locales.mjs` directly. It fails on any missing/extra key, so a correct edit should keep it green.

**Guidelines for good translations**

- Don't translate brand names or protocol terms: Stremio, Nuvio, Xtream, EPG, M3U, VOD, DVR, Trakt, IMDb, Google Cast, Chromecast, MPV, and code-style tokens (`--hwdec=auto`) stay as-is.
- Match the established terminology for the locale. Each language has settled word choices used consistently across all namespaces (e.g. "watchlist", "library", "cache", "sources", "seek") — search the locale file for an existing occurrence before inventing a new term.
- Translations should be faithful to the English meaning, not just its length. Historical machine-translation passes occasionally produced shortened hints or false-friend errors (e.g. "fonts" where English says "sources") — corrections to restore full meaning are especially welcome.
- Keep the tone consistent with the rest of the locale (informative UI hints, not marketing copy).

**Adding a brand-new language** is a larger task: create the locale file with the full `en.json` key structure, add the import + `SUPPORTED_LOCALES` entry with the native label in `packages/ui/src/i18n/index.ts`, and (for CJK locales) check that the font-fallback stack in `packages/ui/src/hooks/useAppSettings.ts` covers the script. Open an issue or PR rather than doing this ad hoc.