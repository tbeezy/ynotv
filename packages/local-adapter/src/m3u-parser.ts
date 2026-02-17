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

      // Create category if needed
      const categoryId = createCategoryId(sourceId, currentMetadata.groupTitle);
      if (currentMetadata.groupTitle && !categoriesMap.has(categoryId)) {
        categoriesMap.set(categoryId, {
          category_id: categoryId,
          category_name: currentMetadata.groupTitle,
          source_id: sourceId,
        });
      }

      // Create channel
      const channel: Channel = {
        stream_id: `${sourceId}_${channelCounter}`,
        name: currentMetadata.displayName || currentMetadata.tvgName || `Channel ${channelCounter}`,
        stream_icon: currentMetadata.tvgLogo || '',
        epg_channel_id: currentMetadata.tvgId || '',
        category_ids: categoryId ? [categoryId] : [],
        direct_url: line,
        source_id: sourceId,
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
