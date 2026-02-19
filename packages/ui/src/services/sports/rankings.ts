/**
 * Rankings API
 *
 * Functions for fetching college sports rankings and UFC rankings
 */

import type { Ranking, RankingsList, UFCWeightClassRanking } from './types';
import { SPORT_CONFIG } from './config';
import { fetchJson, buildRankingsUrl, buildUFCRankingsUrl } from './client';

export async function getLeagueRankings(leagueId: string): Promise<RankingsList[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    rankings?: Array<{
      id: string;
      name: string;
      shortName: string;
      type: string;
      headline: string;
      shortHeadline: string;
      occurrence?: {
        number: number;
        type: string;
        value: string;
        displayValue: string;
      };
      date: string;
      season?: {
        year: number;
        displayName: string;
      };
      ranks: Array<{
        current: number;
        previous?: number;
        points?: number;
        firstPlaceVotes?: number;
        trend?: string;
        record?: string;
        team: {
          id: string;
          displayName: string;
          name: string;
          nickname: string;
          abbreviation: string;
          logos?: Array<{ href: string }>;
        };
      }>;
    }>;
  }>(buildRankingsUrl(config.sport, config.league));

  if (!data?.rankings) return [];

  return data.rankings.map(list => ({
    id: list.id,
    name: list.name,
    shortName: list.shortName || list.name,
    type: list.type,
    headline: list.shortHeadline || list.headline,
    week: list.occurrence?.displayValue || list.occurrence?.value || 'Final',
    year: list.season?.year || new Date().getFullYear(),
    rankings: (list.ranks || []).map(rank => ({
      rank: rank.current,
      team: {
        id: rank.team.id,
        name: rank.team.displayName || `${rank.team.nickname} ${rank.team.name}`,
        shortName: rank.team.abbreviation,
        logo: rank.team.logos?.[0]?.href,
      },
      record: rank.record || '',
      points: rank.points,
      previousRank: rank.previous,
      firstPlaceVotes: rank.firstPlaceVotes,
      trend: calculateTrend(rank.current, rank.previous, rank.trend),
    })),
  }));
}

function calculateTrend(current: number, previous?: number, trendStr?: string): 'up' | 'down' | 'same' | 'new' {
  if (previous === undefined) return 'new';
  if (trendStr === '-') return 'same';
  return current < previous ? 'up' : 'down';
}

export async function getUFCRankings(): Promise<UFCWeightClassRanking[]> {
  const data = await fetchJson<{
    rankings?: Array<{
      name: string;
      displayName?: string;
      athletes?: Array<{
        athlete?: {
          id: string;
          displayName: string;
          headshot?: { href: string };
          record?: Array<{ summary: string }>;
        };
        rank?: number;
        champion?: boolean;
      }>;
    }>;
  }>(buildUFCRankingsUrl());

  const rankings: UFCWeightClassRanking[] = [];

  if (data?.rankings) {
    for (const division of data.rankings) {
      // Skip "Pound for Pound" rankings, only include weight classes
      if (division.name.toLowerCase().includes('pound for pound')) continue;

      const weightClass: UFCWeightClassRanking = {
        weightClass: division.name,
        rankedFighters: [],
      };

      const athletes = division.athletes || [];
      for (const entry of athletes) {
        if (!entry.athlete) continue;

        const fighter = {
          id: entry.athlete.id,
          name: entry.athlete.displayName,
          record: entry.athlete.record?.[0]?.summary,
          headshot: entry.athlete.headshot?.href,
        };

        if (entry.champion) {
          weightClass.champion = fighter;
        } else if (entry.rank) {
          weightClass.rankedFighters.push({
            rank: entry.rank,
            ...fighter,
          });
        }
      }

      // Sort by rank
      weightClass.rankedFighters.sort((a, b) => a.rank - b.rank);
      rankings.push(weightClass);
    }
  }

  console.log('[ESPN API] UFC Rankings:', rankings.length, 'weight classes');
  return rankings;
}
