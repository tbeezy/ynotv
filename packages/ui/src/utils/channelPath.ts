/**
 * Safely parse category IDs from a JSON string, array of strings/numbers, or undefined.
 */
export function parseCategoryIds(categoryIdsJson: string | string[] | number[] | undefined): string[] {
  if (!categoryIdsJson) return [];
  if (Array.isArray(categoryIdsJson)) {
    return categoryIdsJson.map(String);
  }
  try {
    const parsed = JSON.parse(categoryIdsJson);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // Invalid JSON
  }
  return [];
}

export interface ResolveChannelCategoryOptions {
  channel: {
    category_ids?: string | string[] | number[];
    source_id?: string;
  } | null;
  categoryId?: string | null;
  currentCategory?: {
    category_id?: string;
    category_name?: string;
    alias?: string;
  } | null;
  linkedCategoryDisplayName?: string | null;
  categories?: Array<{
    category_id: string;
    category_name: string;
    alias?: string;
    source_id?: string;
  }>;
  categoryNameMap?: Map<string, string>;
  isWatchlistMode?: boolean;
  isSearchMode?: boolean;
  fallbackCategoryName?: string;
}

export interface FormatChannelPathOptions extends ResolveChannelCategoryOptions {
  channel: {
    name?: string;
    alias?: string;
    source_id?: string;
    source_name?: string;
    category_ids?: string | string[] | number[];
  } | null;
  sourceNames?: Map<string, string>;
  showFullPath?: boolean;
  translations?: {
    favorites?: string;
    watchlist?: string;
    recentlyViewed?: string;
    allChannels?: string;
  };
}

/**
 * Resolves a channel's category display name, always prioritizing user-defined aliases.
 */
export function resolveChannelCategoryName(options: ResolveChannelCategoryOptions): string {
  const {
    channel,
    categoryId,
    currentCategory,
    linkedCategoryDisplayName,
    categories,
    categoryNameMap,
    isWatchlistMode,
    isSearchMode,
    fallbackCategoryName = '',
  } = options;

  if (!channel) {
    return linkedCategoryDisplayName || currentCategory?.alias || currentCategory?.category_name || fallbackCategoryName;
  }

  // 1. If currently in a linked playlist category, use its display name directly
  if (linkedCategoryDisplayName) {
    return linkedCategoryDisplayName;
  }

  // 2. If currently in a standard category (not special view), that category is primary
  const isSpecialView = !categoryId ||
    categoryId === '__favorites__' ||
    categoryId.startsWith('__favsrc_') ||
    categoryId === '__recent__' ||
    categoryId === '__watchlist__' ||
    Boolean(isWatchlistMode) ||
    Boolean(isSearchMode);

  if (!isSpecialView) {
    const catName = currentCategory?.alias || currentCategory?.category_name;
    if (catName) {
      return catName;
    }
  }

  // 2. Resolve from channel's category_ids
  const catIds = parseCategoryIds(channel.category_ids);
  const primaryCatId = catIds[0] || (categoryId && !categoryId.startsWith('__') ? categoryId : undefined);

  if (primaryCatId) {
    if (categories && categories.length > 0) {
      const found = categories.find((c) => c.category_id === primaryCatId && (!channel.source_id || c.source_id === channel.source_id))
        || categories.find((c) => c.category_id === primaryCatId);
      if (found?.alias || found?.category_name) {
        return found.alias || found.category_name;
      }
    }
    const mapped = categoryNameMap?.get(primaryCatId);
    if (mapped) return mapped;
  }

  // 3. Fallback to currentCategory alias/name, then fallbackCategoryName
  return currentCategory?.alias || currentCategory?.category_name || fallbackCategoryName;
}

/**
 * Resolves the channel's source display name.
 */
export function resolveChannelSourceName(
  channel: { source_id?: string; source_name?: string } | null,
  sourceNames?: Map<string, string>
): string {
  if (!channel) return '';
  const srcId = channel.source_id;
  if (!srcId) return channel.source_name || '';
  return sourceNames?.get(srcId) || channel.source_name || srcId;
}

/**
 * Resolves context suffix for special views: e.g. " (Favorites)", " (Watchlist)", " (Recently Viewed)"
 */
export function resolveSpecialViewSuffix(
  categoryId?: string | null,
  isWatchlistMode?: boolean,
  translations?: { favorites?: string; watchlist?: string; recentlyViewed?: string }
): string {
  if (categoryId === '__favorites__' || (!!categoryId && categoryId.startsWith('__favsrc_'))) {
    return ` (${translations?.favorites || 'Favorites'})`;
  }
  if (isWatchlistMode || categoryId === '__watchlist__') {
    return ` (${translations?.watchlist || 'Watchlist'})`;
  }
  if (categoryId === '__recent__') {
    return ` (${translations?.recentlyViewed || 'Recently Viewed'})`;
  }
  return '';
}

/**
 * Builds the full channel hierarchy path:
 * Source / Category / Channel (Context)
 */
export function formatChannelFullPath(options: FormatChannelPathOptions): string {
  const { channel, sourceNames, categoryId, isWatchlistMode, translations } = options;
  if (!channel) return '';

  const sourcePart = resolveChannelSourceName(channel, sourceNames);
  const categoryPart = resolveChannelCategoryName(options);
  const channelPart = channel.alias || channel.name || '';

  const parts = [sourcePart, categoryPart, channelPart].filter(Boolean);
  const base = parts.join(' / ');
  if (!base) return '';

  const suffix = resolveSpecialViewSuffix(categoryId, isWatchlistMode, translations);
  return `${base}${suffix}`;
}

/**
 * Formats the string to display in the EPG program details pane.
 * When showFullPath is true: returns "Source / Category / Channel (Context)"
 * When showFullPath is false: returns the renamed category name
 */
export function formatChannelDisplayPath(options: FormatChannelPathOptions): string {
  if (options.showFullPath) {
    const fullPath = formatChannelFullPath(options);
    if (fullPath) return fullPath;
  }
  return resolveChannelCategoryName(options);
}
