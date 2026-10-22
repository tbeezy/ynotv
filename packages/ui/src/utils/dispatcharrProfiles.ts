/**
 * Helpers for Dispatcharr Channel Profile (channel list) multi-select,
 * composite live category ids, and Live TV virtual source headers.
 */
import type { Source } from '@ynotv/core';

/** Prefix for profile-scoped category ids: `dp:{profileId}:{groupId}` */
export const DISPATCHARR_PROFILE_CATEGORY_PREFIX = 'dp:';

/** Separator in virtual Live TV source ids: `{sourceId}::dp:{profileId}` */
export const DISPATCHARR_VIRTUAL_SOURCE_SEP = '::dp:';

export interface ParsedDispatcharrProfileCategoryId {
  profileId: number;
  groupId: string;
}

export interface ParsedDispatcharrVirtualSourceId {
  sourceId: string;
  profileId: number;
}

/** Resolve selected profile ids from new multi-select field or legacy single id. */
export function getSelectedDispatcharrProfileIds(
  source: Pick<
    Source,
    'dispatcharr_selected_profile_ids' | 'dispatcharr_selected_profile_id'
  > | null | undefined
): number[] {
  if (!source) return [];
  const multi = source.dispatcharr_selected_profile_ids;
  if (Array.isArray(multi)) {
    return multi.filter((id) => Number.isFinite(id));
  }
  const legacy = source.dispatcharr_selected_profile_id;
  if (legacy != null && Number.isFinite(legacy)) {
    return [legacy];
  }
  return [];
}

/** True when no specific channel lists are selected (All channels mode). */
export function isDispatcharrAllChannels(
  source: Pick<
    Source,
    'dispatcharr_selected_profile_ids' | 'dispatcharr_selected_profile_id'
  > | null | undefined
): boolean {
  return getSelectedDispatcharrProfileIds(source).length === 0;
}

export function makeDispatcharrProfileCategoryId(
  profileId: number,
  groupId: string | number
): string {
  return `${DISPATCHARR_PROFILE_CATEGORY_PREFIX}${profileId}:${String(groupId)}`;
}

