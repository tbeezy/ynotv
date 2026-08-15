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
  /** Index of `links` keyed by `${league_id}:${team_id}` → sorted by priority, for O(1) lookups. */
  teamIndex: Map<string, TeamChannelLink[]>;
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
  autoLinkLeague: (
    leagueId: string,
    customConfig?: import('./leagueAutoLinkConfigStore').LeagueAutoLinkConfig
  ) => Promise<{ suggestions: TeamLinkSuggestion[]; autoLinked: number; teamCount: number }>;
}

let loadPromise: Promise<void> | null = null;

export function linkId(leagueId: string, teamId: string, streamId?: string): string {
  if (streamId) {
    return `${leagueId}:${teamId}:${streamId}`;
  }
  return `${leagueId}:${teamId}`;
}

/** Stable empty array so selectors for teams without links keep a constant reference. */
const EMPTY_TEAM_LINKS: TeamChannelLink[] = [];

export function teamIndexKey(leagueId: string, teamId: string): string {
  return `${leagueId}:${teamId}`;
}

/**
 * Groups and sorts `links` into a per-team map. Entries whose team didn't
 * change keep their previous array reference, so per-team selectors only
 * re-render when that team's links actually change.
 */
function buildTeamIndex(
  links: TeamChannelLink[],
  prev?: Map<string, TeamChannelLink[]>
): Map<string, TeamChannelLink[]> {
  const byTeam = new Map<string, TeamChannelLink[]>();
  for (const l of links) {
    const key = teamIndexKey(l.league_id, l.team_id);
    const arr = byTeam.get(key);
    if (arr) arr.push(l);
    else byTeam.set(key, [l]);
  }

  const index = new Map<string, TeamChannelLink[]>();
  for (const [key, arr] of byTeam) {
    const sorted = [...arr].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const prevArr = prev?.get(key);
    if (prevArr && prevArr.length === sorted.length && prevArr.every((l, i) => l === sorted[i])) {
      index.set(key, prevArr);
    } else {
      index.set(key, sorted);
    }
  }
  return index;
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
  teamIndex: new Map(),
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

        set((s) => ({
          links: migrated,
          teamIndex: buildTeamIndex(migrated, s.teamIndex),
          loaded: true,
          loading: false,
        }));
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
    set((s) => ({
      links: normalized,
      teamIndex: buildTeamIndex(normalized, s.teamIndex),
      loaded: true,
      loading: false,
    }));
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

    set((s) => {
      const next = [
        ...s.links.filter((l) => !(l.league_id === input.league_id && l.team_id === input.team_id)),
        ...normalized,
      ];
      return { links: next, teamIndex: buildTeamIndex(next, s.teamIndex) };
    });
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

    set((s) => {
      const next = [
        ...s.links.filter((l) => !(l.league_id === leagueId && l.team_id === teamId)),
        ...remainingForTeam,
      ];
      return { links: next, teamIndex: buildTeamIndex(next, s.teamIndex) };
    });
  },

  unlinkTeam: async (leagueId, teamId) => {
    const toDelete = get().links.filter((l) => l.league_id === leagueId && l.team_id === teamId);
    for (const l of toDelete) {
      await db.teamChannelLinks.delete(l.id).catch(() => {});
    }
    await db.teamChannelLinks.delete(`${leagueId}:${teamId}`).catch(() => {});
    set((s) => {
      const next = s.links.filter((l) => !(l.league_id === leagueId && l.team_id === teamId));
      return { links: next, teamIndex: buildTeamIndex(next, s.teamIndex) };
    });
  },

  unlinkLeague: async (leagueId) => {
    const toDelete = get().links.filter((l) => l.league_id === leagueId);
    for (const l of toDelete) {
      await db.teamChannelLinks.delete(l.id).catch(() => {});
    }
    set((s) => {
      const next = s.links.filter((l) => l.league_id !== leagueId);
      return { links: next, teamIndex: buildTeamIndex(next, s.teamIndex) };
    });
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

    set((s) => {
      const next = [
        ...s.links.filter((l) => !(l.league_id === leagueId && l.team_id === teamId)),
        ...reordered,
      ];
      return { links: next, teamIndex: buildTeamIndex(next, s.teamIndex) };
    });
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

    set((s) => {
      const next = [
        ...s.links.filter((l) => !(l.league_id === leagueId && l.team_id === teamId)),
        ...reordered,
      ];
      return { links: next, teamIndex: buildTeamIndex(next, s.teamIndex) };
    });
  },

  bulkLink: async (links) => {
    if (links.length === 0) return;
    await db.teamChannelLinks.bulkPut(links);
    set((s) => {
      const byId = new Map(s.links.map((l) => [l.id, l] as const));
      for (const l of links) byId.set(l.id, l);
      const next = Array.from(byId.values());
      return { links: next, teamIndex: buildTeamIndex(next, s.teamIndex) };
    });
  },

  autoLinkLeague: async (leagueId, customConfig) => {
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

    const { useLeagueAutoLinkConfigStore } = await import('./leagueAutoLinkConfigStore');
    let config = customConfig;
    if (!config) {
      await useLeagueAutoLinkConfigStore.getState().ensureLoaded();
      config = useLeagueAutoLinkConfigStore.getState().getConfig(leagueId);
    }

    const result = await matchTeamsToChannels(leagueId, unlinkedTeams, config);

    if (config.autoApply) {
      // Auto-apply honors the league's confidence floor and per-team candidate
      // count (primary + backups), not just the single best match.
      const minConfidence = config.minConfidence ?? 0;
      const maxCandidates = config.maxCandidatesPerTeam ?? 1;
      const autoLinkedTeams = result.autoLinked
        .map((s) => ({
          s,
          eligible: s.candidates
            .filter((c) => c.score >= minConfidence)
            .slice(0, maxCandidates),
        }))
        .filter(({ eligible }) => eligible.length > 0);

      const autoLinks: TeamChannelLink[] = autoLinkedTeams.flatMap(({ s, eligible }) =>
        eligible.map((cand, idx) => ({
          id: linkId(leagueId, s.team.id, cand.channel.stream_id),
          league_id: leagueId,
          team_id: s.team.id,
          stream_id: cand.channel.stream_id,
          channel_name: cand.channel.alias || cand.channel.name,
          source_id: cand.channel.source_id,
          priority: idx,
          auto: 1,
          confidence: cand.score,
          updated_at: Date.now(),
        }))
      );
      if (autoLinks.length > 0) {
        await get().bulkLink(autoLinks);
      }
      return { suggestions: result.reviewable, autoLinked: autoLinkedTeams.length, teamCount: teams.length };
    }

    // Return all suggestions that found candidate channels so users can review and pick
    const matchingSuggestions = result.suggestions.filter((s) => s.candidates.length > 0);
    return {
      suggestions: matchingSuggestions,
      autoLinked: 0,
      teamCount: teams.length,
    };
  },
}));

export const useTeamChannelLinks = () => {
  const links = useTeamChannelLinksStore((s) => s.links);
  const loaded = useTeamChannelLinksStore((s) => s.loaded);
  const ensureLoaded = useTeamChannelLinksStore((s) => s.ensureLoaded);
  return { links, loaded, ensureLoaded };
};

/**
 * O(1) indexed lookup of a team's links (sorted by priority) for the hot path
 * (match cards). Returns a stable array reference that only changes when that
 * team's links actually change, so a card re-renders only when its own links do.
 */
export const useTeamLinks = (leagueId: string, teamId: string): TeamChannelLink[] =>
  useTeamChannelLinksStore((s) => s.teamIndex.get(teamIndexKey(leagueId, teamId)) ?? EMPTY_TEAM_LINKS);
