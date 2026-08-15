import { create } from 'zustand';
import { db } from '../db';

export interface LeagueSearchConfig {
  sourceIds: string[];   // Allowed provider source IDs (empty = all enabled sources)
  categoryIds: string[]; // Allowed category IDs (empty = all enabled categories)
}

export const DEFAULT_SEARCH_CONFIG: LeagueSearchConfig = {
  sourceIds: [],
  categoryIds: [],
};

// Persisted in SQLite (db.prefs) so it survives cache clears and is included in
// export/import backups (prefs are exported as `userPrefs`).
const STORAGE_KEY = 'sports_search_configs_v1';
// Legacy localStorage key, migrated into prefs on first load.
const LEGACY_STORAGE_KEY = 'ynotv_sports_search_configs_v1';

interface LeagueSearchConfigState {
  configs: Record<string, LeagueSearchConfig>;
  loaded: boolean;
  ensureLoaded: () => Promise<void>;
  getConfig: (leagueId: string) => LeagueSearchConfig;
  setConfig: (leagueId: string, partial: Partial<LeagueSearchConfig>) => void;
  resetConfig: (leagueId: string) => void;
  hasCustomConfig: (leagueId: string) => boolean;
}

let loadPromise: Promise<void> | null = null;

function readLegacyLocalStorage(): Record<string, LeagueSearchConfig> {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    console.error('[LeagueSearchConfigStore] Failed to read legacy localStorage:', err);
  }
  return {};
}

async function persist(configs: Record<string, LeagueSearchConfig>): Promise<void> {
  try {
    await db.prefs.put({ key: STORAGE_KEY, value: JSON.stringify(configs) });
  } catch (err) {
    console.error('[LeagueSearchConfigStore] Failed to persist configs:', err);
  }
}

export const useLeagueSearchConfigStore = create<LeagueSearchConfigState>((set, get) => ({
  configs: {},
  loaded: false,

  ensureLoaded: async () => {
    if (get().loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        let configs: Record<string, LeagueSearchConfig> = {};
        const pref = await db.prefs.get(STORAGE_KEY);
        if (pref?.value) {
          try {
            const parsed = JSON.parse(pref.value);
            if (parsed && typeof parsed === 'object') configs = parsed;
          } catch (err) {
            console.error('[LeagueSearchConfigStore] Failed to parse stored configs:', err);
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
        console.error('[LeagueSearchConfigStore] Failed to load configs:', err);
        set({ loaded: true });
      } finally {
        loadPromise = null;
      }
    })();
    return loadPromise;
  },

  getConfig: (leagueId: string): LeagueSearchConfig => {
    const stored = get().configs[leagueId];
    if (!stored) return { ...DEFAULT_SEARCH_CONFIG };
    return {
      sourceIds: Array.isArray(stored.sourceIds) ? stored.sourceIds : [],
      categoryIds: Array.isArray(stored.categoryIds) ? stored.categoryIds : [],
    };
  },

  setConfig: (leagueId: string, partial: Partial<LeagueSearchConfig>) => {
    const current = get().getConfig(leagueId);
    const updated: LeagueSearchConfig = {
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
      (Array.isArray(cfg.sourceIds) && cfg.sourceIds.length > 0) ||
      (Array.isArray(cfg.categoryIds) && cfg.categoryIds.length > 0)
    );
  },
}));

// Kick off background hydration so configs are ready before first use.
void useLeagueSearchConfigStore.getState().ensureLoaded();
