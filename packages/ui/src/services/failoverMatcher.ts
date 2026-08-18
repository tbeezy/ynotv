/**
 * Smart Failover Matching & Clustering Engine.
 *
 * Automatically detects and clusters similar channels into Failover Groups
 * with confidence scoring, quality variant detection (4K/FHD/HD/SD), callsign
 * detection for local stations, strict East vs West feed separation, and
 * user-configurable country cross-linking.
 */

import { db, type StoredChannel } from '../db';

// ─── Regex & Pattern Definitions ─────────────────────────────────────────────

const QUALITY_REGEX = /\b(4k|8k|uhd|fhd|hd|sd|hevc|1080p|1080i|720p|50fps|60fps|raw|low|hq|ᴴᴰ|ᴿᴬᵂ)\b/gi;
const COUNTRY_EXTRACT_REGEX = /^(?:[•●★\-_|~:\s]*)\b(US|USA|UK|CA|AU|ES|FR|DE|IT|MX|LATIN|LATINO|NZ|IE)\b\s*[:|/\-•\s]+\s*/i;
const BRACKET_COUNTRY_REGEX = /^(?:[•●★\-_|~:\s]*)\[(US|USA|UK|CA|AU|ES|FR|DE|IT|MX|LATIN|LATINO|NZ|IE)\]\s*/i;
const PAREN_COUNTRY_REGEX = /^(?:[•●★\-_|~:\s]*)\((US|USA|UK|CA|AU|ES|FR|DE|IT|MX|LATIN|LATINO|NZ|IE)\)\s*/i;

const FEED_EAST_REGEX = /\b(east|\(e\)|est|\(east\)|este|\(ny\))\b/i;
const FEED_WEST_REGEX = /\b(west|\(w\)|pst|\(west\)|oeste|\(la\))\b/i;

// Match explicit 4-letter US callsign in parentheses e.g. "(WABC)", "(KOVR)", "(WQRF)"
const CALLSIGN_PAREN_REGEX = /\(([WK][A-Z]{3})\)/i;
// Match standalone 4-letter US callsign starting with W or K
const CALLSIGN_WORD_REGEX = /\b([WK][A-Z]{3})\b/i;

// Common English words and channel terms starting with W or K that are NOT callsigns
const NON_CALLSIGN_STOPWORDS = new Set([
  'WITH', 'WHEN', 'WHAT', 'WILL', 'WANT', 'WELL', 'WILD', 'WAVE', 'WARS',
  'WEST', 'WIND', 'WORD', 'WORK', 'WIDE', 'WIRE', 'WISH', 'WIFE', 'WEEK',
  'WARM', 'WASH', 'WEAR', 'WOOD', 'WALL', 'WOKE', 'WOLF',
  'KIDS', 'KING', 'KEEP', 'KNOW', 'KILL', 'KISS', 'KICK', 'KIND', 'KARA',
  'KORE', 'KART', 'KALE', 'KNIT', 'KNOX', 'KEEN', 'KEMP',
  'WARNER', 'WORLD', 'WOMEN', 'WATER', 'WHITE',
]);

export interface ParsedChannelInfo {
  stream_id: string;
  rawName: string;
  country: string | null;
  feed: 'east' | 'west' | 'neutral';
  callsign: string | null;
  quality: '4k' | 'fhd' | 'hd' | 'sd';
  cleanName: string;
  tokens: string[];
}

export interface FailoverMatchConfig {
  minConfidence?: number;           // 0.0 to 1.0 (default 0.75)
  sourceIds?: string[];             // Scoped enabled source IDs
  categoryIds?: string[];           // Scoped category IDs
  groupQualityVariants?: boolean;   // Group HD, FHD, SD, 4K (default true)
  matchByCallsign?: boolean;        // Group local broadcast stations by callsign (default true)
  strictFeedSeparation?: boolean;   // Legacy compatibility
  feedMode?: 'merge_neutral_east' | 'combine_all' | 'strict_separate'; // Default 'merge_neutral_east'
  stripCountryPrefixes?: boolean;   // Strip country prefixes like US | , USA: (default true)
  countryMode?: 'same_only' | 'acceptable_set' | 'any'; // Default 'same_only'
  acceptableCountries?: string[];   // e.g. ['US', 'CA', 'UK']
}


export interface FailoverCandidate {
  channel: StoredChannel;
  score: number; // 0.0 to 1.0
  reason: string;
  parsed: ParsedChannelInfo;
}

export interface ProposedFailoverGroup {
  name: string;
  confidence: number;
  reason: string;
  key: string;
  channels: Array<StoredChannel & { parsed: ParsedChannelInfo; priority: number }>;
}

