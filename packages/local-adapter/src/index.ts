export { parseM3U, fetchAndParseM3U, extractXtreamStreamId } from './m3u-parser';
export type { M3UParseResult } from './m3u-parser';
export { buildM3uCatchupUrl } from './m3u-catchup';
export type { M3uCatchupOptions } from './m3u-catchup';

// XMLTV Parser (shared by Xtream and M3U)
export { parseXmltv, extractXmltvChannels } from './xmltv-parser';
export type { XmltvProgram, XmltvChannel } from './xmltv-parser';

// Xtream Client
export { XtreamClient } from './xtream-client';
export type {
  XtreamConfig,
  XtreamServerInfo,
  XtreamUserInfo,
  XtreamAuthResponse,
} from './xtream-client';

// Stalker Client
export { StalkerClient } from './stalker-client';
export type {
  StalkerConfig,
  StalkerCatchupOptions,
  StalkerSearchEndpoint,
  StalkerSearchMatchKind,
  StalkerSearchOptions,
  StalkerSearchResult,
} from './stalker-client';

// Dispatcharr Direct Connect Client
export { DispatcharrClient, mapDispatcharrEpgGridToPrograms } from './dispatcharr-client';
export type {
  DispatcharrConfig,
  DispatcharrChannelProfile,
  DispatcharrUser,
  DispatcharrEpgGridProgram,
  DispatcharrEpgGridOptions,
} from './dispatcharr-client';
