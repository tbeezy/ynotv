/**
 * Team Channel Links Store — links sports teams to provider channels (primary & backup streams).
 *
 * Persisted in the `team_channel_links` SQLite table. The store keeps an
 * in-memory copy for instant reads from match cards and mutates it
 * optimistically after each write.
 */

import { create } from 'zustand';
import { db } from '../db';
import type { TeamChannelLink } from '../db';
import { getLeagueTeams } from '../services/sports';
import { matchTeamsToChannels, type TeamLinkSuggestion } from '../services/sports/teamChannelMatcher';

export interface TeamLinkInput {
  league_id: string;
  team_id: string;
  stream_id: string;
  channel_name: string;
  source_id?: string;
  priority?: number;
  auto?: number;
  confidence?: number;
}

interface TeamChannelLinksState {
  links: TeamChannelLink[];
  loaded: boolean;
  loading: boolean;
  ensureLoaded: () => Promise<void>;
  reload: () => Promise<void>;
  linkTeam: (input: TeamLinkInput) => Promise<void>;
  unlinkTeamChannel: (leagueId: string, teamId: string, streamId: string) => Promise<void>;
  unlinkTeam: (leagueId: string, teamId: string) => Promise<void>;
  unlinkLeague: (leagueId: string) => Promise<void>;
  setPrimaryChannel: (leagueId: string, teamId: string, streamId: string) => Promise<void>;
  reorderTeamLinks: (leagueId: string, teamId: string, orderedStreamIds: string[]) => Promise<void>;
  bulkLink: (links: TeamChannelLink[]) => Promise<void>;
  autoLinkLeague: (leagueId: string) => Promise<{ suggestions: TeamLinkSuggestion[]; autoLinked: number; teamCount: number }>;
  acceptSuggestion: (suggestion: TeamLinkSuggestion, candidateIndex?: number) => Promise<void>;
}

let loadPromise: Promise<void> | null = null;

export function linkId(leagueId: string, teamId: string, streamId?: string): string {
  if (streamId) {
    return `${leagueId}:${teamId}:${streamId}`;
  }
  return `${leagueId}:${teamId}`;
}

/**
 * Returns all links for a specific team, sorted by priority (0 = primary, 1+ = backups).
 */
