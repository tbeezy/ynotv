// ─────────────────────────────────────────────────────────────────────────────
// Nuvio Cloud Library store — holds the Torbox/Premiumize cloud state.
//
// API keys are NOT stored here: they come from the Nuvio profile settings
// (features.debrid_settings.providerApiKeys) via useNuvioAuthStore and are
// passed in by the UI on load/refresh. This mirrors NuvioDesktop, where
// DebridSettingsRepository owns credentials and CloudLibraryRepository only
// consumes them.
// ─────────────────────────────────────────────────────────────────────────────

import { create } from 'zustand';
import type {
  CloudLibraryFile,
  CloudLibraryItem,
  CloudLibraryProviderState,
  CloudLibraryUiState,
} from '../types/cloud';
import { cloudLibraryStableKey, cloudLibraryFileStableKey } from '../types/cloud';
import { cloudProviderApiFor } from '../services/cloud-api';

export interface NuvioCloudStoreState extends CloudLibraryUiState {
  /** providerId -> API key snapshot used for the last load (for cache checks). */
  loadedApiKeys: Record<string, string>;
  load: (apiKeys: Record<string, string>, enabled: boolean) => Promise<void>;
  refresh: (apiKeys: Record<string, string>, enabled: boolean) => Promise<void>;
  resolvePlayback: (
    apiKey: string,
    item: CloudLibraryItem,
    file: CloudLibraryFile,
  ) => Promise<string>;
  clear: () => void;
}

const initialUiState: CloudLibraryUiState = {
  isLoaded: false,
  isEnabled: true,
  isRefreshing: false,
  providers: [],
};

function emptyProviderState(providerId: string, providerName: string): CloudLibraryProviderState {
  return {
    providerId,
    providerName,
    isLoading: false,
    errorMessage: null,
    items: [],
  };
}

export const useNuvioCloudStore = create<NuvioCloudStoreState>((set, get) => ({
  ...initialUiState,
  loadedApiKeys: {},

  load: async (apiKeys, enabled) => {
    const state = get();
    if (!enabled) {
      set({ ...initialUiState, isLoaded: true, isEnabled: false, loadedApiKeys: {} });
      return;
    }
    if (state.isRefreshing) return;
    const keyHash = JSON.stringify(apiKeys);
    if (state.isLoaded && state.loadedApiKeys && JSON.stringify(state.loadedApiKeys) === keyHash) {
      return;
    }
    await get().refresh(apiKeys, enabled);
  },

  refresh: async (apiKeys, enabled) => {
    if (!enabled) {
      set({ ...initialUiState, isLoaded: true, isEnabled: false, loadedApiKeys: {} });
      return;
    }

    const providerIds = Object.keys(apiKeys);
    const providers: CloudLibraryProviderState[] = providerIds.map((providerId) => {
      const api = cloudProviderApiFor(providerId);
      return emptyProviderState(providerId, api?.providerName || providerId);
    });

    set({
      isEnabled: true,
      isRefreshing: true,
      isLoaded: true,
      providers: providers.map((p) => ({ ...p, isLoading: true, errorMessage: null })),
      loadedApiKeys: { ...apiKeys },
    });

    const results = await Promise.all(
      providerIds.map(async (providerId) => {
        const api = cloudProviderApiFor(providerId);
        const apiKey = apiKeys[providerId];
        if (!api || !apiKey) {
          return emptyProviderState(providerId, api?.providerName || providerId);
        }
        try {
          const items = await api.listItems(apiKey);
          return {
            providerId: api.providerId,
            providerName: api.providerName,
            isLoading: false,
            errorMessage: null,
            items,
          } as CloudLibraryProviderState;
        } catch (error: any) {
          return {
            providerId: api.providerId,
            providerName: api.providerName,
            isLoading: false,
            errorMessage: error?.message || 'Failed to load cloud library.',
            items: [],
          } as CloudLibraryProviderState;
        }
      }),
    );

    set({
      isRefreshing: false,
      providers: results,
    });
  },

  resolvePlayback: async (apiKey, item, file) => {
    const api = cloudProviderApiFor(item.providerId);
    if (!api) throw new Error(`Unsupported cloud provider: ${item.providerId}`);
    const url = await api.resolvePlayback(apiKey, item, file);
    // Remember the resolved URL so the same file plays instantly next time.
    set((state) => ({
      providers: state.providers.map((provider) => {
        if (provider.providerId !== item.providerId) return provider;
        return {
          ...provider,
          items: provider.items.map((candidate) => {
            if (cloudLibraryStableKey(candidate) !== cloudLibraryStableKey(item)) return candidate;
            return {
              ...candidate,
              files: candidate.files.map((candidateFile) =>
                cloudLibraryFileStableKey(candidateFile) === cloudLibraryFileStableKey(file)
                  ? { ...candidateFile, playbackUrl: url }
                  : candidateFile,
              ),
            };
          }),
        };
      }),
    }));
    return url;
  },

  clear: () => {
    set({ ...initialUiState, loadedApiKeys: {} });
  },
}));
