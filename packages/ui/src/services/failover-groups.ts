import { db, updateFailoverMembersBatch } from '../db';
import i18n from '../i18n';
import type { FailoverGroup, StoredChannel } from '../db';
import { useSportsSettingsStore } from '../stores/sportsSettingsStore';
import { useTeamChannelLinksStore, getTeamLinks } from '../stores/teamChannelLinksStore';

/** Get the full ordered member list for a group, with channel data joined */
export async function getFailoverGroupMembers(
  groupId: string
): Promise<Array<{ stream_id: string; priority: number; name: string; stream_icon?: string; source_id?: string; category_ids?: string | string[] }>> {
  const members = await db.failoverGroupMembers
    .where('group_id')
    .equals(groupId)
    .sortBy('priority');
  if (!members.length) return [];
  const streamIds = members.map(m => m.stream_id);
  const channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();

  // Load enabled sources to filter
  const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
  const enabledSourceIds = new Set(sourcesResult.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || []);

  const channelMap = new Map(channels.map(c => [c.stream_id, c]));
  const result: Array<{ stream_id: string; priority: number; name: string; stream_icon?: string; source_id?: string; category_ids?: string | string[] }> = [];
  for (const m of members) {
    const ch = channelMap.get(m.stream_id);
    if (ch && ch.name && enabledSourceIds.has(ch.source_id)) {
      result.push({
        stream_id: m.stream_id,
        priority: m.priority,
        name: ch.name,
        stream_icon: ch.stream_icon,
        source_id: ch.source_id,
        category_ids: ch.category_ids,
      });
    }
  }
  return result;
}

/** Given a stream_id linked to a sports team, return ordered candidate backup channels after it */
export async function getTeamFailoverCandidatesAfter(
  startStreamId: string
): Promise<StoredChannel[]> {
  await useTeamChannelLinksStore.getState().ensureLoaded();
  const links = useTeamChannelLinksStore.getState().links;

  // Find link matching startStreamId
  const match = links.find((l) => l.stream_id === startStreamId);
  if (!match) return [];

  const teamLinks = getTeamLinks(links, match.league_id, match.team_id);
  if (teamLinks.length <= 1) return [];

  const startIndex = teamLinks.findIndex((l) => l.stream_id === startStreamId);
  if (startIndex === -1) return [];

  const candidateLinks = teamLinks.slice(startIndex + 1);
  if (candidateLinks.length === 0) return [];

  const streamIds = candidateLinks.map((l) => l.stream_id);
  const channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
  const channelMap = new Map(channels.map((c) => [c.stream_id, c]));

  // Load enabled sources to filter
  const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
  const enabledSourceIds = new Set(
    sourcesResult.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || []
  );

  const result: StoredChannel[] = [];
  for (const link of candidateLinks) {
    const ch = channelMap.get(link.stream_id);
    if (ch && ch.enabled !== false && (!ch.source_id || enabledSourceIds.has(ch.source_id))) {
      result.push(ch);
    } else if (!ch && link.stream_id && (!link.source_id || enabledSourceIds.has(link.source_id))) {
      // Fallback synthetic channel if not found in db.channels table
      result.push({
        stream_id: link.stream_id,
        name: link.channel_name,
        source_id: link.source_id || '',
        stream_icon: '',
        epg_channel_id: '',
        category_ids: [],
        direct_url: '',
        stream_type: 'live',
      });
    }
  }

  return result;
}

/** Given a stream_id linked to a sports team, return the primary (priority=0) channel of that team */
export async function getTeamPrimaryChannel(
  anyStreamId: string
): Promise<StoredChannel | null> {
  await useTeamChannelLinksStore.getState().ensureLoaded();
  const links = useTeamChannelLinksStore.getState().links;

  const match = links.find((l) => l.stream_id === anyStreamId);
  if (!match) return null;

  const teamLinks = getTeamLinks(links, match.league_id, match.team_id);
  const primaryLink = teamLinks[0];
  if (!primaryLink) return null;

  const channel = await db.channels.where('stream_id').equals(primaryLink.stream_id).first();
  const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
  const enabledSourceIds = new Set(
    sourcesResult.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || []
  );
  if (channel) {
    if (!channel.source_id || enabledSourceIds.has(channel.source_id)) {
      return channel;
    }
  } else if (primaryLink.stream_id && (!primaryLink.source_id || enabledSourceIds.has(primaryLink.source_id))) {
    return {
      stream_id: primaryLink.stream_id,
      name: primaryLink.channel_name,
      source_id: primaryLink.source_id || '',
      stream_icon: '',
      epg_channel_id: '',
      category_ids: [],
      direct_url: '',
      stream_type: 'live',
    };
  }

  return null;
}

