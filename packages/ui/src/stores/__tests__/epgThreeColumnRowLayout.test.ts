import { describe, it, expect, beforeEach } from 'vitest';
import {
  useUIStore,
  getInitialEpgThreeColumnRowLayout,
  isThreeColumnRowActive,
  isVerticalPreviewLayoutActive,
} from '../uiStore';

describe('epgThreeColumnRowLayout UI state, initialization, and layout gating', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getInitialEpgThreeColumnRowLayout', () => {
    it('returns false when localStorage has no app-settings', () => {
      expect(getInitialEpgThreeColumnRowLayout()).toBe(false);
    });

    it('returns false when app-settings is empty, unparseable, or missing the key', () => {
      localStorage.setItem('app-settings', '');
      expect(getInitialEpgThreeColumnRowLayout()).toBe(false);

      localStorage.setItem('app-settings', '{ invalid-json');
      expect(getInitialEpgThreeColumnRowLayout()).toBe(false);

      localStorage.setItem('app-settings', JSON.stringify({ otherSetting: true }));
      expect(getInitialEpgThreeColumnRowLayout()).toBe(false);
    });

    it('reads true when app-settings has epgThreeColumnRowLayout: true', () => {
      localStorage.setItem('app-settings', JSON.stringify({ epgThreeColumnRowLayout: true }));
      expect(getInitialEpgThreeColumnRowLayout()).toBe(true);
    });

    it('reads false when app-settings has epgThreeColumnRowLayout: false', () => {
      localStorage.setItem('app-settings', JSON.stringify({ epgThreeColumnRowLayout: false }));
      expect(getInitialEpgThreeColumnRowLayout()).toBe(false);
    });
  });

  describe('store setter and persistence', () => {
    it('updates store state and persists to app-settings while preserving other settings', () => {
      localStorage.setItem('app-settings', JSON.stringify({ preexistingKey: 123 }));

      useUIStore.getState().setEpgThreeColumnRowLayout(true);
      expect(useUIStore.getState().epgThreeColumnRowLayout).toBe(true);

      let stored = JSON.parse(localStorage.getItem('app-settings') || '{}');
      expect(stored.epgThreeColumnRowLayout).toBe(true);
      expect(stored.preexistingKey).toBe(123);

      useUIStore.getState().setEpgThreeColumnRowLayout(false);
      expect(useUIStore.getState().epgThreeColumnRowLayout).toBe(false);

      stored = JSON.parse(localStorage.getItem('app-settings') || '{}');
      expect(stored.epgThreeColumnRowLayout).toBe(false);
      expect(stored.preexistingKey).toBe(123);
    });
  });

  describe('isThreeColumnRowActive gate', () => {
    it('returns false when both flags are disabled', () => {
      expect(isThreeColumnRowActive(false, false)).toBe(false);
    });

    it('returns false when row layout is enabled but 3-column view is disabled (inert sub-toggle)', () => {
      expect(isThreeColumnRowActive(false, true)).toBe(false);
    });

    it('returns false when 3-column view is enabled but row layout is disabled (standard vertical layout)', () => {
      expect(isThreeColumnRowActive(true, false)).toBe(false);
    });

    it('returns true only when both 3-column view and row layout are enabled (ultrawide row view)', () => {
      expect(isThreeColumnRowActive(true, true)).toBe(true);
    });
  });

  describe('isVerticalPreviewLayoutActive gate', () => {
    it('returns true for standard 3-column stacked layout (sized by height)', () => {
      const isAltLayout = true;
      const isRowLayout = false;
      expect(isVerticalPreviewLayoutActive(isAltLayout, isRowLayout)).toBe(true);
    });

    it('returns false for 3-column row layout (sized by width/flex instead of height)', () => {
      const isAltLayout = true;
      const isRowLayout = true;
      expect(isVerticalPreviewLayoutActive(isAltLayout, isRowLayout)).toBe(false);
    });

    it('returns true for 2-column alternate view', () => {
      const isAltLayout = true;
      const isRowLayout = false;
      expect(isVerticalPreviewLayoutActive(isAltLayout, isRowLayout)).toBe(true);
    });

    it('returns false for traditional 2-column layout', () => {
      const isAltLayout = false;
      const isRowLayout = false;
      expect(isVerticalPreviewLayoutActive(isAltLayout, isRowLayout)).toBe(false);
    });
  });
});
