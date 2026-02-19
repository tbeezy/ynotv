/**
 * Leaders API
 *
 * Functions for fetching league stat leaders
 */

import type { LeadersCategory, LeagueLeader } from './types';
import { SPORT_CONFIG } from './config';
import { fetchJson, buildLeadersUrl } from './client';

export async function getLeagueLeaders(leagueId: string): Promise<LeadersCategory[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    leaders?: {
      categories?: Array<{
        name: string;
        displayName: string;
        shortDisplayName?: string;
        leaders?: Array<{
          rank?: number;
          athlete?: {
            id: string;
            displayName: string;
            headshot?: { href: string };
            position?: { displayName: string; abbreviation?: string };
          };
          team?: {
            id: string;
            displayName: string;
            abbreviation: string;
            logos?: Array<{ href: string }>;
          };
          value: number;
          displayValue: string;
        }>;
      }>;
    };
  }>(buildLeadersUrl(config.sport, config.league));

  const categories = data?.leaders?.categories;
  if (!categories) return [];

  return categories.map(category => ({
    name: category.name,
    displayName: category.displayName,
    shortDisplayName: category.shortDisplayName,
    leaders: (category.leaders || []).map((leader, idx) => ({
      rank: leader.rank ?? (idx + 1),
      athlete: {
        id: leader.athlete?.id || '',
        name: leader.athlete?.displayName || 'Unknown',
        headshot: leader.athlete?.headshot?.href,
        position: leader.athlete?.position?.abbreviation || leader.athlete?.position?.displayName,
      },
      team: {
        id: leader.team?.id || '',
        name: leader.team?.displayName || 'Unknown',
        shortName: leader.team?.abbreviation || '',
        logo: leader.team?.logos?.[0]?.href,
      },
      stat: category.name,
      value: String(leader.value),
      displayValue: leader.displayValue,
    })),
  }));
}
