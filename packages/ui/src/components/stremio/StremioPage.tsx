import { useState, useEffect, useCallback, useRef } from 'react';
import { useMemo } from 'react';
import { isMouseBackButtonActive } from '../../constants/shortcuts';
import { useSettingsStore } from '../../stores/settingsStore';
import type { StremioStreamPickerMode, StremioMeta, StremioStream, StremioVideo, BadgeSource } from '../../types/stremio';
import { compileBadgeSources } from '../../utils/streamBadges';
import { useStremioAddonStore } from '../../stores/stremioAddonStore';
import {
  useStremioView,
  useSetStremioView,
  useStremioActiveMeta,
  useSetStremioActiveMeta,
  useStremioSelectedSeason,
  useSetStremioSelectedSeason,
  useUIStore,
  useStremioNavigate,
  useStremioGoBack,
  useStremioActivePersonId,
} from '../../stores/uiStore';
import { StremioTopbar } from './StremioTopbar';
import { StremioHome } from './StremioHome';
import { StremioLibrary } from './StremioLibrary';
import { StremioCalendar } from './StremioCalendar';
import { StremioDetail } from './StremioDetail';
import { StremioPersonDetail } from './StremioPersonDetail';
import { AddonManagerPanel } from './AddonManagerPanel';
import { StremioAccountModal } from './StremioAccountModal';
import { StremioHoverProvider } from '../../contexts/StremioHoverContext';
import { StremioHoverCard } from './StremioHoverCard';
import { StremTab } from '../settings/StremTab';
import '../Settings.css';
import './StremioPage.css';

interface StremioPageProps {
  onClose: () => void;
  stremioStreamPickerMode: StremioStreamPickerMode;
  onStreamPickerModeChange: (mode: StremioStreamPickerMode) => Promise<void>;
  showStremioStreamBadges: boolean;
  onShowStremioStreamBadgesChange: (show: boolean) => Promise<void>;
  badgeSources: BadgeSource[];
  onBadgeSourcesChange: (sources: BadgeSource[]) => Promise<void>;
  stremioBadgeSize: number;
  onStremioBadgeSizeChange: (size: number) => void;
  showHoverDetails: boolean;
  onShowHoverDetailsChange: (show: boolean) => Promise<void>;
  showFileSizeBadges: boolean;
  onShowFileSizeBadgesChange?: (show: boolean) => Promise<void> | void;
  streamBadgePlacement: 'top' | 'bottom';
  onStreamBadgePlacementChange?: (placement: 'top' | 'bottom') => Promise<void> | void;
  stremioCacheFetchResults: boolean;
  onStremioCacheFetchResultsChange?: (enabled: boolean) => Promise<void> | void;
  stremioCacheFetchTimeout: number;
  onStremioCacheFetchTimeoutChange?: (timeout: number) => Promise<void> | void;
}

