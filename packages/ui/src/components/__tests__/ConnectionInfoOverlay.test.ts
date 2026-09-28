import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StalkerClient } from '@ynotv/local-adapter';
import {
  formatExpiryDateDisplay,
  resolveStreamTitle,
  sanitizeServerDisplayUrl,
  fetchProviderConnectionInfo,
  AutoDismissController,
} from '../../services/connectionInfo';
import { DEFAULT_SHORTCUTS, formatShortcutKey } from '../../constants/shortcuts';
import type { StoredChannel } from '../../db';
import type { VodPlayInfo } from '../../types/media';

describe('ConnectionInfoOverlay & connectionInfo service', () => {
  describe('formatExpiryDateDisplay', () => {
    it('returns "Unlimited" for null, undefined, 0, or "0"', () => {
      expect(formatExpiryDateDisplay(null)).toBe('Unlimited');
      expect(formatExpiryDateDisplay(undefined)).toBe('Unlimited');
      expect(formatExpiryDateDisplay(0)).toBe('Unlimited');
      expect(formatExpiryDateDisplay('0')).toBe('Unlimited');
      expect(formatExpiryDateDisplay('null')).toBe('Unlimited');
      expect(formatExpiryDateDisplay('')).toBe('Unlimited');
    });

    it('formats a Unix epoch timestamp (seconds) into a readable date', () => {
      // 1798329600 = Dec 27, 2026 00:00:00 UTC
      const formatted = formatExpiryDateDisplay('1798329600');
      expect(formatted).toMatch(/2026/);
      expect(formatted).toMatch(/December|Dec/);
    });

    it('formats string dates with "at" separator (Xtream style)', () => {
      const formatted = formatExpiryDateDisplay('August 18, 2026 at 12:00 am');
      expect(formatted).toMatch(/August/);
      expect(formatted).toMatch(/18/);
      expect(formatted).toMatch(/2026/);
    });

    it('preserves raw text if unparseable', () => {
      expect(formatExpiryDateDisplay('Lifetime VIP')).toBe('Lifetime VIP');
    });
  });

  describe('resolveStreamTitle', () => {
    it('resolves live channel name using alias if present', () => {
      const channel: Partial<StoredChannel> = {
        name: 'ESPN (HD) [RAW]',
        alias: 'ESPN HD',
        source_id: 'src_1',
      };
      expect(resolveStreamTitle(channel as StoredChannel)).toBe('ESPN HD');
    });

    it('resolves live channel name with catchup program title', () => {
      const channel: Partial<StoredChannel> = {
        name: 'HBO',
        source_id: 'src_1',
      };
      const catchup = { programTitle: 'Inception' };
      expect(resolveStreamTitle(channel as StoredChannel, null, catchup)).toBe('HBO · Inception');
    });

    it('resolves VOD movie with year', () => {
      const vod: Partial<VodPlayInfo> = {
        type: 'movie',
        title: 'Interstellar',
        year: '2014',
      };
      expect(resolveStreamTitle(null, vod as VodPlayInfo)).toBe('Interstellar (2014)');
    });

    it('resolves VOD series with episode info', () => {
      const vod: Partial<VodPlayInfo> = {
        type: 'series',
        title: 'Breaking Bad',
        episodeInfo: 'S5 E14 · Ozymandias',
      };
      expect(resolveStreamTitle(null, vod as VodPlayInfo)).toBe('Breaking Bad · S5 E14 · Ozymandias');
    });

    it('returns undefined if no channel or VOD is active', () => {
      expect(resolveStreamTitle(null, null)).toBeUndefined();
    });
  });

  describe('sanitizeServerDisplayUrl', () => {
    it('removes username and password credentials from server URLs', () => {
      const clean = sanitizeServerDisplayUrl('http://user:pass@provider.stream.tv:8080/live');
      expect(clean).toBe('http://provider.stream.tv:8080');
      expect(clean).not.toContain('pass');
      expect(clean).not.toContain('user');
    });

    it('extracts protocol and host cleanly', () => {
      expect(sanitizeServerDisplayUrl('https://ott.example.com/api/v1')).toBe('https://ott.example.com');
    });

    it('handles undefined input gracefully', () => {
      expect(sanitizeServerDisplayUrl(undefined)).toBeUndefined();
    });
  });

  describe('fetchProviderConnectionInfo virtual sources & limits', () => {
    it('returns Unlimited max connections for jellyfin virtual source', async () => {
      const stats = await fetchProviderConnectionInfo('jellyfin');
      expect(stats.sourceName).toBe('Jellyfin');
      expect(stats.activeConnections).toBe('1');
      expect(stats.maxConnections).toBe('Unlimited');
      expect(stats.expiryDate).toBe('Unlimited');
    });

    it('returns Unlimited max connections for stremio virtual source', async () => {
      const vod: Partial<VodPlayInfo> = { title: 'Dune', addonName: 'Torrentio' };
      const stats = await fetchProviderConnectionInfo('stremio', null, vod as VodPlayInfo);
      expect(stats.sourceName).toBe('Stremio (Torrentio)');
      expect(stats.activeConnections).toBe('1');
      expect(stats.maxConnections).toBe('Unlimited');
      expect(stats.expiryDate).toBe('Unlimited');
    });

    it('returns Unlimited max connections for nuvio and local virtual sources', async () => {
      const nuvioStats = await fetchProviderConnectionInfo('nuvio');
      expect(nuvioStats.maxConnections).toBe('Unlimited');

      const localStats = await fetchProviderConnectionInfo('local');
      expect(localStats.maxConnections).toBe('Unlimited');
    });

    // NOTE: All credentials below (e.g. 00:1A:79:00:11:22, demo/secret) are synthetic mock fixtures.
    it('returns N/A max connections for Stalker portal when source.max_connections is not set', async () => {
      vi.spyOn(StalkerClient.prototype, 'getAccountInfo').mockResolvedValueOnce({
        mac: '00:1A:79:00:11:22',
        expiry: '1798329600',
      });

      (window as any).storage = {
        getSource: async () => ({
          data: {
            id: 'stalker_1',
            name: 'Stalker Test',
            type: 'stalker',
            url: 'http://stalker.portal.example:8080/c/',
            mac: '00:1A:79:00:11:22',
            meta: { expiry_date: '1798329600' },
          },
        }),
      };

      const stats = await fetchProviderConnectionInfo('stalker_1');
      expect(stats.sourceType).toBe('Stalker Portal');
      expect(stats.maxConnections).toBe('N/A');
      expect(stats.activeConnections).toBe('1');
      expect(stats.isCachedFallback).toBe(false);
      expect(stats.serverUrl).toBe('http://stalker.portal.example:8080');
    });

    it('throws when Stalker portal fails and no cached metadata is available', async () => {
      vi.spyOn(StalkerClient.prototype, 'getAccountInfo').mockResolvedValueOnce({
        mac: '00:1A:79:00:11:22',
        error: 'Portal handshake rejected',
      });

      (window as any).storage = {
        getSource: async () => ({
          data: {
            id: 'stalker_fail',
            name: 'Stalker Fail',
            type: 'stalker',
            url: 'http://stalker.fail.example:8080/c/',
            mac: '00:1A:79:00:11:22',
          },
        }),
      };

      await expect(fetchProviderConnectionInfo('stalker_fail')).rejects.toThrow('Portal handshake rejected');
    });

    it('returns Unlimited max connections for Xtream fallback when max_connections is missing or "0"', async () => {
      (window as any).storage = {
        getSource: async () => ({
          data: {
            id: 'xtream_1',
            name: 'Xtream Test',
            type: 'xtream',
            url: 'http://xtream.example:8080',
            username: 'demo',
            password: 'secret',
            meta: {
              active_cons: '1',
              max_connections: '0',
              expiry_date: '1798329600',
            },
          },
        }),
      };

      const stats = await fetchProviderConnectionInfo('xtream_1');
      expect(stats.sourceType).toBe('Xtream Codes');
      expect(stats.maxConnections).toBe('Unlimited');
      expect(stats.activeConnections).toBe('1');
      expect(stats.serverUrl).toBe('http://xtream.example:8080');
    });
  });

  describe('AutoDismissController (Anti-starvation countdown timer)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('ticks down every 1000ms and calls onClose at 0', () => {
      const onClose = vi.fn();
      const ticks: number[] = [];
      const controller = new AutoDismissController({
        initialSeconds: 5,
        onClose,
        onTick: (sec) => ticks.push(sec),
      });

      expect(controller.getIsRunning()).toBe(false);
      controller.start();
      expect(controller.getIsRunning()).toBe(true);
      expect(controller.getSecondsRemaining()).toBe(5);

      vi.advanceTimersByTime(1000);
      expect(controller.getSecondsRemaining()).toBe(4);

      vi.advanceTimersByTime(3000);
      expect(controller.getSecondsRemaining()).toBe(1);
      expect(onClose).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(controller.getSecondsRemaining()).toBe(0);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(ticks).toEqual([4, 3, 2, 1, 0]);

      controller.stop();
      expect(controller.getIsRunning()).toBe(false);
    });

    it('does NOT starve or restart countdown when onClose is updated rapidly (e.g. 4x/sec render rate)', () => {
      let currentOnClose = vi.fn();
      const controller = new AutoDismissController({
        initialSeconds: 5,
        onClose: () => currentOnClose(),
      });

      controller.start();

      // Simulate 4 renders per second (every 250ms) passing a new callback identity
      for (let i = 0; i < 8; i++) {
        vi.advanceTimersByTime(250);
        currentOnClose = vi.fn();
        controller.updateOnClose(currentOnClose);
      }

      // After 2000ms total, countdown should be exactly 3s remaining, NOT stuck at 5s!
      expect(controller.getSecondsRemaining()).toBe(3);

      controller.stop();
    });

    it('pauses countdown on hover and resumes on unhover', () => {
      const onClose = vi.fn();
      const controller = new AutoDismissController({
        initialSeconds: 5,
        onClose,
      });

      controller.start();
      vi.advanceTimersByTime(1000);
      expect(controller.getSecondsRemaining()).toBe(4);

      // Mouse enters card -> pause
      controller.setPaused(true);
      expect(controller.getIsPaused()).toBe(true);

      vi.advanceTimersByTime(3000);
      // Remained paused, still 4
      expect(controller.getSecondsRemaining()).toBe(4);

      // Mouse leaves card -> resume with reset
      controller.reset(3);
      controller.setPaused(false);
      expect(controller.getSecondsRemaining()).toBe(3);

      vi.advanceTimersByTime(3000);
      expect(controller.getSecondsRemaining()).toBe(0);
      expect(onClose).toHaveBeenCalledTimes(1);

      controller.stop();
    });

    it('resets countdown when user clicks Refresh', () => {
      const controller = new AutoDismissController({
        initialSeconds: 5,
        onClose: vi.fn(),
      });

      controller.start();
      vi.advanceTimersByTime(3000);
      expect(controller.getSecondsRemaining()).toBe(2);

      // Click refresh
      controller.reset(5);
      expect(controller.getSecondsRemaining()).toBe(5);

      vi.advanceTimersByTime(1000);
      expect(controller.getSecondsRemaining()).toBe(4);

      controller.stop();
    });

    it('keeps a hover-paused countdown paused when Refresh resets the timer', () => {
      const onClose = vi.fn();
      const controller = new AutoDismissController({ initialSeconds: 5, onClose });

      controller.start();
      vi.advanceTimersByTime(1000);
      expect(controller.getSecondsRemaining()).toBe(4);

      // Pointer is over the card -> the component pauses the countdown
      controller.setPaused(true);

      // The user clicks Refresh while still hovering: the component calls reset(5)
      controller.reset(5);
      expect(controller.getIsPaused()).toBe(true);
      expect(controller.getSecondsRemaining()).toBe(5);

      // Remains paused: ticks neither advance the countdown nor dismiss the card
      vi.advanceTimersByTime(10000);
      expect(controller.getSecondsRemaining()).toBe(5);
      expect(onClose).not.toHaveBeenCalled();

      // Pointer leaves -> the component resets to 3 and unpauses
      controller.reset(3);
      controller.setPaused(false);

      vi.advanceTimersByTime(3000);
      expect(controller.getSecondsRemaining()).toBe(0);
      expect(onClose).toHaveBeenCalledTimes(1);

      controller.stop();
    });

    it('clears a stale hover pause on start() so a reopened card always counts down', () => {
      const onClose = vi.fn();
      const controller = new AutoDismissController({ initialSeconds: 5, onClose });

      // Hovered, then dismissed while the pointer was still over the card
      controller.start();
      controller.setPaused(true);
      controller.stop();
      expect(controller.getIsPaused()).toBe(true);

      // Reopened: the open effect runs reset(5) + start()
      controller.reset(5);
      controller.start();
      expect(controller.getIsPaused()).toBe(false);

      vi.advanceTimersByTime(5000);
      expect(controller.getSecondsRemaining()).toBe(0);
      expect(onClose).toHaveBeenCalledTimes(1);

      controller.stop();
    });

    it('keeps the timer running through reset() so a stream change never restarts it', () => {
      const onClose = vi.fn();
      const controller = new AutoDismissController({ initialSeconds: 5, onClose });

      expect(controller.getIsRunning()).toBe(false);
      controller.start();
      expect(controller.getIsRunning()).toBe(true);

      // The open effect only calls start() when the timer is not already running,
      // so reset() must leave a live timer alone: zapping a channel resets the
      // countdown without resuming a hover pause.
      controller.setPaused(true);
      controller.reset(5);
      expect(controller.getIsRunning()).toBe(true);
      expect(controller.getIsPaused()).toBe(true);

      vi.advanceTimersByTime(5000);
      expect(controller.getSecondsRemaining()).toBe(5);
      expect(onClose).not.toHaveBeenCalled();

      controller.setPaused(false);
      vi.advanceTimersByTime(5000);
      expect(controller.getSecondsRemaining()).toBe(0);
      expect(onClose).toHaveBeenCalledTimes(1);

      controller.stop();
      expect(controller.getIsRunning()).toBe(false);
    });
  });

  describe('Keyboard Shortcuts Registration', () => {
    it('registers toggleConnectionInfo in DEFAULT_SHORTCUTS with default key "o"', () => {
      expect(DEFAULT_SHORTCUTS.toggleConnectionInfo).toBe('o');
    });

    it('formats toggleConnectionInfo key for HUD overlay display', () => {
      expect(formatShortcutKey('o')).toBe('O');
      expect(formatShortcutKey('a')).toBe('A');
      expect(formatShortcutKey('MouseBack')).toBe('Mouse Back (X1)');
      expect(formatShortcutKey('')).toBe('');
    });
  });
});

