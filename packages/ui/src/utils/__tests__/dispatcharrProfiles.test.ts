import { describe, expect, it } from 'vitest';
import type { Source } from '@ynotv/core';
import {
  expandDispatcharrProfileSources,
  expandSidebarOrderForDispatcharrProfiles,
  formatDispatcharrProfileBadge,
  getSelectedDispatcharrProfileIds,
  isDispatcharrAllChannels,
  makeDispatcharrProfileCategoryId,
  makeDispatcharrProfileDisplayName,
  makeDispatcharrVirtualSourceId,
  parseDispatcharrProfileCategoryId,
  parseDispatcharrVirtualSourceId,
  resolveRealDispatcharrSourceId,
  toLegacyDispatcharrProfileFields,
} from '../dispatcharrProfiles';

describe('getSelectedDispatcharrProfileIds', () => {
  it('prefers multi-select ids', () => {
    expect(
      getSelectedDispatcharrProfileIds({
        dispatcharr_selected_profile_ids: [5, 7],
        dispatcharr_selected_profile_id: 99,
      })
    ).toEqual([5, 7]);
  });

  it('falls back to legacy single id', () => {
    expect(
      getSelectedDispatcharrProfileIds({
        dispatcharr_selected_profile_id: 42,
      })
    ).toEqual([42]);
  });

  it('returns empty for all channels', () => {
    expect(getSelectedDispatcharrProfileIds({})).toEqual([]);
    expect(getSelectedDispatcharrProfileIds({ dispatcharr_selected_profile_ids: [] })).toEqual([]);
    expect(isDispatcharrAllChannels({})).toBe(true);
  });
});

describe('composite category / virtual source ids', () => {
  it('round-trips profile category ids', () => {
    const id = makeDispatcharrProfileCategoryId(10, '55');
    expect(id).toBe('dp:10:55');
    expect(parseDispatcharrProfileCategoryId(id)).toEqual({ profileId: 10, groupId: '55' });
    expect(parseDispatcharrProfileCategoryId('plain')).toBeNull();
  });

  it('round-trips virtual source ids', () => {
    const id = makeDispatcharrVirtualSourceId('src-abc', 3);
    expect(id).toBe('src-abc::dp:3');
    expect(parseDispatcharrVirtualSourceId(id)).toEqual({ sourceId: 'src-abc', profileId: 3 });
    expect(resolveRealDispatcharrSourceId(id)).toBe('src-abc');
    expect(resolveRealDispatcharrSourceId('src-abc')).toBe('src-abc');
  });

  it('builds display names', () => {
    expect(makeDispatcharrProfileDisplayName('Dispatcharr', 'TELUS')).toBe('Dispatcharr-TELUS');
  });
});

describe('toLegacyDispatcharrProfileFields / badge', () => {
  it('stores single id as legacy; clears for multi/all', () => {
    expect(toLegacyDispatcharrProfileFields([9], { '9': 'A' })).toEqual({
      dispatcharr_selected_profile_id: 9,
      dispatcharr_selected_profile_name: 'A',
    });
    expect(toLegacyDispatcharrProfileFields([1, 2], { '1': 'A', '2': 'B' })).toEqual({
      dispatcharr_selected_profile_id: null,
      dispatcharr_selected_profile_name: undefined,
    });
  });

  it('formats badge text', () => {
    expect(
      formatDispatcharrProfileBadge(
        {
          dispatcharr_selected_profile_ids: [1, 2],
          dispatcharr_selected_profile_names: { '1': 'A', '2': 'B' },
        },
        'All channels'
      )
    ).toBe('A, B');
    expect(formatDispatcharrProfileBadge({}, 'All channels')).toBe('All channels');
  });
});

describe('expandDispatcharrProfileSources', () => {
  const source = {
    id: 'src1',
    name: 'Dispatcharr',
    type: 'dispatcharr' as const,
    url: 'http://x',
    dispatcharr_selected_profile_ids: [10, 20],
    dispatcharr_selected_profile_names: { '10': 'A', '20': 'B' },
  } satisfies Partial<Source> & { id: string; name: string; type: 'dispatcharr'; url: string };

  it('splits into virtual headers and filters categories per profile', () => {
    const grouped = [
      {
        sourceId: 'src1',
        categories: [
          { category_id: 'dp:10:1', category_name: 'Sports', channelCount: 2 },
          { category_id: 'dp:10:2', category_name: 'News', channelCount: 1 },
          { category_id: 'dp:20:1', category_name: 'Sports', channelCount: 3 },
          { category_id: '99', category_name: 'Other', channelCount: 9 },
        ],
      },
    ];

    const { groups, virtualNames } = expandDispatcharrProfileSources(grouped, [source]);

    expect(groups).toHaveLength(2);
    expect(groups[0].sourceId).toBe('src1::dp:10');
    expect(groups[0].categories.map((c) => c.category_id)).toEqual(['dp:10:1', 'dp:10:2']);
    expect(groups[1].sourceId).toBe('src1::dp:20');
    expect(groups[1].categories.map((c) => c.category_id)).toEqual(['dp:20:1']);
    expect(virtualNames['src1::dp:10']).toBe('Dispatcharr-A');
    expect(virtualNames['src1::dp:20']).toBe('Dispatcharr-B');
  });

  it('leaves all-channels sources unchanged', () => {
    const allSource = { ...source, dispatcharr_selected_profile_ids: [] };
    const grouped = [
      {
        sourceId: 'src1',
        categories: [{ category_id: '1', category_name: 'Sports', channelCount: 2 }],
      },
    ];
    const { groups, virtualNames } = expandDispatcharrProfileSources(grouped, [allSource]);
    expect(groups).toEqual(grouped);
    expect(virtualNames).toEqual({});
  });
});

describe('expandSidebarOrderForDispatcharrProfiles', () => {
  it('replaces a multi-profile source with virtual ids in place', () => {
    const order = ['other', 'src1', 'playlist:p1'];
    const expanded = expandSidebarOrderForDispatcharrProfiles(order, [
      {
        id: 'src1',
        type: 'dispatcharr',
        dispatcharr_selected_profile_ids: [10, 20],
      },
    ]);
    expect(expanded).toEqual(['other', 'src1::dp:10', 'src1::dp:20', 'playlist:p1']);
  });
});
