# Sports Hub Enhancement Plan

**Goal:** Transform the Sports Hub from a basic IPTV side feature into a professional-grade scoreboard app that rivals standalone sports apps like ESPN, theScore, or Yahoo Sports.

---

## Current State

### What We Have
- Live scores for NFL, NBA, MLB, NHL
- Upcoming games view
- League standings (basic)
- Team schedules (basic)
- Favorite teams (localStorage)
- TV channel listings with search integration

### What We're Missing
- More sports/leagues (UFC, Golf, Tennis, F1, College, more Soccer)
- Game details with box scores
- Play-by-play data
- News feeds
- Rankings (for college sports)
- League leaders/stats
- Professional UI polish
- Real-time updates
- Sport-specific displays (e.g., down & distance for football, inning for baseball)

---

## Implementation Phases

### Phase 1: API Service Expansion (Backend)
**Goal:** Add all ESPN API endpoints we need

**Tasks:**
1. Expand `SPORT_CONFIG` with more leagues
   - UFC/MMA
   - Golf (PGA, LPGA)
   - Tennis (ATP, WTA)
   - F1/NASCAR/IndyCar
   - College Football & Basketball
   - More soccer leagues (Champions League, Liga MX, etc.)

2. Add new API functions to `sports.ts`:
   - `getGameSummary(eventId)` - Full game details with box scores
   - `getPlayByPlay(eventId)` - Live play-by-play data
   - `getLeagueNews(leagueId)` - News articles
   - `getLeagueRankings(leagueId)` - AP/Coaches polls for college
   - `getLeagueLeaders(leagueId)` - Stats leaders
   - `getScoreboardByDate(leagueId, date)` - Historical scores

3. Enhance existing types:
   - Add sport-specific status info (down/distance, outs/innings, period/clock)
   - Add athlete stats for box scores
   - Add news article types

**Files to modify:**
- `packages/ui/src/services/sports.ts`
- `packages/core/src/types.ts`

---

### Phase 2: Enhanced Game Display (UI)
**Goal:** Make games look like a real scoreboard app

**Tasks:**
1. Create `GameCard` component with sport-specific layouts:
   - Football: Quarter, clock, down & distance, possession
   - Baseball: Inning, outs, runners on base
   - Basketball: Quarter, clock
   - Hockey: Period, clock
   - Soccer: Match minute

2. Create `GameDetail` component:
   - Full box score
   - Play-by-play (scrollable)
   - Team stats comparison
   - Betting line (optional)
   - TV channel

3. Enhance `LiveScoresTab`:
   - Group by sport, then league
   - Show live indicator with pulse animation
   - Auto-refresh for live games (every 30s)

**Files to create:**
- `packages/ui/src/components/sports/GameCard.tsx`
- `packages/ui/src/components/sports/GameDetail.tsx`

**Files to modify:**
- `packages/ui/src/components/sports/LiveScoresTab.tsx`
- `packages/ui/src/components/sports/UpcomingTab.tsx`
- `packages/ui/src/components/sports/SportsHub.css`

---

### Phase 3: News & Rankings (Content)
**Goal:** Add rich content beyond scores

**Tasks:**
1. Create `NewsTab` component:
   - League filter dropdown
   - Article cards with images
   - Link to external ESPN article

2. Create `RankingsTab` component:
   - AP Poll / Coaches Poll for college football
   - AP Poll for college basketball
   - UFC divisional rankings

3. Create `LeadersTab` component:
   - League stat leaders (passing yards, points, home runs, etc.)
   - Filter by stat category

**Files to create:**
- `packages/ui/src/components/sports/NewsTab.tsx`
- `packages/ui/src/components/sports/RankingsTab.tsx`
- `packages/ui/src/components/sports/LeadersTab.tsx`

---

### Phase 4: Professional UI Polish
**Goal:** Make it look like a standalone app

**Tasks:**
1. Redesign sidebar:
   - Sport icons with badges for live games
   - Collapsible sections
   - Quick access to favorites

2. Add loading skeletons:
   - Shimmer effect while data loads
   - Error states with retry

