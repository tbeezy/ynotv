# Sports Hub Implementation Documentation

## Overview

The Sports Hub is a comprehensive sports scores, stats, and information feature integrated into ynotTV. It uses ESPN's free public API to provide live scores, upcoming games, standings, news, rankings, and player statistics.

---

## Architecture

### Technology Stack
- **API**: ESPN Public API (free, no API key required)
- **State Management**: Zustand stores + SQLite persistence
- **UI Components**: React + TypeScript
- **Styling**: CSS with CSS variables for theming

### Directory Structure

```
packages/
├── core/src/
│   └── types.ts                    # Core types (SportsEvent, SportsTeam, SportsLeague, SportsTabId)
│
├── ui/src/
│   ├── services/
│   │   └── sports.ts               # ESPN API service (all API calls)
│   │
│   ├── stores/
│   │   ├── sportsFavoritesStore.ts # Favorite teams (SQLite persistence)
│   │   ├── sportsSettingsStore.ts  # User league preferences (SQLite persistence)
│   │   └── uiStore.ts              # UI state (selected tab, league, etc.)
│   │
│   ├── hooks/
│   │   └── useSportsPolling.ts     # Auto-refresh for live games
│   │
│   └── components/sports/
│       ├── SportsHub.tsx           # Main container
│       ├── SportsHub.css           # All styles (~2500 lines)
│       ├── LiveScoresTab.tsx       # Live games with auto-polling
│       ├── UpcomingTab.tsx         # Upcoming games by date
│       ├── LeaguesTab.tsx          # Browse leagues/teams/schedule/standings
│       ├── FavoritesTab.tsx        # Favorite teams
│       ├── NewsTab.tsx             # Sports news feed
│       ├── RankingsTab.tsx         # College rankings
│       ├── LeadersTab.tsx          # Statistical leaders
│       ├── SettingsTab.tsx         # Configure which leagues to show
│       ├── TeamDetail.tsx          # Team page with schedule
│       ├── GameCard.tsx            # Game display card
│       ├── GameDetail.tsx          # Game modal (stats, players, scoring, info)
│       └── LoadingSkeleton.tsx     # Loading states
```

---

## Core Types

Located in `packages/core/src/types.ts`:

```typescript
// Tab identifiers
export type SportsTabId = 
  | 'live' 
  | 'upcoming' 
  | 'leagues' 
  | 'favorites' 
  | 'news' 
  | 'rankings' 
  | 'leaders' 
  | 'settings';

// Sports event/game
export interface SportsEvent {
  id: string;
  startTime: Date;
  status: 'scheduled' | 'live' | 'finished';
  period?: string;
  timeElapsed?: string;
  venue?: string;
  
  homeTeam: SportsTeam;
  awayTeam: SportsTeam;
  homeScore?: number;
  awayScore?: number;
  
  league: SportsLeague;
  channels: SportsBroadcastChannel[];
}

// Team representation
export interface SportsTeam {
  id: string;
  name: string;
  shortName?: string;
  logo?: string;
}

// League representation
export interface SportsLeague {
  id: string;
  name: string;
  sport: string;  // 'football', 'basketball', 'soccer', etc.
}

// TV channel for watching
export interface SportsBroadcastChannel {
  name: string;
  country?: string;
}
```

---

## ESPN API Endpoints

Base URL: `https://site.api.espn.com/apis/site/v2/sports`

### 1. Scoreboard (Live/Upcoming Games)

```
GET /{sport}/{league}/scoreboard
GET /{sport}/{league}/scoreboard?dates=YYYYMMDD-YYYYMMDD
```

**Example:**
```
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20260215-20260222
```

**Returns:** Games for a date window. Without dates parameter, returns a default window (typically ~7 days).

**Key Response Fields:**
```json
{
  "events": [{
    "id": "401671854",
    "name": "Lakers at Celtics",
    "date": "2026-02-18T00:30Z",
    "status": {
      "type": {
        "state": "in",           // "pre", "in", "post"
        "detail": "Halftime",
        "shortDetail": "Halftime"
      },
      "displayClock": "0:00",
      "period": 2
    },
    "competitions": [{
      "competitors": [
        {
          "homeAway": "home",
          "team": {
            "id": "2",
            "displayName": "Boston Celtics",
            "abbreviation": "BOS",
            "logos": [{"href": "https://..."}]
          },
          "score": "78",          // STRING or {value: 78, displayValue: "78"}
          "records": [{"summary": "45-12"}]
        },
        {
          "homeAway": "away",
          "team": {...},
          "score": "82"
        }
      ],
      "broadcasts": [{
        "names": ["ESPN", "ABC"]
      }],
      "venue": {"fullName": "TD Garden"}
    }]
  }]
}
```

