/**
 * XMLTV Parser - Parses XMLTV format EPG data
 *
 * XMLTV is the standard format for IPTV EPG data.
 * Used by both Xtream and M3U sources.
 */

export interface XmltvProgram {
  channel_id: string;
  title: string;
  description: string;
  start: Date;
  stop: Date;
}

/**
 * Parse XMLTV format EPG data
 */
export function parseXmltv(xml: string): XmltvProgram[] {
  const programs: XmltvProgram[] = [];

  // More flexible regex - extracts attributes individually since order varies
  // Matches: <programme ...attributes... >content</programme>
  const programPattern = /<programme\s+([^>]+)>([\s\S]*?)<\/programme>/gi;
  const startAttr = /start="([^"]+)"/;
  const stopAttr = /stop="([^"]+)"/;
  const channelAttr = /channel="([^"]+)"/;
  const titlePattern = /<title[^>]*>([^<]*)<\/title>/i;
  const descPattern = /<desc[^>]*>([^<]*)<\/desc>/i;

  let match;
  while ((match = programPattern.exec(xml)) !== null) {
    const [, attrs, content] = match;

    const startMatch = attrs.match(startAttr);
    const stopMatch = attrs.match(stopAttr);
    const channelMatch = attrs.match(channelAttr);

    if (!startMatch || !stopMatch || !channelMatch) continue;

    const titleMatch = content.match(titlePattern);
    const descMatch = content.match(descPattern);

    const title = titleMatch ? decodeXmlEntities(titleMatch[1]) : '';
    const desc = descMatch ? decodeXmlEntities(descMatch[1]) : '';

    // Parse XMLTV date format: YYYYMMDDHHmmss +0000
    const start = parseXmltvDate(startMatch[1]);
    const stop = parseXmltvDate(stopMatch[1]);

    if (start && stop && title) {
      programs.push({
        channel_id: channelMatch[1],
        title,
        description: desc,
        start,
        stop,
      });
    }
  }

  return programs;
}

/**
 * Parse XMLTV date format: YYYYMMDDHHmmss +0000
 */
function parseXmltvDate(dateStr: string): Date | null {
  const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!match) return null;

  const [, year, month, day, hour, min, sec, tz] = match;
  const isoStr = `${year}-${month}-${day}T${hour}:${min}:${sec}${tz ? tz.slice(0, 3) + ':' + tz.slice(3) : 'Z'}`;
  return new Date(isoStr);
}

/**
 * Decode XML entities in a string
 */
function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}