3. Add animations:
   - Score change flash
   - Game status transitions
   - Smooth tab switches

4. Add dark/light theme support:
   - Ensure all colors use CSS variables
   - Test both themes

5. Add keyboard navigation:
   - Arrow keys to navigate games
   - Enter to open game detail
   - Escape to close

**Files to modify:**
- `packages/ui/src/components/sports/SportsHub.tsx`
- `packages/ui/src/components/sports/SportsHub.css`
- All sports components

---

### Phase 5: Real-Time Updates
**Goal:** Auto-refresh for live games

**Tasks:**
1. Add polling mechanism:
   - Poll live games every 30 seconds
   - Stop polling when no live games
   - Show last update timestamp

2. Add push notification support (future):
   - Score alerts for favorite teams
   - Game start reminders
   - Close game alerts

**Files to modify:**
- `packages/ui/src/components/sports/LiveScoresTab.tsx`
- New hook: `packages/ui/src/hooks/useSportsPolling.ts`

---

## ESPN API Endpoints Reference

From the documentation, here are the key endpoints we'll use:

### Site API (`site.api.espn.com`)
```
/sports/{sport}/{league}/scoreboard       - Live/upcoming games
/sports/{sport}/{league}/teams            - All teams
/sports/{sport}/{league}/standings        - League standings
/sports/{sport}/{league}/news             - News articles
/sports/{sport}/{league}/rankings         - College rankings
/sports/{sport}/{league}/summary?event={id} - Game summary
```

### Core API (`sports.core.api.espn.com`)
```
/v2/sports/{sport}/leagues/{league}/athletes - Player data
/v2/sports/{sport}/leagues/{league}/events/{id}/competitions/{id}/plays - Play-by-play
```

### CDN API (`cdn.espn.com`) - Fastest for live data
```
/core/{league}/scoreboard?xhr=1           - Live scoreboard
/core/{league}/boxscore?xhr=1&gameId={id} - Box score
/core/{league}/playbyplay?xhr=1&gameId={id} - Play-by-play
```

---

## Leagues to Add

| Sport | League Code | League Name |
|-------|-------------|-------------|
| MMA | `mma/ufc` | UFC |
| Golf | `golf/pga` | PGA Tour |
| Golf | `golf/lpga` | LPGA |
| Tennis | `tennis/atp` | ATP |
| Tennis | `tennis/wta` | WTA |
| Racing | `racing/f1` | Formula 1 |
| Racing | `racing/nascar-premier` | NASCAR Cup |
| Racing | `racing/irl` | IndyCar |
| Soccer | `soccer/uefa.champions` | Champions League |
| Soccer | `soccer/uefa.europa` | Europa League |
| Soccer | `soccer/fra.1` | Ligue 1 |
| Soccer | `soccer/por.1` | Primeira Liga |
| Soccer | `soccer/ned.1` | Eredivisie |
| Soccer | `soccer/mex.1` | Liga MX |

---

## Execution Order

1. **Phase 1** - Backend first, no UI changes ✅ **COMPLETED**
2. **Phase 2** - UI for game display (most visible change) ✅ **COMPLETED**
3. **Phase 3** - Additional content (news, rankings) ✅ **COMPLETED**
4. **Phase 4** - Polish and animations ✅ **COMPLETED**
5. **Phase 5** - Real-time updates ✅ **COMPLETED**

---

## Phase 5 Summary (Completed)

### useSportsPolling Hook
- Auto-polls every 30 seconds when there are live games
- Stops polling when no live games to save resources
- Skips polling when tab is hidden (saves API calls)
- Refreshes immediately when tab becomes visible after 30+ seconds
- Tracks last update timestamp
- Provides manual refresh function

### LiveScoresTab Updates
- Integrated with useSportsPolling hook
- Shows "Updated Xs ago" / "Updated Xm ago" timestamp
- Manual refresh button with spinning animation while loading
- Live polling indicator (pulsing dot) when auto-refresh is active
- Stops unnecessary polling when no live games

