import { useState, useEffect, useMemo, useRef } from 'react';
import type { StoredChannel } from '../../db';
import { db } from '../../db';
import { useTeamChannelLinksStore, getTeamLinks } from '../../stores/teamChannelLinksStore';
import { getLeagueTeams } from '../../services/sports';
import { SPORT_CONFIG } from '../../services/sports/config';
import { useSourceNameMap } from '../../hooks/useChannels';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import type { SportsTeam } from '@ynotv/core';
import './TeamChannelOverlay.css';

interface TeamChannelOverlayProps {
  currentChannel: StoredChannel | null;
  onChannelClick: (channel: StoredChannel) => void;
  isCleanDesign?: boolean;
  showSource?: boolean;
  onDropdownOpenChange?: (open: boolean) => void;
}

interface TeamData {
  leagueId: string;
  teamId: string;
  teamName: string;
  teamLogo?: string;
  leagueName: string;
  links: import('../../db').TeamChannelLink[];
  channelMap: Map<string, StoredChannel>;
}

function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h} 65% 40%)`;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function SportsBallIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

export function TeamChannelOverlay({
  currentChannel,
  onChannelClick,
  isCleanDesign,
  showSource: showSourceProp,
  onDropdownOpenChange,
}: TeamChannelOverlayProps) {
  const { t } = useTranslation('player');
  const links = useTeamChannelLinksStore((s) => s.links);
  const ensureLoaded = useTeamChannelLinksStore((s) => s.ensureLoaded);

  const appSettingShowSource = useSettingsStore((s) => s.failoverGroupShowSource);
  const sourceNameMap = useSourceNameMap();
  const showSource = showSourceProp ?? appSettingShowSource;

  const [isOpen, setIsOpen] = useState(false);
  const [selectedTeamIndex, setSelectedTeamIndex] = useState(0);
  const [teamsData, setTeamsData] = useState<TeamData[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);

  // Notify parent if open state changes
  useEffect(() => {
    onDropdownOpenChange?.(isOpen);
  }, [isOpen, onDropdownOpenChange]);

  // Find all teams matching the current channel's stream_id that have > 1 links
  useEffect(() => {
    if (!currentChannel?.stream_id) {
      setTeamsData([]);
      setIsOpen(false);
      return;
    }

    const isVod = currentChannel.stream_id === 'vod' || currentChannel.stream_id.startsWith('recording_');
    if (isVod) {
      setTeamsData([]);
      setIsOpen(false);
      return;
    }

    const matchingLinks = links.filter((l) => l.stream_id === currentChannel.stream_id);
    if (matchingLinks.length === 0) {
      setTeamsData([]);
      setIsOpen(false);
      return;
    }

    // Extract unique teams (league_id + team_id)
    const uniqueTeamKeys = new Set<string>();
    const qualifyingTeams: { leagueId: string; teamId: string; teamLinks: typeof links }[] = [];

    for (const match of matchingLinks) {
      const key = `${match.league_id}:${match.team_id}`;
      if (!uniqueTeamKeys.has(key)) {
        uniqueTeamKeys.add(key);
        const teamLinks = getTeamLinks(links, match.league_id, match.team_id);
        // Only include if there are multiple channels linked to this team
        if (teamLinks.length > 1) {
          qualifyingTeams.push({
            leagueId: match.league_id,
            teamId: match.team_id,
            teamLinks,
          });
        }
      }
    }

    if (qualifyingTeams.length === 0) {
      setTeamsData([]);
      setIsOpen(false);
      return;
    }

    let isMounted = true;

    async function loadTeamsAndChannels() {
      try {
        const loadedData: TeamData[] = [];

        for (const qt of qualifyingTeams) {
          // 1. Resolve Team info
          let teamInfo: SportsTeam | undefined;
          try {
            const leagueTeams = await getLeagueTeams(qt.leagueId);
            teamInfo = leagueTeams.find((t) => t.id === qt.teamId);
          } catch (e) {
            console.warn('[TeamChannelOverlay] Failed to fetch league teams:', e);
          }

          const fallbackTeamName = qt.teamLinks[0]?.channel_name
            ? qt.teamLinks[0].channel_name.replace(/^(hd|fhd|4k|sd|us|uk|ca|es|fr|de|it|\s+|[-:|])+/i, '').trim()
            : qt.teamId;

          const teamName = teamInfo?.name || teamInfo?.shortName || fallbackTeamName || qt.teamId;
          const leagueName = SPORT_CONFIG[qt.leagueId]?.name || qt.leagueId.toUpperCase();

          // 2. Fetch StoredChannel objects for each stream_id
          const streamIds = qt.teamLinks.map((l) => l.stream_id);
          const chList = await db.channels.where('stream_id').anyOf(streamIds).toArray();
          const channelMap = new Map<string, StoredChannel>();
          for (const ch of chList) {
            channelMap.set(ch.stream_id, ch);
          }

          loadedData.push({
            leagueId: qt.leagueId,
            teamId: qt.teamId,
            teamName,
            teamLogo: teamInfo?.logo,
            leagueName,
            links: qt.teamLinks,
            channelMap,
          });
        }

        if (isMounted) {
          setTeamsData(loadedData);
          if (selectedTeamIndex >= loadedData.length) {
            setSelectedTeamIndex(0);
          }
        }
      } catch (err) {
        console.error('[TeamChannelOverlay] Error loading team data:', err);
      }
    }

    loadTeamsAndChannels();

    return () => {
      isMounted = false;
    };
  }, [currentChannel?.stream_id, links]);

  // Click outside to close dropdown
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  if (teamsData.length === 0) return null;

  const currentTeamData = teamsData[selectedTeamIndex] || teamsData[0];
  const currentStreamId = currentChannel?.stream_id;

  const handleChannelSelect = (link: import('../../db').TeamChannelLink) => {
    if (link.stream_id === currentStreamId) return;

    const fullChannel = currentTeamData.channelMap.get(link.stream_id);
    if (fullChannel) {
      onChannelClick(fullChannel);
      setIsOpen(false);
    } else {
      // Fallback: fetch directly from DB or create a fallback channel object
      db.channels.where('stream_id').equals(link.stream_id).first().then((ch) => {
        if (ch) {
          onChannelClick(ch);
          setIsOpen(false);
        } else {
          // If channel not in db, create minimal channel object
          const minimalChannel: StoredChannel = {
            stream_id: link.stream_id,
            name: link.channel_name,
            source_id: link.source_id || '',
            stream_icon: '',
            epg_channel_id: '',
            category_ids: [],
            direct_url: '',
            stream_type: 'live',
          };
          onChannelClick(minimalChannel);
          setIsOpen(false);
        }
      });
    }
  };

  const buttonTitle = t('teamStreamsTooltip', {
    defaultValue: 'Team Streams: {{team}} ({{count}} available)',
    team: currentTeamData.teamName,
    count: currentTeamData.links.length,
  });

  return (
    <div className="tco-container" ref={containerRef}>
      <button
        className={`${isCleanDesign ? 'npb-clean-btn' : 'npb-btn'} tco-trigger-btn${isOpen ? ' active' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        title={buttonTitle}
      >
        {currentTeamData.teamLogo ? (
          <img
            src={currentTeamData.teamLogo}
            alt=""
            className="tco-team-logo-mini"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <SportsBallIcon />
        )}
        <span className="tco-badge-count">{currentTeamData.links.length}</span>
      </button>

      {isOpen && (
        <div
          className="tco-dropdown"
          onMouseEnter={(e) => e.stopPropagation()}
          onMouseLeave={(e) => e.stopPropagation()}
        >
          {/* Multi-team tabs if channel belongs to multiple teams */}
          {teamsData.length > 1 && (
            <div className="tco-team-tabs">
              {teamsData.map((td, idx) => (
                <button
                  key={`${td.leagueId}:${td.teamId}`}
                  className={`tco-team-tab ${idx === selectedTeamIndex ? 'active' : ''}`}
                  onClick={() => setSelectedTeamIndex(idx)}
                >
                  {td.teamName} ({td.links.length})
                </button>
              ))}
            </div>
          )}

          {/* Team Header */}
          <div className="tco-header">
            {currentTeamData.teamLogo ? (
              <img
                src={currentTeamData.teamLogo}
                alt=""
                className="tco-team-logo"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <div
                className="tco-team-logo-fallback"
                style={{ background: stringToColor(currentTeamData.teamName) }}
              >
                {getInitials(currentTeamData.teamName)}
              </div>
            )}
            <div className="tco-team-meta">
              <div className="tco-team-name-row">
                <span className="tco-team-name" title={currentTeamData.teamName}>
                  {currentTeamData.teamName}
                </span>
                <span className="tco-league-badge">{currentTeamData.leagueName}</span>
              </div>
              <span className="tco-team-subtitle">
                {t('connectedChannelsCount', {
                  defaultValue: '{{count}} connected channels',
                  count: currentTeamData.links.length,
                })}
              </span>
            </div>
          </div>

          {/* Channel list */}
          <div className="tco-list">
            {currentTeamData.links.map((link, idx) => {
              const isActive = link.stream_id === currentStreamId;
              const ch = currentTeamData.channelMap.get(link.stream_id);
              const displayName = ch?.alias || ch?.name || link.channel_name;
              const logo = ch?.stream_icon;
              const sourceId = ch?.source_id || link.source_id;
              const sourceName = showSource && sourceNameMap && sourceId ? sourceNameMap.get(sourceId) : undefined;
              const isPrimary = (link.priority ?? idx) === 0;

              return (
                <button
                  key={link.id || `${link.league_id}:${link.team_id}:${link.stream_id}`}
                  className={`tco-item ${isActive ? 'tco-active' : ''}`}
                  onClick={() => handleChannelSelect(link)}
                  disabled={isActive}
                  title={isActive ? t('currentlyPlaying') : t('switchTo', { name: displayName })}
                >
                  {logo ? (
                    <img
                      src={logo}
                      alt=""
                      className="tco-channel-logo"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <span className="tco-channel-logo-placeholder">📺</span>
                  )}

                  <div className="tco-channel-info">
                    <span className="tco-channel-name" title={displayName}>
                      {displayName}
                    </span>
                    {sourceName && (
                      <span className="tco-channel-source" title={sourceName}>
                        {sourceName}
                      </span>
                    )}
                  </div>

                  <div className="tco-item-tags">
                    <span className={`tco-priority-pill ${isPrimary ? 'primary' : ''}`}>
                      {isPrimary ? t('primary', 'Primary') : t('backup', { defaultValue: 'Backup {{num}}', num: (link.priority ?? idx) })}
                    </span>
                    {isActive && (
                      <span className="tco-playing-indicator">
                        <span className="tco-pulse-dot" />
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
