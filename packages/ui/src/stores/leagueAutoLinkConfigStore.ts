import { create } from 'zustand';
import { db } from '../db';

export type AutoLinkMatchMode = 'full' | 'both' | 'nickname';

export interface LeagueAutoLinkConfig {
  matchMode: AutoLinkMatchMode; // 'full' (City + Team), 'both' (Smart: Full + Nickname), 'nickname' (Nickname only)
  sourceIds: string[];          // Allowed provider source IDs (empty = all enabled sources)
  categoryIds: string[];        // Allowed category IDs (empty = all categories)
  minConfidence: number;        // Minimum match score to display (0.5 .. 0.9, default: 0.7)
  maxCandidatesPerTeam: number; // Max candidate streams per team (1 .. 5, default: 1)
  autoApply: boolean;           // If true, automatically links top match without review (default: false)
}

export const DEFAULT_AUTOLINK_CONFIG: LeagueAutoLinkConfig = {
  matchMode: 'both',
  sourceIds: [],
  categoryIds: [],
  minConfidence: 0.7,
  maxCandidatesPerTeam: 1,
  autoApply: false,
};

// Persisted in SQLite (db.prefs) so it survives cache clears and is included in
// export/import backups (prefs are exported as `userPrefs`). The in-memory copy
// keeps reads synchronous.
const STORAGE_KEY = 'sports_autolink_configs_v1';
// Legacy localStorage key, migrated into prefs on first load.
const LEGACY_STORAGE_KEY = 'ynotv_sports_autolink_configs_v1';

interface LeagueAutoLinkConfigState {
  configs: Record<string, LeagueAutoLinkConfig>;
  loaded: boolean;
  ensureLoaded: () => Promise<void>;
  getConfig: (leagueId: string) => LeagueAutoLinkConfig;
  setConfig: (leagueId: string, partial: Partial<LeagueAutoLinkConfig>) => void;
  resetConfig: (leagueId: string) => void;
  hasCustomConfig: (leagueId: string) => boolean;
}

let loadPromise: Promise<void> | null = null;

function readLegacyLocalStorage(): Record<string, LeagueAutoLinkConfig> {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    console.error('[LeagueAutoLinkConfigStore] Failed to read legacy localStorage:', err);
  }
  return {};
}

async function persist(configs: Record<string, LeagueAutoLinkConfig>): Promise<void> {
  try {
    await db.prefs.put({ key: STORAGE_KEY, value: JSON.stringify(configs) });
  } catch (err) {
    console.error('[LeagueAutoLinkConfigStore] Failed to persist configs:', err);
  }
}

export const useLeagueAutoLinkConfigStore = create<LeagueAutoLinkConfigState>((set, get) => ({
  configs: {},
  loaded: false,

  ensureLoaded: async () => {
    if (get().loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        let configs: Record<string, LeagueAutoLinkConfig> = {};
        const pref = await db.prefs.get(STORAGE_KEY);
        if (pref?.value) {
          try {
            const parsed = JSON.parse(pref.value);
            if (parsed && typeof parsed === 'object') configs = parsed;
          } catch (err) {
            console.error('[LeagueAutoLinkConfigStore] Failed to parse stored configs:', err);
          }
        }

        // One-time migration from the old localStorage location.
        if (Object.keys(configs).length === 0) {
          const legacy = readLegacyLocalStorage();
          if (Object.keys(legacy).length > 0) {
            configs = legacy;
            await persist(configs);
          }
        }
        try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }

        set({ configs, loaded: true });
      } catch (err) {
        console.error('[LeagueAutoLinkConfigStore] Failed to load configs:', err);
        set({ loaded: true });
      } finally {
        loadPromise = null;
      }
    })();
    return loadPromise;
  },

  getConfig: (leagueId: string): LeagueAutoLinkConfig => {
    const stored = get().configs[leagueId];
    if (!stored) return { ...DEFAULT_AUTOLINK_CONFIG };
    return {
      matchMode: stored.matchMode || DEFAULT_AUTOLINK_CONFIG.matchMode,
      sourceIds: Array.isArray(stored.sourceIds) ? stored.sourceIds : [],
      categoryIds: Array.isArray(stored.categoryIds) ? stored.categoryIds : [],
      minConfidence: typeof stored.minConfidence === 'number' ? stored.minConfidence : DEFAULT_AUTOLINK_CONFIG.minConfidence,
      maxCandidatesPerTeam: typeof stored.maxCandidatesPerTeam === 'number' ? stored.maxCandidatesPerTeam : DEFAULT_AUTOLINK_CONFIG.maxCandidatesPerTeam,
      autoApply: typeof stored.autoApply === 'boolean' ? stored.autoApply : DEFAULT_AUTOLINK_CONFIG.autoApply,
    };
  },

  setConfig: (leagueId: string, partial: Partial<LeagueAutoLinkConfig>) => {
    const current = get().getConfig(leagueId);
    const updated: LeagueAutoLinkConfig = {
      ...current,
      ...partial,
      sourceIds: partial.sourceIds !== undefined ? partial.sourceIds : current.sourceIds,
      categoryIds: partial.categoryIds !== undefined ? partial.categoryIds : current.categoryIds,
    };

    const newConfigs = {
      ...get().configs,
      [leagueId]: updated,
    };

    set({ configs: newConfigs });
    void persist(newConfigs);
  },

  resetConfig: (leagueId: string) => {
    const newConfigs = { ...get().configs };
    delete newConfigs[leagueId];
    set({ configs: newConfigs });
    void persist(newConfigs);
  },

  hasCustomConfig: (leagueId: string): boolean => {
    const cfg = get().configs[leagueId];
    if (!cfg) return false;
    return (
      (cfg.matchMode !== undefined && cfg.matchMode !== DEFAULT_AUTOLINK_CONFIG.matchMode) ||
      (Array.isArray(cfg.sourceIds) && cfg.sourceIds.length > 0) ||
      (Array.isArray(cfg.categoryIds) && cfg.categoryIds.length > 0) ||
      (cfg.minConfidence !== undefined && cfg.minConfidence !== DEFAULT_AUTOLINK_CONFIG.minConfidence) ||
      (cfg.maxCandidatesPerTeam !== undefined && cfg.maxCandidatesPerTeam !== DEFAULT_AUTOLINK_CONFIG.maxCandidatesPerTeam) ||
      (cfg.autoApply !== undefined && cfg.autoApply !== DEFAULT_AUTOLINK_CONFIG.autoApply)
    );
  },
}));

// Kick off background hydration so configs are ready before first use.
void useLeagueAutoLinkConfigStore.getState().ensureLoaded();