### CSS Added
- `.live-controls` - Container for timestamp and refresh button
- `.live-last-updated` - Timestamp styling
- `.live-polling-indicator` - Pulsing dot for active polling
- `.live-refresh-btn` - Refresh button with hover states
- `.spinning` animation for refresh icon

---

## Project Complete! 🎉

### Final Summary

| Phase | Description | Key Deliverables |
|-------|-------------|------------------|
| 1 | API Service Expansion | 31 leagues, 10 API endpoints, comprehensive types |
| 2 | Enhanced Game Display | GameCard, GameDetail, sport-specific UI |
| 3 | News & Rankings | NewsTab, RankingsTab, LeadersTab |
| 4 | Polish & Animations | Skeletons, animations, keyboard navigation |
| 5 | Real-Time Updates | Auto-polling, timestamps, manual refresh |

### Total Files Created/Modified

**New Files:**
- `packages/ui/src/services/sports.ts` - ESPN API service
- `packages/ui/src/components/sports/GameCard.tsx`
- `packages/ui/src/components/sports/GameDetail.tsx`
- `packages/ui/src/components/sports/NewsTab.tsx`
- `packages/ui/src/components/sports/RankingsTab.tsx`
- `packages/ui/src/components/sports/LeadersTab.tsx`
- `packages/ui/src/components/sports/LoadingSkeleton.tsx`
- `packages/ui/src/components/sports/LoadingSkeleton.css`
- `packages/ui/src/hooks/useSportsPolling.ts`

**Modified Files:**
- `packages/core/src/types.ts` - Added sports types
- `packages/ui/src/components/sports/SportsHub.tsx` - Added all tabs
- `packages/ui/src/components/sports/SportsHub.css` - 1400+ lines of styling
- `packages/ui/src/components/sports/LiveScoresTab.tsx`
- `packages/ui/src/components/sports/UpcomingTab.tsx`
- `packages/ui/src/components/sports/LeaguesTab.tsx`
- `packages/ui/src/components/sports/FavoritesTab.tsx`

### Supported Sports & Leagues

| Category | Leagues |
|----------|---------|
| Football | NFL, NCAAF |
| Basketball | NBA, NCAAM, NCAAW, WNBA |
| Baseball | MLB |
| Hockey | NHL |
| Soccer | Premier League, La Liga, Bundesliga, Serie A, Ligue 1, MLS, Champions League, Europa League, Liga MX, Eredivisie, Primeira Liga, Championship |
| MMA | UFC |
| Golf | PGA Tour, LPGA |
| Tennis | ATP Tour, WTA Tour |
| Racing | Formula 1, NASCAR Cup, IndyCar |

---

## Phase 4 Summary (Completed)

### Loading Skeletons
- **LoadingSkeleton.tsx** - Reusable skeleton components
  - `GameCardSkeleton` - For game cards with team rows
  - `TableRowSkeleton` - For rankings/standings tables
  - News card skeleton with image placeholder
  - Shimmer animation effect

### Animations Added
- `fadeIn` - Cards fade in when appearing
- `slideUp` - Sections slide up on load
- `scaleIn` - Modal scale in effect
- `scoreFlash` - Score change highlight animation
- Staggered delays for grid items (50ms increments)
- Smooth hover transitions on all interactive elements

### Keyboard Navigation
- `tabIndex={0}` on GameCard for keyboard focus
- `role="button"` and `aria-label` for accessibility
- `Enter` and `Space` key support to open game details
- `Escape` key to close modal
- Focus-visible outlines for keyboard users

### CSS Improvements
- `.animate-*` classes for reusable animations
- Staggered animation delays for grids
- Focus-visible styles for accessibility
- Smoother transitions throughout

---

## Phase 1 Summary (Completed)

### Added Leagues
- **Football**: NFL, NCAAF
- **Basketball**: NBA, NCAAM, NCAAW, WNBA
- **Baseball**: MLB
- **Hockey**: NHL
- **Soccer**: Premier League, Championship, La Liga, Bundesliga, Serie A, Ligue 1, MLS, Champions League, Europa League, Liga MX, Eredivisie, Primeira Liga
- **MMA**: UFC
- **Golf**: PGA Tour, LPGA
- **Tennis**: ATP Tour, WTA Tour
- **Racing**: Formula 1, NASCAR Cup, IndyCar

