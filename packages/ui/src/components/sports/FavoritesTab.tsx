import { useState, useEffect, useMemo, useCallback } from 'react';
import i18n from '../../i18n';
import type { SportsTeam, SportsEvent, SportsTabId } from '@ynotv/core';
import { 
  useFavoriteTeams, 
  useRemoveFavorite, 
  useTogglePinFavorite,
  useReorderFavorites,
  type FavoriteTeam 
} from '../../stores/sportsFavoritesStore';
import { useSportsSettingsStore } from '../../stores/sportsSettingsStore';
import { useSportsPolling } from '../../hooks/useSportsPolling';
import { useEpgClockFormat } from '../../stores/uiStore';
import { useTranslation } from 'react-i18next';
import { 
  getTeamDetails, 
  getTeamSchedule,
  formatEventTime, 
  formatEventDate,
  isEventLiveOrPastStart,
  type TeamDetails
} from '../../services/sports';
import type { StoredChannel } from '../../db';
import { searchGameStreams } from '../../services/sports/gameStreamSearcher';
import { TeamDetail } from './TeamDetail';
import { GameDetail } from './GameDetail';

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { eventInvolvesTeam } from './favoritesMatch';

interface FavoritesTabProps {
  onSearchChannels?: (channelName: string) => void;
  onPlayChannel?: (channel: StoredChannel) => void;
  onSetTab?: (tab: SportsTabId) => void;
}

interface CachedTeamEntry {
  details: TeamDetails | null;
  fetchedAt: number;
  hasLive: boolean;
}

// Cooldown and batching configuration matching Live Now standards
const COOLDOWN_LIVE_MS = 30 * 1000;       // 30 seconds if team is live
const COOLDOWN_IDLE_MS = 5 * 60 * 1000;   // 5 minutes if team is non-live
const BATCH_SIZE = 3;                      // Max 3 concurrent requests at a time
const BATCH_DELAY_MS = 500;                // 500ms delay between batches

/**
 * Window-level global cache to persist favorite team data across tab navigations & unmounts
 */
const getWindowFavoritesCache = (): Map<string, CachedTeamEntry> => {
  const w = window as unknown as { __sportsFavoritesCache?: Map<string, CachedTeamEntry> };
  if (!w.__sportsFavoritesCache) {
    w.__sportsFavoritesCache = new Map();
  }
  return w.__sportsFavoritesCache;
};

/**
 * Deduplicate active in-flight promises across concurrent re-renders
 */
const getInFlightMap = (): Map<string, Promise<TeamDetails | null>> => {
  const w = window as unknown as { __sportsFavoritesInFlight?: Map<string, Promise<TeamDetails | null>> };
  if (!w.__sportsFavoritesInFlight) {
    w.__sportsFavoritesInFlight = new Map();
  }
  return w.__sportsFavoritesInFlight;
};

/**
 * Common city/location prefixes to strip for optimal team search query building.
 */
