import { useState, useCallback, useEffect, useRef } from 'react';
import { Bridge } from '../services/tauri-bridge';
import type { StoredChannel } from '../db';
import type { VodPlayInfo } from '../types/media';
import { resolvePlayUrl } from '../services/stream-resolver';
import { useSettingsStore } from '../stores/settingsStore';
import { logInfo, logWarn } from '../utils/logger';

export type PopoutContent =
  | { type: 'channel'; channel: StoredChannel }
  | { type: 'vod'; info: VodPlayInfo };

export interface PopoutPlayerState {
  isOpen: boolean;
  content: PopoutContent | null;
  isLoading: boolean;

  openPopout: (content: PopoutContent, options?: { stopMain?: boolean }) => Promise<void>;
  swapChannel: (channel: StoredChannel) => Promise<void>;
  swapVod: (info: VodPlayInfo) => Promise<void>;
  closePopout: () => Promise<void>;
  togglePause: () => Promise<void>;
  stopPlayback: () => Promise<void>;
  toggleFullscreen: () => Promise<void>;
  setPopoutVolume: (volume: number) => Promise<void>;
  setPopoutMuted: (muted: boolean) => Promise<void>;
  seekPopout: (seconds: number) => Promise<void>;
}

export function usePopoutPlayer(): PopoutPlayerState {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState<PopoutContent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const contentRef = useRef<PopoutContent | null>(null);

  useEffect(() => { contentRef.current = content; }, [content]);

  // Listen for backend popout events
  useEffect(() => {
    if (!Bridge.isTauri) return;
    let unlistenOpened: (() => void) | null = null;
    let unlistenClosed: (() => void) | null = null;
    let disposed = false;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('popout-opened', () => {
        setIsOpen(true);
      }).then((fn) => {
        if (disposed) fn();
        else unlistenOpened = fn;
      });

      listen('popout-closed', () => {
        setIsOpen(false);
        setContent(null);
        setIsLoading(false);
        // Notify usePlayback so it clears the intentional-stop flag and
        // resumes normal stream-death retry handling.
        window.dispatchEvent(new CustomEvent('ynotv:popout-closed'));
      }).then((fn) => {
        if (disposed) fn();
        else unlistenClosed = fn;
      });
    });

    return () => {
      disposed = true;
      unlistenOpened?.();
      unlistenClosed?.();
    };
  }, []);

  const openPopout = useCallback(async (
    newContent: PopoutContent,
    options?: { stopMain?: boolean }
  ) => {
    setIsLoading(true);

    try {
      let url: string;
      let userAgent: string | undefined;

      if (newContent.type === 'channel') {
        const resolved = await resolvePlayUrl(newContent.channel.source_id, newContent.channel.direct_url);
        url = resolved.url;
        userAgent = resolved.userAgent;
      } else {
        const resolved = await resolvePlayUrl(newContent.info.source_id || '', newContent.info.url);
        url = resolved.url;
        userAgent = resolved.userAgent;
      }

      // Popout settings are settings-store fields — read them synchronously
      // instead of paying an IPC getSettings round-trip per popout open.
      const pop = useSettingsStore.getState();
      const alwaysOnTop = pop.popoutAlwaysOnTop ?? false;
      const stopMain = pop.popoutStopMain ?? true;
      const customParams = pop.popoutMpvParamsEnabled ? (pop.popoutMpvParams ?? '') : '';

      // If already open, just swap the URL
      if (isOpen) {
        logInfo('[Popout] Already open, swapping to new URL');
        await Bridge.popoutLoad(url);
        setContent(newContent);
        setIsLoading(false);
      } else {
        logInfo('[Popout] Opening popout with URL:', url);
        await Bridge.popoutOpen(url, alwaysOnTop, customParams);
        setContent(newContent);
        setIsOpen(true);
        setIsLoading(false);
      }

      // Optionally set user-agent
      if (userAgent) {
        await Bridge.popoutSetProperty('user-agent', userAgent).catch(() => {});
      }

      // Optionally stop main player (based on settings or explicit override)
      const shouldStopMain = options?.stopMain !== undefined ? options.stopMain : stopMain;
      if (shouldStopMain) {
        // Signal to usePlayback that this stop is intentional so retry/watchdog
        // doesn't try to reconnect the main player.
        window.dispatchEvent(new CustomEvent('ynotv:intentional-stop'));
        await Bridge.stop().catch(() => {});
      }
    } catch (e) {
      logWarn('[Popout] Failed to open:', e);
      setIsLoading(false);
    }
  }, [isOpen]);

  const swapChannel = useCallback(async (channel: StoredChannel) => {
    if (!isOpen) {
      await openPopout({ type: 'channel', channel });
      return;
    }
    setIsLoading(true);
    try {
      const resolved = await resolvePlayUrl(channel.source_id, channel.direct_url);
      await Bridge.popoutLoad(resolved.url);
      if (resolved.userAgent) {
        await Bridge.popoutSetProperty('user-agent', resolved.userAgent).catch(() => {});
      }
      setContent({ type: 'channel', channel });
    } catch (e) {
      logWarn('[Popout] Failed to swap channel:', e);
    } finally {
      setIsLoading(false);
    }
  }, [isOpen, openPopout]);

  const swapVod = useCallback(async (info: VodPlayInfo) => {
    if (!isOpen) {
      await openPopout({ type: 'vod', info });
      return;
    }
    setIsLoading(true);
    try {
      const resolved = await resolvePlayUrl(info.source_id || '', info.url);
      await Bridge.popoutLoad(resolved.url);
      if (resolved.userAgent) {
        await Bridge.popoutSetProperty('user-agent', resolved.userAgent).catch(() => {});
      }
      setContent({ type: 'vod', info });
    } catch (e) {
      logWarn('[Popout] Failed to swap VOD:', e);
    } finally {
      setIsLoading(false);
    }
  }, [isOpen, openPopout]);

  const closePopout = useCallback(async () => {
    await Bridge.popoutClose();
    setIsOpen(false);
    setContent(null);
    setIsLoading(false);
  }, []);

  const setPopoutVolume = useCallback(async (volume: number) => {
    await Bridge.popoutSetProperty('volume', volume).catch(() => {});
  }, []);

  const setPopoutMuted = useCallback(async (muted: boolean) => {
    await Bridge.popoutSetProperty('mute', muted).catch(() => {});
  }, []);

  const togglePause = useCallback(async () => {
    await Bridge.popoutTogglePause().catch(() => {});
  }, []);

  const stopPlayback = useCallback(async () => {
    await Bridge.popoutStop().catch(() => {});
  }, []);

  const toggleFullscreen = useCallback(async () => {
    await Bridge.popoutToggleFullscreen().catch(() => {});
  }, []);

  const seekPopout = useCallback(async (seconds: number) => {
    await Bridge.popoutSeek(seconds).catch(() => {});
  }, []);

  return {
    isOpen,
    content,
    isLoading,
    openPopout,
    swapChannel,
    swapVod,
    closePopout,
    togglePause,
    stopPlayback,
    toggleFullscreen,
    setPopoutVolume,
    setPopoutMuted,
    seekPopout,
  };
}