export interface ExistingGroupAddition {
  groupId: string;
  groupName: string;
  existingMemberCount: number;
  candidates: FailoverCandidate[];
}

// ─── Channel Parser ──────────────────────────────────────────────────────────

export function parseChannelInfo(name: string, stream_id = '', stripCountry = true): ParsedChannelInfo {
  let raw = (name || '').trim();

  // Strip leading decorative symbols
  raw = raw.replace(/^[•●★\-_|~:\s]+/, '').trim();

  // 1. Extract Country
  let country: string | null = null;
  let cpMatch = raw.match(BRACKET_COUNTRY_REGEX);
  if (cpMatch) {
    country = cpMatch[1].toUpperCase();
    if (stripCountry) raw = raw.replace(BRACKET_COUNTRY_REGEX, '').trim();
  } else {
    cpMatch = raw.match(PAREN_COUNTRY_REGEX);
    if (cpMatch) {
      country = cpMatch[1].toUpperCase();
      if (stripCountry) raw = raw.replace(PAREN_COUNTRY_REGEX, '').trim();
    } else {
      cpMatch = raw.match(COUNTRY_EXTRACT_REGEX);
      if (cpMatch) {
        country = cpMatch[1].toUpperCase();
        if (stripCountry) raw = raw.replace(COUNTRY_EXTRACT_REGEX, '').trim();
      }
    }
  }

  if (country === 'USA') country = 'US';
  if (country === 'LATINO') country = 'LATIN';

  // Strip any leftover prefix characters e.g. "| " or ": "
  raw = raw.replace(/^[•●★\-_|~:\s]+/, '').trim();

  // 2. Extract Feed (East vs West)
  let feed: 'east' | 'west' | 'neutral' = 'neutral';
  if (FEED_EAST_REGEX.test(raw)) {
    feed = 'east';
  } else if (FEED_WEST_REGEX.test(raw)) {
    feed = 'west';
  }

  // 3. Extract Callsign
  let callsign: string | null = null;
  const parenCallMatch = raw.match(CALLSIGN_PAREN_REGEX);
  if (parenCallMatch) {
    const cand = parenCallMatch[1].toUpperCase();
    if (!NON_CALLSIGN_STOPWORDS.has(cand)) {
      callsign = cand;
    }
  }
  if (!callsign) {
    const callMatch = raw.match(CALLSIGN_WORD_REGEX);
    if (callMatch) {
      const cand = callMatch[1].toUpperCase();
      if (!NON_CALLSIGN_STOPWORDS.has(cand)) {
        callsign = cand;
      }
    }
  }

  // 4. Extract Resolution / Quality
  let quality: '4k' | 'fhd' | 'hd' | 'sd' = 'sd';
  if (/\b(4k|8k|uhd)\b/i.test(raw)) {
    quality = '4k';
  } else if (/\b(fhd|1080p|1080i|raw|ᴿᴬᵂ)\b/i.test(raw)) {
    quality = 'fhd';
  } else if (/\b(hd|720p|ᴴᴰ)\b/i.test(raw)) {
    quality = 'hd';
  }

  // 5. Clean Base Name
  let cleaned = raw
    .replace(QUALITY_REGEX, '')
    .replace(/\b(east|west|\(e\)|\(w\)|est|pst|\(east\)|\(west\)|\(ny\)|\(la\)|este|oeste)\b/gi, '')
    .replace(/\([^)]*\)/g, (match) => {
      // Keep callsign if it was in parentheses
      const m = match.match(/([WK][A-Z]{3})/i);
      return m && !NON_CALLSIGN_STOPWORDS.has(m[1].toUpperCase()) ? ` ${m[1].toUpperCase()} ` : ' ';
    })
    .replace(/[•●★\-:|_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();


  // Normalize tokens
  const tokens = cleaned
    .split(/\s+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length > 0);

  return {
    stream_id,
    rawName: name,
    country,
    feed,
    callsign,
    quality,
    cleanName: cleaned,
    tokens,
  };
}

export function parseCategoryIds(raw: string | string[] | number[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* not JSON */
  }
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return [String(raw)];
}

// ─── Scoring & Comparison ────────────────────────────────────────────────────

function areCountriesCompatible(
  countryA: string | null,
  countryB: string | null,
  config?: FailoverMatchConfig
): boolean {
  const mode = config?.countryMode || 'same_only';
  if (mode === 'any') return true;

  // If both have no country tag, treat as compatible
  if (!countryA && !countryB) return true;

  // If both have countries, check equality or acceptable set
  if (countryA && countryB) {
    if (countryA === countryB) return true;
    if (mode === 'acceptable_set' && config?.acceptableCountries && config.acceptableCountries.length > 0) {
      const set = new Set(config.acceptableCountries.map((c) => c.toUpperCase()));
      return set.has(countryA) && set.has(countryB);
    }
    return false;
  }

  // If one has country and one does not
  if (mode === 'same_only') {
    return true;
  }

  return true;
}

export function scoreChannelPair(
  a: ParsedChannelInfo,
  b: ParsedChannelInfo,
  config?: FailoverMatchConfig
): { score: number; reason: string } | null {
  const feedMode = config?.feedMode || (config?.strictFeedSeparation === false ? 'combine_all' : 'merge_neutral_east');
  const matchCallsign = config?.matchByCallsign ?? true;

  // Hard Rule 1: Feed Separation / Alignment
  if (feedMode === 'strict_separate') {
    if (a.feed !== b.feed) return null;
  } else if (feedMode === 'merge_neutral_east') {
    const isEastA = a.feed === 'east' || a.feed === 'neutral';
    const isEastB = b.feed === 'east' || b.feed === 'neutral';
    if (isEastA !== isEastB) {
      return null;
    }
  }

  // Hard Rule 2: Country Compatibility
  if (!areCountriesCompatible(a.country, b.country, config)) {
    return null;
  }


  // Hard Rule 3: Callsign Handling
  if (matchCallsign) {
    if (a.callsign && b.callsign) {
      if (a.callsign === b.callsign) {
        return {
          score: 0.98,
          reason: `Same Callsign (${a.callsign})`,
        };
      } else {
        // Different callsigns = different local stations -> DO NOT LINK
        return null;
      }
    }
  }

  // Rule 4: Exact Clean Name Match
  if (a.cleanName && b.cleanName && a.cleanName === b.cleanName) {
    if (a.quality !== b.quality && (config?.groupQualityVariants ?? true)) {
      return {
        score: 0.96,
        reason: `Quality Variant (${a.quality.toUpperCase()} / ${b.quality.toUpperCase()})`,
      };
    }
    return {
      score: 0.98,
      reason: 'Exact Match across Sources',
    };
  }

  // Rule 5: Token Overlap & Fuzzy Similarity
  if (a.tokens.length > 0 && b.tokens.length > 0) {
    const setA = new Set(a.tokens);
    const setB = new Set(b.tokens);
    let intersection = 0;
    for (const t of setA) {
      if (setB.has(t)) intersection++;
    }
    const union = new Set([...a.tokens, ...b.tokens]).size;
    const jaccard = union > 0 ? intersection / union : 0;

    if (jaccard >= 0.8) {
      return {
        score: 0.88,
        reason: 'High Name Similarity',
      };
    } else if (jaccard >= 0.6) {
      return {
        score: 0.76,
        reason: 'Partial Name Match',
      };
    }
  }

  return null;
}

// Helper to determine priority order by quality (4k > fhd > hd > sd)
export function getQualityPriority(quality: '4k' | 'fhd' | 'hd' | 'sd'): number {
  switch (quality) {
    case '4k': return 0;
    case 'fhd': return 1;
    case 'hd': return 2;
    case 'sd': return 3;
    default: return 2;
  }
}

// ─── Active Enabled Sources & Channels Helper ────────────────────────────────

export async function getEnabledSourcesAndCategories(): Promise<{
  enabledSourceIds: Set<string>;
  enabledCategoryIds: Set<string>;
}> {
  try {
    const sourcesResult = window.storage ? await window.storage.getSources() : { data: [] };
    const enabledSourceIds = new Set<string>(
      (sourcesResult.data || [])
        .filter((s: any) => s.enabled !== false)
        .map((s: any) => String(s.id))
    );

    const allCategories = await db.categories.toArray();
    const enabledCategoryIds = new Set<string>(
      allCategories
        .filter((c) => enabledSourceIds.has(String(c.source_id)) && c.enabled !== false)
        .map((c) => String(c.category_id))
    );

    return { enabledSourceIds, enabledCategoryIds };
  } catch (err) {
    console.error('[FailoverMatcher] Failed to load enabled sources/categories:', err);
    return { enabledSourceIds: new Set(), enabledCategoryIds: new Set() };
  }
}

export async function fetchEligibleChannels(
  config?: FailoverMatchConfig
): Promise<StoredChannel[]> {
  const { enabledSourceIds, enabledCategoryIds } = await getEnabledSourcesAndCategories();
  if (enabledSourceIds.size === 0) return [];

  let targetSourceIds = Array.from(enabledSourceIds);
  if (config?.sourceIds && config.sourceIds.length > 0) {
    targetSourceIds = targetSourceIds.filter((id) => config.sourceIds!.includes(id));
  }
  if (targetSourceIds.length === 0) return [];

  const sourcePlaceholders = targetSourceIds.map(() => '?').join(',');
  let allChannels: StoredChannel[];

  if (config?.categoryIds && config.categoryIds.length > 0) {
    const catPlaceholders = config.categoryIds.map(() => '?').join(',');
    const sql = `SELECT DISTINCT c.* FROM channels c CROSS JOIN json_each(c.category_ids) AS cat
                 WHERE (c.enabled IS NULL OR c.enabled != 0)
                   AND c.source_id IN (${sourcePlaceholders})
                   AND cat.value IN (${catPlaceholders})`;
    allChannels = await db.query<StoredChannel>(sql, [...targetSourceIds, ...config.categoryIds]);
  } else {
    const sql = `SELECT c.* FROM channels c
                 WHERE (c.enabled IS NULL OR c.enabled != 0)
                   AND c.source_id IN (${sourcePlaceholders})`;
    allChannels = await db.query<StoredChannel>(sql, targetSourceIds);
  }

  // Filter out any channels belonging to disabled categories
  return allChannels.filter((c) => {
    if (c.enabled === false) return false;
    const catIds = parseCategoryIds(c.category_ids);
    if (catIds.length > 0 && enabledCategoryIds.size > 0) {
      return catIds.some((id) => enabledCategoryIds.has(String(id)));
    }
    return true;
  });
}

// ─── Single Channel Candidate Finder ─────────────────────────────────────────

export async function findFailoverCandidatesForChannel(
  channel: StoredChannel,
  config?: FailoverMatchConfig
): Promise<FailoverCandidate[]> {
  const stripCountry = config?.stripCountryPrefixes ?? true;
  const parsedTarget = parseChannelInfo(channel.alias || channel.name, channel.stream_id, stripCountry);
  const minConfidence = config?.minConfidence ?? 0.75;

  const eligibleChannels = await fetchEligibleChannels(config);
  const candidates: FailoverCandidate[] = [];

  for (const ch of eligibleChannels) {
    if (ch.stream_id === channel.stream_id) continue;

    const parsedCh = parseChannelInfo(ch.alias || ch.name, ch.stream_id, stripCountry);
    const match = scoreChannelPair(parsedTarget, parsedCh, config);
    if (match && match.score >= minConfidence) {
      candidates.push({
        channel: ch,
        score: match.score,
        reason: match.reason,
        parsed: parsedCh,
      });
    }
  }

  // Sort candidates by score descending, then by quality priority
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return getQualityPriority(a.parsed.quality) - getQualityPriority(b.parsed.quality);
  });

  return candidates;
}