**Used by:**
- `getLiveScores()` - Live Now tab
- `getUpcomingEvents()` - Upcoming tab
- `getLeagueEvents()` - League schedule

---

### 2. Team Schedule

```
GET /{sport}/{league}/teams/{teamId}/schedule
```

**Example:**
```
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/2/schedule
```

**Returns:** Complete schedule for a team (past and future games).

**Used by:** `getTeamSchedule()` in TeamDetail component

---

### 3. Game Summary (Box Score, Plays, Player Stats)

```
GET /{sport}/{league}/summary?event={eventId}
```

**Example:**
```
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401772955
```

**Returns:** Comprehensive game data including:
- Team statistics (boxscore.teams[].statistics)
- Player statistics (boxscore.players[].statistics)
- Scoring plays (plays filtered by scoringPlay: true)
- Game info (venue, attendance, officials)
- Win probability data

**Key Response Structure:**
```json
{
  "header": {
    "id": "401772955",
    "name": "Cardinals at Rams",
    "competitions": [{
      "date": "2026-01-05T21:05Z",
      "status": {...},
      "competitors": [...],
      "officials": [{"displayName": "John Smith"}],
      "broadcasts": [{"names": ["FOX"]}]
    }]
  },
  "boxscore": {
    "teams": [{
      "team": {"id": "22"},
      "statistics": [
        {"label": "1st Downs", "displayValue": "17"},
        {"label": "Total Yards", "displayValue": "317"}
      ]
    }],
    "players": [{
      "team": {"id": "22"},
      "statistics": [{
        "name": "passing",
        "text": "Arizona Passing",
        "labels": ["C/ATT", "YDS", "TD", "INT"],
        "athletes": [{
          "athlete": {
            "id": "2578570",
            "displayName": "Jacoby Brissett",
            "headshot": {"href": "https://..."},
            "jersey": "7"
          },
          "stats": ["22/31", "243", "2", "1"]
        }]
      }]
    }]
  },
  "gameInfo": {
    "venue": {"fullName": "SoFi Stadium", "address": {"city": "Inglewood"}},
    "attendance": 73039,
    "officials": [{"displayName": "Bill Vinovich"}]
  },
  "plays": [{
    "id": "4017729551234",
    "period": {"displayValue": "1st"},
    "clock": {"displayValue": "10:23"},
    "text": "K.Williams rushed up the middle for 8 yards",
    "homeScore": 7,
    "awayScore": 0,
    "scoringPlay": true,
    "type": {"text": "Rushing Touchdown"},
    "team": {"id": "14"}
  }],
  "winprobability": [{
    "homeWinPercentage": 0.52,
    "playId": "4017729551"
  }]
}
```

**Used by:** `getGameSummary()` in GameDetail component

**IMPORTANT:** Player stats are in `boxscore.players`, NOT at top level!

---

### 4. Standings

```
GET https://site.web.api.espn.com/apis/v2/sports/{sport}/{league}/standings
```

**Example:**
```
GET https://site.web.api.espn.com/apis/v2/sports/football/nfl/standings
```

**NOTE:** Use `site.web.api.espn.com` (NOT `site.api.espn.com`) for standings!

**Returns:** League standings with team records.

**Key Response Fields:**
```json
{
  "standings": [{
    "entries": [{
      "team": {
        "id": "2",
        "displayName": "Boston Celtics",
        "logos": [{"href": "https://..."}]
      },
      "stats": [
        {"name": "wins", "value": 45},
        {"name": "losses", "value": 12},
        {"name": "winPercent", "value": 0.789}
      ]
    }]
  }]
}
```

**Used by:** `getLeagueStandings()` in LeaguesTab

---

### 5. League Teams

```
GET /{sport}/{league}/teams
```

