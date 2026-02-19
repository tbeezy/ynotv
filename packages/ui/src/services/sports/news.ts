/**
 * News API
 *
 * Functions for fetching sports news articles
 */

import type { NewsArticle } from './types';
import { SPORT_CONFIG } from './config';
import { fetchJson, buildNewsUrl } from './client';

export async function getLeagueNews(leagueId: string, limit: number = 20): Promise<NewsArticle[]> {
  const config = SPORT_CONFIG[leagueId];
  if (!config) return [];

  const data = await fetchJson<{
    articles?: Array<{
      id: string;
      headline: string;
      description: string;
      links?: { web: { href: string } };
      images?: Array<{ url: string }>;
      source?: string;
      published?: string;
      type: string;
    }>;
  }>(buildNewsUrl(config.sport, config.league, limit));

  if (!data?.articles) return [];

  return data.articles.map(article => ({
    id: article.id,
    title: article.headline,
    description: article.description,
    link: article.links?.web?.href || '',
    image: article.images?.[0]?.url,
    source: article.source,
    published: article.published ? new Date(article.published) : undefined,
    type: article.type,
    leagueId,
  }));
}
