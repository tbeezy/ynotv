import { describe, it, expect } from 'vitest';
import { useSettingsStore } from '../settingsStore';
import { parseStripTags, shouldSyncStripTagsInput } from '../../utils/epgChannelMatch';

describe('epgAutomatch settings and stripTags handling', () => {
  it('correctly parses user input with trailing commas and whitespace', () => {
    expect(parseStripTags('VIP,')).toEqual(['vip']);
    expect(parseStripTags('VIP, ')).toEqual(['vip']);
    expect(parseStripTags('VIP, RAW,')).toEqual(['vip', 'raw']);
    expect(parseStripTags('VIP, RAW, ')).toEqual(['vip', 'raw']);
    expect(parseStripTags('VIP, RAW, 4K')).toEqual(['vip', 'raw', '4k']);
  });

  describe('shouldSyncStripTagsInput (prevents comma stripping regression)', () => {
    it('returns false when typing a trailing comma so the comma is not overwritten by store echo', () => {
      // User has typed "VIP" and then presses "," -> input is "VIP,"
      // Store has parsed ['vip']. shouldSync must return false so input is preserved.
      expect(shouldSyncStripTagsInput('VIP,', ['vip'])).toBe(false);
    });

    it('returns false when typing trailing space after comma', () => {
      expect(shouldSyncStripTagsInput('VIP, ', ['vip'])).toBe(false);
    });

    it('returns false when typing multiple words with trailing commas', () => {
      expect(shouldSyncStripTagsInput('VIP, RAW,', ['vip', 'raw'])).toBe(false);
      expect(shouldSyncStripTagsInput('VIP, RAW, ', ['vip', 'raw'])).toBe(false);
      expect(shouldSyncStripTagsInput('VIP, RAW, 4K,', ['vip', 'raw', '4k'])).toBe(false);
    });

    it('returns false when input preserves user casing or spacing differences', () => {
      expect(shouldSyncStripTagsInput('VIP, RAW', ['vip', 'raw'])).toBe(false);
      expect(shouldSyncStripTagsInput('vip,raw', ['vip', 'raw'])).toBe(false);
      expect(shouldSyncStripTagsInput('  VIP  ,   RAW  ', ['vip', 'raw'])).toBe(false);
    });

    it('returns true when store is updated with genuine external changes', () => {
      // Settings import or external reset
      expect(shouldSyncStripTagsInput('VIP, RAW', ['fhd', '4k'])).toBe(true);
      expect(shouldSyncStripTagsInput('VIP, RAW', [])).toBe(true);
      expect(shouldSyncStripTagsInput('', ['vip'])).toBe(true);
      expect(shouldSyncStripTagsInput('VIP', undefined)).toBe(true);
    });
  });

  describe('setEpgAutomatchStripTags store deduplication', () => {
    it('avoids re-creating state and re-notifying subscribers if tags array is identical', () => {
      useSettingsStore.getState().setEpgAutomatchStripTags(['vip', 'raw']);
      const ref1 = useSettingsStore.getState().epgAutomatchStripTags;
      expect(ref1).toEqual(['vip', 'raw']);

      // Calling again with same contents (e.g. when typing comma or space) preserves reference
      useSettingsStore.getState().setEpgAutomatchStripTags(['vip', 'raw']);
      const ref2 = useSettingsStore.getState().epgAutomatchStripTags;
      expect(ref2).toBe(ref1);

      // Calling with different contents updates the reference
      useSettingsStore.getState().setEpgAutomatchStripTags(['vip', 'raw', 'hevc']);
      const ref3 = useSettingsStore.getState().epgAutomatchStripTags;
      expect(ref3).toEqual(['vip', 'raw', 'hevc']);
      expect(ref3).not.toBe(ref1);
    });
  });
});
