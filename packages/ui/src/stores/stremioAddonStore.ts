import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import i18n from '../i18n';
import type { InstalledAddon } from '../types/stremio';
import { fetchManifest, clearCatalogCache, cleanAddonUrl, getManifestUrl, openAddonConfigureUrl } from '../services/stremio-addon';

const STORAGE_KEY = 'stremio-addons';

/**
 * Thrown when an add-on's manifest declares `configurationRequired`. Mirrors
 * stremio-core, which refuses to install these until the user configures them:
 * an unconfigured add-on can return a far larger (and unfiltered) payload than
 * the configured one.
 */
export class AddonConfigurationRequiredError extends Error {
  readonly code = 'addonConfigurationRequired';
  readonly configureUrl: string;

  constructor(message: string, configureUrl: string) {
    super(message);
    this.name = 'AddonConfigurationRequiredError';
    this.configureUrl = configureUrl;
  }
}

export interface AddAddonOptions {
  /** Install even though the manifest asks to be configured first. */
  allowUnconfigured?: boolean;
}

const DEFAULT_ADDONS = [
  { url: 'https://v3-cinemeta.strem.io/manifest.json', isDefault: true },
];

function deriveEnabled(addons: InstalledAddon[]) {
  return addons.filter(a => a.enabled !== false);
}

interface StremioAddonStore {
  addons: InstalledAddon[];
  enabledAddons: InstalledAddon[];
  initialized: boolean;
  addonsReordered: boolean;
  initializeDefaults: () => Promise<void>;
  addAddon: (url: string, options?: AddAddonOptions) => Promise<void>;
  removeAddon: (id: string) => void;
  toggleAddon: (id: string) => void;
  reorderAddons: (currentIndex: number, direction: 'up' | 'down') => void;
  syncAddonPositions: () => Promise<void>;
}