**Example:**
```
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams
```

**Returns:** All teams in a league.

**Used by:** `getLeagueTeams()` in LeaguesTab

---

### 6. Statistical Leaders

```
GET /{sport}/{league}/leaders
```

**Example:**
```
GET https://site.api.espn.com/apis/site/v3/sports/football/nfl/leaders
```

**NOTE:** Use v3 endpoint for leaders!

**Returns:** Top players in various statistical categories.

**Used by:** `getLeagueLeaders()` in LeadersTab

---

### 7. College Rankings

```
GET /{sport}/{league}/rankings
```

**Example:**
```
GET https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings
```

**Returns:** Poll rankings (AP, Coaches, etc.) for college sports.

**Used by:** `getLeagueRankings()` in RankingsTab

---

### 8. News

```
GET /{sport}/{league}/news
```

**Example:**
```
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/news
```

**Returns:** News articles with headlines, descriptions, images, and links.

**Used by:** `getLeagueNews()` in NewsTab

---

## Supported Leagues

Defined in `packages/ui/src/services/sports.ts`:

| League ID | Sport | Name |
|-----------|-------|------|
| `nfl` | football | NFL |
| `college-football` | football | NCAAF |
| `nba` | basketball | NBA |
| `mens-college-basketball` | basketball | NCAAM |
| `womens-college-basketball` | basketball | NCAAW |
| `wnba` | basketball | WNBA |
| `mlb` | baseball | MLB |
| `nhl` | hockey | NHL |
| `soccer-eng.1` | soccer | Premier League |
| `soccer-eng.2` | soccer | Championship |
| `soccer-esp.1` | soccer | La Liga |
| `soccer-ger.1` | soccer | Bundesliga |
| `soccer-ita.1` | soccer | Serie A |
| `soccer-fra.1` | soccer | Ligue 1 |
| `soccer-usa.1` | soccer | MLS |
| `soccer-uefa.champions` | soccer | Champions League |
| `soccer-uefa.europa` | soccer | Europa League |
| `soccer-mex.1` | soccer | Liga MX |
| `soccer-ned.1` | soccer | Eredivisie |
| `soccer-por.1` | soccer | Primeira Liga |
| `ufc` | mma | UFC |
| `pga` | golf | PGA Tour |
| `lpga` | golf | LPGA |
| `atp` | tennis | ATP Tour |
| `wta` | tennis | WTA Tour |
| `f1` | racing | Formula 1 |
| `nascar` | racing | NASCAR Cup |
| `indycar` | racing | IndyCar |

---

## Service Functions

Located in `packages/ui/src/services/sports.ts`:

### Data Fetching Functions

| Function | Parameters | Returns | Purpose |
|----------|------------|---------|---------|
| `getLiveScores(leagues?)` | `string[]` (optional) | `Promise<SportsEvent[]>` | Get live/recent games |
| `getUpcomingEvents(days?, leagues?)` | `number`, `string[]` | `Promise<SportsEvent[]>` | Get upcoming games |
| `getLeagueEvents(leagueId)` | `string` | `Promise<SportsEvent[]>` | Get league schedule |
| `getTeamSchedule(teamId, leagueId)` | `string`, `string` | `Promise<SportsEvent[]>` | Get team schedule |
| `getGameSummary(eventId, leagueId)` | `string`, `string` | `Promise<GameSummary \| null>` | Get full game details |
| `getLeagueStandings(leagueId)` | `string` | `Promise<StandingTeam[]>` | Get standings |
| `getLeagueTeams(leagueId)` | `string` | `Promise<SportsTeam[]>` | Get all teams in league |
| `getLeagueNews(leagueId, limit?)` | `string`, `number` | `Promise<NewsArticle[]>` | Get news articles |
| `getLeagueRankings(leagueId)` | `string` | `Promise<RankingEntry[]>` | Get college rankings |
| `getLeagueLeaders(leagueId)` | `string` | `Promise<LeaderCategory[]>` | Get stat leaders |
| `searchTeams(query)` | `string` | `Promise<SportsTeam[]>` | Search teams globally |

### Utility Functions

