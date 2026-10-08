/**
 * League inference for legacy sports favorites.
 *
 * A team ID is only unique inside an ESPN league, so this module deliberately
 * fails closed when a legacy favorite cannot be identified confidently.
 */

export interface TeamLike {
  id?: string;
  name?: string;
  shortName?: string;
  logo?: string;
  leagueId?: string;
}

export type LeagueInferenceConfidence = 'explicit' | 'logo' | 'exact-name' | 'unknown';

export interface LeagueInferenceResult {
  leagueId?: string;
  confidence: LeagueInferenceConfidence;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[’']/g, "'");
}

// These are intentionally full team identities rather than nickname substrings.
// Generic names such as "Kings", "Wings", "Lions", and "Spurs" are ambiguous.
const EXACT_TEAM_LEAGUES: Array<{ leagueId: string; names: string[] }> = [
  {
    leagueId: 'nba',
    names: [
      'atlanta hawks', 'boston celtics', 'brooklyn nets', 'charlotte hornets',
      'chicago bulls', 'cleveland cavaliers', 'dallas mavericks', 'denver nuggets',
      'detroit pistons', 'golden state warriors', 'houston rockets', 'indiana pacers',
      'la clippers', 'los angeles clippers', 'los angeles lakers', 'memphis grizzlies',
      'miami heat', 'milwaukee bucks', 'minnesota timberwolves', 'new orleans pelicans',
      'new york knicks', 'oklahoma city thunder', 'orlando magic', 'philadelphia 76ers',
      'phoenix suns', 'portland trail blazers', 'sacramento kings', 'san antonio spurs',
      'toronto raptors', 'utah jazz', 'washington wizards',
      // Unambiguous nicknames
      'nuggets', 'celtics', 'lakers', 'warriors', 'bulls', 'knicks', '76ers', 'sixers',
      'bucks', 'clippers', 'mavericks', 'mavs', 'grizzlies', 'pelicans', 'timberwolves',
      'trail blazers', 'blazers', 'wizards', 'pacers', 'cavaliers', 'cavs', 'raptors',
    ],
  },
  {
    leagueId: 'nfl',
    names: [
      'arizona cardinals', 'atlanta falcons', 'baltimore ravens', 'buffalo bills',
      'carolina panthers', 'chicago bears', 'cincinnati bengals', 'cleveland browns',
      'dallas cowboys', 'denver broncos', 'detroit lions', 'green bay packers',
      'houston texans', 'indianapolis colts', 'jacksonville jaguars', 'kansas city chiefs',
      'las vegas raiders', 'los angeles chargers', 'los angeles rams', 'miami dolphins',
      'minnesota vikings', 'new england patriots', 'new orleans saints', 'new york giants',
      'new york jets', 'philadelphia eagles', 'pittsburgh steelers', 'san francisco 49ers',
      'seattle seahawks', 'tampa bay buccaneers', 'tennessee titans', 'washington commanders',
      // Unambiguous nicknames
      'broncos', 'chiefs', 'packers', 'cowboys', 'steelers', '49ers', 'niners',
      'seahawks', 'bills', 'dolphins', 'ravens', 'bengals', 'browns', 'buccaneers',
      'bucs', 'titans', 'raiders', 'chargers', 'commanders', 'patriots',
    ],
  },
  {
    leagueId: 'mlb',
    names: [
      'arizona diamondbacks', 'atlanta braves', 'baltimore orioles', 'boston red sox',
      'chicago cubs', 'chicago white sox', 'cincinnati reds', 'cleveland guardians',
      'colorado rockies', 'detroit tigers', 'houston astros', 'kansas city royals',
      'los angeles angels', 'los angeles dodgers', 'miami marlins', 'milwaukee brewers',
      'minnesota twins', 'new york mets', 'new york yankees', 'oakland athletics',
      'philadelphia phillies', 'pittsburgh pirates', 'san diego padres', 'san francisco giants',
      'seattle mariners', 'st. louis cardinals', 'st louis cardinals', 'tampa bay rays',
      'texas rangers', 'toronto blue jays', 'washington nationals',
      // Unambiguous nicknames
      'yankees', 'red sox', 'dodgers', 'cubs', 'braves', 'mets', 'phillies',
      'astros', 'mariners', 'white sox', 'guardians', 'blue jays', 'diamondbacks', 'd-backs',
    ],
  },
  {
    leagueId: 'nhl',
    names: [
      'anaheim ducks', 'arizona coyotes', 'boston bruins', 'buffalo sabres',
      'calgary flames', 'carolina hurricanes', 'chicago blackhawks', 'colorado avalanche',
      'columbus blue jackets', 'dallas stars', 'detroit red wings', 'edmonton oilers',
      'florida panthers', 'los angeles kings', 'minnesota wild', 'montreal canadiens',
      'nashville predators', 'new jersey devils', 'new york islanders', 'new york rangers',
      'ottawa senators', 'philadelphia flyers', 'pittsburgh penguins', 'san jose sharks',
      'seattle kraken', 'st. louis blues', 'st louis blues', 'tampa bay lightning',
      'toronto maple leafs', 'utah hockey club', 'utah mammoth', 'vancouver canucks',
      'vegas golden knights', 'washington capitals', 'winnipeg jets',
      // Unambiguous nicknames
      'canadiens', 'habs', 'maple leafs', 'leafs', 'bruins', 'blackhawks', 'red wings',
      'penguins', 'flyers', 'capitals', 'lightning', 'hurricanes', 'canes', 'devils',
      'islanders', 'sabres', 'blue jackets', 'avalanche', 'avs', 'kraken', 'canucks',
      'golden knights',
    ],
  },
  {
    leagueId: 'wnba',
    names: [
      'atlanta dream', 'chicago sky', 'connecticut sun', 'dallas wings',
      'indiana fever', 'las vegas aces', 'los angeles sparks', 'minnesota lynx',
      'new york liberty', 'phoenix mercury', 'seattle storm', 'washington mystics',
      'golden state valkyries', 'valkyries',
    ],
  },
  {
    leagueId: 'afl',
    names: [
      'adelaide crows', 'brisbane lions', 'carlton blues', 'collingwood magpies',
      'essendon bombers', 'fremantle dockers', 'geelong cats', 'gold coast suns',
      'greater western sydney giants', 'hawthorn hawks', 'melbourne demons',
      'north melbourne kangaroos', 'port adelaide power', 'richmond tigers',
      'st kilda saints', 'sydney swans', 'west coast eagles', 'western bulldogs',
    ],
  },
  {
    leagueId: 'soccer-eng.1',
    names: [
      'arsenal', 'aston villa', 'bournemouth', 'brentford', 'brighton & hove albion',
      'brighton', 'chelsea', 'crystal palace', 'everton', 'fulham', 'ipswich town',
      'ipswich', 'leicester city', 'leicester', 'liverpool', 'manchester city',
      'man city', 'manchester united', 'man utd', 'newcastle united', 'newcastle',
      'nottingham forest', 'southampton', 'tottenham hotspur', 'tottenham',
      'west ham united', 'west ham', 'wolverhampton wanderers', 'wolves',
    ],
  },
  {
    leagueId: 'soccer-esp.1',
    names: [
      'real madrid', 'barcelona', 'fc barcelona', 'atletico madrid', 'atlético madrid',
      'sevilla', 'valencia', 'villarreal', 'real betis', 'real sociedad',
      'athletic bilbao', 'athletic club',
    ],
  },
  {
    leagueId: 'soccer-ger.1',
    names: [
      'bayern munich', 'fc bayern', 'bayern', 'borussia dortmund', 'dortmund',
      'bayer leverkusen', 'leverkusen', 'rb leipzig', 'leipzig',
      'eintracht frankfurt', 'vfb stuttgart',
    ],
  },
  {
    leagueId: 'soccer-ita.1',
    names: [
      'juventus', 'inter milan', 'internazionale', 'ac milan', 'napoli',
      'as roma', 'lazio', 'atalanta', 'fiorentina',
    ],
  },
  {
    leagueId: 'soccer-fra.1',
    names: [
      'paris saint-germain', 'paris saint germain', 'psg', 'marseille',
      'olympique marseille', 'lyon', 'olympique lyonnais', 'monaco', 'as monaco', 'lille',
    ],
  },
  {
    leagueId: 'soccer-usa.1',
    names: [
      'inter miami', 'inter miami cf', 'la galaxy', 'lafc', 'los angeles fc',
      'seattle sounders', 'atlanta united', 'columbus crew', 'new york red bulls',
      'new york city fc', 'nycfc', 'philadelphia union',
    ],
  },
];

function inferLeagueFromExactTeamName(rawName: string): string | undefined {
  const normalized = normalizeName(rawName);
  return EXACT_TEAM_LEAGUES.find((entry) => entry.names.includes(normalized))?.leagueId;
}

/** Infer a league and expose why it was selected for migration/UI decisions. */
export function inferTeamLeagueResult(team?: TeamLike | null): LeagueInferenceResult {
  if (!team) return { confidence: 'unknown' };

  if (team.leagueId && team.leagueId.trim()) {
    return { leagueId: team.leagueId.trim().toLowerCase(), confidence: 'explicit' };
  }

  if (team.logo) {
    const fromLogo = inferLeagueFromLogoUrl(team.logo);
    if (fromLogo) return { leagueId: fromLogo, confidence: 'logo' };
  }

  if (team.name) {
    const exact = inferLeagueFromExactTeamName(team.name);
    if (exact) return { leagueId: exact, confidence: 'exact-name' };
  }

  return { confidence: 'unknown' };
}

export function inferTeamLeague(team?: TeamLike | null): string | undefined {
  return inferTeamLeagueResult(team).leagueId;
}

/** Infer league only from the structured ESPN team-logo path. */
export function inferLeagueFromLogoUrl(logoUrl: string): string | undefined {
  try {
    const path = new URL(logoUrl).pathname.toLowerCase();
    const match = path.match(/\/teamlogos\/([^/]+)\//);
    const key = match?.[1];
    if (!key) return undefined;

    if (key === 'nba') return 'nba';
    if (key === 'nfl') return 'nfl';
    if (key === 'mlb') return 'mlb';
    if (key === 'nhl') return 'nhl';
    if (key === 'wnba') return 'wnba';
    if (key === 'afl') return 'afl';
    if (key === 'ncaa') return undefined;
    if (key === 'soccer') return undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Kept as a public helper for callers/tests. It now fails closed for generic or
 * ambiguous nicknames instead of guessing a league from a substring.
 */
export function inferLeagueFromTeamName(rawName: string): string | undefined {
  return inferLeagueFromExactTeamName(rawName);
}