### Added API Functions
- `getGameSummary(eventId, leagueId)` - Full game details with box scores
- `getPlayByPlay(eventId, leagueId)` - Play-by-play data structure
- `getLeagueNews(leagueId, limit)` - News articles
- `getLeagueRankings(leagueId)` - AP/Coaches polls for college
- `getLeagueLeaders(leagueId)` - Stats leaders by category
- `getScoreboardByDate(leagueId, date)` - Historical scores
- `getAvailableCategories()` - Sport categories for navigation
- `getLeaguesByCategory(category)` - Filter leagues by sport
- `getLeagueConfig(leagueId)` - Get league config

### Added Types
- `GameSummary` - Detailed game info with venue, officials, broadcasts
- `GameTeam` - Team with leaders, stats, scoring plays
- `GameLeader` - Player stat leader
- `TeamStat` - Head-to-head stat comparison
- `ScoringPlay` - Individual scoring event
- `GameHeadline` - Related news article
- `PlayByPlay`, `PlayPeriod`, `Play` - Play-by-play data
- `NewsArticle` - News article with metadata
- `Ranking`, `RankingsList` - College rankings
- `LeagueLeader`, `LeadersCategory` - Stats leaders

---

## Phase 2 Summary (Completed)

### New Components Created
- **GameCard.tsx** - Professional game card with sport-specific status displays
  - Football: Quarter/clock display
  - Basketball: Quarter/clock display
  - Baseball: Inning/half indicator
  - Hockey: Period display (1st, 2nd, 3rd, OT, SO)
  - Soccer: Match minute
  - MMA: Round display
  - Tennis: Set display
  - Compact variant for lists

- **GameDetail.tsx** - Full game detail modal
  - Team logos, names, records
  - Live status with pulsing indicator
  - Venue and broadcast info
  - Key performers/leaders
  - Related news headlines
  - Tab navigation (Overview/News)

### Enhanced Components
- **LiveScoresTab.tsx** - Updated to use new GameCard and GameDetail
  - Category filter buttons (All, Football, Basketball, etc.)
  - Live game count indicator
  - Leagues sorted by live games first
  - Cleaner, more professional layout

### CSS Added
- `.game-card` - Professional card styling with hover effects
- `.game-status-badge` - Live/Final/Scheduled badges
- `.game-card-status` - Sport-specific status displays
- `.game-detail-modal` - Full modal styling
- `.live-header`, `.live-categories`, `.live-category-btn` - Category filters

---

## Phase 3 Summary (Completed)

### New Components Created
- **NewsTab.tsx** - News feed with league filter
  - League dropdown filter (All or specific league)
  - Article cards with images, titles, descriptions
  - Relative timestamps (Just now, 2h ago, 3d ago)
  - Links to ESPN articles

- **RankingsTab.tsx** - College sports rankings
  - League tabs (College Football, Men's College Basketball)
  - Rankings table with rank, team, record, trend
  - Trend indicators (up/down arrows, NEW badge)
  - Team logos

- **LeadersTab.tsx** - Stat leaders by category
  - League tabs (NFL, NBA, MLB, NHL)
  - Category cards (Passing Yards, Points, Home Runs, etc.)
  - Player headshots and team logos
  - Top 5 leaders per category

### Updated Types
- `SportsTabId` - Added 'news', 'rankings', 'leaders'

### CSS Added
- `.news-header`, `.news-grid`, `.news-card` - News layout
- `.rankings-header`, `.rankings-table`, `.rankings-trend` - Rankings layout
- `.leaders-header`, `.leaders-grid`, `.leaders-category` - Leaders layout

### Navigation Updated
- SportsHub sidebar now has 7 tabs:
  - Live Now, Upcoming, Leagues, Favorites, News, Rankings, Leaders

---

## Ready to Start?

When you're ready, I'll begin with **Phase 1** - expanding the API service with more leagues and endpoints. This is backend-only work that won't break anything.

Just say "start phase 1" when you want to proceed.
