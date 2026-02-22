import { useCallback, useRef, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  useMultiview,
  type LayoutMode,
  type ViewerSlot,
  type MainSlot,
} from './useMultiview';

// Re-export SavedLayoutState for convenience
export type { LayoutMode } from './useMultiview';
export interface SavedLayoutState {
  layout: LayoutMode;
  mainChannel: {
    channelName: string | null;
    channelUrl: string | null;
  };
  slots: {
    id: 2 | 3 | 4;
    channelName: string | null;
    channelUrl: string | null;
    active: boolean;
  }[];
}

interface UseLayoutPersistenceOptions {
  enabled: boolean;
  initialSavedState?: SavedLayoutState | null;
  settingsLoaded?: boolean;
  mpvReady?: boolean;
  onLoadMainChannel?: (channelName: string, channelUrl: string) => void;
}

/**
 * Extended version of useMultiview that adds layout state persistence.
 * When enabled, saves the current layout and channels when switching layouts
 * and can restore them on startup.
 */
export function useLayoutPersistence(options: UseLayoutPersistenceOptions) {
  const { enabled, initialSavedState, settingsLoaded, mpvReady, onLoadMainChannel } = options;

  // Get base multiview functionality
  const multiview = useMultiview();
  const [isRestoring, setIsRestoring] = useState(false);
  const {
    layout,
    slots,
    switchLayout: baseSwitchLayout,
    sendToSlot: baseSendToSlot,
    swapWithMain: baseSwapWithMain,
    stopSlot: baseStopSlot,
    notifyMainLoaded: baseNotifyMainLoaded,
  } = multiview;

  // Track main slot state locally for persistence
  const mainSlotRef = useRef<MainSlot>({ channelName: null, channelUrl: null });

  // Keep a ref to the full saved state for cross-layout restoration
  const savedStateRef = useRef<SavedLayoutState | null>(null);

  // Master state that preserves ALL channel info across layout switches
  // This is never overwritten with partial data (like PiP state)
  const masterStateRef = useRef<SavedLayoutState | null>(null);

  // Track if we've done initial restore
  const hasRestoredRef = useRef(false);

  // Track slots in a ref so we always have latest values
  const slotsRef = useRef(slots);
  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  // Initialize refs from props if available
  useEffect(() => {
    if (initialSavedState && !savedStateRef.current) {
      savedStateRef.current = initialSavedState;
      masterStateRef.current = initialSavedState;
    }
  }, [initialSavedState]);

  /**
   * Build the current state snapshot from refs and layout
   */
  const buildCurrentState = useCallback((): SavedLayoutState => {
    return {
      layout,
      mainChannel: { ...mainSlotRef.current },
      slots: slotsRef.current.map((s) => ({ ...s })),
    };
  }, [layout]);

  /**
   * Save state using current refs (not React state which may be stale)
   * Updates master state incrementally to preserve channel info
   */
  const saveStateWithRefs = useCallback(async () => {
    if (!enabled) return;

    // Build new state from current refs
    const currentState = buildCurrentState();

    console.log('[useLayoutPersistence] Saving state:', currentState);

    // Update master state incrementally - merge current slots with master slots
    // This preserves channel info for slots that may be inactive in current layout (e.g., PiP)
    const masterState = masterStateRef.current;
    // Start with master slots (or current if no master), then overlay active current slots
    const baseSlots = masterState?.slots || currentState.slots;
    const updatedMasterState: SavedLayoutState = {
      ...currentState,
      slots: baseSlots.map((baseSlot) => {
        const currentSlot = currentState.slots.find((s) => s.id === baseSlot.id);
        // If slot is active now, use current data. Otherwise keep master/base data
        if (currentSlot?.active) {
          return currentSlot;
        }
        return baseSlot;
      }),
    };

    masterStateRef.current = updatedMasterState;
    savedStateRef.current = currentState;

    if (window.storage) {
      try {
        // Save the master state (with all channels) to storage
        await window.storage.updateSettings({ savedLayoutState: updatedMasterState });
        console.log('[useLayoutPersistence] Saved to storage');
      } catch (e) {
        console.error('[useLayoutPersistence] Failed to save:', e);
      }
    }
  }, [enabled, buildCurrentState]);

  /**
   * Notify that main channel loaded - tracks for persistence
   */
  const notifyMainLoaded = useCallback(
    (channelName: string, channelUrl: string) => {
      baseNotifyMainLoaded(channelName, channelUrl);
      mainSlotRef.current = { channelName, channelUrl };

      // Save state immediately
      if (enabled) {
        saveStateWithRefs();
      }
    },
    [baseNotifyMainLoaded, enabled, saveStateWithRefs]
  );

  /**
   * Switch layouts with state persistence.
   * Simplified: just save before switch, let baseSwitchLayout handle the actual work.
   */
  const switchLayout = useCallback(
    async (newLayout: LayoutMode) => {
      // Save current state BEFORE the switch
      if (enabled) {
        const stateBeforeSwitch = buildCurrentState();

        // Update master state - merge to preserve inactive slot data
        const masterState = masterStateRef.current;
        if (masterState) {
          // Start with master slots, overlay current active slots
          const mergedSlots = masterState.slots.map((masterSlot) => {
            const currentSlot = stateBeforeSwitch.slots.find((s) => s.id === masterSlot.id);
            // If slot is currently active, use current data. Otherwise keep master.
            return currentSlot?.active ? currentSlot : masterSlot;
          });
          masterStateRef.current = {
            ...stateBeforeSwitch,
            slots: mergedSlots,
          };
        } else {
          masterStateRef.current = stateBeforeSwitch;
        }

        savedStateRef.current = stateBeforeSwitch;

        console.log('[useLayoutPersistence] Saving before switch to', newLayout);
        if (window.storage) {
          try {
            await window.storage.updateSettings({
              savedLayoutState: masterStateRef.current,
            });
          } catch (e) {
            console.error('[useLayoutPersistence] Failed to pre-save state:', e);
          }
        }
      }

      // Perform the base layout switch - let useMultiview handle all the complexity
      await baseSwitchLayout(newLayout);

      // Post-switch: Update master state with the new layout so if we close,
      // the new layout is what we recall, rather than the stateBeforeSwitch.
      if (enabled && masterStateRef.current) {
        masterStateRef.current.layout = newLayout;
        if (window.storage) {
          window.storage.updateSettings({
            savedLayoutState: masterStateRef.current,
          }).catch((e) => console.error('[useLayoutPersistence] Failed to save post-switch state:', e));
        }
      }

      // After switching (and after startup restore is complete), restore slots for multiview layouts
      // But only if we're NOT switching to 'main' (main should clear everything)
      if (hasRestoredRef.current && enabled && newLayout !== 'main') {
        // Wait for layout to render, then restore any slots that should be active
        setTimeout(async () => {
          const savedState = masterStateRef.current;
          if (!savedState) return;

          // Get currently active slots from the base multiview
          const currentlyActiveSlots = new Set(
            slotsRef.current.filter(s => s.active).map(s => s.id)
          );

          // Determine which slots should be restored based on new layout
          const slotsToRestore =
            newLayout === 'pip'
              ? savedState.slots.filter((s) => s.id === 2 && s.active && s.channelUrl)
              : savedState.slots.filter((s) => s.active && s.channelUrl);

          console.log('[useLayoutPersistence] Restoring slots after switch to', newLayout, ':', slotsToRestore.map(s => s.id));

          // Only restore slots that aren't already active
          for (const slot of slotsToRestore) {
            if (!currentlyActiveSlots.has(slot.id)) {
              console.log('[useLayoutPersistence] Restoring slot', slot.id, ':', slot.channelName);
              await baseSendToSlot(slot.id, slot.channelName || '', slot.channelUrl || '');
              await new Promise((r) => setTimeout(r, 200));
            }
          }
        }, 300);
      }
    },
    [baseSwitchLayout, baseSendToSlot, enabled, buildCurrentState]
  );

  /**
   * Send a channel to a slot with persistence
   */
  const sendToSlot = useCallback(
    async (slotId: 2 | 3 | 4, channelName: string, channelUrl: string) => {
      console.log('[useLayoutPersistence] sendToSlot:', slotId, channelName);

      await baseSendToSlot(slotId, channelName, channelUrl);

      // Save state after loading
      if (enabled) {
        await saveStateWithRefs();
      }
    },
    [baseSendToSlot, enabled, saveStateWithRefs]
  );

  /**
   * Swap main with a slot with persistence
   */
  const swapWithMain = useCallback(
    async (slotId: 2 | 3 | 4, currentSlots: ViewerSlot[]) => {
      const slot = currentSlots.find((s) => s.id === slotId);
      if (slot?.channelUrl) {
        mainSlotRef.current = {
          channelName: slot.channelName,
          channelUrl: slot.channelUrl,
        };
      }

      await baseSwapWithMain(slotId, currentSlots);

      if (enabled) {
        await saveStateWithRefs();
      }
    },
    [baseSwapWithMain, enabled, saveStateWithRefs]
  );

  /**
   * Stop a slot with persistence
   */
  const stopSlot = useCallback(
    async (slotId: 2 | 3 | 4) => {
      await baseStopSlot(slotId);

      if (enabled) {
        await saveStateWithRefs();
      }
    },
    [baseStopSlot, enabled, saveStateWithRefs]
  );

  /**
   * Restore layout state on initial mount (for startup)
   * This runs ONCE when the app starts and restores the saved layout and channels.
   */
  const restoreLayoutState = useCallback(
    async (state: SavedLayoutState) => {
      if (hasRestoredRef.current) return;
      hasRestoredRef.current = true;

      console.log('[useLayoutPersistence] Restoring layout state:', state);

      // Step 1: Switch to the saved layout first (this mounts MultiviewLayout)
      // Use baseSwitchLayout directly to avoid triggering the post-switch restore logic
      await baseSwitchLayout(state.layout);

      // Step 2: Wait for layout to fully render
      // Need to wait for MultiviewLayout to mount and DOM elements to exist
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Step 3: Load main channel if present
      if (state.mainChannel.channelUrl) {
        console.log(
          '[useLayoutPersistence] Restoring main channel:',
          state.mainChannel.channelName
        );
        if (onLoadMainChannel) {
          onLoadMainChannel(
            state.mainChannel.channelName || '',
            state.mainChannel.channelUrl
          );
        } else {
          await invoke('mpv_load', { url: state.mainChannel.channelUrl }).catch(
            (e) => console.warn('[useLayoutPersistence] Failed to restore main:', e)
          );
        }
        mainSlotRef.current = { ...state.mainChannel };
        baseNotifyMainLoaded(
          state.mainChannel.channelName || '',
          state.mainChannel.channelUrl
        );
      }

      // Step 4: Wait for main to load and React to render
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Step 5: Load secondary slots - now MultiviewLayout should be fully rendered
      // Filter for slots that should be active
      const slotsToRestore = state.slots.filter((s) => s.active && s.channelUrl);
      console.log('[useLayoutPersistence] Restoring', slotsToRestore.length, 'slots:', slotsToRestore.map(s => ({ id: s.id, name: s.channelName })));

      for (const slot of slotsToRestore) {
        console.log('[useLayoutPersistence] Restoring slot', slot.id, ':', slot.channelName);
        await baseSendToSlot(
          slot.id,
          slot.channelName || '',
          slot.channelUrl || '',
          true // force - bypass tab mode check during restore
        );
        // Wait between slots for React to render mini media bars
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      // Update saved state refs to match restored state
      savedStateRef.current = state;
      masterStateRef.current = state;

      console.log('[useLayoutPersistence] Layout state restored successfully');
    },
    [baseSwitchLayout, baseNotifyMainLoaded, baseSendToSlot, onLoadMainChannel]
  );

  // Restore on mount - run once when all conditions are met
  const restoreAttemptedRef = useRef(false);
  const initialStateRef = useRef(initialSavedState);
  initialStateRef.current = initialSavedState;
  const restoreFnRef = useRef(restoreLayoutState);
  restoreFnRef.current = restoreLayoutState;

  useEffect(() => {
    // Skip if already attempted or conditions not met
    if (
      restoreAttemptedRef.current ||
      !enabled ||
      !initialStateRef.current ||
      !settingsLoaded ||
      !mpvReady ||
      hasRestoredRef.current
    ) {
      return;
    }

    restoreAttemptedRef.current = true;
    console.log('[useLayoutPersistence] Triggering restore with state:', initialStateRef.current);
    setIsRestoring(true);
    restoreFnRef.current(initialStateRef.current).then(() => {
      setIsRestoring(false);
    });
    // Only depend on the boolean flags, not the objects/functions
  }, [enabled, settingsLoaded, mpvReady]);

  // Save state before window closes
  useEffect(() => {
    if (!enabled) return;

    const handleBeforeUnload = () => {
      // Synchronously save master state to localStorage for reliability on shutdown
      // Use master state to ensure all channel info is preserved
      const stateToSave = masterStateRef.current || buildCurrentState();

      try {
        const existing = localStorage.getItem('app-settings');
        const parsed = existing ? JSON.parse(existing) : {};
        localStorage.setItem(
          'app-settings',
          JSON.stringify({
            ...parsed,
            savedLayoutState: stateToSave,
          })
        );
        console.log('[useLayoutPersistence] Saved master state on beforeunload:', stateToSave);
      } catch (e) {
        console.error('[useLayoutPersistence] Failed to save on unload:', e);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [enabled, buildCurrentState]);

  return {
    ...multiview,
    switchLayout,
    sendToSlot,
    swapWithMain,
    stopSlot,
    notifyMainLoaded,
    saveLayoutState: saveStateWithRefs,
    restoreLayoutState,
    mainChannel: mainSlotRef.current,
    isRestoring,
  };
}
