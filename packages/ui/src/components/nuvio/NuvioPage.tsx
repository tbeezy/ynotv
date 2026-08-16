import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../../i18n';
import { isMouseBackButtonActive } from '../../constants/shortcuts';
import { useSettingsStore } from '../../stores/settingsStore';
import { Virtuoso } from 'react-virtuoso';
import { useNuvioAuthStore } from '../../stores/nuvioAuthStore';
import { useNuvioCollectionStore } from '../../stores/nuvioCollectionStore';
import { useNuvioAddonStore } from '../../stores/nuvioAddonStore';
import { useNuvioPluginStore } from '../../stores/nuvioPluginStore';
import {
  useNuvioView,
  useSetNuvioView,
  useNuvioActiveMeta,
  useSetNuvioActiveMeta,
  useNuvioSelectedFolder,
  useSetNuvioSelectedFolder,
  useNuvioSelectedFolderCollectionTitle,
  useSetNuvioSelectedFolderCollectionTitle,
  useSetNuvioPreselectVideoId,
  useNuvioActivePersonId,
  useSetNuvioActivePersonId,
  useNuvioNavigate,
  useNuvioGoBack,
  useTraktCatalogRefreshToken,
  useUIStore,
  useNuvioHasUnsavedHomeLayout,
  useNuvioTabSaveFn
} from '../../stores/uiStore';
import {
  fetchNuvioLibrary,
  fetchNuvioWatchProgress,
  fetchNuvioWatchProgressDeltaCursor,
  fetchNuvioWatchProgressDelta,
  pushNuvioLibrary,
  type NuvioLibrarySyncItem,
  type NuvioWatchProgressSyncEntry,
  type NuvioWatchProgressDeltaEvent,
  type NuvioCollectionFolder,
  type NuvioCollectionSource,
  type NuvioCollection
} from '../../services/nuvio-api';
import { fetchCatalog, fetchMeta, parseAddonUrl } from '../../services/stremio-addon';
import { NuvioHeroBanner } from './NuvioHeroBanner';
import { StremioCatalogRow } from '../stremio/StremioCatalogRow';
import { StremioHoverProvider, useStremioHover } from '../../contexts/StremioHoverContext';
import { StremioHoverCard } from '../stremio/StremioHoverCard';
import { NuvioDetailView, type NuvioMeta } from './NuvioDetailView';
import { PosterSizeSlider } from '../PosterSizeSlider';
import { NuvioPersonDetail } from './NuvioPersonDetail';
import { NuvioPinModal } from './NuvioPinModal';
import { useModal } from '../Modal';
import type { StremioStream, StremioVideo, StremioMeta, BadgeSource, StreamAutoPlayMode, StreamAutoPlaySourceScope } from '../../types/stremio';
import type { StremioMetaPreview, InstalledAddon } from '../../types/stremio';
import { scrobbler, TRAKT_CATALOG_DEFINITIONS } from '../../services/scrobbler';
import { SERVICES, type StreamingService } from '../../constants/streamingProviders';
import { StreamingServiceView } from '../stremio/StreamingServiceView';
import { compileBadgeSources } from '../../utils/streamBadges';
import { NuvioTab } from '../settings/NuvioTab';
import { NuvioSearchPage } from './NuvioSearchPage';
import { NuvioCloudLibrary } from './NuvioCloudLibrary';
import { LazyImage } from '../LazyImage';
import { useNuvioCloudStore } from '../../stores/nuvioCloudStore';
import { cloudProviderApiKeysFromSettings, cloudLibraryEnabledFromSettings } from '../../services/cloud-api';
import type { CloudLibraryFile, CloudLibraryItem } from '../../types/cloud';
import '../Settings.css';
import './NuvioPage.css';

interface NuvioPageProps {
  onClose: () => void;
  showNuvioStreamBadges?: boolean;
  onShowNuvioStreamBadgesChange?: (show: boolean) => Promise<void> | void;
  nuvioBadgeSources?: BadgeSource[];
  onNuvioBadgeSourcesChange?: (sources: BadgeSource[]) => Promise<void> | void;
  nuvioBadgeSize?: number;
  onNuvioBadgeSizeChange?: (size: number) => Promise<void> | void;
  nuvioShowFileSizeBadges?: boolean;
  onNuvioShowFileSizeBadgesChange?: (show: boolean) => Promise<void> | void;
  nuvioStreamBadgePlacement?: 'top' | 'bottom';
  onNuvioStreamBadgePlacementChange?: (placement: 'top' | 'bottom') => Promise<void> | void;
  showNuvioHoverDetails?: boolean;
  onShowNuvioHoverDetailsChange?: (show: boolean) => Promise<void> | void;
  nuvioAutoPlayMode?: StreamAutoPlayMode;
  onNuvioAutoPlayModeChange?: (mode: StreamAutoPlayMode) => void;
  nuvioAutoPlayTimeout?: number;
  onNuvioAutoPlayTimeoutChange?: (timeout: number) => void;
  nuvioAutoPlaySourceScope?: StreamAutoPlaySourceScope;
  onNuvioAutoPlaySourceScopeChange?: (scope: StreamAutoPlaySourceScope) => void;
  nuvioAutoPlayAllowedAddons?: string[];
  onNuvioAutoPlayAllowedAddonsChange?: (addonIds: string[]) => void;
  nuvioAutoPlayAllowedPlugins?: string[];
  onNuvioAutoPlayAllowedPluginsChange?: (pluginIds: string[]) => void;
  nuvioAutoPlayRegex?: string;
  onNuvioAutoPlayRegexChange?: (regex: string) => void;
  onNavigateToSettingsTab?: (tab: string) => void;
  nuvioCacheFetchResults?: boolean;
  onNuvioCacheFetchResultsChange?: (show: boolean) => Promise<void> | void;
  nuvioCacheFetchTimeout?: number;
  onNuvioCacheFetchTimeoutChange?: (timeout: number) => void;
  onCardMouseEnter?: (item: StremioMetaPreview, element: HTMLElement, event?: React.MouseEvent) => void;
  onCardMouseLeave?: () => void;
  onCardClick?: () => void;
}

const getFolderShapeClass = (folderShape: string | undefined): string => {
  const shape = (folderShape || 'poster').toLowerCase();
  if (shape === 'wide' || shape === 'landscape') return 'landscape';
  if (shape === 'square') return 'square';
  return 'poster';
};

const isAioMetadataAddon = (addon: InstalledAddon): boolean => {
  const addonId = (addon.manifest?.id || addon.id || '').toLowerCase();
  const baseUrl = (addon.baseUrl || '').toLowerCase();
  const name = (addon.manifest?.name || '').toLowerCase();
  const description = (addon.manifest?.description || '').toLowerCase();
  
  return (
    addonId.includes('aio') ||
    addonId.includes('genres') ||
    baseUrl.includes('aio') ||
    baseUrl.includes('genres') ||
    name.includes('aio') ||
    name.includes('genres') ||
    description.includes('aio') ||
    description.includes('genres')
  );
};

const isCinemetaAddon = (addon: InstalledAddon): boolean => {
  const addonId = (addon.manifest?.id || addon.id || '').toLowerCase();
  const baseUrl = (addon.baseUrl || '').toLowerCase();
  const name = (addon.manifest?.name || '').toLowerCase();
  
  return (
    addonId.includes('cinemeta') ||
    addonId.includes('linvo') ||
    baseUrl.includes('cinemeta') ||
    baseUrl.includes('linvo') ||
    name.includes('cinemeta') ||
    name.includes('linvo')
  );
};

const matchCatalogKey = (settingsKey: string, row: { key: string; addon: InstalledAddon; catalog: any }): boolean => {
  const parts = settingsKey.split(':');
  if (parts.length < 3) return false;
  
  const catalogId = parts.pop();
  const catalogType = parts.pop();
  const addonManifestId = parts.join(':').toLowerCase();
  
  const rowAddonId = (row.addon.manifest?.id || row.addon.id || '').toLowerCase();
  const rowAddonBaseUrl = (row.addon.baseUrl || '').toLowerCase();
  
  // Fuzzy addon match
  let addonMatches = false;
  if (rowAddonId === addonManifestId || addonManifestId.includes(rowAddonId) || rowAddonId.includes(addonManifestId)) {
    addonMatches = true;
  } else if (rowAddonBaseUrl.includes(addonManifestId) || addonManifestId.includes(rowAddonBaseUrl)) {
    addonMatches = true;
  } else {
    // Special Cinemeta fuzzy match
    const settingsIsCinemeta = addonManifestId.includes('cinemeta') || addonManifestId.includes('linvo');
    if (settingsIsCinemeta && isCinemetaAddon(row.addon)) {
      addonMatches = true;
    }
    
    // Special AIO metadata fuzzy match
    const settingsIsAio = addonManifestId.includes('aio') || addonManifestId.includes('genres');
    if (settingsIsAio && isAioMetadataAddon(row.addon)) {
      addonMatches = true;
    }
  }
  
  if (!addonMatches) return false;
  
  // Match catalog type and catalog ID
  const settingsCatId = (catalogId || '').toLowerCase();
  const rowCatId = (row.catalog.id || '').toLowerCase();
  const settingsCatType = (catalogType || '').toLowerCase();
  const rowCatType = (row.catalog.type || '').toLowerCase();
  
  // Normalize types: series -> series, tv -> series
  const normSettingsType = settingsCatType === 'tv' ? 'series' : settingsCatType;
  const normRowType = rowCatType === 'tv' ? 'series' : rowCatType;
  
  return normSettingsType === normRowType && settingsCatId === rowCatId;
};

const getHomeCatalogDefaultTitle = (catalogName: string, type: string): string => {
  const cleanType = (type || '').trim().toLowerCase();
  let mediaTypeLabel = '';
  switch (cleanType) {
    case 'movie':
      mediaTypeLabel = 'Movies';
      break;
    case 'series':
      mediaTypeLabel = 'Series';
      break;
    case 'anime':
      mediaTypeLabel = 'Anime';
      break;
    case 'channel':
      mediaTypeLabel = 'Channels';
      break;
    case 'tv':
      mediaTypeLabel = 'TV';
      break;
    default:
      mediaTypeLabel = cleanType ? cleanType.charAt(0).toUpperCase() + cleanType.slice(1) : '';
  }
  return mediaTypeLabel ? `${catalogName} - ${mediaTypeLabel}` : catalogName;
};

// Match a collection source's addonId against an installed addon.
// Uses exact ID matching only to avoid selecting the wrong addon.
const fuzzyMatchAddon = (source: NuvioCollectionSource, addon: InstalledAddon): boolean => {
  const targetId = (source.addonId || '').trim().toLowerCase();
  if (!targetId) return false;

  const addonId = (addon.manifest?.id || addon.id || '').toLowerCase();
  if (addonId === targetId) return true;

  // Known heuristics for addons that alias IDs (only if targetId is NOT empty)
  if ((targetId.includes('aio') || targetId.includes('genres')) && isAioMetadataAddon(addon)) return true;
  if ((targetId.includes('cinemeta') || targetId.includes('linvo')) && isCinemetaAddon(addon)) return true;

  return false;
};

// Mirrors Nuvio Desktop's CollectionCatalogResolver.findCollectionCatalog:
// 1) Exact manifest.id match + catalog check
// 2) Heuristic (fuzzy) match + catalog check
// 3) Scan ALL enabled addons for catalogId+type (ignoring addonId)
const findAddonForSource = (
  source: NuvioCollectionSource,
  addons: InstalledAddon[]
): InstalledAddon | undefined => {
  const catalogType = source.type === 'tv' ? 'series' : (source.type || 'movie');
  const catalogId = source.catalogId || 'top';
  const targetId = (source.addonId || '').trim().toLowerCase();

  const hasMatchingCatalog = (a: InstalledAddon) =>
    a.manifest?.catalogs?.some(
      c => (c.type === catalogType || (c.type === 'tv' && catalogType === 'series')) &&
           (c.id === catalogId || c.id === catalogId.split(',')[0])
    );

  if (targetId) {
    const exactMatch = addons.find(a => (a.manifest?.id || a.id || '').toLowerCase() === targetId);
    if (exactMatch && hasMatchingCatalog(exactMatch)) return exactMatch;
  }

  const heuristicMatch = addons.find(a => hasMatchingCatalog(a) && fuzzyMatchAddon(source, a));
  if (heuristicMatch) return heuristicMatch;

  return addons.find(hasMatchingCatalog);
};

// Mirrors Nuvio Desktop's CollectionModels.normalizedOptionalGenre()
const normalizeGenre = (genre: string | null | undefined): string | undefined => {
  const g = (genre || '').trim();
  return g && !/^none$/i.test(g) ? g : undefined;
};

const getSourceLabel = (
  source: NuvioCollectionSource,
  index: number,
  activeAddons: InstalledAddon[]
): string => {
  if (source.provider === 'tmdb') {
    return `TMDB - ${source.title || 'Discover'}`;
  }
  if (source.provider === 'trakt') {
    return `Trakt - ${source.title || 'List'}`;
  }
  
  const resolvedAddon = findAddonForSource(source, activeAddons);

  let catalogName: string;
  if (resolvedAddon) {
    const catalogType2 = source.type === 'tv' ? 'series' : (source.type || 'movie');
    const catalog = resolvedAddon.manifest?.catalogs?.find(
      c => (c.type === catalogType2 || (c.type === 'tv' && catalogType2 === 'series')) && c.id === (source.catalogId || '').split(',')[0]
    );
    if (catalog) {
      catalogName = catalog.name;
    } else {
      catalogName = source.catalogId || resolvedAddon.manifest?.name || `Source ${index + 1}`;
    }
  } else {
    catalogName = source.catalogId || source.addonId || `Source ${index + 1}`;
  }

  const typeLabel = source.type === 'tv' || source.type === 'series' ? 'Series' : 'Movie';
  const genreSuffix = normalizeGenre(source.genre) ? ` · ${normalizeGenre(source.genre)}` : '';
  
  return `${catalogName} (${typeLabel})${genreSuffix}`;
};

export function NuvioPage(props: NuvioPageProps) {
  const addonsStore = useNuvioAddonStore();
  const addons = addonsStore.enabledAddons;
  return (
    <StremioHoverProvider addons={addons} disabled={!props.showNuvioHoverDetails}>
      <NuvioPageContentWithHover {...props} />
    </StremioHoverProvider>
  );
}

function NuvioPageContentWithHover(props: NuvioPageProps) {
  const hoverHandlers = useStremioHover();
  return <NuvioPageContent {...props} {...hoverHandlers} />;
}

