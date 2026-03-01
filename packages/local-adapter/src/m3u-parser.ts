/**
 * M3U Playlist Parser
 *
 * Parses M3U/M3U8 playlists with EXTINF metadata.
 * M3U playlist parser for IPTV channel lists.
 *
 * M3U Format:
 * #EXTM3U url-tvg="http://epg.url/xmltv.xml"
 * #EXTINF:-1 tvg-id="channel1" tvg-name="Channel One" tvg-logo="http://logo.png" group-title="News",Channel One
 * http://stream.url/live/123.ts
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Channel, Category } from '@ynotv/core';

/**
 * Generate a stable hash from a string (DJB2 algorithm)
 * Returns a short alphanumeric hash for use in IDs
 */
function stableHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
  }
  // Convert to base36 (alphanumeric) and take first 8 chars
  return Math.abs(hash).toString(36).substring(0, 8);
}

/**
 * Generate a stable stream_id for a channel
 * Uses tvg-id if available, otherwise falls back to URL hash
 * This ensures favorites, custom groups, and EPG remain matched after re-sync
 */
function generateStableStreamId(
  sourceId: string,
  tvgId: string,
  url: string,
  seenIds: Set<string>
): string {
  // Sanitize tvg-id for use in ID (remove special chars)
  const sanitizedTvgId = tvgId ? tvgId.replace(/[^a-zA-Z0-9._-]/g, '_') : '';

  // Try using tvg-id first
  if (sanitizedTvgId) {
    const baseId = `${sourceId}_${sanitizedTvgId}`;

    // If this tvg-id hasn't been seen yet, use it directly
    if (!seenIds.has(baseId)) {
      seenIds.add(baseId);
      return baseId;
    }

    // Tvg-id collision - add URL hash suffix to make it unique but stable
    // This handles cases like multiple ESPN backup channels with same tvg-id
    const urlHash = stableHash(url);
    const uniqueId = `${baseId}_${urlHash}`;
    seenIds.add(uniqueId);
    return uniqueId;
  }

  // No tvg-id - use URL hash for stable ID
  const urlHash = stableHash(url);
  const fallbackId = `${sourceId}_url_${urlHash}`;

  // Handle rare case of URL hash collision
  if (!seenIds.has(fallbackId)) {
    seenIds.add(fallbackId);
    return fallbackId;
  }

  // Extremely rare: hash collision - add counter
  let counter = 1;
  let finalId = `${fallbackId}_${counter}`;
  while (seenIds.has(finalId)) {
    counter++;
    finalId = `${fallbackId}_${counter}`;
  }
  seenIds.add(finalId);
  return finalId;
}



export interface M3UParseResult {
  channels: Channel[];
  categories: Category[];
  epgUrl: string | null;
}

interface ExtInfMetadata {
  duration: number;
  tvgId: string;
  tvgName: string;
  tvgLogo: string;
  tvgChno: number | null;  // Channel number for ordering
  groupTitle: string;
  displayName: string;
  tvArchive: boolean;
  catchupDays?: number;
  catchupSource?: string;
}

/**
 * Parse an M3U playlist content
 */
export function parseM3U(content: string, sourceId: string): M3UParseResult {
  const lines = content.split('\n').map(line => line.trim());
  const channels: Channel[] = [];
  const categoriesMap = new Map<string, Category>();

  let epgUrl: string | null = null;
  let currentMetadata: ExtInfMetadata | null = null;
  let channelCounter = 0;

  // Track seen stream_ids to handle duplicates (e.g., multiple channels with same tvg-id)
  const seenStreamIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip empty lines
    if (!line) continue;

    // Parse header for EPG URL
    if (line.startsWith('#EXTM3U')) {
      epgUrl = extractEpgUrl(line);
      continue;
    }

    // Parse EXTINF line
    if (line.startsWith('#EXTINF:')) {
      currentMetadata = parseExtInf(line);
      continue;
    }

    // Skip other comments/directives
    if (line.startsWith('#')) {
      continue;
    }

    // This should be a URL - create channel if we have metadata
    if (currentMetadata && (line.startsWith('http://') || line.startsWith('https://') || line.startsWith('rtmp://'))) {
      channelCounter++;

      // Generate stable stream_id that persists across re-syncs
      const streamId = generateStableStreamId(
        sourceId,
        currentMetadata.tvgId,
        line,
        seenStreamIds
      );

      // DEBUG: Log first few channels to verify stable ID generation
      if (channels.length < 5) {
        console.log(`[M3U DEBUG] Channel ${channels.length}: tvgId="${currentMetadata.tvgId}" -> stream_id="${streamId}"`);
      }

      // Create category if needed
      const categoryId = createCategoryId(sourceId, currentMetadata.groupTitle);
      if (currentMetadata.groupTitle && !categoriesMap.has(categoryId)) {
        categoriesMap.set(categoryId, {
          category_id: categoryId,
          category_name: currentMetadata.groupTitle,
          source_id: sourceId,
        });
      }

      // Create channel with stable stream_id
      const channel: Channel = {
        stream_id: streamId,
        name: currentMetadata.displayName || currentMetadata.tvgName || `Channel ${channelCounter}`,
        stream_icon: currentMetadata.tvgLogo || '',
        epg_channel_id: currentMetadata.tvgId || '',
        category_ids: categoryId ? [categoryId] : [],
        direct_url: line,
        source_id: sourceId,
        tv_archive: currentMetadata.tvArchive ? 1 : 0,
        ...(currentMetadata.tvgChno !== null && { channel_num: currentMetadata.tvgChno }),
      };

      channels.push(channel);
      currentMetadata = null;
    }
  }

  return {
    channels,
    categories: Array.from(categoriesMap.values()),
    epgUrl,
  };
}