/** Given a stream_id in a failover group or team channel links, return ordered enabled candidates after it */
export async function getFailoverCandidatesAfter(
  startStreamId: string
): Promise<StoredChannel[]> {
  const membership = await db.failoverGroupMembers
    .where('stream_id')
    .equals(startStreamId)
    .first();
  if (membership) {
    const allMembers = await db.failoverGroupMembers
      .where('group_id')
      .equals(membership.group_id)
      .toArray();

    allMembers.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (a.id ?? 0) - (b.id ?? 0);
    });

    const startIndex = allMembers.findIndex(m => m.stream_id === startStreamId);
    if (startIndex === -1) return [];

    const candidateMembers = allMembers.slice(startIndex + 1);
    if (candidateMembers.length === 0) return [];

    const streamIds = candidateMembers.map(m => m.stream_id);
    const channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
    const channelMap = new Map(channels.map(c => [c.stream_id, c]));

    // Load enabled sources to filter
    const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
    const enabledSourceIds = new Set(sourcesResult.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || []);

    return candidateMembers
      .map(m => channelMap.get(m.stream_id))
      .filter((channel): channel is StoredChannel => !!channel && channel.enabled !== false && enabledSourceIds.has(channel.source_id));
  }

  // If not in a standard failover group, check team channel links if autoSwapDeadStreams is enabled
  const autoSwap = useSportsSettingsStore.getState().autoSwapDeadStreams;
  if (autoSwap) {
    return getTeamFailoverCandidatesAfter(startStreamId);
  }

  return [];
}

/** Given a stream_id, return the primary (priority=0) channel of its group or team, or null */
export async function getPrimaryChannelForGroup(
  anyStreamId: string
): Promise<StoredChannel | null> {
  const membership = await db.failoverGroupMembers
    .where('stream_id')
    .equals(anyStreamId)
    .first();
  if (membership) {
    const primary = await db.failoverGroupMembers
      .where('group_id')
      .equals(membership.group_id)
      .filter(m => m.priority === 0)
      .first();
    if (!primary) return null;

    const channel = await db.channels.where('stream_id').equals(primary.stream_id).first();
    if (channel) {
      // Load enabled sources to filter
      const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
      const enabledSourceIds = new Set(sourcesResult.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || []);
      if (enabledSourceIds.has(channel.source_id)) {
        return channel;
      }
    }
    return null;
  }

  // If not in a standard failover group, check team channel links if autoSwapDeadStreams is enabled
  const autoSwap = useSportsSettingsStore.getState().autoSwapDeadStreams;
  if (autoSwap) {
    return getTeamPrimaryChannel(anyStreamId);
  }

  return null;
}

/** Create a new failover group and return its ID */
export async function createFailoverGroup(name: string): Promise<string> {
  const group_id = crypto.randomUUID();
  await db.failoverGroups.put({ group_id, name, created_at: Date.now() });
  return group_id;
}

/** Add a channel to a group. Throws if channel is already in a different group. */
export async function addChannelToFailoverGroup(
  groupId: string,
  streamId: string
): Promise<void> {
  // Check existing membership
  const existing = await db.failoverGroupMembers
    .where('stream_id')
    .equals(streamId)
    .first();
  if (existing && existing.group_id !== groupId) {
    throw new Error(i18n.t('settings:failover.alreadyInGroup', { group: existing.group_id }));
  }
  if (existing) return; // Already in this group, nothing to do

  // Determine next priority
  const members = await db.failoverGroupMembers
    .where('group_id')
    .equals(groupId)
    .toArray();
  const maxPriority = members.reduce((max, m) => Math.max(max, m.priority), -1);

  await db.failoverGroupMembers.put({
    group_id: groupId,
    stream_id: streamId,
    priority: maxPriority + 1,
  });
}