function NuvioPageContent({
  onClose,
  showNuvioStreamBadges = true,
  onShowNuvioStreamBadgesChange,
  nuvioBadgeSources = [],
  onNuvioBadgeSourcesChange,
  nuvioBadgeSize = 100,
  onNuvioBadgeSizeChange,
  nuvioShowFileSizeBadges = true,
  onNuvioShowFileSizeBadgesChange,
  nuvioStreamBadgePlacement = 'bottom',
  onNuvioStreamBadgePlacementChange,
  showNuvioHoverDetails = true,
  onShowNuvioHoverDetailsChange,
  nuvioAutoPlayMode = 'manual',
  onNuvioAutoPlayModeChange,
  nuvioAutoPlayTimeout = 0,
  onNuvioAutoPlayTimeoutChange,
  nuvioAutoPlaySourceScope = 'all',
  onNuvioAutoPlaySourceScopeChange,
  nuvioAutoPlayAllowedAddons = [],
  onNuvioAutoPlayAllowedAddonsChange,
  nuvioAutoPlayAllowedPlugins = [],
  onNuvioAutoPlayAllowedPluginsChange,
  nuvioAutoPlayRegex = '',
  onNuvioAutoPlayRegexChange,
  onNavigateToSettingsTab,
  nuvioCacheFetchResults = false,
  onNuvioCacheFetchResultsChange,
  nuvioCacheFetchTimeout = 5,
  onNuvioCacheFetchTimeoutChange,
  onCardMouseEnter: onCardMouseEnterProp,
  onCardMouseLeave: onCardMouseLeaveProp,
  onCardClick: onCardClickProp,
}: NuvioPageProps) {
  const { t } = useTranslation('nuvio');
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const compiledBadgeRules = useMemo(() => compileBadgeSources(nuvioBadgeSources), [nuvioBadgeSources]);
  const addonsStore = useNuvioAddonStore();
  const addons = addonsStore.enabledAddons;
  const authStore = useNuvioAuthStore();
  const collectionStore = useNuvioCollectionStore();
  const pluginStore = useNuvioPluginStore();
  const { showConfirm, ModalComponent } = useModal();
  const nuvioHasUnsavedHomeLayout = useNuvioHasUnsavedHomeLayout();
  const nuvioTabSaveFn = useNuvioTabSaveFn();

  const nuvioPosterSize = useUIStore((s) => s.nuvioPosterSize);
  const setNuvioPosterSize = useUIStore((s) => s.setNuvioPosterSize);

  const [library, setLibrary] = useState<NuvioLibrarySyncItem[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [libraryViewTab, setLibraryViewTab] = useState<'library' | 'cloud'>('library');
  const libraryIds = useMemo(() => new Set(library.map(l => l.content_id)), [library]);

  // Cloud library: API keys + enable flag come from the Nuvio profile settings
  // (features.debrid_settings), synced by useNuvioAuthStore.
  const cloudApiKeys = useMemo(
    () => cloudProviderApiKeysFromSettings(authStore.settings),
    [authStore.settings],
  );
  const cloudEnabled = useMemo(
    () => cloudLibraryEnabledFromSettings(authStore.settings),
    [authStore.settings],
  );
  const isLandscapePosters = !!authStore.homeCatalogSettings?.landscape_posters;
  const [resolvedWatchProgress, setResolvedWatchProgress] = useState<(NuvioWatchProgressSyncEntry & { poster?: string; name?: string; background?: string; episodeTitle?: string; episodeThumbnail?: string })[]>([]);
  const [rawWatchProgress, setRawWatchProgress] = useState<NuvioWatchProgressSyncEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const nuvioView = useNuvioView();
  const setNuvioView = useSetNuvioView();
  const nuvioActiveMeta = useNuvioActiveMeta();
  const setNuvioActiveMeta = useSetNuvioActiveMeta();
  const setNuvioPreselectVideoId = useSetNuvioPreselectVideoId();
  const nuvioActivePersonId = useNuvioActivePersonId();
  const setNuvioActivePersonId = useSetNuvioActivePersonId();
  const nuvioNavigate = useNuvioNavigate();
  const nuvioGoBack = useNuvioGoBack();
  const nuvioHistory = useUIStore((s) => s.nuvioHistory);
  const currentFrame = nuvioHistory[nuvioHistory.length - 1];
  const initialCatalogKey = (currentFrame && currentFrame.view === 'search') ? (currentFrame as any).catalogKey : null;
  const onCardMouseEnter = onCardMouseEnterProp || (() => {});
  const onCardMouseLeave = onCardMouseLeaveProp || (() => {});
  const onCardClick = onCardClickProp || (() => {});
  const [pinPromptProfile, setPinPromptProfile] = useState<any | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoginMode, setIsLoginMode] = useState(true);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    if (!loginEmail || !loginPassword) {
      setLoginError(t('pleaseFillAllFields'));
      return;
    }
    try {
      if (isLoginMode) {
        await authStore.login(loginEmail, loginPassword);
      } else {
        await authStore.signup(loginEmail, loginPassword);
      }
      setLoginEmail('');
      setLoginPassword('');
    } catch (err: any) {
      setLoginError(translateNativeError(err.message) || t('authFailed'));
    }
  };

  const [catalogFilter, setCatalogFilter] = useState('');
  const [nuvioSearchQuery, setNuvioSearchQuery] = useState('');
  const [editableCollections, setEditableCollections] = useState<NuvioCollection[]>([]);

  const tmdbApiKey = useSettingsStore((s) => s.tmdbApiKey);
  const streamingNuvioCatalogsEnabled = useSettingsStore((s) => s.streamingNuvioCatalogsEnabled);
  const enabledStreamingServices = useSettingsStore((s) => s.enabledStreamingServices);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const nuvioServiceScrollRef = useRef<HTMLDivElement>(null);
  const scrollNuvioServices = (dir: 'left' | 'right') => {
    const el = nuvioServiceScrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.75;
    el.scrollTo({ left: el.scrollLeft + (dir === 'left' ? -amount : amount), behavior: 'smooth' });
  };

  const nuvioCwScrollRef = useRef<HTMLDivElement>(null);
  const scrollContinueWatching = (dir: 'left' | 'right') => {
    const el = nuvioCwScrollRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.75;
    el.scrollTo({ left: el.scrollLeft + (dir === 'left' ? -amount : amount), behavior: 'smooth' });
  };

  const refreshToken = useTraktCatalogRefreshToken();
  interface TraktNuvioCatalogRow {
    key: string;
    type: 'trakt-catalog';
    title: string;
    items: StremioMetaPreview[];
    page: number;
    hasMore: boolean;
  }
  const [traktNuvioCatalogRows, setTraktNuvioCatalogRows] = useState<TraktNuvioCatalogRow[]>([]);
  const [traktNuvioCatalogsBeforeAddon, setTraktNuvioCatalogsBeforeAddon] = useState(false);

  // Helper to navigate to a top-level view and clear any detail overlay
  const navigateToView = (view: 'home' | 'library' | 'search' | 'collections' | 'addons' | 'scrapers' | 'settings') => {
    if (nuvioView === 'settings' && nuvioHasUnsavedHomeLayout) {
      showConfirm(
        'Unsaved Changes',
        "Changes aren't saved, would you like to save homepage layout?",
        async () => {
          try {
            await nuvioTabSaveFn?.();
            useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
            performNavigation(view);
          } catch (err) {
            // Error was already alerted inside child component
          }
        },
        () => {
          useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
          performNavigation(view);
        },
        'Save',
        'Discard Changes'
      );
    } else {
      performNavigation(view);
    }
  };

  const performNavigation = (view: 'home' | 'library' | 'search' | 'collections' | 'addons' | 'scrapers' | 'settings') => {
    setNuvioActiveMeta(null);
    setNuvioActivePersonId(null);
    setSelectedFolder(null);
    useUIStore.setState({ nuvioHistory: [{ view } as any] });
    setNuvioView(view);
  };

  // Scroll-to-top button state (debounced to avoid re-render thrashing on scroll)
  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollRAFRef = useRef<number>(0);
  const scrollToTop = useCallback(() => {
    const el = document.querySelector('.nuvio-main');
    if (el) {
      el.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  useEffect(() => {
    const el = document.querySelector('.nuvio-main');
    if (!el) return;

    setShowScrollTop(el.scrollTop > 400);

    const handleScroll = () => {
      if (scrollRAFRef.current) return;
      scrollRAFRef.current = requestAnimationFrame(() => {
        scrollRAFRef.current = 0;
        setShowScrollTop(el.scrollTop > 400);
      });
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (scrollRAFRef.current) cancelAnimationFrame(scrollRAFRef.current);
    };
  }, []);



  // Derive home catalog layout by sorting and filtering collections & addon rows from Nuvio homeCatalogSettings
  const homeRows = useMemo(() => {
    const collections = collectionStore.collections || [];
    const catalogRows: { key: string; type: 'catalog'; title: string; addon: InstalledAddon; catalog: any }[] = [];

    addons.forEach(addon => {
      addon.manifest?.catalogs?.forEach(catalog => {
        if (catalog.extra?.some(e => e.isRequired)) return;
        const key = `${addon.manifest.id || addon.id}:${catalog.type}:${catalog.id}`;
        catalogRows.push({
          key,
          type: 'catalog',
          title: getHomeCatalogDefaultTitle(catalog.name, catalog.type),
          addon,
          catalog
        });
      });
    });

    console.log('[NuvioPage:homeRows] Info:', {
      collectionsCount: collections.length,
      addonsCount: addons.length,
      addonsList: addons.map(a => ({ id: a.id, name: a.manifest?.name, catalogs: a.manifest?.catalogs?.map(c => c.id) })),
      catalogRowsCount: catalogRows.length,
      catalogRowsKeys: catalogRows.map(r => r.key),
      homeCatalogSettings: authStore.homeCatalogSettings,
    });

    // Default Fallback: If settings aren't fetched/configured, display collections and Cinemeta popular/featured catalogs
    if (!authStore.homeCatalogSettings || !authStore.homeCatalogSettings.items || authStore.homeCatalogSettings.items.length === 0) {
      const defaultRows: any[] = [];
      collections.forEach(coll => {
        defaultRows.push({
          type: 'collection',
          id: coll.id,
          key: `collection_${coll.id}`,
          title: coll.title,
          collection: coll
        });
      });

      catalogRows.forEach(row => {
        const isCinemeta = (row.addon.id || '').includes('cinemeta') || (row.addon.manifest?.id || '').includes('cinemeta');
        const isDefaultCatalog = row.catalog.id === 'top' || row.catalog.id === 'imdbRating';
        if (isCinemeta && isDefaultCatalog) {
          defaultRows.push(row);
        }
      });
      return defaultRows;
    }

    const settingsItems = authStore.homeCatalogSettings.items as Array<{
      key?: string;
      addon_id?: string;
      addonId?: string;
      type?: string;
      catalog_id?: string;
      catalogId?: string;
      is_collection?: boolean;
      isCollection?: boolean;
      collection_id?: string;
      collectionId?: string;
      custom_title?: string;
      customTitle?: string;
      enabled?: boolean;
      order?: number;
    }>;

    const collectionMap = new Map(collections.map(coll => [`collection_${coll.id}`, coll]));
    const catalogMap = new Map(catalogRows.map(row => [row.key, row]));
    const orderedRows: any[] = [];
    const mappedKeys = new Set<string>();

    const sortedSettings = [...settingsItems].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    sortedSettings.forEach(item => {
      const itemKey = item.key || (item.is_collection || item.isCollection
        ? `collection_${item.collection_id || item.collectionId}`
        : `${item.addon_id || item.addonId}:${item.type}:${item.catalog_id || item.catalogId}`);

      if (item.is_collection || item.isCollection || itemKey.startsWith('collection_')) {
        const collectionId = item.collection_id || item.collectionId || itemKey.replace('collection_', '');
        const coll = collectionMap.get(`collection_${collectionId}`);
        if (coll) {
          mappedKeys.add(itemKey);
          if (item.enabled !== false) {
            orderedRows.push({
              type: 'collection',
              id: coll.id,
              key: itemKey,
              title: item.custom_title?.trim() || item.customTitle?.trim() || coll.title,
              collection: coll
            });
          }
        }
      } else {
        const matchedRowIndex = catalogRows.findIndex(row => matchCatalogKey(itemKey, row));
        if (matchedRowIndex !== -1) {
          const row = catalogRows[matchedRowIndex];
          mappedKeys.add(row.key);
          if (item.enabled !== false) {
            orderedRows.push({
              ...row,
              title: item.custom_title?.trim() || item.customTitle?.trim() || row.title
            });
          }
          catalogRows.splice(matchedRowIndex, 1);
        }
      }
    });

    // Append newly added/unsynced collections
    collections.forEach(coll => {
      const key = `collection_${coll.id}`;
      if (!mappedKeys.has(key)) {
        orderedRows.push({
          type: 'collection',
          id: coll.id,
          key,
          title: coll.title,
          collection: coll
        });
      }
    });

    // Append newly installed/unsynced addon catalogs
    catalogRows.forEach(row => {
      orderedRows.push(row);
    });

    return orderedRows;
  }, [collectionStore.collections, addons, authStore.homeCatalogSettings]);

  // Derived: filter catalog rows by user-provided text
  const filteredRows = useMemo(() => {
    if (!catalogFilter.trim()) return homeRows;
    const lower = catalogFilter.toLowerCase().trim();
    return homeRows.filter((row: any) => {
      const name = row.title || '';
      return name.toLowerCase().includes(lower);
    });
  }, [homeRows, catalogFilter]);

  const filteredTraktRows = useMemo(() => {
    if (!catalogFilter.trim()) return traktNuvioCatalogRows;
    const lower = catalogFilter.toLowerCase().trim();
    return traktNuvioCatalogRows.filter(row => row.title.toLowerCase().includes(lower));
  }, [traktNuvioCatalogRows, catalogFilter]);

  // Scroll boundaries states for rails
  const [cwCanScrollLeft, setCwCanScrollLeft] = useState(false);
  const [cwCanScrollRight, setCwCanScrollRight] = useState(false);

  const [spCanScrollLeft, setSpCanScrollLeft] = useState(false);
  const [spCanScrollRight, setSpCanScrollRight] = useState(false);

  const collectionScrollRefs = useRef<Record<string, HTMLDivElement>>({});
  const [collectionScrollState, setCollectionScrollState] = useState<Record<string, { left: boolean; right: boolean }>>({});

  const updateCwScroll = useCallback(() => {
    const el = nuvioCwScrollRef.current;
    if (!el) return;
    setCwCanScrollLeft(el.scrollLeft > 0);
    setCwCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  const updateSpScroll = useCallback(() => {
    const el = nuvioServiceScrollRef.current;
    if (!el) return;
    setSpCanScrollLeft(el.scrollLeft > 0);
    setSpCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  const updateCollectionScroll = useCallback((key: string) => {
    const el = collectionScrollRefs.current[key];
    if (!el) return;
    const left = el.scrollLeft > 0;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setCollectionScrollState(prev => {
      if (prev[key]?.left === left && prev[key]?.right === right) return prev;
      return { ...prev, [key]: { left, right } };
    });
  }, []);

  const scrollCollection = (key: string, direction: 'left' | 'right') => {
    const el = collectionScrollRefs.current[key];
    if (el) {
      const scrollAmount = direction === 'left' ? -el.clientWidth * 0.75 : el.clientWidth * 0.75;
      el.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    const handleResize = () => {
      updateCwScroll();
      updateSpScroll();
      Object.keys(collectionScrollRefs.current).forEach(key => updateCollectionScroll(key));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateCwScroll, updateSpScroll, updateCollectionScroll]);

  useEffect(() => {
    const timer = setTimeout(() => {
      updateCwScroll();
    }, 150);
    return () => clearTimeout(timer);
  }, [resolvedWatchProgress, updateCwScroll]);

  useEffect(() => {
    const timer = setTimeout(() => {
      updateSpScroll();
    }, 150);
    return () => clearTimeout(timer);
  }, [enabledStreamingServices, updateSpScroll]);

  useEffect(() => {
    const timer = setTimeout(() => {
      Object.keys(collectionScrollRefs.current).forEach(key => updateCollectionScroll(key));
    }, 150);
    return () => clearTimeout(timer);
  }, [filteredRows, updateCollectionScroll]);

  // Profile selection dropdown state
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  // Folder detail modal state
  const selectedFolder = useNuvioSelectedFolder();
  const setSelectedFolder = useSetNuvioSelectedFolder();
  const selectedFolderCollectionTitle = useNuvioSelectedFolderCollectionTitle();
  const setSelectedFolderCollectionTitle = useSetNuvioSelectedFolderCollectionTitle();
  const [folderItems, setFolderItems] = useState<StremioMetaPreview[]>([]);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [loadingFolderItems, setLoadingFolderItems] = useState(false);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);

  // Pagination state for folder detail grid
  const [folderSkip, setFolderSkip] = useState(0);
  const [hasMoreFolderItems, setHasMoreFolderItems] = useState(true);
  const [loadingMoreFolderItems, setLoadingMoreFolderItems] = useState(false);
  const folderGridContainerRef = useRef<HTMLDivElement | null>(null);
  const folderSentinelRef = useRef<HTMLDivElement | null>(null);

  // Refs for observer closure safety
  const loadingMoreFolderRef = useRef(loadingMoreFolderItems);
  const hasMoreFolderRef = useRef(hasMoreFolderItems);
  const folderSkipRef = useRef(folderSkip);
  const selectedFolderRef = useRef(selectedFolder);
  const activeSourceIndexRef = useRef(activeSourceIndex);
  useEffect(() => { loadingMoreFolderRef.current = loadingMoreFolderItems; }, [loadingMoreFolderItems]);
  useEffect(() => { hasMoreFolderRef.current = hasMoreFolderItems; }, [hasMoreFolderItems]);
  useEffect(() => { folderSkipRef.current = folderSkip; }, [folderSkip]);
  useEffect(() => { selectedFolderRef.current = selectedFolder; }, [selectedFolder]);
  useEffect(() => { activeSourceIndexRef.current = activeSourceIndex; }, [activeSourceIndex]);

  // Scroll restoration refs
  const homeScrollPosRef = useRef<number>(0);
  const folderScrollPosRef = useRef<number>(0);

  // Add addon states
  const [addonUrl, setAddonUrl] = useState('');
  const [addonError, setAddonError] = useState<string | null>(null);
  const [installingAddon, setInstallingAddon] = useState(false);

  // Scrapers states
  const [repoUrl, setRepoUrl] = useState('');
  const [repoError, setRepoError] = useState<string | null>(null);
  const [installingRepo, setInstallingRepo] = useState(false);

  const token = authStore.token;
  const profile = authStore.activeProfile;

  // Sync editable collections with store
  useEffect(() => {
    if (collectionStore.collections) {
      setEditableCollections(JSON.parse(JSON.stringify(collectionStore.collections)));
    }
  }, [collectionStore.collections, nuvioView]);

  // Fetch profiles on mount/token change, reset library cache on profile switch
  useEffect(() => {
    if (token && authStore.profiles.length === 0) {
      authStore.fetchProfiles();
    }
    if (!token) {
      setLibrary([]);
      setLibraryLoaded(false);
      deltaCursorRef.current = 0;
    }
  }, [token, authStore.profiles.length]);

  useEffect(() => {
    setLibraryLoaded(false);
    deltaCursorRef.current = 0;
  }, [profile?.profile_index]);

  // Load library when switching to library view or opening details view
  useEffect(() => {
    if ((nuvioView === 'library' || !!nuvioActiveMeta) && token && profile && !libraryLoaded) {
      fetchNuvioLibrary(token, profile.profile_index, 500)
        .then((lib) => {
          setLibrary(lib || []);
          setLibraryLoaded(true);
        })
        .catch((e) => console.error('[NuvioPage] Failed to fetch library:', e));
    }
  }, [nuvioView, nuvioActiveMeta, token, profile?.profile_index, libraryLoaded]);

  useEffect(() => {
    const handleMouseBack = (e: MouseEvent) => {
      if (isMouseBackButtonActive(shortcuts, e.button)) {
        e.preventDefault();
        e.stopPropagation();

        if (pinPromptProfile) {
          setPinPromptProfile(null);
        } else if (nuvioActivePersonId) {
          nuvioGoBack();
        } else if (nuvioActiveMeta) {
          nuvioGoBack();
        } else if (selectedFolder) {
          handleBackFromFolder();
        } else if (selectedService) {
          setSelectedService(null);
        } else if (nuvioHistory.length > 1) {
          nuvioGoBack();
        } else if (nuvioView !== 'home') {
          setNuvioView('home');
        } else {
          onClose();
        }
      }
    };

    window.addEventListener('mousedown', handleMouseBack);
    return () => {
      window.removeEventListener('mousedown', handleMouseBack);
    };
  }, [
    shortcuts,
    pinPromptProfile,
    nuvioActivePersonId,
    nuvioActiveMeta,
    selectedFolder,
    selectedService,
    nuvioHistory,
    nuvioView,
    onClose,
    nuvioGoBack,
    setNuvioView,
  ]);



  // Click outside listener for profile menu
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(event.target as Node)) {
        setShowProfileMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // IntersectionObserver for folder detail infinite scroll
  useEffect(() => {
    const sentinel = folderSentinelRef.current;
    if (!sentinel || loadingFolderItems) return;
    const container = sentinel.closest('.nuvio-main');
    if (!container) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        if (loadingMoreFolderRef.current || !hasMoreFolderRef.current || !selectedFolderRef.current) return;
        loadFolderSourceItems(selectedFolderRef.current, activeSourceIndexRef.current, true);
      }
    }, { root: container, rootMargin: '600px' });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [folderItems, loadingFolderItems]);

  // Restore folder grid scroll position when returning from detail view
  useEffect(() => {
    if (!nuvioActiveMeta && selectedFolder) {
      const el = document.querySelector('.nuvio-main');
      if (el && folderScrollPosRef.current > 0) {
        const timer = setTimeout(() => {
          el.scrollTop = folderScrollPosRef.current;
        }, 50);
        return () => clearTimeout(timer);
      }
    }
  }, [nuvioActiveMeta, selectedFolder]);

  // Helper to resolve folder sources
  const getResolvedSources = (folder: NuvioCollectionFolder): NuvioCollectionSource[] => {
    if (folder.sources && folder.sources.length > 0) return folder.sources;
    if ((folder as any).catalogSources && (folder as any).catalogSources.length > 0) {
      return (folder as any).catalogSources.map((cs: any) => ({
        provider: 'addon',
        addonId: cs.addonId,
        type: cs.type,
        catalogId: cs.catalogId,
        genre: normalizeGenre(cs.genre),
      }));
    }
    return [];
  };

  const deltaCursorRef = useRef<number>(0);

  const applyWatchProgressDelta = (existing: NuvioWatchProgressSyncEntry[], events: NuvioWatchProgressDeltaEvent[]): NuvioWatchProgressSyncEntry[] => {
    const map = new Map(existing.map(e => [e.progress_key || e.video_id, e]));
    const deleteKeys = new Set<string>();

    for (const event of events) {
      const key = event.progress_key || event.video_id;
      if (event.operation === 'delete') {
        deleteKeys.add(key);
        map.delete(key);
      } else {
        deleteKeys.delete(key);
        map.set(key, {
          content_id: event.content_id,
          content_type: event.content_type,
          video_id: event.video_id,
          season: event.season,
          episode: event.episode,
          position: event.position,
          duration: event.duration,
          last_watched: event.last_watched,
          progress_key: event.progress_key,
        });
      }
    }

    return Array.from(map.values());
  };

  const lastDeltaPullTimeRef = useRef<number>(0);

  const loadWatchProgressDelta = async (profileId: number, existingEntries: NuvioWatchProgressSyncEntry[]): Promise<NuvioWatchProgressSyncEntry[]> => {
    if (Date.now() - lastDeltaPullTimeRef.current < 15000 && existingEntries.length > 0) {
      return existingEntries;
    }
    lastDeltaPullTimeRef.current = Date.now();
    const cursor = deltaCursorRef.current;
    const events = await fetchNuvioWatchProgressDelta(token!, profileId, cursor, 900);
    if (!events || events.length === 0) return existingEntries;

    const maxEventId = Math.max(...events.map(e => e.event_id));
    deltaCursorRef.current = maxEventId;

    return applyWatchProgressDelta(existingEntries, events);
  };

  const inFlightLoadSyncedDataRef = useRef<Promise<void> | null>(null);

  const loadSyncedData = async (background = false) => {
    if (!token || !profile) return;
    // Match NuvioDesktop: If library data is already loaded in memory state, serve from memory unless background/forced
    if (!background && libraryLoaded) {
      return;
    }
    if (inFlightLoadSyncedDataRef.current) {
      return inFlightLoadSyncedDataRef.current;
    }
    if (!background) setLoading(true);
    const task = (async () => {
      try {
        const libraryPromise = fetchNuvioLibrary(token, profile.profile_index, 500);

        // Try delta sync first, fall back to full pull
        let progressPromise: Promise<NuvioWatchProgressSyncEntry[]>;
        if (deltaCursorRef.current === 0) {
          // First load: try to initialize delta cursor
          progressPromise = (async () => {
            try {
              const cursor = await fetchNuvioWatchProgressDeltaCursor(token!, profile.profile_index);
              if (cursor > 0) {
                deltaCursorRef.current = 0;
                const entries = await loadWatchProgressDelta(profile.profile_index, []);
                return entries;
              }
            } catch {}
            // Fallback to full pull
            return fetchNuvioWatchProgress(token!, profile.profile_index, null, 100);
          })();
        } else {
          progressPromise = loadWatchProgressDelta(profile.profile_index, rawWatchProgress);
        }

        // Handle progress promise resolution as soon as it resolves
        progressPromise.then((progress) => {
          if (progress && progress.length > 0) {
            setRawWatchProgress(progress);
            setResolvedWatchProgress(progress.map(p => ({ ...p, name: `Content ID: ${p.content_id}` })));
            resolveProgressMetadata(progress);
          } else {
            setRawWatchProgress([]);
            setResolvedWatchProgress([]);
          }
        }).catch(e => console.error('[NuvioPage] Failed to fetch progress:', e));

        // Handle library promise resolution as soon as it resolves
        libraryPromise.then((lib) => {
          setLibrary(lib || []);
          setLibraryLoaded(true);
        }).catch(e => console.error('[NuvioPage] Failed to fetch library:', e));

        // Wait for both to complete to turn off loading state
        await Promise.allSettled([progressPromise, libraryPromise]);
      } catch (e) {
        console.error('[NuvioPage] Failed to fetch synced progress/addons:', e);
      } finally {
        if (!background) setLoading(false);
        inFlightLoadSyncedDataRef.current = null;
      }
    })();

    inFlightLoadSyncedDataRef.current = task;
    return task;
  };

  const resolveProgressMetadata = async (progressItems: NuvioWatchProgressSyncEntry[]) => {
    const activeAddons = useNuvioAddonStore.getState().enabledAddons;

    // Group progressItems by content_id (series or movie ID)
    const groups: Record<string, NuvioWatchProgressSyncEntry[]> = {};
    for (const item of progressItems) {
      if (!groups[item.content_id]) {
        groups[item.content_id] = [];
      }
      groups[item.content_id].push(item);
    }

    const resolvedItems = await Promise.all(
      Object.keys(groups).map(async (contentId) => {
        const items = groups[contentId];
        const first = items[0];
        const type = first.content_type === 'series' || first.content_type === 'show' || first.content_type === 'tv' ? 'series' : 'movie';

        if (type === 'movie') {
          // Find the latest in-progress entry for the movie
          const inProgress = items
            .filter(item => !(item.duration > 0 && (item.position / item.duration) >= 0.90))
            .sort((a, b) => b.last_watched - a.last_watched);
          if (inProgress.length > 0) {
            return inProgress[0];
          }
          return null; // All completed or no entries
        } else {
          // Series: Check if any in-progress records exist
          const inProgress = items
            .filter(item => !(item.duration > 0 && (item.position / item.duration) >= 0.90))
            .sort((a, b) => b.last_watched - a.last_watched);

          if (inProgress.length > 0) {
            // Keep only the latest in-progress entry (suppress any completed ones / "Up Next")
            return inProgress[0];
          }

          // No in-progress entries: find the latest completed episode
          const completed = items
            .filter(item => item.duration > 0 && (item.position / item.duration) >= 0.90)
            .sort((a, b) => b.last_watched - a.last_watched);

          if (completed.length > 0) {
            const latestCompleted = completed[0];
            return {
              ...latestCompleted,
              _generateNextEpisode: true, // Marker to generate next episode
            } as any;
          }
          return null;
        }
      })
    );

    const filteredCandidates = resolvedItems.filter((item): item is NonNullable<typeof item> => item !== null);

    const resolved = await Promise.all(
      filteredCandidates.map(async (entry) => {
        try {
          const type = entry.content_type === 'series' || entry.content_type === 'show' || entry.content_type === 'tv' ? 'series' : 'movie';
          const meta = await fetchMeta(activeAddons, type, entry.content_id);
          if (meta) {
            if ((entry as any)._generateNextEpisode && type === 'series') {
              // Find the next episode
              if (meta.videos && meta.videos.length > 0) {
                const sortedVideos = [...meta.videos].sort((a, b) => {
                  const aSeason = a.season ?? 0;
                  const bSeason = b.season ?? 0;
                  if (aSeason !== bSeason) return aSeason - bSeason;
                  return (a.episode ?? 0) - (b.episode ?? 0);
                });
                const currentIndex = sortedVideos.findIndex(
                  v => v.season === entry.season && v.episode === entry.episode
                );
                if (currentIndex !== -1 && currentIndex + 1 < sortedVideos.length) {
                  const nextVideo = sortedVideos[currentIndex + 1];
                  return {
                    ...entry,
                    video_id: nextVideo.id || `${entry.content_id}:${nextVideo.season ?? 0}:${nextVideo.episode ?? 0}`,
                    season: nextVideo.season ?? null,
                    episode: nextVideo.episode ?? null,
                    position: 0,
                    duration: 0,
                    poster: meta.poster,
                    background: meta.background,
                    name: meta.name,
                    episodeTitle: nextVideo.title,
                    episodeThumbnail: nextVideo.thumbnail || meta.background || meta.poster,
                    isUpNext: true,
                  };
                }
              }
              // If no next episode is found (last episode of series), filter it out
              return null;
            }

            let episodeTitle: string | undefined;
            let episodeThumbnail: string | undefined;
            if (entry.season != null && entry.episode != null && meta.videos) {
              const match = meta.videos.find(
                v => v.season === entry.season && v.episode === entry.episode
              );
              if (match) {
                episodeTitle = match.title;
                episodeThumbnail = match.thumbnail;
              }
            }
            return {
              ...entry,
              poster: meta.poster,
              background: meta.background,
              name: meta.name,
              episodeTitle,
              episodeThumbnail,
            };
          }
        } catch (e) {
          // Ignore
        }
        // Remove marker
        const { _generateNextEpisode, ...rest } = entry as any;
        return rest;
      })
    );
    const finalFiltered = resolved.filter((item): item is NonNullable<typeof item> => item !== null);

    // Sort final list by last_watched descending to keep Continue Watching in correct chronological order
    finalFiltered.sort((a, b) => b.last_watched - a.last_watched);

    setResolvedWatchProgress(finalFiltered as any);
  };

  useEffect(() => {
    loadSyncedData();
  }, [token, profile?.profile_index]);

  useEffect(() => {
    if (rawWatchProgress.length > 0) {
      resolveProgressMetadata(rawWatchProgress);
    }
  }, [rawWatchProgress, addons]);

  useEffect(() => {
    let active = true;
    const loadNuvioTraktCatalogs = async () => {
      // Trakt settings read from the store (single source of truth)
      const s = useSettingsStore.getState();
      if (!active) return;

      try {
        const rows: TraktNuvioCatalogRow[] = [];
        if (s.traktEnabled && s.traktAccessToken) {
          const enabledCatalogs: Record<string, boolean> = s.traktNuvioCatalogsEnabled || {};
          const enabledDefs = TRAKT_CATALOG_DEFINITIONS.filter(
            (def) => enabledCatalogs[def.type] === true
          );

          const results = await Promise.all(
            enabledDefs.map((def) =>
              scrobbler.fetchTraktCatalog(def.type, 1).then(({ items, hasMore }) => ({
                key: `trakt-${def.type}`,
                type: 'trakt-catalog' as const,
                title: `Trakt ${def.label}`,
                items,
                page: 1,
                hasMore,
              }))
            )
          );
          rows.push(...results.filter((r) => r.items.length > 0));

          // Load Trakt custom lists
          const enabledLists: { id: string; name: string }[] = s.traktNuvioEnabledLists || [];
          const listResults = await Promise.all(
            enabledLists.map((list) =>
              scrobbler.fetchTraktListCatalog(list.id, 1).then(({ items, hasMore }) => ({
                key: `trakt-list-${list.id}`,
                type: 'trakt-catalog' as const,
                title: `Trakt \u2014 ${list.name}`,
                items,
                page: 1,
                hasMore,
              }))
            )
          );
          rows.push(...listResults.filter((r) => r.items.length > 0));

          // Apply catalog order from settings
          const order = s.traktNuvioCatalogOrder || [];
          if (order.length > 0) {
            rows.sort((a, b) => {
              const keyA = a.key.replace('trakt-', '');
              const keyB = b.key.replace('trakt-', '');
              const iA = order.indexOf(keyA);
              const iB = order.indexOf(keyB);
              return (iA === -1 ? 999 : iA) - (iB === -1 ? 999 : iB);
            });
          }
        }

        if (active) {
          setTraktNuvioCatalogRows(rows);
          setTraktNuvioCatalogsBeforeAddon(s.traktNuvioCatalogsBeforeAddon ?? false);
        }
      } catch (e) {
        console.error('Failed to load Trakt Nuvio catalogs:', e);
      }
    };

    loadNuvioTraktCatalogs();
    return () => {
      active = false;
    };
  }, [refreshToken]);

  // TMDB/streaming-catalog settings come from the settings store (setters keep
  // them current — no IPC read or event listener needed).

  useEffect(() => {
    const syncHandler = () => {
      loadSyncedData(true);
    };
    window.addEventListener('ynotv:nuvio-sync-required', syncHandler);
    return () => window.removeEventListener('ynotv:nuvio-sync-required', syncHandler);
  }, [token, profile?.profile_index]);

  const handleAddToLibrary = async (item: { id: string; type: string; name: string; poster?: string | null; background?: string | null }) => {
    if (!token || !profile) return;

    let currentLibrary = library;
    if (!libraryLoaded) {
      try {
        const lib = await fetchNuvioLibrary(token, profile.profile_index, 500);
        currentLibrary = lib || [];
        setLibrary(currentLibrary);
        setLibraryLoaded(true);
      } catch (e) {
        console.error('[NuvioPage] Failed to fetch library before adding:', e);
        return;
      }
    }

    if (currentLibrary.some(x => x.content_id === item.id)) return;

    const libItem: NuvioLibrarySyncItem = {
      content_id: item.id,
      content_type: item.type === 'series' || item.type === 'show' || item.type === 'tv' ? 'series' : 'movie',
      name: item.name,
      poster: item.poster || null,
      poster_shape: 'POSTER',
      background: item.background || null,
      description: null,
      release_info: null,
      imdb_rating: null,
      genres: [],
      addon_base_url: null,
      added_at: Date.now(),
    };
    const updatedLibrary = [libItem, ...currentLibrary];
    try {
      await pushNuvioLibrary(token, profile.profile_index, updatedLibrary);
      setLibrary(updatedLibrary);
    } catch (e) {
      console.error('[NuvioPage] Failed to add to library:', e);
    }
  };

  const handleItemClick = (item: { content_id: string; content_type: string; name: string; poster: string | null; background?: string | null; video_id?: string | null }) => {
    const el = document.querySelector('.nuvio-main');
    if (el && selectedFolder) {
      folderScrollPosRef.current = el.scrollTop;
    }

    if ((item.content_type === 'series' || item.content_type === 'show' || item.content_type === 'tv') && item.video_id) {
      setNuvioPreselectVideoId(item.video_id);
    }
    nuvioNavigate({
      view: 'detail',
      meta: {
        id: item.content_id,
        type: item.content_type === 'series' || item.content_type === 'show' || item.content_type === 'tv' ? 'series' : 'movie',
        name: item.name,
        poster: item.poster,
        background: item.background ?? item.poster ?? null,
      },
    });
  };

  const handleNuvioPlay = (stream: StremioStream, meta: any, episodeVideo?: StremioVideo) => {
    window.dispatchEvent(new CustomEvent('ynotv:stremio-play', {
      detail: { 
        stream, 
        meta: meta, 
        episodeVideo, 
        isNuvio: true 
      },
    }));
  };

  // Cloud library playback: resolve a direct URL from the debrid provider,
  // then hand it to the normal Nuvio playback pipeline.
  const handleCloudPlay = useCallback(async (item: CloudLibraryItem, file: CloudLibraryFile) => {
    const keys = cloudProviderApiKeysFromSettings(useNuvioAuthStore.getState().settings);
    const apiKey = keys[item.providerId];
    if (!apiKey) return;
    try {
      const url = await useNuvioCloudStore.getState().resolvePlayback(apiKey, item, file);
      const meta = {
        id: `cloud:${item.providerId}:${item.type}:${item.id}`,
        type: 'movie' as const,
        name: item.name,
        poster: null,
        background: null,
      };
      window.dispatchEvent(new CustomEvent('ynotv:stremio-play', {
        detail: {
          stream: {
            url,
            name: file.name,
            title: file.name,
            addonName: item.providerName,
            behaviorHints: {
              filename: file.name,
              videoSize: file.sizeBytes ?? undefined,
            },
          },
          meta,
          episodeVideo: undefined,
          isNuvio: true,
        },
      }));
    } catch (e: any) {
      console.error('[NuvioCloud] Failed to play cloud file:', e);
      alert(e?.message || 'Failed to play cloud file.');
    }
  }, []);

  const handleNuvioNavigate = (newMeta: StremioMeta) => {
    if (newMeta.type === 'person') {
      const idNum = parseInt(newMeta.id.replace('tmdb:', ''), 10);
      if (!isNaN(idNum)) {
        nuvioNavigate({ view: 'person', personId: idNum });
      }
      return;
    }

    nuvioNavigate({
      view: 'detail',
      meta: {
        id: newMeta.id,
        type: newMeta.type,
        name: newMeta.name,
        poster: newMeta.poster ?? null,
        background: newMeta.background ?? newMeta.poster ?? null,
      },
    });
  };

  const handleOpenSettings = () => {
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'nuvio' } }));
  };

  // Helper to render watch progress percentage
  const getProgressPercent = (entry: NuvioWatchProgressSyncEntry) => {
    if (!entry.duration) return 0;
    return Math.min(100, Math.max(0, (entry.position / entry.duration) * 100));
  };

  const handleFolderClick = async (collectionTitle: string, folder: NuvioCollectionFolder) => {
    const el = document.querySelector('.nuvio-main');
    if (el) {
      homeScrollPosRef.current = el.scrollTop;
    }

    setSelectedFolder(folder);
    setSelectedFolderCollectionTitle(collectionTitle);
    setActiveSourceIndex(0);
    setFolderSkip(0);
    setHasMoreFolderItems(true);
    setLoadingMoreFolderItems(false);
    loadFolderSourceItems(folder, 0, false);
    
    if (el) {
      el.scrollTop = 0;
    }
    folderScrollPosRef.current = 0;
  };

  const handleBackFromFolder = () => {
    setSelectedFolder(null);
    setTimeout(() => {
      const el = document.querySelector('.nuvio-main');
      if (el) {
        el.scrollTop = homeScrollPosRef.current;
      }
    }, 0);
  };

  const loadFolderSourceItems = async (folder: NuvioCollectionFolder, sourceIndex: number, append = false) => {
    if (append) {
      if (loadingMoreFolderRef.current || !hasMoreFolderRef.current) return;
      loadingMoreFolderRef.current = true;
      setLoadingMoreFolderItems(true);
    } else {
      setLoadingFolderItems(true);
      setFolderItems([]);
      setFolderError(null);
      setFolderSkip(0);
      setHasMoreFolderItems(true);
    }
    try {
      const sources = getResolvedSources(folder);
      const source = sources[sourceIndex];
      
      if (!append) {
        console.log('[NuvioPage] loadFolderSourceItems - source:', JSON.parse(JSON.stringify(source)));
        console.log('[NuvioPage] enabledAddons:', useNuvioAddonStore.getState().enabledAddons.map(a => ({ id: a.id, manifestId: a.manifest?.id, baseUrl: a.baseUrl, catalogs: a.manifest?.catalogs })));
      }

      if (!source) {
        setFolderError(t('folderNoSource'));
      } else if (source.provider === 'tmdb' || source.provider === 'trakt') {
        setFolderError(t('unsupportedProvider', { provider: source.provider }));
      } else if (source.provider && source.provider !== 'addon') {
        setFolderError(i18n.t('nuvio:providerNotRecognized', { provider: source.provider }));
      } else {
        const activeAddons = useNuvioAddonStore.getState().enabledAddons;
        const catalogType = source.type === 'tv' ? 'series' : (source.type || 'movie');
        const catalogId = source.catalogId || 'top';

        const resolvedAddon = findAddonForSource(source, activeAddons);

        if (resolvedAddon) {
          const matchingAddonsForError = (source.addonId
            ? activeAddons.filter(a => fuzzyMatchAddon(source, a))
            : activeAddons.filter(a =>
                a.manifest?.catalogs?.some(
                  c => (c.type === catalogType || (c.type === 'tv' && catalogType === 'series')) &&
                       (c.id === catalogId || c.id === catalogId.split(',')[0])
                )
              )
          );
          const matchingCatalog = resolvedAddon.manifest?.catalogs?.find(
            c => (c.type === catalogType || (c.type === 'tv' && catalogType === 'series')) &&
                 (c.id === catalogId || c.id === catalogId.split(',')[0])
          );

          if (!matchingCatalog) {
            if (!append) {
              const availableCatalogs = (resolvedAddon.manifest?.catalogs || [])
                .filter(c => c.type === catalogType || (c.type === 'tv' && catalogType === 'series'))
                .map(c => `"${c.id}"`)
                .join(', ');
              setFolderError(
                i18n.t('nuvio:catalogNotFoundInAddon', {
                  catalogId,
                  addonName: resolvedAddon.manifest?.name || resolvedAddon.id,
                  matchingAddons: matchingAddonsForError.map(a => a.manifest?.name || a.id).join(', '),
                  availableCatalogs: availableCatalogs || 'none',
                })
              );
            }
          } else {
            const skip = append ? folderSkipRef.current : 0;
            const extra: Record<string, string> = {};
            const normalizedGenre = normalizeGenre(source.genre);
            if (normalizedGenre) extra.genre = normalizedGenre;
            if (skip > 0) extra.skip = String(skip);
            extra.limit = '100';

            const resp = await fetchCatalog(
              resolvedAddon.baseUrl,
              matchingCatalog.type,
              catalogId,
              extra
            );
            const metas = resp?.metas || [];
            if (append) {
              setFolderItems(prev => [...prev, ...metas]);
              setFolderSkip(skip + metas.length);
              if (metas.length === 0) setHasMoreFolderItems(false);
            } else {
              setFolderItems(metas);
              setFolderSkip(metas.length);
              if (metas.length === 0) setHasMoreFolderItems(false);
            }
          }
        } else {
          if (!append) {
            const missingId = source.addonId || source.catalogId || 'unknown';
            setFolderError(i18n.t('nuvio:addonNotFound', { missingId }));
          }
        }
      }
    } catch (e) {
      if (!append) {
        console.error('[NuvioPage] Failed to fetch folder items:', e);
        setFolderError(t('failedLoadCatalogItems'));
      }
    } finally {
      if (append) {
        loadingMoreFolderRef.current = false;
        setLoadingMoreFolderItems(false);
      } else {
        setLoadingFolderItems(false);
      }
    }
  };

  // Collections modification actions
  const handleSaveCollections = async (updated: NuvioCollection[]) => {
    try {
      await collectionStore.saveCollections(updated);
    } catch (e: any) {
      alert(translateNativeError(e.message) || i18n.t('nuvio:failedSaveCollections'));
    }
  };

  const handleCreateCollection = () => {
    const newColl: NuvioCollection = {
      id: Math.random().toString(36).substring(2, 9),
      title: 'New Collection',
      backdropImageUrl: null,
      pinToTop: false,
      viewMode: 'TABBED_GRID',
      showAllTab: true,
      folders: []
    };
    const updated = [...editableCollections, newColl];
    setEditableCollections(updated);
    handleSaveCollections(updated);
  };

  const handleDeleteCollection = (id: string) => {
    if (confirm(i18n.t('nuvio:confirmDeleteCollection'))) {
      const updated = editableCollections.filter(c => c.id !== id);
      setEditableCollections(updated);
      handleSaveCollections(updated);
    }
  };

  const handleUpdateCollectionTitle = (id: string, title: string) => {
    const updated = editableCollections.map(c => c.id === id ? { ...c, title } : c);
    setEditableCollections(updated);
  };

  const handleAddFolder = (collId: string) => {
    const newFolder: NuvioCollectionFolder = {
      id: Math.random().toString(36).substring(2, 9),
      title: 'New Folder',
      coverImageUrl: null,
      coverEmoji: '📁',
      focusGifEnabled: false,
      tileShape: 'poster',
      hideTitle: false,
      sources: []
    };
    const updated = editableCollections.map(c => {
      if (c.id === collId) {
        return { ...c, folders: [...c.folders, newFolder] };
      }
      return c;
    });
    setEditableCollections(updated);
    handleSaveCollections(updated);
  };

  const handleDeleteFolder = (collId: string, folderId: string) => {
    if (confirm(i18n.t('nuvio:confirmDeleteFolder'))) {
      const updated = editableCollections.map(c => {
        if (c.id === collId) {
          return { ...c, folders: c.folders.filter(f => f.id !== folderId) };
        }
        return c;
      });
      setEditableCollections(updated);
      handleSaveCollections(updated);
    }
  };

  const handleUpdateFolder = (collId: string, folderId: string, fields: Partial<NuvioCollectionFolder>) => {
    const updated = editableCollections.map(c => {
      if (c.id === collId) {
        return {
          ...c,
          folders: c.folders.map(f => f.id === folderId ? { ...f, ...fields } : f)
        };
      }
      return c;
    });
    setEditableCollections(updated);
  };

  const handleAddSource = (collId: string, folderId: string) => {
    const newSource: NuvioCollectionSource = {
      provider: 'addon',
      addonId: addons[0]?.id || 'community.cinemeta',
      type: 'movie',
      catalogId: 'top',
      genre: null
    };
    const updated = editableCollections.map(c => {
      if (c.id === collId) {
        return {
          ...c,
          folders: c.folders.map(f => {
            if (f.id === folderId) {
              return { ...f, sources: [...(f.sources || []), newSource] };
            }
            return f;
          })
        };
      }
      return c;
    });
    setEditableCollections(updated);
    handleSaveCollections(updated);
  };

  const handleDeleteSource = (collId: string, folderId: string, sourceIndex: number) => {
    const updated = editableCollections.map(c => {
      if (c.id === collId) {
        return {
          ...c,
          folders: c.folders.map(f => {
            if (f.id === folderId) {
              const src = [...(f.sources || [])];
              src.splice(sourceIndex, 1);
              return { ...f, sources: src };
            }
            return f;
          })
        };
      }
      return c;
    });
    setEditableCollections(updated);
    handleSaveCollections(updated);
  };

  const handleUpdateSource = (collId: string, folderId: string, sourceIndex: number, fields: Partial<NuvioCollectionSource>) => {
    const updated = editableCollections.map(c => {
      if (c.id === collId) {
        return {
          ...c,
          folders: c.folders.map(f => {
            if (f.id === folderId) {
              const src = [...(f.sources || [])];
              src[sourceIndex] = { ...src[sourceIndex], ...fields };
              return { ...f, sources: src };
            }
            return f;
          })
        };
      }
      return c;
    });
    setEditableCollections(updated);
  };

  // Addon management actions
  const handleAddAddon = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddonError(null);
    if (!addonUrl.trim()) return;
    if (!token || !profile) {
      setAddonError(t('loginProfileFirst'));
      return;
    }
    setInstallingAddon(true);
    try {
      await addonsStore.addAddon(token, profile.profile_index, addonUrl.trim());
      setAddonUrl('');
      alert(i18n.t('nuvio:addonInstalled'));
    } catch (err: any) {
      setAddonError(translateNativeError(err.message) || i18n.t('nuvio:failedInstallAddon'));
    } finally {
      setInstallingAddon(false);
    }
  };

  const handleToggleAddon = async (addonId: string) => {
    if (!token || !profile) return;
    try {
      await addonsStore.toggleAddon(token, profile.profile_index, addonId);
    } catch (err: any) {
      alert(translateNativeError(err.message) || i18n.t('nuvio:failedToggleAddon'));
    }
  };

  const handleRemoveAddon = async (addonId: string) => {
    if (!token || !profile) return;
    if (confirm(i18n.t('nuvio:confirmUninstallAddon'))) {
      try {
        await addonsStore.removeAddon(token, profile.profile_index, addonId);
      } catch (err: any) {
        alert(translateNativeError(err.message) || i18n.t('nuvio:failedRemoveAddon'));
      }
    }
  };

  // Scrapers management actions
  const handleAddRepository = async (e: React.FormEvent) => {
    e.preventDefault();
    setRepoError(null);
    if (!repoUrl.trim()) return;
    setInstallingRepo(true);
    try {
      await pluginStore.addRepository(repoUrl.trim());
      setRepoUrl('');
      alert(i18n.t('nuvio:repoInstalled'));
    } catch (err: any) {
      setRepoError(translateNativeError(err.message) || i18n.t('nuvio:failedAddRepository'));
    } finally {
      setInstallingRepo(false);
    }
  };

  return (
    <div className="nuvio-page" style={{ '--nuvio-poster-width': `${nuvioPosterSize}px` } as React.CSSProperties}>
      {/* Nuvio Dedicated Topbar */}
      <div className="nuvio-topbar">
        <div className="nuvio-topbar-left">
          <div className="nuvio-brand">
            <svg className="nuvio-brand-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="2" y="7" width="20" height="14" rx="3" />
              <path d="M17 2l-5 5-5-5" />
            </svg>
            <span className="nuvio-brand-name" style={{ background: 'linear-gradient(135deg, #00d4ff, #ff007f)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              Nuvio
            </span>
          </div>
          <PosterSizeSlider value={nuvioPosterSize} onChange={setNuvioPosterSize} />
        </div>

        {/* Centered Navigation Tabs */}
        {token && (
          <div className="nuvio-topbar-center">
            <button
              className={`nuvio-topbar-item ${nuvioView === 'home' ? 'active' : ''}`}
              onClick={() => navigateToView('home')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="nuvio-topbar-icon">
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
              </svg>
              <span>{t('home')}</span>
            </button>

            <button
              className={`nuvio-topbar-item ${nuvioView === 'library' ? 'active' : ''}`}
              onClick={() => navigateToView('library')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="nuvio-topbar-icon">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                <line x1="8" y1="7" x2="16" y2="7" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
              <span>{t('library')}</span>
            </button>

            <button
              className={`nuvio-topbar-item ${nuvioView === 'search' ? 'active' : ''}`}
              onClick={() => navigateToView('search')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="nuvio-topbar-icon">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <span>{t('discover')}</span>
            </button>

            {/* Collections tab hidden — code kept for future implementation
            <button
              className={`nuvio-topbar-item ${nuvioView === 'collections' ? 'active' : ''}`}
              onClick={() => setNuvioView('collections')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="nuvio-topbar-icon">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>{t('collections')}</span>
            </button>
            */}

            <button
              className={`nuvio-topbar-item ${nuvioView === 'addons' ? 'active' : ''}`}
              onClick={() => navigateToView('addons')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="nuvio-topbar-icon">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>{t('addons')}</span>
            </button>

            {/* Scrapers tab hidden — code kept for future implementation
            <button
              className={`nuvio-topbar-item ${nuvioView === 'scrapers' ? 'active' : ''}`}
              onClick={() => setNuvioView('scrapers')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="nuvio-topbar-icon">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              <span>{t('scrapers')}</span>
            </button>
            */}

            <button
              className={`nuvio-topbar-item ${nuvioView === 'settings' ? 'active' : ''}`}
              onClick={() => navigateToView('settings')}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="nuvio-topbar-icon">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>{t('settings')}</span>
            </button>
          </div>
        )}

        <div className="nuvio-topbar-right">
          {profile && (
            <>
              <div className="nuvio-topbar-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="nuvio-topbar-search-icon">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  type="text"
                  placeholder={t('quickSearch')}
                  value={nuvioSearchQuery}
                  onChange={(e) => {
                    setNuvioSearchQuery(e.target.value);
                    if (nuvioView !== 'search') {
                      navigateToView('search');
                    }
                  }}
                  className="nuvio-topbar-search-input"
                />
                {nuvioSearchQuery && (
                  <button
                    className="nuvio-topbar-search-clear"
                    onClick={() => setNuvioSearchQuery('')}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                )}
              </div>

              <div className="nuvio-profile-badge-wrapper" ref={profileMenuRef}>
              <div className="nuvio-profile-badge" onClick={() => setShowProfileMenu(!showProfileMenu)}>
                <div style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  backgroundColor: profile.avatar_color_hex || 'var(--accent-primary, #00d4ff)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 700,
                  fontSize: '0.55rem',
                  color: '#000'
                }}>
                  {profile.name.charAt(0).toUpperCase()}
                </div>
                <span>{profile.name}</span>
                <span className="nuvio-profile-chevron">{showProfileMenu ? '▲' : '▼'}</span>
              </div>
              {showProfileMenu && authStore.profiles.length > 0 && (
                <div className="nuvio-profile-dropdown">
                  <div className="nuvio-profile-dropdown-header">{t('switchProfile')}</div>
                  {authStore.profiles.map((p) => {
                    const isActive = p.profile_index === profile.profile_index;
                    return (
                      <div
                        key={p.profile_index}
                        className={`nuvio-profile-dropdown-item ${isActive ? 'active' : ''}`}
                        onClick={() => {
                          if (!isActive) {
                            if (p.pin_enabled) {
                              setPinPromptProfile(p);
                            } else {
                              authStore.selectProfile(p.profile_index);
                            }
                          }
                          setShowProfileMenu(false);
                        }}
                      >
                        <div style={{
                          width: '18px',
                          height: '18px',
                          borderRadius: '50%',
                          backgroundColor: p.avatar_color_hex || 'var(--accent-primary, #00d4ff)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          fontSize: '0.55rem',
                          color: '#000'
                        }}>
                          {p.name.charAt(0).toUpperCase()}
                        </div>
                        <span>{p.name}</span>
                        {isActive && <span className="nuvio-profile-dropdown-active-marker">✓</span>}
                      </div>
                    );
                  })}
                  <div className="nuvio-profile-dropdown-footer" onClick={() => { setShowProfileMenu(false); navigateToView('settings'); }}>
                    Manage Profiles...
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        </div>
      </div>

      {/* Main Content */}
      <div className={`nuvio-main ${nuvioView === 'home' ? 'nuvio-main-home' : ''} ${nuvioView === 'search' ? 'nuvio-main-search' : ''} ${nuvioActiveMeta ? 'nuvio-page-hide-content' : ''}`}>
        {!token ? (
          <div className="nuvio-login-container">
            <div className="nuvio-login-header">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary, #00d4ff)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: '12px' }}>
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <h3 className="nuvio-login-title">{t('nuvioSyncOffline')}</h3>
              <p className="nuvio-login-desc">
                {t('syncOfflineHint')}
              </p>
            </div>

            <div className="nuvio-login-card">
              <h4 className="nuvio-login-card-title">
                {isLoginMode ? t('signInToNuvio') : t('createNuvioAccount')}
              </h4>
              <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <input
                  type="email"
                  placeholder={t('emailAddress')}
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  className="nuvio-login-input"
                />
                <input
                  type="password"
                  placeholder={t('password')}
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  className="nuvio-login-input"
                />
                {loginError && (
                  <div style={{ color: '#ff4f4f', fontSize: '0.75rem' }}>{loginError}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                  <button
                    type="submit"
                    disabled={authStore.isSyncing}
                    style={{
                      background: 'linear-gradient(135deg, var(--accent-primary, #00d4ff), color-mix(in srgb, var(--accent-primary, #00d4ff) 70%, black))',
                      border: 'none',
                      color: '#000',
                      borderRadius: '6px',
                      padding: '10px 20px',
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      cursor: authStore.isSyncing ? 'not-allowed' : 'pointer',
                      opacity: authStore.isSyncing ? 0.7 : 1
                    }}
                  >
                    {authStore.isSyncing ? 'Authenticating...' : isLoginMode ? 'Login' : 'Sign Up'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsLoginMode(!isLoginMode)}
                    className="nuvio-login-toggle-btn"
                  >
                    {isLoginMode ? t('needAccountRegister') : t('haveAccountLogin')}
                  </button>
                </div>
              </form>
            </div>

            <p className="nuvio-login-disclaimer">
              Disclaimer: ynoTV is an independent open source desktop client and is not affiliated with or endorsed by Nuvio. Your login credentials are only used to connect to Nuvio's servers directly to sync &mdash; ynoTV never stores or transmits them.
            </p>

            <div style={{ textAlign: 'center', marginTop: '4px' }}>
              <button
                onClick={handleOpenSettings}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'rgba(255,255,255,0.4)',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  textDecoration: 'underline'
                }}
              >
                Advanced settings &rarr;
              </button>
            </div>
          </div>
        ) : !profile && authStore.profiles.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 20px', minHeight: '400px' }}>
            <h2 style={{ color: '#fff', fontSize: '1.3rem', fontWeight: 700, margin: '0 0 8px 0' }}>{t('selectProfile')}</h2>
            <p style={{ margin: '0 0 36px 0', fontSize: '0.82rem', color: 'rgba(255,255,255,0.4)' }}>
              {t('chooseProfileHint')}
            </p>
            <div style={{ display: 'flex', gap: '28px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {authStore.profiles.map((p) => (
                <div
                  key={p.profile_index}
                  onClick={() => {
                    if (p.pin_enabled) {
                      setPinPromptProfile(p);
                    } else {
                      authStore.selectProfile(p.profile_index);
                    }
                  }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '10px',
                    cursor: 'pointer',
                    transition: 'transform 0.2s ease',
                    padding: '16px',
                    borderRadius: '12px',
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    minWidth: '100px',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-4px)'; (e.currentTarget as HTMLElement).style.borderColor = 'rgba(0,212,255,0.3)'; (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = ''; (e.currentTarget as HTMLElement).style.borderColor = ''; (e.currentTarget as HTMLElement).style.background = ''; }}
                >
                  <div style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '50%',
                    backgroundColor: p.avatar_color_hex || 'var(--accent-primary, #00d4ff)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 700,
                    fontSize: '1.3rem',
                    color: '#000',
                    position: 'relative',
                  }}>
                    {p.name.charAt(0).toUpperCase()}
                    {p.pin_enabled && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{
                        position: 'absolute', bottom: '-2px', right: '-2px', width: '18px', height: '18px',
                        background: 'rgba(0,0,0,0.7)', borderRadius: '50%', padding: '2px', color: '#ffc800'
                      }}>
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    )}
                  </div>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#fff' }}>{p.name}</span>
                  {p.pin_enabled && (
                    <span style={{ fontSize: '0.72rem', color: 'rgba(255,200,0,0.6)', fontWeight: 500 }}>{i18n.t('nuvio:pinRequired')}</span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: '36px', fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)' }}>
              {t('manageProfilesIn')} <span onClick={() => navigateToView('settings')} style={{ color: 'var(--accent-primary, #00d4ff)', cursor: 'pointer', textDecoration: 'underline' }}>{t('settings')}</span>
            </div>
          </div>
        ) : loading && resolvedWatchProgress.length === 0 && library.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'rgba(255,255,255,0.4)', gap: '10px' }}>
            <div className="spinner" style={{ width: '28px', height: '28px', borderRadius: '50%', border: '3px solid color-mix(in srgb, var(--accent-primary, #00d4ff) 10%, transparent)', borderTopColor: 'var(--accent-primary, #00d4ff)', animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: '0.82rem' }}>{t('loadingSyncedData')}</span>
          </div>
        ) : (
          <div>
            {nuvioView === 'home' && (
              selectedFolder ? (
                <div className="nuvio-folder-detail-page-container">
                  {/* Hero Banner with backdrop image */}
                  <div className="nuvio-folder-detail-banner">
                    {/* Backdrop Image */}
                    {(() => {
                      const backdropImg = selectedFolder.heroBackdropUrl || selectedFolder.coverImageUrl || null;
                      if (backdropImg) {
                        return <LazyImage rootMargin="200px" src={backdropImg} alt={selectedFolder.title} className="nuvio-folder-detail-banner-img" />;
                      }
                      return <div className="nuvio-folder-detail-banner-fallback" />;
                    })()}
                    <div className="nuvio-folder-detail-banner-gradient" />
                    
                    {/* Floating Back Button */}
                    <button className="nuvio-folder-detail-back-btn" onClick={handleBackFromFolder}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="19" y1="12" x2="5" y2="12" />
                        <polyline points="12 19 5 12 12 5" />
                      </svg>
                      <span>{t('back')}</span>
                    </button>

                    {/* Metadata overlay */}
                    <div className="nuvio-folder-detail-banner-meta">
                      <div className="nuvio-folder-detail-coll-title">{selectedFolderCollectionTitle}</div>
                      <h2 className="nuvio-folder-detail-title">{selectedFolder.title}</h2>
                    </div>
                  </div>

                  {/* Sources Tabs if there are multiple sources */}
                  {getResolvedSources(selectedFolder).length > 1 && (
                    <div className="nuvio-folder-detail-tabs">
                      {getResolvedSources(selectedFolder).map((source, idx) => (
                        <button
                          key={idx}
                          className={`nuvio-folder-detail-tab-btn ${activeSourceIndex === idx ? 'active' : ''}`}
                          onClick={() => {
                            setActiveSourceIndex(idx);
                            setFolderSkip(0);
                            setHasMoreFolderItems(true);
                            setLoadingMoreFolderItems(false);
                            loadFolderSourceItems(selectedFolder, idx, false);
                          }}
                        >
                          {getSourceLabel(source, idx, addons)}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Grid Container */}
                  <div className="nuvio-folder-detail-grid-wrapper">
                    {loadingFolderItems ? (
                      <div className="nuvio-folder-detail-loading">
                        <div className="spinner" style={{ width: '28px', height: '28px', borderRadius: '50%', border: '3px solid color-mix(in srgb, var(--accent-primary, #00d4ff) 10%, transparent)', borderTopColor: 'var(--accent-primary, #00d4ff)', animation: 'spin 1s linear infinite' }} />
                        <span>{t('loadingCatalogItems')}</span>
                      </div>
                    ) : folderError ? (
                      <div className="nuvio-folder-detail-empty" style={{ flexDirection: 'column', gap: '12px', padding: '40px 24px' }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="#ff9900" strokeWidth="1.5" width="36" height="36">
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                          <line x1="12" y1="9" x2="12" y2="13"/>
                          <line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                        <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.85rem', textAlign: 'center', maxWidth: '360px', lineHeight: 1.5 }}>{folderError}</span>
                      </div>
                    ) : folderItems.length > 0 ? (
                      <>
                        <div className="nuvio-folder-detail-grid">
                          {folderItems.map((item, idx) => (
                            <div
                              key={`${item.id}-${idx}`}
                              className="nuvio-folder-detail-item"
                              onMouseEnter={(e) => onCardMouseEnter(item, e.currentTarget, e)}
                              onMouseLeave={onCardMouseLeave}
                              onClick={() => {
                                onCardClick();
                                handleItemClick({ content_id: item.id, content_type: item.type, name: item.name, poster: item.poster ?? null });
                              }}
                            >
                              <div className="nuvio-folder-detail-poster-wrapper">
                                {item.poster ? (
                                  <LazyImage src={item.poster} alt={item.name} className="nuvio-folder-detail-poster" fetchPriority="low" />
                                ) : (
                                  <div className="nuvio-folder-detail-poster-placeholder">{item.name}</div>
                                )}
                              </div>
                              <div className="nuvio-folder-detail-item-title">{item.name}</div>
                            </div>
                          ))}
                        </div>
                        {/* Sentinel for infinite scroll */}
                        {hasMoreFolderItems && (
                          <div ref={folderSentinelRef} style={{ height: '1px' }} />
                        )}
                        {loadingMoreFolderItems && (
                          <div className="nuvio-folder-detail-loading" style={{ padding: '20px 0' }}>
                            <div className="spinner" style={{ width: '20px', height: '20px', borderRadius: '50%', border: '2px solid color-mix(in srgb, var(--accent-primary, #00d4ff) 10%, transparent)', borderTopColor: 'var(--accent-primary, #00d4ff)', animation: 'spin 1s linear infinite' }} />
                            <span style={{ fontSize: '0.78rem' }}>{t('loadingMore')}</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="nuvio-folder-detail-empty">{t('noItemsInCatalogSource')}</div>
                    )}
                  </div>
                </div>
              ) : selectedService ? (
                <div style={{ padding: '0 24px 24px 24px' }}>
                  <StreamingServiceView
                    service={selectedService}
                    onBack={() => setSelectedService(null)}
                    onItemClick={(item) => handleItemClick({ content_id: item.id, content_type: item.type, name: item.name, poster: item.poster ?? null })}
                    addons={addons}
                  />
                </div>
              ) : (
                <div>
                  {/* Catalog Filter Bar */}
                  {(homeRows.some((r: any) => r.type === 'catalog') || homeRows.some((r: any) => r.type === 'collection')) && (
                    <div className="nuvio-catalog-filter">
                      <svg className="nuvio-catalog-filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8" />
                        <path d="m21 21-4.3-4.3" />
                      </svg>
                      <input
                        className="nuvio-catalog-filter-input"
                        type="text"
                        placeholder={t('filterCatalogs')}
                        value={catalogFilter}
                        onChange={(e) => setCatalogFilter(e.target.value)}
                      />
                      {catalogFilter && (
                        <button className="nuvio-catalog-filter-clear" onClick={() => setCatalogFilter('')}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}

                  {/* Hero banner — fed from selected catalogs in settings */}
                  <div className="nuvio-home-section nuvio-home-section-hero" style={{ marginBottom: '24px' }}>
                    <NuvioHeroBanner
                      libraryIds={libraryIds}
                      onItemClick={(item) => handleItemClick({ content_id: item.id, content_type: item.type, name: item.name, poster: item.poster ?? null })}
                      onAddToLibrary={handleAddToLibrary}
                    />
                  </div>

                  {/* Continue Watching (Watch Progress) — 3 styles configurable from Settings */}
                  {resolvedWatchProgress.length > 0 && (
                    <div className="nuvio-row nuvio-home-section nuvio-home-section-cw">
                      <div className="nuvio-row-header">
                        <h3 className="nuvio-row-title">{t('continueWatching')}</h3>
                        <div className="stremio-row-nav">
                          <button
                            className="stremio-row-nav-btn"
                            onClick={() => scrollContinueWatching('left')}
                            aria-label={t('scrollLeft')}
                            disabled={!cwCanScrollLeft}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                          </button>
                          <button
                            className="stremio-row-nav-btn"
                            onClick={() => scrollContinueWatching('right')}
                            aria-label={t('scrollRight')}
                            disabled={!cwCanScrollRight}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                          </button>
                        </div>
                      </div>
                      <div
                        className="nuvio-scroll-rail"
                        ref={(el) => {
                          (nuvioCwScrollRef as any).current = el;
                          if (el) {
                            setTimeout(() => {
                              updateCwScroll();
                            }, 150);
                          }
                        }}
                        onScroll={updateCwScroll}
                      >
                        {(() => {
                          const cwStyle = localStorage.getItem('nuvio_cw_style') || 'card';
                          if (cwStyle === 'wide') {
                            return resolvedWatchProgress.map((entry) => {
                              const progressPct = getProgressPercent(entry);
                              const progressInt = Math.round(progressPct);
                              const imgUrl = entry.poster || entry.background;
                              const isEpisode = entry.season !== null && entry.episode !== null;
                              const isUpNext = (entry as any).isUpNext;
                              const subtitle = isUpNext
                                ? `Up Next • ${entry.episodeTitle || ''}`
                                : (isEpisode ? entry.episodeTitle || '' : (entry.content_type === 'movie' ? 'Movie' : entry.content_type));
                              return (
                                <div
                                  key={entry.progress_key}
                                  className="nuvio-cw-wide-card"
                                  onClick={() => handleItemClick({ content_id: entry.content_id, content_type: entry.content_type, name: entry.name || entry.progress_key, poster: entry.poster || null, video_id: entry.video_id })}
                                >
                                  {imgUrl ? (
                                    <LazyImage src={imgUrl} alt={entry.name} className="nuvio-cw-wide-poster" fetchPriority="low" />
                                  ) : (
                                    <div className="nuvio-cw-wide-poster" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)' }}>{entry.name?.[0]}</div>
                                  )}
                                  <div className="nuvio-cw-wide-body">
                                    <div className="nuvio-cw-wide-title">{entry.name || entry.content_id}</div>
                                    {isEpisode && <div className="nuvio-cw-wide-ep">S{entry.season}:E{entry.episode}</div>}
                                    <div className="nuvio-cw-wide-meta">{subtitle}</div>
                                    <div className="nuvio-cw-wide-progress-track">
                                      <div className="nuvio-cw-wide-progress-fill" style={{ width: `${progressPct}%` }} />
                                    </div>
                                  </div>
                                  <div className="nuvio-cw-wide-pct-badge">{progressInt}%</div>
                                </div>
                              );
                            });
                          }
                          if (cwStyle === 'poster') {
                            return resolvedWatchProgress.map((entry) => {
                              const progressPct = getProgressPercent(entry);
                              const imgUrl = entry.poster;
                              const isUpNext = (entry as any).isUpNext;
                              const remainingMs = entry.duration - entry.position;
                              const remainingMin = Math.max(1, Math.round(remainingMs / 60000));
                              const badgeText = isUpNext
                                ? 'Up Next'
                                : (progressPct > 0
                                  ? (remainingMin >= 60
                                    ? `${Math.floor(remainingMin / 60)}h ${remainingMin % 60}m`
                                    : `${remainingMin}m`)
                                  : '');
                              return (
                                <div
                                  key={entry.progress_key}
                                  className="nuvio-cw-poster-card"
                                  onClick={() => handleItemClick({ content_id: entry.content_id, content_type: entry.content_type, name: entry.name || entry.progress_key, poster: entry.poster || null, video_id: entry.video_id })}
                                >
                                  {imgUrl ? (
                                    <LazyImage src={imgUrl} alt={entry.name} className="nuvio-cw-poster-img" fetchPriority="low" />
                                  ) : (
                                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', padding: '12px', boxSizing: 'border-box', textAlign: 'center' }}>{entry.name}</div>
                                  )}
                                  {entry.season !== null && entry.episode !== null && (
                                    <div className="nuvio-cw-poster-badge">S{entry.season}:E{entry.episode}</div>
                                  )}
                                  <div className="nuvio-cw-poster-progress-pill">
                                    <div className="nuvio-cw-poster-progress-track">
                                      <div className="nuvio-cw-poster-progress-fill" style={{ width: `${progressPct}%` }} />
                                    </div>
                                    {badgeText && <span className="nuvio-cw-poster-pct">{badgeText}</span>}
                                  </div>
                                  <div className="nuvio-cw-poster-title">{entry.name || entry.content_id}</div>
                                </div>
                              );
                            });
                          }
                          // Default: Card style (landscape with gradient overlay)
                          return resolvedWatchProgress.map((entry) => {
                            const progressPct = getProgressPercent(entry);
                            const remainingMs = entry.duration - entry.position;
                            const remainingMin = Math.max(1, Math.round(remainingMs / 60000));
                            const isUpNext = (entry as any).isUpNext;
                            const badgeText = isUpNext
                              ? 'Up Next'
                              : (progressPct > 0
                                ? (remainingMin >= 60
                                  ? `${Math.floor(remainingMin / 60)}h ${remainingMin % 60}m left`
                                  : `${remainingMin}m left`)
                                : '');
                            const cardImg = entry.episodeThumbnail || entry.background || entry.poster;
                            const isEpisode = entry.season !== null && entry.episode !== null;
                            const subtitle = isEpisode
                              ? entry.episodeTitle || ''
                              : entry.content_type === 'movie' ? 'Movie' : entry.content_type;
                            return (
                              <div
                                key={entry.progress_key}
                                className="nuvio-cw-card"
                                onClick={() => handleItemClick({ content_id: entry.content_id, content_type: entry.content_type, name: entry.name || entry.progress_key, poster: entry.poster || null, video_id: entry.video_id })}
                              >
                                {cardImg ? (
                                  <LazyImage src={cardImg} alt={entry.name} className="nuvio-cw-card-img" fetchPriority="low" />
                                ) : (
                                  <div style={{ width: '100%', height: '100%', background: 'rgba(255,255,255,0.03)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px', boxSizing: 'border-box', fontSize: '0.85rem', fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>
                                    {entry.name || entry.content_id}
                                  </div>
                                )}
                                {isEpisode && (
                                  <div className="nuvio-cw-card-ep-top">S{entry.season}:E{entry.episode}</div>
                                )}
                                <div className="nuvio-cw-card-gradient" />
                                <div className="nuvio-cw-card-body">
                                  <div className="nuvio-cw-card-title">{entry.name || entry.content_id}</div>
                                  {subtitle && <div className="nuvio-cw-card-meta">{subtitle}</div>}
                                </div>
                                {badgeText && (
                                  <div className="nuvio-cw-card-badge">{badgeText}</div>
                                )}
                                <div className="nuvio-cw-progress-track">
                                  <div className="nuvio-cw-progress-fill" style={{ width: `${progressPct}%` }} />
                                </div>
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  )}

                  {tmdbApiKey && streamingNuvioCatalogsEnabled && enabledStreamingServices.length > 0 && (
                    <div className="nuvio-row nuvio-home-section nuvio-home-section-sp" style={{ marginBottom: '24px', position: 'relative' }}>
                      <div className="nuvio-row-header">
                        <h3 className="nuvio-row-title">{t('streamingPlatforms')}</h3>
                        <div className="stremio-row-nav">
                          <button
                            className="stremio-row-nav-btn"
                            onClick={() => scrollNuvioServices('left')}
                            aria-label={t('scrollLeft')}
                            disabled={!spCanScrollLeft}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                          </button>
                          <button
                            className="stremio-row-nav-btn"
                            onClick={() => scrollNuvioServices('right')}
                            aria-label={t('scrollRight')}
                            disabled={!spCanScrollRight}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                          </button>
                        </div>
                      </div>
                      <div
                        className="nuvio-service-rail-scroll"
                        ref={(el) => {
                          (nuvioServiceScrollRef as any).current = el;
                          if (el) {
                            setTimeout(() => {
                              updateSpScroll();
                            }, 150);
                          }
                        }}
                        onScroll={updateSpScroll}
                      >
                        <div className="nuvio-service-rail-track">
                          {Object.keys(SERVICES)
                            .filter((svcKey) => enabledStreamingServices.includes(svcKey))
                            .map((svcKey) => {
                              const svc = SERVICES[svcKey as StreamingService];
                              return (
                                <button
                                  key={svcKey}
                                  className="nuvio-service-tile-btn"
                                  onClick={() => setSelectedService(svcKey)}
                                >
                                  <img
                                    src={svc.logo}
                                    alt={svc.name}
                                    style={{
                                      height: svc.logoHeightHome ? `${svc.logoHeightHome}px` : '24px',
                                      width: 'auto',
                                      filter: svc.logoFilter || 'none',
                                    }}
                                  />
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Unified Home Rows (Collections and Catalogs sorted/filtered) */}
                  {filteredRows.length === 0 && filteredTraktRows.length === 0 ? (
                    <div className="nuvio-catalog-filter-empty">
                      {catalogFilter.trim()
                        ? t('noCatalogsMatch')
                        : t('noCatalogsAvailable')}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                      {traktNuvioCatalogsBeforeAddon && filteredTraktRows.map((row) => (
                        <div className="nuvio-home-section" key={row.key}>
                        <StremioCatalogRow
                          title={row.title}
                          items={row.items}
                          landscape={isLandscapePosters}
                          onItemClick={(item) => handleItemClick({ content_id: item.id, content_type: item.type, name: item.name, poster: item.poster ?? null })}
                        />
                        </div>
                      ))}

                      {filteredRows.map((row: any) => {
                        if (row.type === 'collection') {
                          const coll = row.collection;
                          return (
                            <div key={row.key} className="nuvio-row nuvio-home-section">
                              <div className="nuvio-row-header">
                                <h3 className="nuvio-row-title">{row.title}</h3>
                                <div className="stremio-row-nav">
                                  <button
                                    className="stremio-row-nav-btn"
                                    onClick={() => scrollCollection(row.key, 'left')}
                                    aria-label={t('scrollLeft')}
                                    disabled={!collectionScrollState[row.key]?.left}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
                                  </button>
                                  <button
                                    className="stremio-row-nav-btn"
                                    onClick={() => scrollCollection(row.key, 'right')}
                                    aria-label={t('scrollRight')}
                                    disabled={!collectionScrollState[row.key]?.right}
                                  >
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
                                  </button>
                                </div>
                              </div>
                              <div
                                className="nuvio-scroll-rail"
                                ref={(el) => {
                                  if (el) {
                                    collectionScrollRefs.current[row.key] = el;
                                    setTimeout(() => {
                                      updateCollectionScroll(row.key);
                                    }, 150);
                                  } else {
                                    delete collectionScrollRefs.current[row.key];
                                  }
                                }}
                                onScroll={() => updateCollectionScroll(row.key)}
                              >
                                {coll.folders.map((folder: any) => {
                                  const tileShape = getFolderShapeClass(folder.tileShape);
                                  const folderImgUrl = (folder.focusGifEnabled && folder.focusGifUrl) || folder.coverImageUrl;
                                  return (
                                    <div
                                      key={folder.id}
                                      className={`nuvio-folder-card nuvio-folder-card-${tileShape}`}
                                      onClick={() => handleFolderClick(row.title, folder)}
                                    >
                                      <div className="nuvio-folder-card-inner">
                                        {folderImgUrl ? (
                                          <LazyImage src={folderImgUrl} alt={folder.title} className="nuvio-folder-card-img" fetchPriority="low" />
                                        ) : folder.coverEmoji ? (
                                          <div className="nuvio-folder-card-emoji">{folder.coverEmoji}</div>
                                        ) : (
                                          <div className="nuvio-folder-card-abbrev">
                                            {folder.title.slice(0, 2).toUpperCase()}
                                          </div>
                                        )}
                                        {!folder.hideTitle && (
                                          <div className="nuvio-folder-card-overlay-title">
                                            {folder.title}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        } else {
                          // row.type === 'catalog'
                          return (
                            <div className="nuvio-home-section" key={row.key}>
                            <StremioCatalogRow
                              title={row.title}
                              addon={row.addon}
                              catalog={row.catalog}
                              landscape={isLandscapePosters}
                              onItemClick={(item) => handleItemClick({ content_id: item.id, content_type: item.type, name: item.name, poster: item.poster ?? null })}
                              onSeeAll={() => {
                                nuvioNavigate({ view: 'search', catalogKey: row.key } as any);
                              }}
                            />
                            </div>
                          );
                        }
                      })}

                      {!traktNuvioCatalogsBeforeAddon && filteredTraktRows.map((row) => (
                        <div className="nuvio-home-section" key={row.key}>
                        <StremioCatalogRow
                          title={row.title}
                          items={row.items}
                          landscape={isLandscapePosters}
                          onItemClick={(item) => handleItemClick({ content_id: item.id, content_type: item.type, name: item.name, poster: item.poster ?? null })}
                        />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            )}

            {nuvioView === 'library' && (
              <div>
                {/* Library / Cloud view switcher */}
                <div className="nuvio-library-view-tabs">
                  <button
                    className={`nuvio-library-view-tab ${libraryViewTab === 'library' ? 'active' : ''}`}
                    onClick={() => setLibraryViewTab('library')}
                  >
                    {t('library')}
                  </button>
                  <button
                    className={`nuvio-library-view-tab ${libraryViewTab === 'cloud' ? 'active' : ''}`}
                    onClick={() => setLibraryViewTab('cloud')}
                  >
                    Cloud
                  </button>
                </div>

                {libraryViewTab === 'cloud' ? (
                  <NuvioCloudLibrary
                    apiKeys={cloudApiKeys}
                    enabled={cloudEnabled}
                    onPlay={handleCloudPlay}
                    onConnectCloudClick={handleOpenSettings}
                  />
                ) : (
                  /* Sync Library */
                  <div className="nuvio-row">
                    <div className="nuvio-row-header">
                      <h3 className="nuvio-row-title">{t('library')}</h3>
                    </div>
                    {library.length > 0 ? (
                      <div className="nuvio-library-grid">
                        {library.map((item) => {
                          const previewItem = {
                            id: item.content_id,
                            type: item.content_type,
                            name: item.name,
                            poster: item.poster || undefined,
                            background: item.background || undefined,
                            description: item.description || undefined,
                            releaseInfo: item.release_info || undefined,
                            imdbRating: item.imdb_rating ? String(item.imdb_rating) : undefined,
                            genres: item.genres,
                          };
                          return (
                            <div
                              key={item.content_id}
                              className="nuvio-card"
                              onMouseEnter={(e) => onCardMouseEnter(previewItem, e.currentTarget, e)}
                              onMouseLeave={onCardMouseLeave}
                              onClick={() => {
                                onCardClick();
                                handleItemClick(item);
                              }}
                            >
                              {item.poster ? (
                                <LazyImage src={item.poster} alt={item.name} className="nuvio-card-img" fetchPriority="low" />
                              ) : (
                                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.02)', color: 'rgba(255,255,255,0.3)', padding: '12px', boxSizing: 'border-box', textAlign: 'center', fontSize: '0.75rem' }}>
                                  {item.name}
                                </div>
                              )}
                              <div className="nuvio-card-info">
                                <div className="nuvio-card-title">{item.name}</div>
                                <div className="nuvio-card-sub">{item.release_info} · {item.content_type}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="nuvio-empty-state">
                        No items in library. Star movies or shows to see them here.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {nuvioView === 'search' && (
              <NuvioSearchPage
                addons={addons}
                onItemClick={(item) => handleItemClick(item)}
                initialCatalogKey={initialCatalogKey}
                onBack={() => nuvioGoBack()}
                query={nuvioSearchQuery}
                onQueryChange={setNuvioSearchQuery}
              />
            )}

            {/* Collections tab hidden — code kept for future implementation */}
            {nuvioView === 'collections' && false && (
              <div className="nuvio-editor-container">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                  <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#fff' }}>{t('collectionsManager')}</h3>
                  <button className="nuvio-btn nuvio-btn-primary" onClick={handleCreateCollection}>
                    + {t('addCollection')}
                  </button>
                </div>

                {editableCollections.length === 0 ? (
                  <div className="nuvio-empty-state">{t('noCollectionsHint')}</div>
                ) : (
                  editableCollections.map((coll) => (
                    <div key={coll.id} className="nuvio-editor-section">
                      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
                        <input
                          type="text"
                          value={coll.title}
                          className="nuvio-input"
                          style={{ fontSize: '1.05rem', fontWeight: 700, flex: 1, height: '38px' }}
                          onChange={(e) => handleUpdateCollectionTitle(coll.id, e.target.value)}
                          onBlur={() => handleSaveCollections(editableCollections)}
                        />
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button className="nuvio-btn" onClick={() => handleAddFolder(coll.id)}>
                            + Add Folder
                          </button>
                          <button className="nuvio-btn nuvio-btn-danger" onClick={() => handleDeleteCollection(coll.id)}>
                            Delete
                          </button>
                        </div>
                      </div>

                      {/* Folders in collection */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', paddingLeft: '16px', borderLeft: '1px solid rgba(255,255,255,0.06)' }}>
                        {coll.folders.map((folder) => (
                          <div key={folder.id} style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px', padding: '16px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                              <div>
                                <label style={{ display: 'block', fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>{t('folderTitle')}</label>
                                <input
                                  type="text"
                                  value={folder.title}
                                  className="nuvio-input"
                                  style={{ width: '100%' }}
                                  onChange={(e) => handleUpdateFolder(coll.id, folder.id, { title: e.target.value })}
                                  onBlur={() => handleSaveCollections(editableCollections)}
                                />
                              </div>
                              <div>
                                <label style={{ display: 'block', fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>{t('tileShape')}</label>
                                <select
                                  value={getFolderShapeClass(folder.tileShape)}
                                  className="nuvio-input"
                                  style={{ width: '100%', padding: '9px 12px' }}
                                  onChange={(e) => handleUpdateFolder(coll.id, folder.id, { tileShape: e.target.value })}
                                  onBlur={() => handleSaveCollections(editableCollections)}
                                >
                                  <option value="poster">{t('poster')} (2:3)</option>
                                  <option value="landscape">{t('landscape')} (16:10)</option>
                                  <option value="square">{t('square')} (1:1)</option>
                                </select>
                              </div>
                              <div>
                                <label style={{ display: 'block', fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>{t('coverEmoji')}</label>
                                <input
                                  type="text"
                                  value={folder.coverEmoji || ''}
                                  placeholder="📁"
                                  className="nuvio-input"
                                  style={{ width: '100%' }}
                                  onChange={(e) => handleUpdateFolder(coll.id, folder.id, { coverEmoji: e.target.value })}
                                  onBlur={() => handleSaveCollections(editableCollections)}
                                />
                              </div>
                              <div>
                                <label style={{ display: 'block', fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)', marginBottom: '4px' }}>{t('coverImageUrl')}</label>
                                <input
                                  type="text"
                                  value={folder.coverImageUrl || ''}
                                  className="nuvio-input"
                                  style={{ width: '100%' }}
                                  onChange={(e) => handleUpdateFolder(coll.id, folder.id, { coverImageUrl: e.target.value })}
                                  onBlur={() => handleSaveCollections(editableCollections)}
                                />
                              </div>
                            </div>

                            {/* Folder sources */}
                            <div style={{ marginTop: '16px' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>{t('catalogSources')}</span>
                                <button className="nuvio-btn" style={{ padding: '4px 10px', fontSize: '0.7rem' }} onClick={() => handleAddSource(coll.id, folder.id)}>
                                  + {t('addSource')}
                                </button>
                              </div>

                              {(!folder.sources || folder.sources.length === 0) ? (
                                <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.3)', padding: '8px', border: '1px dashed rgba(255,255,255,0.05)', borderRadius: '4px', textAlign: 'center' }}>
                                  {t('noSourcesYet')}
                                </div>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                  {folder.sources.map((source, srcIdx) => {
                                    const selectedAddon = addons.find(a => a.id === source.addonId || a.manifest.id === source.addonId);
                                    const catalogOptions = selectedAddon?.manifest?.catalogs || [];
                                    return (
                                      <div key={srcIdx} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr)) 40px', gap: '8px', alignItems: 'end', background: 'rgba(0,0,0,0.15)', padding: '10px', borderRadius: '4px' }}>
                                        <div>
                                          <label style={{ display: 'block', fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', marginBottom: '3px' }}>{t('addonProvider')}</label>
                                          <select
                                            value={source.addonId ?? ''}
                                            className="nuvio-input"
                                            style={{ width: '100%', fontSize: '0.72rem', padding: '6px' }}
                                            onChange={(e) => handleUpdateSource(coll.id, folder.id, srcIdx, { addonId: e.target.value, catalogId: 'top' })}
                                            onBlur={() => handleSaveCollections(editableCollections)}
                                          >
                                            {addons.map(a => (
                                              <option key={a.id} value={a.id}>{a.manifest.name}</option>
                                            ))}
                                          </select>
                                        </div>
                                        <div>
                                          <label style={{ display: 'block', fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', marginBottom: '3px' }}>{t('catalog')}</label>
                                          <select
                                            value={source.catalogId ?? ''}
                                            className="nuvio-input"
                                            style={{ width: '100%', fontSize: '0.72rem', padding: '6px' }}
                                            onChange={(e) => handleUpdateSource(coll.id, folder.id, srcIdx, { catalogId: e.target.value })}
                                            onBlur={() => handleSaveCollections(editableCollections)}
                                          >
                                            {catalogOptions.map(c => (
                                              <option key={c.id} value={c.id}>{c.name}</option>
                                            ))}
                                            {catalogOptions.length === 0 && (
                                              <option value="top">{t('top')}</option>
                                            )}
                                          </select>
                                        </div>
                                        <div>
                                          <label style={{ display: 'block', fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', marginBottom: '3px' }}>{t('type')}</label>
                                          <select
                                            value={source.type ?? ''}
                                            className="nuvio-input"
                                            style={{ width: '100%', fontSize: '0.72rem', padding: '6px' }}
                                            onChange={(e) => handleUpdateSource(coll.id, folder.id, srcIdx, { type: e.target.value })}
                                            onBlur={() => handleSaveCollections(editableCollections)}
                                          >
                                            <option value="movie">{t('movie')}</option>
                                            <option value="series">{t('series')}</option>
                                          </select>
                                        </div>
                                        <div>
                                          <label style={{ display: 'block', fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', marginBottom: '3px' }}>{t('genreFilter')}</label>
                                          <input
                                            type="text"
                                            value={source.genre || ''}
                                            placeholder={t('optional')}
                                            className="nuvio-input"
                                            style={{ width: '100%', fontSize: '0.72rem', padding: '5px' }}
                                            onChange={(e) => handleUpdateSource(coll.id, folder.id, srcIdx, { genre: e.target.value || null })}
                                            onBlur={() => handleSaveCollections(editableCollections)}
                                          />
                                        </div>
                                        <button className="nuvio-btn nuvio-btn-danger" style={{ padding: '6px', width: '100%', height: '28px', justifyContent: 'center' }} onClick={() => handleDeleteSource(coll.id, folder.id, srcIdx)}>
                                          ✕
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                              <button className="nuvio-btn nuvio-btn-danger" style={{ padding: '4px 10px', fontSize: '0.7rem' }} onClick={() => handleDeleteFolder(coll.id, folder.id)}>
                                Delete Folder
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {nuvioView === 'addons' && (
              <div className="nuvio-editor-container">
                <div className="nuvio-editor-section">
                  <h4 className="nuvio-editor-title">{t('installCustomAddon')}</h4>
                  <p style={{ margin: '0 0 16px 0', fontSize: '0.82rem', color: 'rgba(255,255,255,0.5)' }}>
                    {t('installCustomAddonHint')}
                  </p>
                  <form onSubmit={handleAddAddon} style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      placeholder="https://example.com/manifest.json"
                      value={addonUrl}
                      onChange={(e) => setAddonUrl(e.target.value)}
                      className="nuvio-input"
                      style={{ flex: 1 }}
                    />
                    <button type="submit" className="nuvio-btn nuvio-btn-primary" disabled={installingAddon || !addonUrl.trim()}>
                      {installingAddon ? 'Installing...' : 'Install'}
                    </button>
                  </form>
                  {addonError && <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginTop: '8px' }}>{addonError}</div>}
                  {addonsStore.error && <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginTop: '8px' }}>{addonsStore.error}</div>}
                </div>

                <div className="nuvio-editor-section" style={{ marginTop: '20px' }}>
                  <h4 className="nuvio-editor-title">Installed Addons ({addonsStore.addons.length})</h4>
                  {addonsStore.addons.length === 0 ? (
                    <div style={{ padding: '24px 0', textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '0.85rem' }}>
                      No addons installed.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                      {addonsStore.addons.map((addon) => (
                        <div key={`${addon.id}-${addon.baseUrl}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '6px', padding: '12px 16px' }}>
                          <div style={{ overflow: 'hidden', marginRight: '10px' }}>
                            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#fff' }}>
                              {addon.manifest.name} <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', marginLeft: '4px' }}>v{addon.manifest.version}</span>
                            </div>
                            {addon.manifest.description && (
                              <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>
                                {addon.manifest.description}
                              </div>
                            )}
                            <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {addon.baseUrl}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                            <button className="nuvio-btn" style={{ padding: '6px 12px', fontSize: '0.75rem' }} onClick={() => handleToggleAddon(addon.id)}>
                              {addon.enabled === false ? 'Enable' : 'Disable'}
                            </button>
                            <button className="nuvio-btn nuvio-btn-danger" style={{ padding: '6px 12px', fontSize: '0.75rem' }} onClick={() => handleRemoveAddon(addon.id)}>
                              Uninstall
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Scrapers tab hidden — code kept for future implementation */}
            {nuvioView === 'scrapers' && false && (
              <div className="nuvio-editor-container">
                <div className="nuvio-editor-section">
                  <h4 className="nuvio-editor-title">{t('settings')}</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('enableScrapers')}</div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>{t('enableScrapersHint')}</div>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={pluginStore.pluginsEnabled}
                          onChange={(e) => pluginStore.setPluginsEnabled(e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('groupStreamsByRepo')}</div>
                        <div style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.4)' }}>{t('groupStreamsByRepoHint')}</div>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={pluginStore.groupStreamsByRepository}
                          onChange={(e) => pluginStore.setGroupStreamsByRepository(e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>
                  </div>
                </div>

                <div className="nuvio-editor-section" style={{ marginTop: '20px' }}>
                  <h4 className="nuvio-editor-title">{t('installScraperRepo')}</h4>
                  <form onSubmit={handleAddRepository} style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="text"
                      placeholder="https://example.com/manifest.json"
                      value={repoUrl}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      className="nuvio-input"
                      style={{ flex: 1 }}
                    />
                    <button type="submit" className="nuvio-btn nuvio-btn-primary" disabled={installingRepo || !repoUrl.trim()}>
                      {installingRepo ? 'Installing...' : 'Install'}
                    </button>
                  </form>
                  {repoError && <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginTop: '8px' }}>{repoError}</div>}
                  {pluginStore.error && <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginTop: '8px' }}>{pluginStore.error}</div>}
                </div>

                <div className="nuvio-editor-section" style={{ marginTop: '20px' }}>
                  <h4 className="nuvio-editor-title">Installed Repositories ({pluginStore.repositories.length})</h4>
                  {pluginStore.repositories.length === 0 ? (
                    <div style={{ padding: '24px 0', textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: '0.85rem' }}>
                      No plugin repositories installed yet.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      {pluginStore.repositories.map((repo) => {
                        const repoScrapers = pluginStore.scrapers.filter(s => s.repositoryUrl === repo.manifestUrl);
                        return (
                          <div key={repo.manifestUrl} style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px', padding: '16px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                              <div style={{ overflow: 'hidden', marginRight: '10px' }}>
                                <div style={{ fontSize: '0.88rem', fontWeight: 600, color: '#fff' }}>
                                  {repo.name} <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', marginLeft: '4px' }}>v{repo.version}</span>
                                </div>
                                {repo.description && (
                                  <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>
                                    {repo.description}
                                  </div>
                                )}
                                <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {repo.manifestUrl}
                                </div>
                              </div>
                              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                                <button className="nuvio-btn" style={{ padding: '4px 8px', fontSize: '0.7rem' }} onClick={() => pluginStore.refreshRepository(repo.manifestUrl)} disabled={repo.isRefreshing}>
                                  {repo.isRefreshing ? 'Refreshing...' : 'Refresh'}
                                </button>
                                <button className="nuvio-btn nuvio-btn-danger" style={{ padding: '4px 8px', fontSize: '0.7rem' }} onClick={() => pluginStore.removeRepository(repo.manifestUrl)}>
                                  Remove
                                </button>
                              </div>
                            </div>

                            {/* Scrapers list */}
                            {repoScrapers.length > 0 && (
                              <div style={{ marginTop: '12px', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.03)' }}>
                                <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'rgba(255,255,255,0.35)', marginBottom: '6px' }}>{i18n.t('nuvio:scrapersLabel')}</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                  {repoScrapers.map((scraper) => (
                                    <div key={scraper.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.01)', padding: '6px 8px', borderRadius: '4px' }}>
                                      <span style={{ fontSize: '0.78rem', color: scraper.enabled ? '#fff' : 'rgba(255,255,255,0.4)' }}>
                                        {scraper.name} <span style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.25)', marginLeft: '4px' }}>v{scraper.version}</span>
                                      </span>
                                      <label className="toggle-switch" style={{ transform: 'scale(0.8)' }}>
                                        <input
                                          type="checkbox"
                                          checked={scraper.enabled}
                                          onChange={(e) => pluginStore.toggleScraper(scraper.id, e.target.checked)}
                                        />
                                        <span className="toggle-slider" />
                                      </label>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {nuvioView === 'settings' && (
              <NuvioTab
                showNuvioStreamBadges={showNuvioStreamBadges}
                onShowNuvioStreamBadgesChange={onShowNuvioStreamBadgesChange || (() => {})}
                nuvioBadgeSources={nuvioBadgeSources}
                onNuvioBadgeSourcesChange={onNuvioBadgeSourcesChange || (() => {})}
                nuvioBadgeSize={nuvioBadgeSize}
                onNuvioBadgeSizeChange={onNuvioBadgeSizeChange || (() => {})}
                nuvioShowFileSizeBadges={nuvioShowFileSizeBadges}
                onNuvioShowFileSizeBadgesChange={onNuvioShowFileSizeBadgesChange || (() => {})}
                nuvioStreamBadgePlacement={nuvioStreamBadgePlacement}
                onNuvioStreamBadgePlacementChange={onNuvioStreamBadgePlacementChange || (() => {})}
                showNuvioHoverDetails={showNuvioHoverDetails}
                onShowNuvioHoverDetailsChange={onShowNuvioHoverDetailsChange || (() => {})}
                nuvioAutoPlayMode={nuvioAutoPlayMode}
                onNuvioAutoPlayModeChange={onNuvioAutoPlayModeChange || (() => {})}
                nuvioAutoPlayTimeout={nuvioAutoPlayTimeout}
                onNuvioAutoPlayTimeoutChange={onNuvioAutoPlayTimeoutChange || (() => {})}
                nuvioAutoPlaySourceScope={nuvioAutoPlaySourceScope}
                onNuvioAutoPlaySourceScopeChange={onNuvioAutoPlaySourceScopeChange || (() => {})}
                nuvioAutoPlayAllowedAddons={nuvioAutoPlayAllowedAddons}
                onNuvioAutoPlayAllowedAddonsChange={onNuvioAutoPlayAllowedAddonsChange || (() => {})}
                nuvioAutoPlayAllowedPlugins={nuvioAutoPlayAllowedPlugins}
                onNuvioAutoPlayAllowedPluginsChange={onNuvioAutoPlayAllowedPluginsChange || (() => {})}
                nuvioAutoPlayRegex={nuvioAutoPlayRegex}
                onNuvioAutoPlayRegexChange={onNuvioAutoPlayRegexChange || (() => {})}
                nuvioCacheFetchResults={nuvioCacheFetchResults}
                onNuvioCacheFetchResultsChange={onNuvioCacheFetchResultsChange || (() => {})}
                nuvioCacheFetchTimeout={nuvioCacheFetchTimeout}
                onNuvioCacheFetchTimeoutChange={onNuvioCacheFetchTimeoutChange || (() => {})}
                onNavigateToSettingsTab={onNavigateToSettingsTab}
              />
            )}
          </div>
        )}
      </div>

      {/* Scroll to Top Button */}
      <button
        className={`nuvio-scroll-top ${showScrollTop ? 'visible' : ''}`}
        onClick={scrollToTop}
        aria-label={t('scrollToTop')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 15l-6-6-6 6" />
        </svg>
      </button>



      {/* Spinner animation definition */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>

      {/* Nuvio Detail View — fully self-contained, no Stremio page */}
      {nuvioActiveMeta && (
        <NuvioDetailView
          meta={nuvioActiveMeta}
          onBack={() => nuvioGoBack()}
          onPlay={handleNuvioPlay}
          onNavigate={handleNuvioNavigate}
          showStreamBadges={showNuvioStreamBadges}
          compiledBadgeRules={compiledBadgeRules}
          showFileSizeBadges={nuvioShowFileSizeBadges}
          streamBadgePlacement={nuvioStreamBadgePlacement}
          library={library}
          onUpdateLibrary={setLibrary}
          nuvioAutoPlayMode={nuvioAutoPlayMode}
          nuvioAutoPlayTimeout={nuvioAutoPlayTimeout}
          nuvioAutoPlaySourceScope={nuvioAutoPlaySourceScope}
          nuvioAutoPlayAllowedAddons={nuvioAutoPlayAllowedAddons}
          nuvioAutoPlayAllowedPlugins={nuvioAutoPlayAllowedPlugins}
          nuvioAutoPlayRegex={nuvioAutoPlayRegex}
          nuvioCacheFetchResults={nuvioCacheFetchResults}
          nuvioCacheFetchTimeout={nuvioCacheFetchTimeout}
        />
      )}

      {/* Nuvio Person/Cast Detail View Overlay */}
      {nuvioView === 'person' && nuvioActivePersonId && (
        <NuvioPersonDetail
          personId={nuvioActivePersonId}
          onBack={() => nuvioGoBack()}
          onItemClick={handleNuvioNavigate}
        />
      )}

      {pinPromptProfile && (
        <NuvioPinModal
          profile={pinPromptProfile}
          onClose={() => setPinPromptProfile(null)}
        />
      )}

      <StremioHoverCard />
      <ModalComponent />
      </div>
  );
}