export function StremioPage({
  onClose,
  stremioStreamPickerMode,
  onStreamPickerModeChange,
  showStremioStreamBadges,
  onShowStremioStreamBadgesChange,
  badgeSources,
  onBadgeSourcesChange,
  stremioBadgeSize,
  onStremioBadgeSizeChange,
  showHoverDetails,
  onShowHoverDetailsChange,
  showFileSizeBadges,
  onShowFileSizeBadgesChange,
  streamBadgePlacement,
  onStreamBadgePlacementChange,
  stremioCacheFetchResults,
  onStremioCacheFetchResultsChange,
  stremioCacheFetchTimeout,
  onStremioCacheFetchTimeoutChange,
}: StremioPageProps) {
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const addons = useStremioAddonStore((s) => s.enabledAddons);
  const stremioView = useStremioView();
  const setStremioView = useSetStremioView();
  const compiledBadgeRules = useMemo(() => compileBadgeSources(badgeSources), [badgeSources]);
  const activeMeta = useStremioActiveMeta();
  const setActiveMeta = useSetStremioActiveMeta();
  const selectedSeason = useStremioSelectedSeason();
  const setSelectedSeason = useSetStremioSelectedSeason();
  const stremioNavigate = useStremioNavigate();
  const stremioGoBack = useStremioGoBack();
  const activePersonId = useStremioActivePersonId();
  const [showAddonManager, setShowAddonManager] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);

  const stremioPosterSize = useUIStore((s) => s.stremioPosterSize);

  const mainRef = useRef<HTMLDivElement | null>(null);
  const [homeScrollTop, setHomeScrollTop] = useState(0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showAccountModal) {
          setShowAccountModal(false);
        } else if (showAddonManager) {
          setShowAddonManager(false);
        } else if (useUIStore.getState().stremioHistory.length > 1) {
          stremioGoBack();
        } else if (stremioView === 'search' || stremioView === 'settings') {
          setStremioView('home');
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddonManager, showAccountModal, onClose, stremioGoBack, stremioView, setStremioView]);

  useEffect(() => {
    const handleMouseBack = (e: MouseEvent) => {
      if (isMouseBackButtonActive(shortcuts, e.button)) {
        e.preventDefault();
        e.stopPropagation();
        if (showAccountModal) {
          setShowAccountModal(false);
        } else if (showAddonManager) {
          setShowAddonManager(false);
        } else if (useUIStore.getState().stremioHistory.length > 1) {
          stremioGoBack();
        } else if (stremioView === 'search' || stremioView === 'settings') {
          setStremioView('home');
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('mousedown', handleMouseBack);
    return () => window.removeEventListener('mousedown', handleMouseBack);
  }, [shortcuts, showAddonManager, showAccountModal, onClose, stremioGoBack, stremioView, setStremioView]);

  const handleItemClick = useCallback((meta: StremioMeta) => {
    if (mainRef.current) {
      setHomeScrollTop(mainRef.current.scrollTop);
    }
    stremioNavigate({ view: 'detail', meta });
    // If preselectVideoId is set (from Continue Watching), keep the season
    // already set by the caller. Otherwise, reset to undefined so StremioDetail
    // auto-selects Season 1.
    if (!useUIStore.getState().stremioPreselectVideoId) {
      setSelectedSeason(undefined);
    }
  }, [stremioNavigate, setSelectedSeason]);

  const handleBack = useCallback(() => {
    stremioGoBack();
  }, [stremioGoBack]);

  const handlePlayStream = useCallback((stream: StremioStream, meta: StremioMeta, episodeVideo?: StremioVideo) => {
    window.dispatchEvent(new CustomEvent('ynotv:stremio-play', {
      detail: { stream, meta, season: selectedSeason, episodeVideo },
    }));
  }, [selectedSeason]);

  useEffect(() => {
    if (stremioView === 'home' || stremioView === 'search') {
      if (mainRef.current && homeScrollTop > 0) {
        const el = mainRef.current;
        const timer = setTimeout(() => {
          el.scrollTop = homeScrollTop;
        }, 50);
        return () => clearTimeout(timer);
      }
    }
  }, [stremioView, homeScrollTop]);

  return (
    <StremioHoverProvider>
      <div className="stremio-page" style={{ '--strem-poster-width': `${stremioPosterSize}px` } as React.CSSProperties}>
        {showAddonManager && (
          <AddonManagerPanel onClose={() => setShowAddonManager(false)} />
        )}

        {showAccountModal && (
          <StremioAccountModal onClose={() => setShowAccountModal(false)} />
        )}

        <StremioTopbar
          addons={addons}
          onOpenAddonManager={() => setShowAddonManager(true)}
          onOpenAccount={() => setShowAccountModal(true)}
        />

        <div className="stremio-main" ref={mainRef}>
          <div style={{ display: stremioView === 'home' || stremioView === 'search' ? 'block' : 'none' }}>
            <StremioHome
              addons={addons}
              onItemClick={handleItemClick}
            />
          </div>

          <div style={{ display: stremioView === 'library' ? 'block' : 'none' }}>
            <StremioLibrary
              onItemClick={handleItemClick}
            />
          </div>

          <div style={{ display: stremioView === 'calendar' ? 'block' : 'none' }}>
            <StremioCalendar
              onItemClick={handleItemClick}
            />
          </div>

          {stremioView === 'detail' && activeMeta && (
            <StremioDetail
              meta={activeMeta}
              onBack={handleBack}
              onPlay={handlePlayStream}
              streamPickerMode={stremioStreamPickerMode}
              showStreamBadges={showStremioStreamBadges}
              compiledBadgeRules={compiledBadgeRules}
              showFileSizeBadges={showFileSizeBadges}
              streamBadgePlacement={streamBadgePlacement}
              stremioCacheFetchResults={stremioCacheFetchResults}
              stremioCacheFetchTimeout={stremioCacheFetchTimeout}
            />
          )}

          {stremioView === 'person' && activePersonId && (
            <StremioPersonDetail
              personId={activePersonId}
              onBack={handleBack}
              onItemClick={handleItemClick}
            />
          )}

          {stremioView === 'settings' && (
            <div className="stremio-settings-container" style={{ padding: '24px 32px 80px 32px', maxWidth: '800px', margin: '0 auto' }}>
              <StremTab
                stremioStreamPickerMode={stremioStreamPickerMode}
                onStremioStreamPickerModeChange={onStreamPickerModeChange}
                showStremioStreamBadges={showStremioStreamBadges}
                onShowStremioStreamBadgesChange={onShowStremioStreamBadgesChange}
                badgeSources={badgeSources}
                onBadgeSourcesChange={onBadgeSourcesChange}
                stremioBadgeSize={stremioBadgeSize}
                onStremioBadgeSizeChange={onStremioBadgeSizeChange}
                showHoverDetails={showHoverDetails}
                onShowHoverDetailsChange={onShowHoverDetailsChange}
                showFileSizeBadges={showFileSizeBadges}
                onShowFileSizeBadgesChange={onShowFileSizeBadgesChange || (() => {})}
                streamBadgePlacement={streamBadgePlacement}
                onStreamBadgePlacementChange={onStreamBadgePlacementChange || (() => {})}
                stremioCacheFetchResults={stremioCacheFetchResults}
                onStremioCacheFetchResultsChange={onStremioCacheFetchResultsChange || (() => {})}
                stremioCacheFetchTimeout={stremioCacheFetchTimeout}
                onStremioCacheFetchTimeoutChange={onStremioCacheFetchTimeoutChange || (() => {})}
              />
            </div>
          )}
        </div>

        <StremioHoverCard />
      </div>
    </StremioHoverProvider>
  );
}