export const useStremioAddonStore = create<StremioAddonStore>()(
  persist(
    (set, get) => ({
      addons: [],
      enabledAddons: [],
      initialized: false,
      addonsReordered: false,
      reorderAddons: (currentIndex: number, direction: 'up' | 'down') => {
        const state = get();
        const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
        if (nextIndex < 0 || nextIndex >= state.addons.length) return;

        const newAddons = [...state.addons];
        const temp = newAddons[currentIndex];
        newAddons[currentIndex] = newAddons[nextIndex];
        newAddons[nextIndex] = temp;

        clearCatalogCache();
        set({ addons: newAddons, enabledAddons: deriveEnabled(newAddons), addonsReordered: true });
      },

      syncAddonPositions: async () => {
        const state = get();
        const { useStremioAuthStore } = await import('./stremioAuthStore');
        const auth = useStremioAuthStore.getState();
        if (auth.authKey && auth.syncAddons) {
          const { setStremioAddons } = await import('../services/stremio-api');
          const toPush = state.addons.map(a => ({
            transportUrl: getManifestUrl(a.baseUrl),
            manifest: a.manifest,
          }));
          await setStremioAddons(auth.authKey, toPush);
          set({ addonsReordered: false });
        }
      },

      initializeDefaults: async () => {
        const state = get();
        if (state.initialized) return;
        set({ initialized: true });

        const existingIds = new Set(state.addons.map(a => a.id));
        for (const def of DEFAULT_ADDONS) {
          try {
            const manifest = await fetchManifest(def.url);
            if (!existingIds.has(manifest.id)) {
              clearCatalogCache();
              set(s => {
                const newAddons = [
                  ...s.addons,
                  {
                    id: manifest.id,
                    baseUrl: cleanAddonUrl(def.url),
                    manifest,
                    installedAt: Date.now(),
                    isDefault: true,
                  },
                ];
                return { addons: newAddons, enabledAddons: deriveEnabled(newAddons) };
              });
            }
          } catch (e) {
            console.warn('[StremioAddonStore] Failed to install default addon:', def.url, e);
          }
        }
      },

      addAddon: async (url: string, options?: AddAddonOptions) => {
        const manifest = await fetchManifest(url);
        const state = get();
        if (state.addons.some(a => a.id === manifest.id)) {
          throw new Error(i18n.t('stremio:addonAlreadyInstalled', { name: manifest.name }));
        }
        if (manifest.behaviorHints?.configurationRequired && !options?.allowUnconfigured) {
          const configureUrl = cleanAddonUrl(url);
          void openAddonConfigureUrl(configureUrl).catch(() => {});
          throw new AddonConfigurationRequiredError(
            i18n.t('stremio:addonRequiresConfiguration', { name: manifest.name }),
            configureUrl
          );
        }
        const addon: InstalledAddon = {
          id: manifest.id,
          baseUrl: cleanAddonUrl(url),
          manifest,
          installedAt: Date.now(),
        };
        clearCatalogCache();
        
        const newAddons = [...state.addons, addon];
        set({ addons: newAddons, enabledAddons: deriveEnabled(newAddons) });

        // Sync to Stremio cloud if logged in & sync enabled
        import('./stremioAuthStore').then(({ useStremioAuthStore }) => {
          const auth = useStremioAuthStore.getState();
          if (auth.authKey && auth.syncAddons) {
            import('../services/stremio-api').then(({ setStremioAddons }) => {
              const toPush = newAddons.map(a => ({
                transportUrl: getManifestUrl(a.baseUrl),
                manifest: a.manifest,
              }));
              setStremioAddons(auth.authKey!, toPush)
                .then(() => set({ addonsReordered: false }))
                .catch(() => {});
            });
          }
        });
      },

      removeAddon: (id: string) => {
        clearCatalogCache();
        const state = get();
        const newAddons = state.addons.filter(a => a.id !== id);
        set({ addons: newAddons, enabledAddons: deriveEnabled(newAddons) });

        // Sync to Stremio cloud if logged in & sync enabled
        import('./stremioAuthStore').then(({ useStremioAuthStore }) => {
          const auth = useStremioAuthStore.getState();
          if (auth.authKey && auth.syncAddons) {
            import('../services/stremio-api').then(({ setStremioAddons }) => {
              const toPush = newAddons.map(a => ({
                transportUrl: getManifestUrl(a.baseUrl),
                manifest: a.manifest,
              }));
              setStremioAddons(auth.authKey!, toPush)
                .then(() => set({ addonsReordered: false }))
                .catch(() => {});
            });
          }
        });
      },

      toggleAddon: (id: string) => {
        clearCatalogCache();
        const state = get();
        const newAddons = state.addons.map(a =>
          a.id === id ? { ...a, enabled: a.enabled === false ? true : false } : a
        );
        set({ addons: newAddons, enabledAddons: deriveEnabled(newAddons) });

        // Sync to Stremio cloud if logged in & sync enabled
        import('./stremioAuthStore').then(({ useStremioAuthStore }) => {
          const auth = useStremioAuthStore.getState();
          if (auth.authKey && auth.syncAddons) {
            import('../services/stremio-api').then(({ setStremioAddons }) => {
              const toPush = newAddons.map(a => ({
                transportUrl: getManifestUrl(a.baseUrl),
                manifest: a.manifest,
              }));
              setStremioAddons(auth.authKey!, toPush)
                .then(() => set({ addonsReordered: false }))
                .catch(() => {});
            });
          }
        });
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({ addons: state.addons }),
      merge: (persisted, current) => {
        let addons = (persisted as any)?.addons ?? current.addons;
        if (Array.isArray(addons)) {
          // Clean up legacy Open Subtitles v3 default addon for existing users
          addons = addons.filter(a => a.id !== 'opensubtitles-v3');
        }
        return { ...current, addons, enabledAddons: deriveEnabled(addons) };
      },
    }
  )
);