// ─── Automated Full Clustering Engine ────────────────────────────────────────

export async function clusterChannelsIntoFailoverGroups(
  config?: FailoverMatchConfig
): Promise<{
  proposedGroups: ProposedFailoverGroup[];
  existingAdditions: ExistingGroupAddition[];
}> {
  const stripCountry = config?.stripCountryPrefixes ?? true;
  const eligibleChannels = await fetchEligibleChannels(config);
  if (eligibleChannels.length === 0) {
    return { proposedGroups: [], existingAdditions: [] };
  }

  // Load existing failover groups and their members to preserve them
  const existingGroups = await db.failoverGroups.toArray();
  const existingMembers = await db.failoverGroupMembers.toArray();
  const streamToGroupId = new Map<string, string>();
  for (const m of existingMembers) {
    streamToGroupId.set(m.stream_id, m.group_id);
  }

  // Parse all channels
  const parsedList = eligibleChannels.map((c) => ({
    channel: c,
    parsed: parseChannelInfo(c.alias || c.name, c.stream_id, stripCountry),
  }));


  // Group into initial clusters based on deterministic keys
  const clusters = new Map<
    string,
    {
      name: string;
      key: string;
      reason: string;
      country: string | null;
      members: Array<{ channel: StoredChannel; parsed: ParsedChannelInfo }>;
    }
  >();

  for (const item of parsedList) {
    const { parsed, channel } = item;
    if (!parsed.cleanName || parsed.cleanName.length < 2) continue;

    // Check if country matches acceptable policy
    if (config?.countryMode === 'acceptable_set' && config.acceptableCountries && config.acceptableCountries.length > 0) {
      if (parsed.country && !config.acceptableCountries.map(c => c.toUpperCase()).includes(parsed.country)) {
        continue;
      }
    }

    const feedMode = config?.feedMode || (config?.strictFeedSeparation === false ? 'combine_all' : 'merge_neutral_east');
    let feedKey: string = parsed.feed;
    if (feedMode === 'combine_all') {
      feedKey = 'ALL';
    } else if (feedMode === 'merge_neutral_east') {
      feedKey = (parsed.feed === 'neutral' || parsed.feed === 'east') ? 'EAST_MAIN' : 'WEST';
    }


    let suffix = '';
    if (feedKey === 'WEST') suffix = ' (West)';
    else if (feedMode === 'strict_separate' && parsed.feed === 'east') suffix = ' (East)';

    let clusterKey: string;
    let displayName: string;
    let reason: string;

    const countryKey = (config?.countryMode === 'any' || (config?.countryMode === 'acceptable_set' && (!parsed.country || config.acceptableCountries?.map(c => c.toUpperCase()).includes(parsed.country))))
      ? 'SET'
      : (parsed.country || 'ANY');

    if (config?.matchByCallsign !== false && parsed.callsign) {
      clusterKey = `CALL:${parsed.callsign}:${countryKey}:${feedKey}`;
      displayName = parsed.cleanName.toUpperCase() + suffix;
      reason = `Callsign: ${parsed.callsign}`;
    } else {
      clusterKey = `NAME:${parsed.cleanName}:${countryKey}:${feedKey}`;
      // Capitalize display name nicely
      displayName = parsed.cleanName
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ') + suffix;
      reason = 'Identical Channel Feed';
    }


    if (!clusters.has(clusterKey)) {
      clusters.set(clusterKey, {
        name: displayName,
        key: clusterKey,
        reason,
        country: parsed.country,
        members: [],
      });
    }

    clusters.get(clusterKey)!.members.push({ channel, parsed });
  }

  // Identify new clusters vs additions to existing groups
  const proposedGroups: ProposedFailoverGroup[] = [];
  const existingAdditionsMap = new Map<string, FailoverCandidate[]>();

  for (const cluster of clusters.values()) {
    if (cluster.members.length <= 1) continue;

    // Check if any member in this cluster is already in an existing failover group
    const existingGroupIds = new Set<string>();
    for (const m of cluster.members) {
      const gId = streamToGroupId.get(m.channel.stream_id);
      if (gId) existingGroupIds.add(gId);
    }

    if (existingGroupIds.size > 0) {
      // Stream(s) belong to existing group(s) — suggest unlinked channels as additions
      for (const targetGroupId of existingGroupIds) {
        const unlinked = cluster.members.filter(
          (m) => !streamToGroupId.has(m.channel.stream_id)
        );
        if (unlinked.length > 0) {
          const currentAdditions = existingAdditionsMap.get(targetGroupId) || [];
          for (const u of unlinked) {
            if (!currentAdditions.some((c) => c.channel.stream_id === u.channel.stream_id)) {
              currentAdditions.push({
                channel: u.channel,
                score: 0.95,
                reason: cluster.reason,
                parsed: u.parsed,
              });
            }
          }
          existingAdditionsMap.set(targetGroupId, currentAdditions);
        }
      }
    } else {
      // Brand new proposed failover group!
      // Sort members by quality priority: 4K (0) -> FHD (1) -> HD (2) -> SD (3)
      const sortedMembers = [...cluster.members].sort(
        (a, b) => getQualityPriority(a.parsed.quality) - getQualityPriority(b.parsed.quality)
      );

      const orderedChannels = sortedMembers.map((m, idx) => ({
        ...m.channel,
        parsed: m.parsed,
        priority: idx,
      }));

      proposedGroups.push({
        name: cluster.name,
        confidence: 0.95,
        reason: cluster.reason,
        key: cluster.key,
        channels: orderedChannels,
      });
    }
  }

  // Build existing additions array
  const groupMap = new Map(existingGroups.map((g) => [g.group_id, g]));
  const existingAdditions: ExistingGroupAddition[] = [];

  for (const [groupId, candidates] of existingAdditionsMap.entries()) {
    const grp = groupMap.get(groupId);
    if (grp && candidates.length > 0) {
      const existingMembersCount = existingMembers.filter((m) => m.group_id === groupId).length;
      existingAdditions.push({
        groupId,
        groupName: grp.name,
        existingMemberCount: existingMembersCount,
        candidates,
      });
    }
  }

  // Sort proposed groups alphabetically by name
  proposedGroups.sort((a, b) => a.name.localeCompare(b.name));

  return { proposedGroups, existingAdditions };
}