export function parseDispatcharrProfileCategoryId(
  categoryId: string
): ParsedDispatcharrProfileCategoryId | null {
  if (!categoryId.startsWith(DISPATCHARR_PROFILE_CATEGORY_PREFIX)) return null;
  const rest = categoryId.slice(DISPATCHARR_PROFILE_CATEGORY_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const profileId = Number(rest.slice(0, colon));
  const groupId = rest.slice(colon + 1);
  if (!Number.isFinite(profileId) || !groupId) return null;
  return { profileId, groupId };
}

export function isDispatcharrProfileCategoryId(categoryId: string): boolean {
  return parseDispatcharrProfileCategoryId(categoryId) != null;
}

export function makeDispatcharrVirtualSourceId(
  sourceId: string,
  profileId: number
): string {
  return `${sourceId}${DISPATCHARR_VIRTUAL_SOURCE_SEP}${profileId}`;
}

export function parseDispatcharrVirtualSourceId(
  virtualOrRealId: string
): ParsedDispatcharrVirtualSourceId | null {
  const idx = virtualOrRealId.indexOf(DISPATCHARR_VIRTUAL_SOURCE_SEP);
  if (idx <= 0) return null;
  const sourceId = virtualOrRealId.slice(0, idx);
  const profileId = Number(
    virtualOrRealId.slice(idx + DISPATCHARR_VIRTUAL_SOURCE_SEP.length)
  );
  if (!sourceId || !Number.isFinite(profileId)) return null;
  return { sourceId, profileId };
}

export function isDispatcharrVirtualSourceId(id: string): boolean {
  return parseDispatcharrVirtualSourceId(id) != null;
}

/** Resolve real source id from a virtual or real Live TV source key. */
export function resolveRealDispatcharrSourceId(sourceIdOrVirtual: string): string {
  return parseDispatcharrVirtualSourceId(sourceIdOrVirtual)?.sourceId ?? sourceIdOrVirtual;
}

export function makeDispatcharrProfileDisplayName(
  sourceName: string,
  profileName: string
): string {
  const src = (sourceName || '').trim() || 'Dispatcharr';
  const prof = (profileName || '').trim();
  return prof ? `${src}-${prof}` : src;
}

/** Cached profile name from source config, with fallbacks. */
export function getDispatcharrProfileName(
  source: Pick<
    Source,
    | 'dispatcharr_selected_profile_names'
    | 'dispatcharr_selected_profile_name'
    | 'dispatcharr_selected_profile_id'
  > | null | undefined,
  profileId: number
): string {
  if (!source) return String(profileId);
  const names = source.dispatcharr_selected_profile_names;
  if (names && names[String(profileId)]) {
    return names[String(profileId)];
  }
  if (
    source.dispatcharr_selected_profile_id === profileId &&
    source.dispatcharr_selected_profile_name
  ) {
    return source.dispatcharr_selected_profile_name;
  }
  return String(profileId);
}

/**
 * Build legacy single-id fields from a multi-select selection for storage compat.
 * - All channels → null / undefined name
 * - Exactly one → that id + name
 * - Multiple → null (multi lives only in `_ids`)
 */
export function toLegacyDispatcharrProfileFields(
  ids: number[],
  names: Record<string, string>
): {
  dispatcharr_selected_profile_id: number | null;
  dispatcharr_selected_profile_name: string | undefined;
} {
  if (ids.length === 1) {
    const id = ids[0];
    return {
      dispatcharr_selected_profile_id: id,
      dispatcharr_selected_profile_name: names[String(id)] || undefined,
    };
  }
  return {
    dispatcharr_selected_profile_id: null,
    dispatcharr_selected_profile_name: undefined,
  };
}

/** Human-readable badge text for a source card. */
export function formatDispatcharrProfileBadge(
  source: Pick<
    Source,
    | 'dispatcharr_selected_profile_ids'
    | 'dispatcharr_selected_profile_id'
    | 'dispatcharr_selected_profile_names'
    | 'dispatcharr_selected_profile_name'
  >,
  allChannelsLabel: string
): string {
  const ids = getSelectedDispatcharrProfileIds(source);
  if (ids.length === 0) return allChannelsLabel;
  return ids
    .map((id) => getDispatcharrProfileName(source, id))
    .join(', ');
}

export interface SourceWithCategoriesLike {
  sourceId: string;
  // Keep this structural (no index signature) so CategoryWithCount / richer
  // category shapes remain assignable without widening fields to `unknown`.
  categories: Array<{ category_id: string }>;
}

/**
 * Expand Dispatcharr sources that have one or more channel lists selected into
 * virtual Live TV groups (`{sourceId}::dp:{profileId}`) with display names
 * `{sourceName}-{profileName}`. All-channels mode is left unchanged.
 */
export function expandDispatcharrProfileSources<T extends SourceWithCategoriesLike>(
  grouped: T[],
  sourceConfigs: Array<
    Pick<
      Source,
      | 'id'
      | 'name'
      | 'type'
      | 'dispatcharr_selected_profile_ids'
      | 'dispatcharr_selected_profile_id'
      | 'dispatcharr_selected_profile_names'
      | 'dispatcharr_selected_profile_name'
    >
  >
): { groups: T[]; virtualNames: Record<string, string> } {
  const byId = new Map(sourceConfigs.map((s) => [s.id, s]));
  const virtualNames: Record<string, string> = {};
  const out: T[] = [];

  for (const group of grouped) {
    const cfg = byId.get(group.sourceId);
    if (!cfg || cfg.type !== 'dispatcharr') {
      out.push(group);
      continue;
    }

    const profileIds = getSelectedDispatcharrProfileIds(cfg);
    if (profileIds.length === 0) {
      out.push(group);
      continue;
    }

    for (const profileId of profileIds) {
      const prefix = `${DISPATCHARR_PROFILE_CATEGORY_PREFIX}${profileId}:`;
      const cats = group.categories.filter((c) =>
        String(c.category_id).startsWith(prefix)
      );
      const virtualId = makeDispatcharrVirtualSourceId(group.sourceId, profileId);
      const displayName = makeDispatcharrProfileDisplayName(
        cfg.name || group.sourceId,
        getDispatcharrProfileName(cfg, profileId)
      );
      virtualNames[virtualId] = displayName;
      out.push({
        ...group,
        sourceId: virtualId,
        categories: cats,
      } as T);
    }
  }

  return { groups: out, virtualNames };
}

/**
 * Category id prefix for channels belonging to a virtual Dispatcharr profile source.
 * Returns null when `sourceIdOrVirtual` is a real (non-virtual) source id.
 */
export function dispatcharrProfileCategoryPrefixForSource(
  sourceIdOrVirtual: string
): string | null {
  const parsed = parseDispatcharrVirtualSourceId(sourceIdOrVirtual);
  if (!parsed) return null;
  return `${DISPATCHARR_PROFILE_CATEGORY_PREFIX}${parsed.profileId}:`;
}

/**
 * Expand sidebar source order so a Dispatcharr source with selected profiles
 * is replaced by its virtual `{sourceId}::dp:{profileId}` entries in place.
 */
export function expandSidebarOrderForDispatcharrProfiles(
  order: string[] | null | undefined,
  sourceConfigs: Array<
    Pick<
      Source,
      | 'id'
      | 'type'
      | 'dispatcharr_selected_profile_ids'
      | 'dispatcharr_selected_profile_id'
    >
  >
): string[] | null | undefined {
  if (!order) return order;
  const byId = new Map(sourceConfigs.map((s) => [s.id, s]));
  const result: string[] = [];
  for (const id of order) {
    const cfg = byId.get(id);
    if (cfg?.type === 'dispatcharr') {
      const profileIds = getSelectedDispatcharrProfileIds(cfg);
      if (profileIds.length > 0) {
        for (const profileId of profileIds) {
          result.push(makeDispatcharrVirtualSourceId(id, profileId));
        }
        continue;
      }
    }
    result.push(id);
  }
  return result;
}