/**
 * Extract EPG URL from #EXTM3U header
 */
function extractEpgUrl(line: string): string | null {
  // Try url-tvg="..."
  const urlTvgMatch = line.match(/url-tvg="([^"]+)"/i);
  if (urlTvgMatch) {
    return urlTvgMatch[1];
  }

  // Try x-tvg-url="..."
  const xTvgUrlMatch = line.match(/x-tvg-url="([^"]+)"/i);
  if (xTvgUrlMatch) {
    return xTvgUrlMatch[1];
  }

  return null;
}

/**
 * Parse #EXTINF line metadata
 *
 * Format: #EXTINF:duration key="value" key="value"...,Display Name
 * Example: #EXTINF:-1 tvg-id="cnn" tvg-logo="http://..." group-title="News",CNN HD
 */
function parseExtInf(line: string): ExtInfMetadata {
  const metadata: ExtInfMetadata = {
    duration: -1,
    tvgId: '',
    tvgName: '',
    tvgLogo: '',
    tvgChno: null,
    groupTitle: '',
    displayName: '',
    tvArchive: false,
  };

  // Remove #EXTINF: prefix
  const content = line.substring(8);

  // Split by comma to get display name (everything after last comma)
  const commaIndex = content.lastIndexOf(',');
  if (commaIndex !== -1) {
    metadata.displayName = content.substring(commaIndex + 1).trim();
  }

  // Parse the part before the comma for attributes
  const attrPart = commaIndex !== -1 ? content.substring(0, commaIndex) : content;

  // Extract duration (first number)
  const durationMatch = attrPart.match(/^(-?\d+)/);
  if (durationMatch) {
    metadata.duration = parseInt(durationMatch[1], 10);
  }

  // Extract tvg-id
  const tvgIdMatch = attrPart.match(/tvg-id="([^"]*)"/i);
  if (tvgIdMatch) {
    metadata.tvgId = tvgIdMatch[1];
  }

  // Extract tvg-name
  const tvgNameMatch = attrPart.match(/tvg-name="([^"]*)"/i);
  if (tvgNameMatch) {
    metadata.tvgName = tvgNameMatch[1];
  }

  // Extract tvg-logo
  const tvgLogoMatch = attrPart.match(/tvg-logo="([^"]*)"/i);
  if (tvgLogoMatch) {
    metadata.tvgLogo = tvgLogoMatch[1];
  }

  // Extract group-title
  const groupTitleMatch = attrPart.match(/group-title="([^"]*)"/i);
  if (groupTitleMatch) {
    metadata.groupTitle = groupTitleMatch[1];
  }

  // Extract catchup tags
  const catchupMatch = attrPart.match(/catchup="([^"]*)"/i);
  if (catchupMatch && catchupMatch[1].length > 0) {
    metadata.tvArchive = true;
  }

  const catchupDaysMatch = attrPart.match(/catchup-days="([^"]*)"/i);
  if (catchupDaysMatch) {
    const days = parseInt(catchupDaysMatch[1], 10);
    if (!isNaN(days) && days > 0) {
      metadata.tvArchive = true;
      metadata.catchupDays = days;
    }
  }

  const catchupSourceMatch = attrPart.match(/catchup-source="([^"]*)"/i);
  if (catchupSourceMatch && catchupSourceMatch[1].length > 0) {
    metadata.tvArchive = true;
    metadata.catchupSource = catchupSourceMatch[1];
  }

  // Extract tvg-chno (channel number for ordering)
  const tvgChnoMatch = attrPart.match(/tvg-chno="([^"]*)"/i);
  if (tvgChnoMatch) {
    const num = parseInt(tvgChnoMatch[1], 10);
    if (!isNaN(num)) {
      metadata.tvgChno = num;
    }
  }

  return metadata;
}

/**
 * Create a category ID from source and group name
 */
function createCategoryId(sourceId: string, groupTitle: string): string {
  if (!groupTitle) return '';

  // Slugify the group title
  const slug = groupTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return `${sourceId}_${slug}`;
}

/**
 * Fetch and parse an M3U playlist from URL
 */
export async function fetchAndParseM3U(url: string, sourceId: string, userAgent?: string): Promise<M3UParseResult> {
  const headers: Record<string, string> = {};
  if (userAgent) {
    headers['User-Agent'] = userAgent;
  }

  // Tauri Environment
  if ((window as any).__TAURI__) {
    const response = await tauriFetch(url, { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch M3U: ${response.status} ${response.statusText}`);
    }
    const content = await response.text();
    return parseM3U(content, sourceId);
  }

  // Use Electron's fetch proxy if available (bypasses CORS + SSRF protection)
  if (typeof window !== 'undefined' && window.fetchProxy) {
    const result = await window.fetchProxy.fetch(url, { headers });
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Failed to fetch M3U');
    }
    if (!result.data.ok) {
      throw new Error(`Failed to fetch M3U: ${result.data.status} ${result.data.statusText}`);
    }
    return parseM3U(result.data.text, sourceId);
  }

  // Fallback to regular fetch (Node.js or when CORS is not an issue)
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Failed to fetch M3U: ${response.status} ${response.statusText}`);
  }

  const content = await response.text();
  return parseM3U(content, sourceId);
}
