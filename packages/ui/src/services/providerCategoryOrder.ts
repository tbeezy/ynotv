import { fetchAndParseM3U, XtreamClient, StalkerClient } from '@ynotv/local-adapter';
import type { Source } from '@ynotv/core';

/**
 * True when a source can be queried for its current category order. Local M3U
 * imports (file paths) and sources without the credentials their type needs
 * have nothing to ask, so the "Server Order" action stays hidden for them.
 */
export function canFetchProviderCategoryOrder(source: Source | null | undefined): boolean {
  if (!source) return false;
  if (source.type === 'xtream') return Boolean(source.username && source.password);
  if (source.type === 'stalker') return Boolean(source.mac);
  if (source.type === 'm3u') return /^https?:\/\//i.test(source.url || '');
  return false;
}

/**
 * Fetch the live category order straight from the provider, so the category
 * manager can re-apply it when the panel-side order has changed since the last
 * import. Category ids are already source-prefixed by each client/parser, so
 * they match `db.categories.category_id` for this source.
 */
export async function fetchProviderCategoryOrder(source: Source): Promise<string[]> {
  if (source.type === 'xtream') {
    const client = new XtreamClient(
      {
        baseUrl: source.url,
        username: source.username ?? '',
        password: source.password ?? '',
        userAgent: source.user_agent,
      },
      source.id
    );
    const categories = await client.getLiveCategories();
    return categories.map((c) => c.category_id);
  }

  if (source.type === 'stalker') {
    const client = new StalkerClient(
      { baseUrl: source.url, mac: source.mac ?? '', userAgent: source.user_agent },
      source.id
    );
    const categories = await client.getLiveCategories();
    return categories.map((c) => c.category_id);
  }

  if (source.type === 'm3u') {
    const result = await fetchAndParseM3U(source.url, source.id, source.user_agent);
    return result.categories.map((c) => c.category_id);
  }

  throw new Error(`Unsupported source type: ${source.type}`);
}