| Function | Purpose |
|----------|---------|
| `getAvailableSports()` | Get list of sport categories |
| `getAvailableLeagues()` | Get all configured leagues |
| `getLeaguesBySport(sport)` | Get leagues for a sport |
| `getAvailableCategories()` | Get sport categories for filtering |
| `formatEventDateTime(date)` | Format date for display |
| `formatEventDate(date)` | Format date only |

---

## State Management

### 1. UI Store (`uiStore.ts`)

Manages UI state for the Sports Hub:

```typescript
// Tab selection
useSportsSelectedTab()      // Get current tab
useSetSportsSelectedTab()   // Set current tab

// Sport/League selection (for navigation)
selectedSport: string | null
selectedLeague: SportsLeague | null
```

### 2. Favorites Store (`sportsFavoritesStore.ts`)

Persists favorite teams to SQLite `prefs` table:

```typescript
// Keys stored in SQLite:
// - sports_favorites: JSON array of team IDs

favoriteTeamIds: string[]           // List of favorited team IDs
addFavoriteTeam(teamId: string)     // Add team to favorites
removeFavoriteTeam(teamId: string)  // Remove from favorites
isFavorite(teamId: string): boolean // Check if favorited
```

### 3. Settings Store (`sportsSettingsStore.ts`)

Persists user league preferences to SQLite `prefs` table:

```typescript
// Keys stored in SQLite:
// - sports_live_leagues: JSON array of league IDs
// - sports_upcoming_leagues: JSON array of league IDs
// - sports_news_leagues: JSON array of league IDs

liveLeagues: string[]           // Leagues shown in Live Now
upcomingLeagues: string[]       // Leagues shown in Upcoming
newsLeagues: string[]           // Leagues shown in News
loaded: boolean                 // Whether settings loaded from SQLite

loadSettings(): Promise<void>   // Load from SQLite
toggleLeague(section, leagueId) // Toggle league on/off
resetToDefaults()               // Reset to default leagues
```

**Default Leagues:**
- **Live:** NFL, NCAAF, NBA, NCAAM, MLB, NHL, Premier League, Champions League, MLS, UFC
- **Upcoming:** All of above + La Liga, Bundesliga, Serie A, Formula 1
- **News:** NFL, NBA, MLB, NHL, Premier League

---

## Components

### SportsHub.tsx (Main Container)

The root component that renders the sidebar navigation and main content area.

**Props:**
```typescript
interface SportsHubProps {
  onClose: () => void;
  onSearchChannels?: (query: string) => void;
}
```

**Structure:**
```
┌────────────────────────────────────────────────────┐
│ Sidebar          │ Main Content Area              │
│ ┌──────────────┐ │ ┌────────────────────────────┐ │
│ │ Sports Hub   │ │ │ Header (Tab Title)         │ │
│ │ Subtitle     │ │ ├────────────────────────────┤ │
│ ├──────────────┤ │ │                            │ │
│ │ ▶ Live Now   │ │ │    Tab Content             │
│ │   Upcoming   │ │ │    (LiveScoresTab, etc.)   │
│ │   Leagues    │ │ │                            │ │
│ │   Favorites  │ │ │                            │ │
│ │   News       │ │ │                            │ │
│ │   Rankings   │ │ │                            │ │
│ │   Leaders    │ │ │                            │ │
│ │   Settings   │ │ │                            │ │
│ ├──────────────┤ │ └────────────────────────────┘ │
│ │ Back to TV   │ │                                │
│ └──────────────┘ │                                │
└────────────────────────────────────────────────────┘
```

---

### LiveScoresTab.tsx

Displays live and recent games with auto-polling.

**Features:**
- Auto-refreshes every 30 seconds when live games exist
- Shows live games first, then today's scheduled/finished
- Groups games by league
- Filters by category (All, Football, Basketball, etc.)
- Click game to open GameDetail modal

**Data Flow:**
```
useSportsSettingsStore.liveLeagues
    ↓
useSportsPolling({ leagues })
    ↓
getLiveScores(leagues)
    ↓
ESPN API: /scoreboard for each league
    ↓
Events displayed in GameCard components
```

---

### UpcomingTab.tsx

Displays upcoming scheduled games grouped by date.

**Features:**
- Date selector (1-7 days ahead)
- Groups games by date
- Sorted by start time
- Click game to open GameDetail modal

---

### LeaguesTab.tsx

