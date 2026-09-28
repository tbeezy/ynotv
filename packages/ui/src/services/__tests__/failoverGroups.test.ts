import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the (also hoisted) vi.mock factory below can reach them.
const mocks = vi.hoisted(() => ({
  groupCount: vi.fn(),
  clearGroups: vi.fn(),
  clearMembers: vi.fn(),
  bulkDeleteGroups: vi.fn(),
  deleteMembersWhere: vi.fn(),
  transactionScopeCount: vi.fn(),
}));

vi.mock('../../db', () => {
  const db = {
    failoverGroups: {
      count: () => mocks.groupCount(),
      clear: () => mocks.clearGroups(),
      bulkDelete: (keys: string[]) => mocks.bulkDeleteGroups(keys),
      toArray: vi.fn().mockResolvedValue([]),
    },
    failoverGroupMembers: {
      clear: () => mocks.clearMembers(),
      toArray: vi.fn().mockResolvedValue([]),
      where: vi.fn().mockReturnValue({
        anyOf: vi.fn().mockReturnValue({
          delete: () => mocks.deleteMembersWhere(),
        }),
      }),
    },
    channels: {
      where: vi.fn().mockReturnValue({
        anyOf: vi.fn().mockReturnValue({
          toArray: vi.fn().mockResolvedValue([]),
        }),
      }),
    },
    // Run the transaction scope straight away; we only care that both tables
    // are cleared inside it, not that Dexie is real.
    transaction: async (_mode: string, _tables: unknown, scope: () => Promise<void>) => {
      mocks.transactionScopeCount();
      return scope();
    },
  };
  return { db, updateFailoverMembersBatch: vi.fn() };
});

vi.mock('../../stores/sportsSettingsStore', () => ({
  useSportsSettingsStore: { getState: () => ({ autoSwapDeadStreams: false }) },
}));

vi.mock('../../stores/teamChannelLinksStore', () => ({
  useTeamChannelLinksStore: { getState: () => ({ ensureLoaded: async () => {}, links: [] }) },
  getTeamLinks: () => [],
}));

import { deleteAllFailoverGroups, deleteEmptyFailoverGroups, isFailoverGroupEmpty } from '../failover-groups';
import { db } from '../../db';

describe('deleteAllFailoverGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.groupCount.mockResolvedValue(4);
  });

  it('clears the groups and their members, and returns the number of groups removed', async () => {
    const removed = await deleteAllFailoverGroups();

    expect(removed).toBe(4);
    // Both tables must be cleared in one transaction, or deleting the groups
    // would leave orphaned member rows behind.
    expect(mocks.transactionScopeCount).toHaveBeenCalledTimes(1);
    expect(mocks.clearMembers).toHaveBeenCalledTimes(1);
    expect(mocks.clearGroups).toHaveBeenCalledTimes(1);
  });

  it('reports zero when there was nothing to delete', async () => {
    mocks.groupCount.mockResolvedValue(0);

    expect(await deleteAllFailoverGroups()).toBe(0);
  });
});

describe('deleteEmptyFailoverGroups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 early if targetGroupIds is empty array without querying groups or running a transaction', async () => {
    const count = await deleteEmptyFailoverGroups([]);
    expect(count).toBe(0);
    expect(mocks.transactionScopeCount).not.toHaveBeenCalled();
    expect(db.failoverGroups.toArray).not.toHaveBeenCalled();
  });

  it('deletes provided target group IDs and removes member mappings in a transaction', async () => {
    const count = await deleteEmptyFailoverGroups(['grp_empty_1', 'grp_empty_2']);

    expect(count).toBe(2);
    expect(mocks.transactionScopeCount).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMembersWhere).toHaveBeenCalledTimes(1);
    expect(mocks.bulkDeleteGroups).toHaveBeenCalledWith(['grp_empty_1', 'grp_empty_2']);
  });

  it('queries all groups and deletes only those with zero member rows when no target IDs are provided', async () => {
    vi.mocked(db.failoverGroups.toArray).mockResolvedValueOnce([
      { group_id: 'g1', name: 'Has Members', created_at: 100 },
      { group_id: 'g2', name: 'Empty Group', created_at: 200 },
    ] as any);
    vi.mocked(db.failoverGroupMembers.toArray).mockResolvedValueOnce([
      { id: 1, group_id: 'g1', stream_id: 'str1', priority: 0 },
    ] as any);

    const count = await deleteEmptyFailoverGroups();

    expect(count).toBe(1);
    expect(mocks.transactionScopeCount).toHaveBeenCalledTimes(1);
    expect(mocks.bulkDeleteGroups).toHaveBeenCalledWith(['g2']);
  });

  it('does NOT delete groups whose channels belong to disabled sources (F1 fix)', async () => {
    vi.mocked(db.failoverGroups.toArray).mockResolvedValueOnce([
      { group_id: 'g_disabled', name: 'Source Disabled', created_at: 100 },
      { group_id: 'g_empty', name: 'Truly Empty', created_at: 200 },
    ] as any);
    // g_disabled has member str_disabled in failoverGroupMembers
    vi.mocked(db.failoverGroupMembers.toArray).mockResolvedValueOnce([
      { id: 1, group_id: 'g_disabled', stream_id: 'str_disabled', priority: 0 },
    ] as any);

    const count = await deleteEmptyFailoverGroups();

    expect(count).toBe(1);
    expect(mocks.transactionScopeCount).toHaveBeenCalledTimes(1);
    expect(mocks.bulkDeleteGroups).toHaveBeenCalledWith(['g_empty']);
  });
});

describe('isFailoverGroupEmpty', () => {
  it('returns false if rawMemberCount > 0 even if memberCount is 0 (disabled source)', () => {
    expect(isFailoverGroupEmpty({ memberCount: 0, rawMemberCount: 1 })).toBe(false);
    expect(isFailoverGroupEmpty({ memberCount: 0, rawMemberCount: 3 })).toBe(false);
  });

  it('returns true if rawMemberCount is 0', () => {
    expect(isFailoverGroupEmpty({ memberCount: 0, rawMemberCount: 0 })).toBe(true);
  });

  it('falls back to memberCount when rawMemberCount is undefined', () => {
    expect(isFailoverGroupEmpty({ memberCount: 0 })).toBe(true);
    expect(isFailoverGroupEmpty({ memberCount: 2 })).toBe(false);
  });
});