const TEAM_CITY_PREFIXES: string[] = [
  'St. Louis', 'St Louis', 'New York', 'Los Angeles', 'San Francisco', 'San Diego',
  'San Jose', 'Kansas City', 'Oklahoma City', 'Salt Lake', 'New Orleans',
  'Las Vegas', 'Green Bay', 'Tampa Bay', 'Bay Area', 'Golden State',
  'New England', 'Carolina', 'Rhode Island',
  'Fort Worth', 'Fort Lauderdale', 'El Paso', 'San Antonio', 'Little Rock',
  'Baton Rouge', 'West Ham', 'Crystal Palace', 'Brighton', 'Sheffield',
  'Nottingham', 'Wolverhampton', 'Aston', 'Porto Alegre',
  'Porto', 'Real Madrid', 'Real Sociedad', 'Real Betis', 'Real Valladolid',
  'Atletico', 'Athletic',
  'Atlanta', 'Baltimore', 'Boston', 'Buffalo', 'Charlotte', 'Chicago',
  'Cincinnati', 'Cleveland', 'Colorado', 'Columbus', 'Dallas', 'Denver',
  'Detroit', 'Edmonton', 'Florida', 'Houston', 'Indiana', 'Jacksonville',
  'Louisville', 'Memphis', 'Miami', 'Milwaukee', 'Minnesota', 'Montreal',
  'Nashville', 'Newark', 'Oakland', 'Orlando', 'Ottawa', 'Philadelphia',
  'Phoenix', 'Pittsburgh', 'Portland', 'Sacramento', 'Seattle', 'Toronto',
  'Utah', 'Vancouver', 'Washington', 'Winnipeg', 'Arizona', 'Tennessee',
  'Arsenal', 'Chelsea', 'Everton', 'Liverpool', 'Fulham', 'Brentford',
  'Bayern', 'Dortmund', 'Barcelona', 'Juventus', 'Napoli', 'Milan', 'Roma', 'Inter',
  'Paris', 'Lyon', 'Marseille', 'Monaco', 'Ajax', 'Lisbon', 'Porto'
].sort((a, b) => b.length - a.length);

function stripCityPrefix(name: string): string {
  const trimmed = name.trim();
  for (const city of TEAM_CITY_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(city.toLowerCase() + ' ')) {
      const nickname = trimmed.slice(city.length).trim();
      if (nickname.length > 0) return nickname;
    }
  }
  return trimmed;
}

function buildTeamSearchQuery(homeTeam: string, awayTeam?: string): string {
  if (!awayTeam) return stripCityPrefix(homeTeam);
  return `${stripCityPrefix(homeTeam)} ${stripCityPrefix(awayTeam)}`;
}



/**
 * Single team fetch worker with promise deduplication
 */
async function fetchSingleTeamData(teamId: string, leagueId: string): Promise<TeamDetails | null> {
  const inFlight = getInFlightMap();

  if (inFlight.has(teamId)) {
    return inFlight.get(teamId)!;
  }

  const promise = (async () => {
    try {
      const [details, schedule] = await Promise.all([
        getTeamDetails(teamId, leagueId, false).catch(() => null), // includeRoster = false
        getTeamSchedule(teamId, leagueId).catch(() => ({ upcoming: [], past: [] })),
      ]);

      const now = new Date();
      const nextGameFromSchedule = schedule?.upcoming?.find(
        (e) => e.status === 'scheduled' && new Date(e.startTime).getTime() > now.getTime()
      );
      if (details) {
        if (nextGameFromSchedule) {
          details.nextEvent = nextGameFromSchedule;
        } else if (
          details.nextEvent &&
          (details.nextEvent.status !== 'scheduled' || new Date(details.nextEvent.startTime).getTime() <= now.getTime())
        ) {
          details.nextEvent = undefined;
        }
      }
      return details;
    } finally {
      inFlight.delete(teamId);
    }
  })();

  inFlight.set(teamId, promise);
  return promise;
}

/**
 * Sortable Favorite Team Card Component using @dnd-kit
 */
interface SortableFavoriteCardProps {
  team: FavoriteTeam;
  details: TeamDetails | null;
  liveEvent?: SportsEvent;
  nextEvent?: SportsEvent;
  isLive: boolean;
  searchQuery: string;
  isSearching: boolean;
  streamsList: StoredChannel[] | null | undefined;
  epgClockFormat: string;
  onSelectTeam: (team: SportsTeam) => void;
  onTogglePin: (teamId: string) => void;
  onRemove: (teamId: string) => void;
  onSearchClick: (query: string) => void;
  onToggleInlineStreams: (cardKey: string, query: string, leagueId?: string) => void;
  onStreamClick: (channel: StoredChannel) => void;
  dropIndicator?: 'above' | 'below' | null;
}

