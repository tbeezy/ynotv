import { useState, useEffect, useCallback, useRef, memo } from 'react';
import i18n from '../../i18n';
import type { SportsEvent } from '@ynotv/core';
import { GameDetail } from './GameDetail';
import { isEventLiveOrPastStart } from '../../services/sports';
import { getStatusDisplay, sameEvents } from '../../services/sports/utils';

interface SportsCache {
  events: SportsEvent[];
  lastUpdated: Date | null;
  leagues: string[] | undefined;
}

function getSportsCache(): SportsCache {
  const w = window as unknown as { __sportsCache?: SportsCache };
  return w.__sportsCache ?? { events: [], lastUpdated: null, leagues: undefined };
}

// -----------------------------------------------------------------------------
// Memoized score item — re-renders only when ITS score/status changed
// -----------------------------------------------------------------------------

interface ScoreItemProps {
  event: SportsEvent;
  onOpen: (event: SportsEvent) => void;
}

const SportsScoreItem = memo(
  function SportsScoreItem({ event, onOpen }: ScoreItemProps) {
    const awayWinning = (event.awayScore ?? 0) > (event.homeScore ?? 0);
    const homeWinning = (event.homeScore ?? 0) > (event.awayScore ?? 0);
    const statusText = getStatusDisplay(event);

    return (
      <div
        className="sports-score-item"
        onClick={() => onOpen(event)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(event);
          }
        }}
      >
        <span className="sports-score-league">{event.league.name}</span>
        <div className="sports-score-matchup">
          <span className="sports-score-block">
            <span className={`sports-score-team ${awayWinning ? 'winning' : ''}`}>
              {event.awayTeam.shortName || event.awayTeam.name}
            </span>
            <span className={`sports-score-value ${awayWinning ? 'winning' : ''}`}>
              {event.awayScore ?? 0}
            </span>
          </span>
          <span className="sports-score-vs">{i18n.t('sports:vs')}</span>
          <span className="sports-score-block">
            <span className={`sports-score-value ${homeWinning ? 'winning' : ''}`}>
              {event.homeScore ?? 0}
            </span>
            <span className={`sports-score-team ${homeWinning ? 'winning' : ''}`}>
              {event.homeTeam.shortName || event.homeTeam.name}
            </span>
          </span>
        </div>
        {statusText && (
          <span className="sports-score-status">{statusText}</span>
        )}
      </div>
    );
  },
  (prev, next) => {
    // Return true (props equal → skip re-render) unless a displayed field changed.
    const a = prev.event;
    const b = next.event;
    return (
      a.id === b.id &&
      a.status === b.status &&
      a.homeScore === b.homeScore &&
      a.awayScore === b.awayScore &&
      a.period === b.period &&
      a.timeElapsed === b.timeElapsed &&
      a.league?.name === b.league?.name &&
      (a.homeTeam?.shortName || a.homeTeam?.name) === (b.homeTeam?.shortName || b.homeTeam?.name) &&
      (a.awayTeam?.shortName || a.awayTeam?.name) === (b.awayTeam?.shortName || b.awayTeam?.name) &&
      (a.startTime ? new Date(a.startTime).getTime() : 0) === (b.startTime ? new Date(b.startTime).getTime() : 0)
    );
  }
);

export function SportsScoresOverlay() {
  const [liveEvents, setLiveEvents] = useState<SportsEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<SportsEvent | null>(null);
  const prevRef = useRef<SportsEvent[]>([]);

  const updateFromCache = useCallback(() => {
    const cache = getSportsCache();
    const live = cache.events.filter(isEventLiveOrPastStart);
    // Change detection — a no-op poll must not re-render/flash the strip.
    if (sameEvents(prevRef.current, live)) return;
    prevRef.current = live;
    setLiveEvents(live);
  }, []);

  useEffect(() => {
    // Initial read
    updateFromCache();

    // Poll cache every 5 seconds to catch updates from LiveScoresTab
    const interval = setInterval(updateFromCache, 5000);

    // Also listen for visibility changes to refresh immediately when tab becomes visible
    const handleVisibility = () => {
      if (!document.hidden) updateFromCache();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [updateFromCache]);

  if (liveEvents.length === 0) return null;

  return (
    <>
      <div className="sports-scores-overlay">
        <div className="sports-scores-track">
          {liveEvents.map(event => (
            <SportsScoreItem
              key={event.id}
              event={event}
              onOpen={setSelectedEvent}
            />
          ))}
        </div>
      </div>

      {selectedEvent && (
        <GameDetail
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          variant="glass"
        />
      )}
    </>
  );
}