export function getTeamLinks(links: TeamChannelLink[], leagueId: string, teamId: string): TeamChannelLink[] {
  return links
    .filter((l) => l.league_id === leagueId && l.team_id === teamId)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/**
 * Returns the primary (or single) channel link for a team (for backward compatibility).
 */
export function getTeamLink(links: TeamChannelLink[], leagueId: string, teamId: string): TeamChannelLink | undefined {
  const teamLinks = getTeamLinks(links, leagueId, teamId);
  return teamLinks[0];
}

export const useTeamChannelLinksStore = create<TeamChannelLinksState>((set, get) => ({
  links: [],
  loaded: false,
  loading: false,

  ensureLoaded: async () => {
    if (get().loaded || get().loading) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      set({ loading: true });
      try {
        const rawLinks = await db.teamChannelLinks.toArray();
        const migrated: TeamChannelLink[] = [];

        for (const l of rawLinks) {
          // Self-heal legacy records that had id = `${league_id}:${team_id}`
          if (l.id === `${l.league_id}:${l.team_id}` && l.stream_id) {
            const newId = `${l.league_id}:${l.team_id}:${l.stream_id}`;
            const updated: TeamChannelLink = { ...l, id: newId, priority: l.priority ?? 0 };
            migrated.push(updated);
            db.teamChannelLinks.delete(l.id).catch(() => {});
            db.teamChannelLinks.put(updated).catch(() => {});
          } else {
            migrated.push({ ...l, priority: l.priority ?? 0 });
          }
        }

        set({ links: migrated, loaded: true, loading: false });
      } catch (err) {
        console.error('[TeamChannelLinks] Failed to load links:', err);
        set({ loaded: true, loading: false });
      } finally {
        loadPromise = null;
      }
    })();
    return loadPromise;
  },

  reload: async () => {
    const rawLinks = await db.teamChannelLinks.toArray();
    const normalized = rawLinks.map((l) => ({ ...l, priority: l.priority ?? 0 }));
    set({ links: normalized, loaded: true, loading: false });
  },

  linkTeam: async (input) => {
    const existingTeamLinks = getTeamLinks(get().links, input.league_id, input.team_id);
    const existingIdx = existingTeamLinks.findIndex((l) => l.stream_id === input.stream_id);

    let priority: number;
    if (existingIdx !== -1) {
      // Re-linking an already-linked stream keeps its current slot.
      priority = existingTeamLinks[existingIdx].priority ?? existingIdx;
    } else if (input.priority !== undefined) {
      priority = input.priority;
    } else {
      priority = existingTeamLinks.length;
    }

    const id = linkId(input.league_id, input.team_id, input.stream_id);
    const link: TeamChannelLink = {
      id,
      league_id: input.league_id,
      team_id: input.team_id,
      stream_id: input.stream_id,
      channel_name: input.channel_name,
      source_id: input.source_id,
      priority,
      auto: input.auto ?? 0,
      confidence: input.confidence ?? 1,
      updated_at: Date.now(),
    };

    // Rebuild this team's ordered list and normalize priorities so it can never
    // end up with two links sharing a priority (e.g. a second "primary").
    const others = existingTeamLinks.filter((l) => l.stream_id !== input.stream_id);
    const ordered = [...others, link].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const normalized = ordered.map((l, idx) => ({ ...l, priority: idx }));

    // Clean up any legacy record with the old `${league_id}:${team_id}` key.
    const legacyId = `${input.league_id}:${input.team_id}`;
    if (get().links.some((l) => l.id === legacyId)) {
      await db.teamChannelLinks.delete(legacyId).catch(() => {});
    }

    await db.teamChannelLinks.bulkPut(normalized);

    set((s) => ({
      links: [
        ...s.links.filter((l) => !(l.league_id === input.league_id && l.team_id === input.team_id)),
        ...normalized,
      ],
    }));
  },

  unlinkTeamChannel: async (leagueId, teamId, streamId) => {
    const id = linkId(leagueId, teamId, streamId);
    const legacyId = `${leagueId}:${teamId}`;

    await db.teamChannelLinks.delete(id).catch(() => {});
    await db.teamChannelLinks.delete(legacyId).catch(() => {});

    const remainingForTeam = get()
      .links.filter((l) => l.league_id === leagueId && l.team_id === teamId && l.stream_id !== streamId)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((l, idx) => ({ ...l, priority: idx }));

    if (remainingForTeam.length > 0) {
      await db.teamChannelLinks.bulkPut(remainingForTeam).catch(() => {});
    }

    set((s) => ({
      links: [
        ...s.links.filter(
          (l) => !(l.league_id === leagueId && l.team_id === teamId)
        ),
        ...remainingForTeam,
      ],
    }));
  },

  unlinkTeam: async (leagueId, teamId) => {
    const toDelete = get().links.filter((l) => l.league_id === leagueId && l.team_id === teamId);
    for (const l of toDelete) {
      await db.teamChannelLinks.delete(l.id).catch(() => {});
    }
    await db.teamChannelLinks.delete(`${leagueId}:${teamId}`).catch(() => {});
    set((s) => ({
      links: s.links.filter((l) => !(l.league_id === leagueId && l.team_id === teamId)),
    }));
  },

  unlinkLeague: async (leagueId) => {
    const toDelete = get().links.filter((l) => l.league_id === leagueId);
    for (const l of toDelete) {
      await db.teamChannelLinks.delete(l.id).catch(() => {});
    }
    set((s) => ({ links: s.links.filter((l) => l.league_id !== leagueId) }));
  },

  setPrimaryChannel: async (leagueId, teamId, streamId) => {
    const teamLinks = getTeamLinks(get().links, leagueId, teamId);
    const targetIdx = teamLinks.findIndex((l) => l.stream_id === streamId);
    if (targetIdx === -1) return;

    const target = teamLinks[targetIdx];
    const rest = teamLinks.filter((_, idx) => idx !== targetIdx);
    const reordered: TeamChannelLink[] = [target, ...rest].map((l, idx) => ({
      ...l,
      priority: idx,
      updated_at: Date.now(),
    }));

    await db.teamChannelLinks.bulkPut(reordered);

    set((s) => ({
      links: [
        ...s.links.filter((l) => !(l.league_id === leagueId && l.team_id === teamId)),
        ...reordered,
      ],
    }));
  },

  reorderTeamLinks: async (leagueId, teamId, orderedStreamIds) => {
    const teamLinks = getTeamLinks(get().links, leagueId, teamId);
    const linkMap = new Map(teamLinks.map((l) => [l.stream_id, l]));

    const reordered: TeamChannelLink[] = [];
    let pri = 0;
    for (const sid of orderedStreamIds) {
      const l = linkMap.get(sid);
      if (l) {
        reordered.push({ ...l, priority: pri++, updated_at: Date.now() });
        linkMap.delete(sid);
      }
    }
    // Any remaining
    for (const l of linkMap.values()) {
      reordered.push({ ...l, priority: pri++, updated_at: Date.now() });
    }

    if (reordered.length > 0) {
      await db.teamChannelLinks.bulkPut(reordered);
    }

    set((s) => ({
      links: [
        ...s.links.filter((l) => !(l.league_id === leagueId && l.team_id === teamId)),
        ...reordered,
      ],
    }));
  },

  bulkLink: async (links) => {
    if (links.length === 0) return;
    await db.teamChannelLinks.bulkPut(links);
    set((s) => {
      const byId = new Map(s.links.map((l) => [l.id, l] as const));
      for (const l of links) byId.set(l.id, l);
      return { links: Array.from(byId.values()) };
    });
  },

  autoLinkLeague: async (leagueId) => {
    await get().ensureLoaded();
    const teams = await getLeagueTeams(leagueId);
    if (teams.length === 0) {
      return { suggestions: [], autoLinked: 0, teamCount: 0 };
    }

    // Never auto-link teams that already have a link — re-running auto-link must
    // not create a duplicate "primary" alongside an existing one.
    const alreadyLinked = new Set(
      get().links.filter((l) => l.league_id === leagueId).map((l) => l.team_id)
    );
    const unlinkedTeams = teams.filter((t) => !alreadyLinked.has(t.id));

    const result = await matchTeamsToChannels(leagueId, unlinkedTeams);
    const autoLinks: TeamChannelLink[] = result.autoLinked
      .filter((s) => s.best)
      .map((s) => ({
        id: linkId(leagueId, s.team.id, s.best!.channel.stream_id),
        league_id: leagueId,
        team_id: s.team.id,
        stream_id: s.best!.channel.stream_id,
        channel_name: s.best!.channel.alias || s.best!.channel.name,
        source_id: s.best!.channel.source_id,
        priority: 0,
        auto: 1,
        confidence: s.best!.score,
        updated_at: Date.now(),
      }));
    if (autoLinks.length > 0) {
      await get().bulkLink(autoLinks);
    }
    return { suggestions: result.reviewable, autoLinked: autoLinks.length, teamCount: teams.length };
  },

  acceptSuggestion: async (suggestion, candidateIndex = 0) => {
    const candidate = suggestion.candidates[candidateIndex];
    if (!candidate) return;
    await get().linkTeam({
      league_id: suggestion.leagueId,
      team_id: suggestion.team.id,
      stream_id: candidate.channel.stream_id,
      channel_name: candidate.channel.alias || candidate.channel.name,
      source_id: candidate.channel.source_id,
      auto: 0,
      confidence: candidate.score,
    });
  },
}));

export const useTeamChannelLinks = () => {
  const links = useTeamChannelLinksStore((s) => s.links);
  const loaded = useTeamChannelLinksStore((s) => s.loaded);
  const ensureLoaded = useTeamChannelLinksStore((s) => s.ensureLoaded);
  return { links, loaded, ensureLoaded };
};