function SortableFavoriteCard(props: SortableFavoriteCardProps) {
  const {
    team,
    details,
    liveEvent,
    nextEvent,
    isLive,
    searchQuery,
    isSearching,
    streamsList,
    epgClockFormat,
    onSelectTeam,
    onTogglePin,
    onRemove,
    onSearchClick,
    onToggleInlineStreams,
    onStreamClick,
    dropIndicator = null,
  } = props;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: team.id });

  useTranslation();

  const primaryColor = details?.color ? `#${details.color}` : '#3b82f6';
  const altColor = details?.alternateColor ? `#${details.alternateColor}` : '#1e293b';

  const cardStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 99 : 1,
    '--team-color': primaryColor,
    '--team-alt-color': altColor,
  } as React.CSSProperties;

  const cardKey = `fav-${team.id}`;

  return (
    <div
      ref={setNodeRef}
      style={cardStyle}
      {...attributes}
      {...listeners}
      className={`favorite-scoreboard-card ${isLive ? 'is-live' : ''} ${team.isPinned ? 'is-pinned' : ''} ${isDragging ? 'is-dragging' : ''}${dropIndicator ? ` drop-${dropIndicator}` : ''}`}
    >
      {/* Team Brand Accent Bar */}
      <div className="favorite-card-color-strip" />

      {/* Card Controls Header (Pin & Remove) */}
      <div className="favorite-card-controls" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className={`favorite-card-pin-btn ${team.isPinned ? 'active' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(team.id);
          }}            title={team.isPinned ? i18n.t('sports:unpinTeam') : i18n.t('sports:pinTeamToTop')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={team.isPinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>

        <button
          className="favorite-card-remove-btn"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(team.id);
          }}            title={i18n.t('sports:removeFromFavorites')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Team Info Header */}
      <div className="favorite-card-header" onClick={() => onSelectTeam(team)}>
        <div className="favorite-card-logo-container">
          {team.logo ? (
            <img src={team.logo} alt={team.name} className="favorite-card-logo" />
          ) : (
            <div className="favorite-card-logo-placeholder">{team.name.slice(0, 2).toUpperCase()}</div>
          )}
        </div>

        <div className="favorite-card-title-group">
          <div className="favorite-card-name-row">
            <h3 className="favorite-card-team-name">{team.name}</h3>
            {team.isPinned && <span className="favorite-pinned-badge">{i18n.t('sports:pinnedLabel')}</span>}
          </div>

          <div className="favorite-card-stats-row">
            {details?.standingSummary && (
              <span className="favorite-card-standing">{details.standingSummary}</span>
            )}
            {details?.record?.overall && (
              <span className="favorite-card-record">
                {details.record.overall}
                {details.record.winPercent !== undefined && ` (${(details.record.winPercent * 100).toFixed(0)}%)`}
              </span>
            )}
            {!details && (
              <span className="favorite-card-league">{team.shortName || team.country || i18n.t('sports:team')}</span>
            )}
          </div>
        </div>
      </div>

      {/* Mini Scoreboard / Match Section */}
      <div className="favorite-card-match-box" onClick={() => onSelectTeam(team)}>
        {isLive && liveEvent ? (
          <div className="favorite-card-live-box">
            <div className="favorite-card-live-header">
              <span className="favorite-live-pill">
                <span className="live-count-dot" /> LIVE
              </span>
              {liveEvent.period && <span className="favorite-live-period">{liveEvent.period}</span>}
            </div>

            <div className="favorite-card-live-score-row">
              <div className="favorite-card-score-team">
                <span>{liveEvent.homeTeam.shortName || liveEvent.homeTeam.name}</span>
                <span className="score">{liveEvent.homeScore ?? 0}</span>
              </div>
              <span className="favorite-card-score-vs">-</span>
              <div className="favorite-card-score-team">
                <span>{liveEvent.awayTeam.shortName || liveEvent.awayTeam.name}</span>
                <span className="score">{liveEvent.awayScore ?? 0}</span>
              </div>
            </div>
          </div>
        ) : nextEvent ? (
          <div className="favorite-card-next-box">
            <div className="favorite-card-next-label">
              <span>{i18n.t('sports:nextGameLabel')}</span>
              <span className="favorite-card-next-time">
                {formatEventDate(nextEvent.startTime)} • {formatEventTime(nextEvent.startTime, epgClockFormat !== '24h')}
              </span>
            </div>
            <div className="favorite-card-next-matchup">
              <span className="favorite-card-next-vs">
                {nextEvent.homeTeam.id === team.id ? i18n.t('sports:vs') : '@'}
              </span>
              <div className="favorite-card-next-opp">
                {nextEvent.homeTeam.id === team.id ? (
                  <>
                    {nextEvent.awayTeam.logo && <img src={nextEvent.awayTeam.logo} alt="" className="favorite-next-logo" />}
                    <span>{nextEvent.awayTeam.name}</span>
                  </>
                ) : (
                  <>
                    {nextEvent.homeTeam.logo && <img src={nextEvent.homeTeam.logo} alt="" className="favorite-next-logo" />}
                    <span>{nextEvent.homeTeam.name}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="favorite-card-no-game-box">
            <span>{i18n.t('sports:noUpcomingGameScheduled')}</span>
          </div>
        )}
      </div>

      {/* Actions Row: Search & List Streams Here */}
      <div className="favorite-card-actions-row" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="favorite-action-text-btn search-btn"            title={i18n.t('sports:searchEpgForQuery', { query: searchQuery })}
          onClick={(e) => {
            e.stopPropagation();
            onSearchClick(searchQuery);
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          Search
        </button>

        <button
          className={`favorite-action-text-btn list-btn ${streamsList && streamsList.length > 0 ? 'active' : ''}`}            title={streamsList ? i18n.t('sports:hideStreams') : i18n.t('sports:findMatchingLiveStreams')}
          onClick={(e) => {
            e.stopPropagation();
            onToggleInlineStreams(cardKey, searchQuery, team.leagueId || liveEvent?.league?.id || nextEvent?.league?.id);
          }}
        >
          {isSearching ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="gc-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 2v4" />
              <path d="m5 5 2.8 2.8" />
              <path d="m19 5-2.8 2.8" />
              <path d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" />
            </svg>
          )}
          List Streams Here
        </button>
      </div>

      {/* Inline Streams Vertically Stacked List */}
      {streamsList !== undefined && streamsList !== null && (
        <div className="favorite-card-inline-streams" onPointerDown={(e) => e.stopPropagation()}>
          {streamsList.length > 0 ? (
            <div className="favorite-streams-vlist">
              {streamsList.map((ch, idx) => (
                <button
                  key={`fav-ch-${ch.stream_id}-${idx}`}
                  className="favorite-stream-pill-vertical"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStreamClick(ch);
                  }}
                  title={ch.name}
                >
                  <span className="favorite-stream-play">▶</span>
                  <span className="favorite-stream-name">{ch.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="favorite-no-streams-text">{i18n.t('sports:noStreamsInPlaylists')}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function FavoritesTab({ onSearchChannels, onPlayChannel, onSetTab }: FavoritesTabProps) {
  const favorites = useFavoriteTeams();
  const removeFavorite = useRemoveFavorite();
  const togglePinFavorite = useTogglePinFavorite();
  const reorderFavorites = useReorderFavorites();
  const epgClockFormat = useEpgClockFormat();

  const [selectedTeam, setSelectedTeam] = useState<SportsTeam | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);

  // Configure @dnd-kit sensors: distance = 5px so clicks on cards/buttons aren't mistaken for drags
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Initialize state from window cache if available
  const [teamCache, setTeamCache] = useState<Record<string, TeamDetails | null>>(() => {
    const winCache = getWindowFavoritesCache();
    const initial: Record<string, TeamDetails | null> = {};
    winCache.forEach((entry, id) => {
      initial[id] = entry.details;
    });
    return initial;
  });

  // Inline stream search results & loading states per card key
  const [inlineStreams, setInlineStreams] = useState<Record<string, StoredChannel[] | null>>({});
  const [searchingKeys, setSearchingKeys] = useState<Record<string, boolean>>({});

  const { liveLeagues, loaded, loadSettings } = useSportsSettingsStore();

  const { events: liveEvents } = useSportsPolling({
    pollingInterval: 30000,
    enabled: loaded,
    leagues: loaded ? liveLeagues : undefined,
  });

  useEffect(() => {
    if (!loaded) {
      loadSettings();
    }
  }, [loaded, loadSettings]);

  // Map favorite teams to active live/upcoming games from polling feed or team nextEvent details
  const teamGameMap = useMemo(() => {
    const map: Record<string, { liveEvent?: SportsEvent; nextEvent?: SportsEvent }> = {};
    const now = new Date();

    favorites.forEach((team) => {
      const liveEv = liveEvents.find(
        (e) => eventInvolvesTeam(e, team) && isEventLiveOrPastStart(e)
      );

      const upcomingEv = liveEvents.find(
        (e) =>
          eventInvolvesTeam(e, team) &&
          e.status === 'scheduled' &&
          new Date(e.startTime).getTime() > now.getTime()
      );

      const cachedDetails = teamCache[team.id];
      const fallbackNext =
        cachedDetails?.nextEvent &&
        cachedDetails.nextEvent.status === 'scheduled' &&
        new Date(cachedDetails.nextEvent.startTime).getTime() > now.getTime()
          ? cachedDetails.nextEvent
          : undefined;

      map[team.id] = {
        liveEvent: liveEv,
        nextEvent: upcomingEv || fallbackNext,
      };
    });

    return map;
  }, [favorites, liveEvents, teamCache]);

  // Batched & rate-limited fetching with cooldown check
  useEffect(() => {
    let isCancelled = false;
    const now = Date.now();
    const winCache = getWindowFavoritesCache();

    // Identify which teams actually require network fetching based on per-team cooldown
    const teamsToFetch = favorites.filter((fav) => {
      const entry = winCache.get(fav.id);
      if (!entry) return true; // Never fetched

      const isLive = Boolean(teamGameMap[fav.id]?.liveEvent);
      const cooldown = isLive ? COOLDOWN_LIVE_MS : COOLDOWN_IDLE_MS;
      const isExpired = now - entry.fetchedAt > cooldown;
      return isExpired;
    });

    if (teamsToFetch.length === 0) {
      console.log('[FavoritesTab] All favorite teams served from cache within cooldown window.');
      return;
    }

    console.log(`[FavoritesTab] Queueing batched fetch for ${teamsToFetch.length}/${favorites.length} favorite teams`);

    // Process queue in batches of BATCH_SIZE (3 concurrent requests) with BATCH_DELAY_MS (500ms) delay
    const processBatches = async () => {
      for (let i = 0; i < teamsToFetch.length; i += BATCH_SIZE) {
        if (isCancelled) break;

        const batch = teamsToFetch.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
          batch.map(async (fav) => {
            const leagueId = fav.leagueId || 'nfl';
            const details = await fetchSingleTeamData(fav.id, leagueId);
            const isLive = Boolean(teamGameMap[fav.id]?.liveEvent);
            return { id: fav.id, details, isLive };
          })
        );

        if (isCancelled) break;

        // Update window cache & component state progressively after each batch
        results.forEach(({ id, details, isLive }) => {
          winCache.set(id, {
            details,
            fetchedAt: Date.now(),
            hasLive: isLive,
          });

          setTeamCache((prev) => ({
            ...prev,
            [id]: details,
          }));
        });

        // Stagger delay between batches to keep network traffic smooth and rate-limit safe
        if (i + BATCH_SIZE < teamsToFetch.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }
      }
    };

    processBatches();

    return () => {
      isCancelled = true;
    };
  }, [favorites, teamGameMap]);

  const handleChannelClick = (channelName: string) => {
    if (onSearchChannels) {
      onSearchChannels(channelName);
    }
  };

  const handleStreamClick = (channel: StoredChannel) => {
    if (onPlayChannel) {
      onPlayChannel(channel);
    } else if (onSearchChannels) {
      onSearchChannels(channel.name);
    }
  };

  const toggleInlineStreams = useCallback(async (cardKey: string, searchQuery: string, leagueId?: string) => {
    if (inlineStreams[cardKey] !== undefined && inlineStreams[cardKey] !== null) {
      // Toggle hide
      setInlineStreams((prev) => ({ ...prev, [cardKey]: null }));
      return;
    }

    setSearchingKeys((prev) => ({ ...prev, [cardKey]: true }));
    try {
      const results = await searchGameStreams(searchQuery, leagueId, 15);
      setInlineStreams((prev) => ({ ...prev, [cardKey]: results }));
    } finally {
      setSearchingKeys((prev) => ({ ...prev, [cardKey]: false }));
    }
  }, [inlineStreams]);

  // "Your Teams Today" events (live or scheduled for today across favorite teams)
  const todayFavoriteGames = useMemo(() => {
    const now = new Date();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const matches: Array<{ team: FavoriteTeam; event: SportsEvent; isLive: boolean }> = [];
    const seenEventIds = new Set<string>();

    favorites.forEach((team) => {
      const { liveEvent, nextEvent } = teamGameMap[team.id] || {};

      if (liveEvent && !seenEventIds.has(liveEvent.id)) {
        seenEventIds.add(liveEvent.id);
        matches.push({ team, event: liveEvent, isLive: true });
      } else if (
        nextEvent &&
        !seenEventIds.has(nextEvent.id) &&
        nextEvent.status === 'scheduled' &&
        new Date(nextEvent.startTime).getTime() > now.getTime() &&
        new Date(nextEvent.startTime) <= endOfDay
      ) {
        seenEventIds.add(nextEvent.id);
        matches.push({ team, event: nextEvent, isLive: false });
      }
    });

    return matches;
  }, [favorites, teamGameMap]);

  // Sort favorites: Pinned first, then Live games, then original order
  const sortedFavorites = useMemo(() => {
    return [...favorites].sort((a, b) => {
      const aPinned = a.isPinned ? 1 : 0;
      const bPinned = b.isPinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;

      const aLive = teamGameMap[a.id]?.liveEvent ? 1 : 0;
      const bLive = teamGameMap[b.id]?.liveEvent ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;

      return 0;
    });
  }, [favorites, teamGameMap]);

  // @dnd-kit drag end handler
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overDragId, setOverDragId] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  };

  const handleDragOver = (event: DragOverEvent) => {
    if (event.over && event.active.id !== event.over.id) {
      setOverDragId(String(event.over.id));
    } else {
      setOverDragId(null);
    }
  };

  const handleDragCancel = () => {
    setActiveDragId(null);
    setOverDragId(null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragId(null);
    setOverDragId(null);

    if (over && active.id !== over.id) {
      const oldIndex = sortedFavorites.findIndex((t) => t.id === active.id);
      const newIndex = sortedFavorites.findIndex((t) => t.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(sortedFavorites, oldIndex, newIndex);
        reorderFavorites(newOrder);
      }
    }
  };

  if (selectedTeam) {
    return (
      <TeamDetail
        team={selectedTeam}
        onClose={() => setSelectedTeam(null)}
        onChannelClick={handleChannelClick}
        onPlayChannel={onPlayChannel}
        fromTab={i18n.t('sports:tabs.favorites')}
      />
    );
  }

  if (selectedEvent) {
    return (
      <GameDetail
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
        onChannelClick={handleChannelClick}
        onPlayChannel={onPlayChannel}
      />
    );
  }

  if (favorites.length === 0) {
    return (
      <div className="sports-empty favorites-empty">
        <div className="sports-empty-icon">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        </div>
        <h3>{i18n.t('sports:noFavoriteTeamsAdded')}</h3>
        <p>{i18n.t('sports:noFavoriteTeamsHint')}</p>
        {onSetTab && (
          <button className="sports-empty-action-btn" onClick={() => onSetTab('leagues')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Browse Teams & Leagues
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="sports-tab-content favorites-tab-container">
      {/* Your Teams Today Strip */}
      <section className="your-teams-today-section">
        <div className="your-teams-today-header">
          <div className="your-teams-today-title-group">
            <span className="your-teams-today-badge-icon">🔥</span>
            <h2>{i18n.t('sports:yourTeamsToday')}</h2>
          </div>
          <span className="your-teams-today-count">
            {todayFavoriteGames.length > 0 
              ? `${todayFavoriteGames.length} ${todayFavoriteGames.length === 1 ? 'game' : 'games'} scheduled` 
              : 'No games today'}
          </span>
        </div>

        {todayFavoriteGames.length > 0 ? (
          <div className="your-teams-today-ticker">
            {todayFavoriteGames.map(({ team, event, isLive }) => {
              const isHome = event.homeTeam.id === team.id;
              const opponent = isHome ? event.awayTeam : event.homeTeam;
              const cardKey = `today-${event.id}`;
              const searchQuery = buildTeamSearchQuery(event.homeTeam.name, event.awayTeam.name);
              const isSearching = searchingKeys[cardKey] || false;
              const streamsList = inlineStreams[cardKey];

              return (
                <div key={event.id} className={`your-teams-today-card ${isLive ? 'is-live' : ''}`}>
                  {/* Top Match Info */}
                  <div className="your-teams-today-match-info" onClick={() => setSelectedEvent(event)}>
                    {isLive ? (
                      <span className="your-teams-today-status live">
                        <span className="live-count-dot" /> LIVE
                      </span>
                    ) : (
                      <span className="your-teams-today-status time">
                        {formatEventTime(event.startTime, epgClockFormat !== '24h')}
                      </span>
                    )}

                    <div className="your-teams-today-teams">
                      <div className="your-teams-today-team">
                        {event.homeTeam.logo && (
                          <img src={event.homeTeam.logo} alt="" className="your-teams-today-logo" />
                        )}
                        <span className="your-teams-today-team-name">{event.homeTeam.shortName || event.homeTeam.name}</span>
                        {isLive && event.homeScore !== undefined && (
                          <span className="your-teams-today-score">{event.homeScore}</span>
                        )}
                      </div>
                      <span className="your-teams-today-vs">{i18n.t('sports:vs')}</span>
                      <div className="your-teams-today-team">
                        {event.awayTeam.logo && (
                          <img src={event.awayTeam.logo} alt="" className="your-teams-today-logo" />
                        )}
                        <span className="your-teams-today-team-name">{event.awayTeam.shortName || event.awayTeam.name}</span>
                        {isLive && event.awayScore !== undefined && (
                          <span className="your-teams-today-score">{event.awayScore}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions Row Underneath Match Info */}
                  <div className="your-teams-today-actions-row">
                    <button
                      className="favorite-action-text-btn search-btn"
                      title={i18n.t('sports:searchEpgForTeam', { home: event.homeTeam.name, away: event.awayTeam.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleChannelClick(searchQuery);
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.35-4.35" />
                      </svg>
                      Search
                    </button>

                    <button
                      className={`favorite-action-text-btn list-btn ${streamsList && streamsList.length > 0 ? 'active' : ''}`}
                      title={streamsList ? i18n.t('sports:hideStreams') : i18n.t('sports:listStreamsForGame')}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleInlineStreams(cardKey, searchQuery, event.league.id);
                      }}
                    >
                      {isSearching ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="gc-spin">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M12 2v4" />
                          <path d="m5 5 2.8 2.8" />
                          <path d="m19 5-2.8 2.8" />
                          <path d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" />
                        </svg>
                      )}
                      List Streams Here
                    </button>
                  </div>

                  {/* Inline Streams Vertically Stacked List */}
                  {streamsList !== undefined && streamsList !== null && (
                    <div className="favorite-card-inline-streams">
                      {streamsList.length > 0 ? (
                        <div className="favorite-streams-vlist">
                          {streamsList.map((ch, idx) => (
                            <button
                              key={`today-ch-${ch.stream_id}-${idx}`}
                              className="favorite-stream-pill-vertical"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStreamClick(ch);
                              }}
                              title={ch.name}
                            >
                              <span className="favorite-stream-play">▶</span>
                              <span className="favorite-stream-name">{ch.name}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="favorite-no-streams-text">{i18n.t('sports:noStreamsInPlaylists')}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="your-teams-today-empty">
            <span className="your-teams-today-empty-icon">📅</span>
            <span>{i18n.t('sports:noTeamsPlayingToday')}</span>
          </div>
        )}
      </section>

      {/* Favorites Scoreboards Grid with @dnd-kit */}
      <section className="sports-section favorites-grid-section">
        <div className="favorites-grid-header">
          <h2 className="sports-section-title">
            Favorite Teams <span className="sports-section-count">({favorites.length})</span>
          </h2>
          <span className="favorites-grid-subtitle">
            Drag cards to reorder. Hover to pin or list streams.
          </span>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragCancel={handleDragCancel}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={sortedFavorites.map((t) => t.id)}
            strategy={rectSortingStrategy}
          >
            <div className="favorites-scoreboards-grid">
              {sortedFavorites.map((team) => {
                const details = teamCache[team.id];
                const { liveEvent, nextEvent } = teamGameMap[team.id] || {};
                const isLive = Boolean(liveEvent);
                const cardKey = `fav-${team.id}`;
                const activeIndex = activeDragId ? sortedFavorites.findIndex((t) => t.id === activeDragId) : -1;
                const overIndex = overDragId ? sortedFavorites.findIndex((t) => t.id === overDragId) : -1;
                const dropIndicator = overDragId === team.id && activeDragId !== overDragId
                  ? (activeIndex < overIndex ? 'below' : 'above')
                  : null;

                const activeGame = liveEvent || nextEvent;
                const searchQuery = activeGame 
                  ? buildTeamSearchQuery(activeGame.homeTeam.name, activeGame.awayTeam.name)
                  : buildTeamSearchQuery(team.name);

                const isSearching = searchingKeys[cardKey] || false;
                const streamsList = inlineStreams[cardKey];

                return (
                  <SortableFavoriteCard
                    key={team.id}
                    team={team}
                    details={details}
                    liveEvent={liveEvent}
                    nextEvent={nextEvent}
                    isLive={isLive}
                    searchQuery={searchQuery}
                    isSearching={isSearching}
                    streamsList={streamsList}
                    epgClockFormat={epgClockFormat}
                    onSelectTeam={setSelectedTeam}
                    onTogglePin={togglePinFavorite}
                    onRemove={removeFavorite}
                    onSearchClick={handleChannelClick}
                    onToggleInlineStreams={toggleInlineStreams}
                    onStreamClick={handleStreamClick}
                    dropIndicator={dropIndicator}
                  />
                );
              })}

              {/* Add Team Card */}
              <button
                className="sports-add-team-card"
                onClick={() => onSetTab?.('leagues')}
                title={i18n.t('sports:addNewTeamToFavorites')}
              >
                <div className="sports-add-team-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </div>
          <span className="sports-add-team-title">{i18n.t('sports:addFavoriteTeam')}</span>
          <span className="sports-add-team-desc">{i18n.t('sports:browseLeaguesDesc')}</span>
              </button>
            </div>
          </SortableContext>
        </DndContext>
      </section>
    </div>
  );
}

export default FavoritesTab;