/** Remove a channel from its failover group. Re-normalizes priority numbers. */
export async function removeChannelFromFailoverGroup(streamId: string): Promise<void> {
  const member = await db.failoverGroupMembers
    .where('stream_id')
    .equals(streamId)
    .first();
  if (!member || member.id === undefined) return;

  await db.failoverGroupMembers.delete(member.id);

  // Re-normalize priorities (0, 1, 2, ... without gaps)
  const remaining = await db.failoverGroupMembers
    .where('group_id')
    .equals(member.group_id)
    .sortBy('priority');
  const renormalizeUpdates = remaining
    .map((m, i) => (m.priority !== i && m.id !== undefined ? { id: m.id!, priority: i } : null))
    .filter(Boolean) as Array<{ id: number; priority: number }>;
  if (renormalizeUpdates.length > 0) {
    await updateFailoverMembersBatch(renormalizeUpdates);
  }
}

/** Reorder: move a member to a new priority index within its group */
export async function reorderFailoverGroupMember(
  streamId: string,
  newPriority: number
): Promise<void> {
  const member = await db.failoverGroupMembers
    .where('stream_id')
    .equals(streamId)
    .first();
  if (!member || member.id === undefined) return;

  const members = await db.failoverGroupMembers
    .where('group_id')
    .equals(member.group_id)
    .sortBy('priority');

  // Remove from current position, insert at new position
  const reordered = members.filter(m => m.stream_id !== streamId);
  reordered.splice(newPriority, 0, member);

  // Write back new priorities
  const reorderUpdates = reordered
    .map((m, i) => (m.id !== undefined && m.priority !== i ? { id: m.id!, priority: i } : null))
    .filter(Boolean) as Array<{ id: number; priority: number }>;
  if (reorderUpdates.length > 0) {
    await updateFailoverMembersBatch(reorderUpdates);
  }
}

/** Bulk reorder all channels in a group by ordered stream IDs */
export async function reorderFailoverGroupChannels(
  groupId: string,
  orderedStreamIds: string[]
): Promise<void> {
  const members = await db.failoverGroupMembers
    .where('group_id')
    .equals(groupId)
    .toArray();
  const memberMap = new Map(members.map(m => [m.stream_id, m]));

  const reorderUpdates = orderedStreamIds
    .map((streamId, i) => {
      const member = memberMap.get(streamId);
      return member && member.id !== undefined && member.priority !== i
        ? { id: member.id, priority: i }
        : null;
    })
    .filter(Boolean) as Array<{ id: number; priority: number }>;
  if (reorderUpdates.length > 0) {
    await updateFailoverMembersBatch(reorderUpdates);
  }
}

/** Delete an entire failover group and all its member mappings */
export async function deleteFailoverGroup(groupId: string): Promise<void> {
  await db.transaction('rw', [db.failoverGroups, db.failoverGroupMembers], async () => {
    await db.failoverGroupMembers.where('group_id').equals(groupId).delete();
    await db.failoverGroups.delete(groupId);
  });
}

/** Rename a failover group */
export async function renameFailoverGroup(groupId: string, newName: string): Promise<void> {
  await db.failoverGroups.update(groupId, { name: newName });
}

/** Get the group name for a given stream_id (for display in channel lists) */
export async function getFailoverGroupForChannel(
  streamId: string
): Promise<{ groupId: string; groupName: string; priority: number } | null> {
  const member = await db.failoverGroupMembers
    .where('stream_id')
    .equals(streamId)
    .first();
  if (!member) return null;
  const group = await db.failoverGroups.where('group_id').equals(member.group_id).first();
  if (!group) return null;
  return { groupId: group.group_id, groupName: group.name, priority: member.priority };
}

/** List all failover groups with their member count */
export async function listFailoverGroups(): Promise<
  Array<FailoverGroup & { memberCount: number }>
> {
  const groups = await db.failoverGroups.toArray();

  // Load enabled sources to filter count
  const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
  const enabledSourceIds = new Set(sourcesResult.data?.filter((s: any) => s.enabled !== false).map((s: any) => s.id) || []);

  const result = [];
  for (const g of groups) {
    const members = await db.failoverGroupMembers
      .where('group_id')
      .equals(g.group_id)
      .toArray();

    // Join with channels to check source_id
    const streamIds = members.map(m => m.stream_id);
    const channels = await db.channels.where('stream_id').anyOf(streamIds).toArray();
    const activeStreamIds = new Set(
      channels
        .filter(c => enabledSourceIds.has(c.source_id))
        .map(c => c.stream_id)
    );

    const activeCount = members.filter(m => activeStreamIds.has(m.stream_id)).length;
    result.push({ ...g, memberCount: activeCount });
  }
  return result;
}