Browse all leagues, teams, schedules, and standings.

**Navigation Flow:**
```
Leagues List
    ↓ Select League
League Detail (Teams/Schedule/Standings tabs)
    ↓ Select Team
Team Detail (Schedule tab)
    ↓ Click Game
GameDetail Modal
```

---

### GameDetail.tsx

Modal showing comprehensive game information with 4 tabs:

1. **Team Stats** - Side-by-side statistics comparison
2. **Players** - Player statistics by category (passing, rushing, etc.)
3. **Scoring Plays** - Chronological scoring events
4. **Game Info** - Venue, attendance, officials, broadcasts

**Data Source:**
```typescript
const summary = await getGameSummary(eventId, leagueId);

// summary.homeTeam.statistics - Team stats
// summary.homeTeam.playerStats - Player stats  
// summary.scoringPlays - Scoring plays
// summary.venue, summary.attendance, summary.officials - Game info
```

---

### TeamDetail.tsx

Team page showing schedule and team info.

**Features:**
- Team logo and name header
- Schedule list (clickable to open GameDetail)
- Record display

---

### SettingsTab.tsx

Configure which leagues appear in each section.

**Features:**
- Toggle leagues on/off for Live, Upcoming, News sections
- Organized by sport category
- Shows count of selected leagues
- Reset to defaults button
- Persists to SQLite immediately on change

---

### useSportsPolling Hook

Custom hook for auto-refreshing live scores.

```typescript
const { 
  events,        // SportsEvent[]
  loading,       // boolean
  error,         // string | null
  lastUpdated,   // Date | null
  refresh,       // () => Promise<void>
  isPolling      // boolean
} = useSportsPolling({
  pollingInterval: 30000,  // 30 seconds
  enabled: true,
  leagues: ['nfl', 'nba']  // Optional - from settings
});
```

**Behavior:**
- Only polls when there are live games
- Stops polling when no live games (saves API calls)
- Pauses when tab is hidden
- Refreshes immediately when tab becomes visible (if stale)
- Respects user's league settings

---

## CSS Styling

All styles in `SportsHub.css` (~2500 lines). Uses CSS variables for theming:

```css
/* Common CSS Variables Used */
--bg-primary, --bg-secondary, --bg-hover
--text-primary, --text-secondary
--border-color
--accent-primary, --accent-color

/* Key Class Prefixes */
.sports-hub          /* Main container */
.sports-sidebar      /* Left navigation */
.sports-nav          /* Navigation buttons */
.sports-main         /* Content area */
.sports-tab-content  /* Tab content wrapper */
.game-card           /* Game display card */
.game-detail         /* Game modal */
.sports-settings     /* Settings tab */
```

**Important Responsive Breakpoints:**
```css
@media (max-width: 768px) {
  /* Sidebar collapses or becomes overlay */
}
```

---

## Data Flow Diagrams

### Live Scores Flow

```
User Opens Live Tab
        │
        ▼
loadSettings() from SQLite
        │
        ▼
useSportsPolling starts
        │
        ▼
For each league in liveLeagues:
    GET /scoreboard
        │
        ▼
mapESPNEvent() transforms data
        │
        ▼
Filter: live OR (scheduled today) OR (finished < 6hrs)
        │
        ▼
Sort: live first, then by startTime
        │
        ▼
Render GameCard components
        │
        ▼
User clicks game → GameDetail modal
```

### Game Detail Flow

```
User clicks game
        │
        ▼
GameDetail modal opens
        │
        ▼
GET /summary?event={eventId}
        │
        ▼
Parse response:
├── header.competitions → Teams, scores, status
├── boxscore.teams → Team statistics
├── boxscore.players → Player statistics (IMPORTANT: inside boxscore!)
├── plays (filter scoringPlay=true) → Scoring plays
└── gameInfo → Venue, attendance, officials
        │
        ▼
Render tabs: Team Stats | Players | Scoring | Game Info
```

---

## Common Issues & Solutions

### Issue: "Player statistics not available" in GameDetail

**Cause:** Player stats are in `boxscore.players`, not top-level `players`.

**Fix in code:**
```typescript
// WRONG
const teamPlayers = data.players?.find(...)

// CORRECT  
const teamPlayers = data.boxscore?.players?.find(...)
```

### Issue: Standings not loading

**Cause:** Wrong API endpoint.

**Fix:** Use `site.web.api.espn.com` for standings:
```typescript
// WRONG
https://site.api.espn.com/.../standings

// CORRECT
https://site.web.api.espn.com/apis/v2/sports/.../standings
```

### Issue: Live games showing old games (from days ago)

**Cause:** ESPN returns a date window, not just today.

**Fix:** Filter in code:
```typescript
const filteredEvents = allEvents.filter(event => {
  if (event.status === 'live') return true;
  
  // Only show scheduled games for today
  if (event.status === 'scheduled') {
    return isToday(event.startTime);
  }
  
  // Show finished games from last 6 hours
  if (event.status === 'finished') {
    return event.startTime >= sixHoursAgo;
  }
  
  return false;
});
```

### Issue: Score showing as "[object Object]"

**Cause:** ESPN returns scores in two formats:
- String: `"110"`
- Object: `{ value: 110, displayValue: "110" }`

**Fix:**
```typescript
const parseScore = (score: string | { value: number }) => {
  return typeof score === 'string' 
    ? parseInt(score, 10) 
    : score.value;
};
```

### Issue: Settings not persisting

**Cause:** Settings load async from SQLite.

**Fix:** Ensure `loadSettings()` is called before using:
```typescript
const { liveLeagues, loaded, loadSettings } = useSportsSettingsStore();

useEffect(() => {
  if (!loaded) loadSettings();
}, [loaded, loadSettings]);

// Only fetch when loaded
const { events } = useSportsPolling({
  leagues: loaded ? liveLeagues : undefined
});
```

---

## Debugging Tips

### Enable API Logging

API calls are logged to console:
```
[ESPN API] Fetching: https://site.api.espn.com/...
[ESPN API] Response received: https://...
```

### Check SQLite Data

```typescript
// In browser console
const prefs = await db.prefs.toArray();
console.log(prefs.filter(p => p.key.startsWith('sports_')));
```

### Test API Endpoints

```bash
# Test scoreboard
curl "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard" | jq '.events[0]'

# Test game summary
curl "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=401772955" | jq '.boxscore.players[0]'

# Test standings
curl "https://site.web.api.espn.com/apis/v2/sports/football/nfl/standings" | jq '.standings[0].entries[0]'
```

---

## Performance Considerations

1. **API Call Limiting**: Only fetch leagues user has enabled in settings
2. **Polling Efficiency**: Stops polling when no live games
3. **Tab Visibility**: Pauses polling when tab hidden
4. **Lazy Loading**: Settings loaded once on first tab open
5. **SQLite Persistence**: Faster than localStorage for larger data

---

## Future Improvements

1. **Caching**: Add in-memory cache with TTL for API responses
2. **WebSockets**: For true real-time updates (ESPN doesn't support)
3. **Notifications**: Push notifications for game starts/scores
4. **More Data**: Play-by-play full feed, drive charts
5. **Betting Odds**: Integrate odds data if available

---

## File Quick Reference

| File | Purpose |
|------|---------|
| `sports.ts` | All ESPN API calls and data transformation |
| `SportsHub.tsx` | Main container with tab navigation |
| `SportsHub.css` | All styling |
| `LiveScoresTab.tsx` | Live games with auto-polling |
| `UpcomingTab.tsx` | Future games by date |
| `LeaguesTab.tsx` | Browse leagues, teams, standings |
| `FavoritesTab.tsx` | User's favorite teams |
| `NewsTab.tsx` | Sports news feed |
| `RankingsTab.tsx` | College rankings |
| `LeadersTab.tsx` | Statistical leaders |
| `SettingsTab.tsx` | Configure visible leagues |
| `TeamDetail.tsx` | Team page with schedule |
| `GameCard.tsx` | Compact game display |
| `GameDetail.tsx` | Full game modal with stats |
| `useSportsPolling.ts` | Auto-refresh hook |
| `sportsSettingsStore.ts` | League preferences (SQLite) |
| `sportsFavoritesStore.ts` | Favorite teams (SQLite) |
| `uiStore.ts` | UI state (current tab, etc.) |
| `types.ts` (core) | TypeScript interfaces |

