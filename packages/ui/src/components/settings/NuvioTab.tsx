import { useState, useEffect, useMemo, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../../i18n';
import { useNuvioAuthStore } from '../../stores/nuvioAuthStore';
import { useNuvioPluginStore } from '../../stores/nuvioPluginStore';
import { useNuvioAddonStore } from '../../stores/nuvioAddonStore';
import { useNuvioCollectionStore } from '../../stores/nuvioCollectionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { NuvioPinModal } from '../nuvio/NuvioPinModal';
import { useModal } from '../Modal';
import { TraktCatalogsModal } from './TraktCatalogsModal';
import { getEffectiveNuvioUrl, getEffectiveNuvioKey } from '../../services/nuvio-api';
import type { InstalledAddon, BadgeSource, StreamAutoPlayMode, StreamAutoPlaySourceScope } from '../../types/stremio';
import { parseBadgePayload, isLightColor, convertArgbToRgba } from '../../utils/streamBadges';
import { formatTime } from '../../utils/dateTime';

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

const matchCatalogKey = (settingsKey: string, availableKey: string, activeAddons: InstalledAddon[]): boolean => {
  const parts = settingsKey.split(':');
  if (parts.length < 3) return false;
  
  const catalogId = parts.pop()?.toLowerCase();
  const catalogType = parts.pop()?.toLowerCase();
  const addonManifestId = parts.join(':').toLowerCase();
  
  const compareParts = availableKey.split(':');
  if (compareParts.length < 3) return false;
  
  const compareCatId = compareParts.pop()?.toLowerCase();
  const compareCatType = compareParts.pop()?.toLowerCase();
  const compareAddonId = compareParts.join(':').toLowerCase();
  
  // Fuzzy addon match
  let addonMatches = false;
  if (compareAddonId === addonManifestId || addonManifestId.includes(compareAddonId) || compareAddonId.includes(addonManifestId)) {
    addonMatches = true;
  } else {
    const matchedAddon = activeAddons.find(a => (a.manifest?.id || a.id || '').toLowerCase() === compareAddonId);
    if (matchedAddon) {
      const settingsIsCinemeta = addonManifestId.includes('cinemeta') || addonManifestId.includes('linvo');
      if (settingsIsCinemeta && isCinemetaAddon(matchedAddon)) {
        addonMatches = true;
      }
      
      const settingsIsAio = addonManifestId.includes('aio') || addonManifestId.includes('genres');
      if (settingsIsAio && isAioMetadataAddon(matchedAddon)) {
        addonMatches = true;
      }
    }
  }
  
  if (!addonMatches) return false;
  
  const normSettingsType = catalogType === 'tv' ? 'series' : catalogType;
  const normCompareType = compareCatType === 'tv' ? 'series' : compareCatType;
  
  return normSettingsType === normCompareType && catalogId === compareCatId;
};

interface NuvioTabProps {
  showNuvioStreamBadges: boolean;
  onShowNuvioStreamBadgesChange: (show: boolean) => Promise<void> | void;
  nuvioBadgeSources: BadgeSource[];
  onNuvioBadgeSourcesChange: (sources: BadgeSource[]) => Promise<void> | void;
  nuvioBadgeSize: number;
  onNuvioBadgeSizeChange: (size: number) => Promise<void> | void;
  nuvioShowFileSizeBadges: boolean;
  onNuvioShowFileSizeBadgesChange: (show: boolean) => Promise<void> | void;
  nuvioStreamBadgePlacement: 'top' | 'bottom';
  onNuvioStreamBadgePlacementChange: (placement: 'top' | 'bottom') => Promise<void> | void;
  showNuvioHoverDetails: boolean;
  onShowNuvioHoverDetailsChange: (show: boolean) => Promise<void> | void;
  nuvioAutoPlayMode: StreamAutoPlayMode;
  onNuvioAutoPlayModeChange: (mode: StreamAutoPlayMode) => void;
  nuvioAutoPlayTimeout: number;
  onNuvioAutoPlayTimeoutChange: (timeout: number) => void;
  nuvioAutoPlaySourceScope: StreamAutoPlaySourceScope;
  onNuvioAutoPlaySourceScopeChange: (scope: StreamAutoPlaySourceScope) => void;
  nuvioAutoPlayAllowedAddons: string[];
  onNuvioAutoPlayAllowedAddonsChange: (addonIds: string[]) => void;
  nuvioAutoPlayAllowedPlugins: string[];
  onNuvioAutoPlayAllowedPluginsChange: (pluginIds: string[]) => void;
  nuvioAutoPlayRegex: string;
  onNuvioAutoPlayRegexChange: (regex: string) => void;
  onNavigateToSettingsTab?: (tab: string) => void;
  onUnsavedChangesChange?: (dirty: boolean) => void;
  nuvioCacheFetchResults: boolean;
  onNuvioCacheFetchResultsChange: (enabled: boolean) => Promise<void> | void;
  nuvioCacheFetchTimeout: number;
  onNuvioCacheFetchTimeoutChange: (timeout: number) => void;
}

export const NuvioTab = forwardRef<{ save: () => Promise<void> }, NuvioTabProps>(
  function NuvioTab({
    showNuvioStreamBadges,
    onShowNuvioStreamBadgesChange,
    nuvioBadgeSources,
    onNuvioBadgeSourcesChange,
    nuvioBadgeSize,
    onNuvioBadgeSizeChange,
    nuvioShowFileSizeBadges,
    onNuvioShowFileSizeBadgesChange,
    nuvioStreamBadgePlacement,
    onNuvioStreamBadgePlacementChange,
    showNuvioHoverDetails,
    onShowNuvioHoverDetailsChange,
    nuvioAutoPlayMode,
    onNuvioAutoPlayModeChange,
    nuvioAutoPlayTimeout,
    onNuvioAutoPlayTimeoutChange,
    nuvioAutoPlaySourceScope,
    onNuvioAutoPlaySourceScopeChange,
    nuvioAutoPlayAllowedAddons,
    onNuvioAutoPlayAllowedAddonsChange,
    nuvioAutoPlayAllowedPlugins,
    onNuvioAutoPlayAllowedPluginsChange,
    nuvioAutoPlayRegex,
    onNuvioAutoPlayRegexChange,
    onNavigateToSettingsTab,
    onUnsavedChangesChange,
    nuvioCacheFetchResults,
    onNuvioCacheFetchResultsChange,
    nuvioCacheFetchTimeout,
    onNuvioCacheFetchTimeoutChange,
  }, ref) {
  useTranslation();
  const authStore = useNuvioAuthStore();
  const [pinPromptProfile, setPinPromptProfile] = useState<any | null>(null);
  const [showAddonDialog, setShowAddonDialog] = useState(false);
  const [showPluginDialog, setShowPluginDialog] = useState(false);
  const pluginStore = useNuvioPluginStore();
  const addonsStore = useNuvioAddonStore();
  const collectionStore = useNuvioCollectionStore();
  const { showConfirm, ModalComponent } = useModal();

  const token = authStore.token;
  const profile = authStore.activeProfile;

  const traktAccessToken = useSettingsStore((s) => s.traktAccessToken);
  const traktConnected = !!traktAccessToken;
  const [showTraktModal, setShowTraktModal] = useState(false);

  // Badge import states
  const [badgeUrl, setBadgeUrl] = useState('');
  const [badgePaste, setBadgePaste] = useState('');
  const [badgeImportError, setBadgeImportError] = useState('');
  const [badgeImporting, setBadgeImporting] = useState(false);
  const [expandedSourceUrl, setExpandedSourceUrl] = useState<string | null>(null);

  const handleImportBadge = useCallback(async () => {
    setBadgeImportError('');
    const url = badgeUrl.trim();
    const paste = badgePaste.trim();
    if (!url && !paste) {
      setBadgeImportError(i18n.t('settings:nuvio.badgeUrlRequired'));
      return;
    }

    setBadgeImporting(true);
    try {
      let payloadStr = paste;
      let sourceUrl = url;
      let sourceName = '';
      if (paste) {
        sourceUrl = `pasted_${Date.now()}`;
        const pastedCount = nuvioBadgeSources.filter((s) => s.url.startsWith('pasted_')).length + 1;
        sourceName = `Pasted Rule ${pastedCount}`;
      } else {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          setBadgeImportError(i18n.t('settings:nuvio.badgeUrlInvalid'));
          setBadgeImporting(false);
          return;
        }
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        payloadStr = await resp.text();
        sourceName = url.split('/').pop() || url;
      }

      const payload = parseBadgePayload(payloadStr);
      const newSource: BadgeSource = {
        url: sourceUrl,
        name: sourceName,
        payload,
        isActive: true,
      };

      const updated = nuvioBadgeSources.filter(
        (s) => s.url.toLowerCase() !== newSource.url.toLowerCase(),
      );
      updated.push(newSource);

      await onNuvioBadgeSourcesChange(updated);
      setBadgeUrl('');
      setBadgePaste('');
    } catch (err: any) {
      setBadgeImportError(translateNativeError(err?.message) || i18n.t('settings:nuvio.importFailed'));
    } finally {
      setBadgeImporting(false);
    }
  }, [badgeUrl, badgePaste, nuvioBadgeSources, onNuvioBadgeSourcesChange]);

  const handleToggleSource = useCallback(
    async (url: string) => {
      const updated = nuvioBadgeSources.map((s) => ({
        ...s,
        isActive: s.url === url ? !s.isActive : s.isActive,
      }));
      await onNuvioBadgeSourcesChange(updated);
    },
    [nuvioBadgeSources, onNuvioBadgeSourcesChange],
  );

  const handleDeleteSource = useCallback(
    async (url: string) => {
      const updated = nuvioBadgeSources.filter((s) => s.url !== url);
      await onNuvioBadgeSourcesChange(updated);
    },
    [nuvioBadgeSources, onNuvioBadgeSourcesChange],
  );

  // Add Addon State
  const [addonUrl, setAddonUrl] = useState('');
  const [addonError, setAddonError] = useState<string | null>(null);
  const [installingAddon, setInstallingAddon] = useState(false);

  // Auth Form State
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);

  // Profile creation state
  const [showCreateProfile, setShowCreateProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileColor, setNewProfileColor] = useState('#00d4ff');

  // Add Repository State
  const [repoUrl, setRepoUrl] = useState('');
  const [repoError, setRepoError] = useState<string | null>(null);

  // Nuvio Profile Settings States
  const [debridEnabled, setDebridEnabled] = useState(false);
  const [cloudLibEnabled, setCloudLibEnabled] = useState(true);
  const [preferredDebrid, setPreferredDebrid] = useState('');
  const [realDebridKey, setRealDebridKey] = useState('');
  const [premiumizeKey, setPremiumizeKey] = useState('');
  const [torboxKey, setTorboxKey] = useState('');

  const [tmdbEnabled, setTmdbEnabled] = useState(false);
  const [tmdbKey, setTmdbKey] = useState('');
  const [tmdbLang, setTmdbLang] = useState('en');
  const [showTmdbKey, setShowTmdbKey] = useState(false);

  // Homepage catalog settings states
  const [localCatalogItems, setLocalCatalogItems] = useState<any[]>([]);
  // Pointer-event drag state for catalog items reordering
  const dragFromIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const catalogListRef = useRef<HTMLDivElement>(null);
  const [hideUnreleased, setHideUnreleased] = useState(false);
  const [hideUnderline, setHideUnderline] = useState(false);
  const [landscapePosters, setLandscapePosters] = useState(false);

  useEffect(() => {
    if (authStore.token) {
      if (authStore.profiles.length === 0) {
        authStore.fetchProfiles();
      }
      if (authStore.activeProfile) {
        if (!authStore.settings) {
          authStore.fetchSettings();
        }
        if (!authStore.homeCatalogSettings) {
          authStore.fetchHomeCatalogSettings();
        }
        const effectiveAddonProfileId =
          authStore.activeProfile.profile_index !== 1 && authStore.activeProfile.uses_primary_addons
            ? 1
            : authStore.activeProfile.profile_index;
        if (!addonsStore.initialized) {
          addonsStore.pullAddons(authStore.token, effectiveAddonProfileId);
        }
      }
    }
  }, [authStore.token, authStore.activeProfile?.profile_index]);

  useEffect(() => {
    if (authStore.homeCatalogSettings) {
      setHideUnreleased(authStore.homeCatalogSettings.hide_unreleased_content || false);
      setHideUnderline(authStore.homeCatalogSettings.hide_catalog_underline || false);
      setLandscapePosters(authStore.homeCatalogSettings.landscape_posters || false);
    }
  }, [authStore.homeCatalogSettings]);




  useEffect(() => {
    const features = authStore.settings?.features || {};
    const debrid = features.debrid_settings || {};
    const tmdb = features.tmdb_settings || {};

    setDebridEnabled(debrid.enabled || false);
    setCloudLibEnabled(debrid.cloudLibraryEnabled !== false);
    setPreferredDebrid(debrid.preferredResolverProviderId || '');
    
    const apiKeys = debrid.providerApiKeys || {};
    setRealDebridKey(apiKeys.realdebrid || '');
    setPremiumizeKey(apiKeys.premiumize || '');
    setTorboxKey(apiKeys.torbox || '');

    setTmdbEnabled(tmdb.enabled || false);
    setTmdbKey(tmdb.apiKey || '');
    setTmdbLang(tmdb.language || 'en');
  }, [authStore.settings]);

  // Derive catalog lists
  const collections = collectionStore.collections || [];
  const activeAddons = addonsStore.enabledAddons || [];

  const collectionsList = useMemo(() => {
    return collections.map(c => ({
      key: `collection_${c.id}`,
      title: c.title,
      subtitle: `${c.folders?.length || 0} folders`,
      isCollection: true,
      collectionId: c.id,
      addonName: 'Collection'
    }));
  }, [collections]);

  const catalogsList = useMemo(() => {
    const list: any[] = [];
    activeAddons.forEach(addon => {
      addon.manifest?.catalogs?.forEach(catalog => {
        if (catalog.extra?.some(e => e.isRequired)) return;
        list.push({
          key: `${addon.manifest.id || addon.id}:${catalog.type}:${catalog.id}`,
          title: catalog.name,
          subtitle: `${catalog.type.charAt(0).toUpperCase() + catalog.type.slice(1)} catalog`,
          isCollection: false,
          addonName: addon.manifest.name,
          addonId: addon.manifest.id || addon.id,
          type: catalog.type,
          catalogId: catalog.id
        });
      });
    });
    return list;
  }, [activeAddons]);

  const mergedItems = useMemo(() => {
    const allAvailable = [...collectionsList, ...catalogsList];
    const settingsItems = authStore.homeCatalogSettings?.items || [];
    
    const result: any[] = [];
    const usedKeys = new Set<string>();
    
    const sortedSettings = [...settingsItems].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    sortedSettings.forEach(sItem => {
      const isCollection = sItem.is_collection || sItem.isCollection;
      const collectionId = sItem.collection_id || sItem.collectionId;
      const addonId = sItem.addon_id || sItem.addonId;
      const catalogId = sItem.catalog_id || sItem.catalogId;
      const customTitle = sItem.custom_title !== undefined ? sItem.custom_title : sItem.customTitle;
      const enabled = sItem.enabled !== false;
      const order = sItem.order ?? 999;

      const key = isCollection 
        ? `collection_${collectionId}` 
        : `${addonId}:${sItem.type}:${catalogId}`;
        
      let availableItem: any = null;
      if (isCollection) {
        availableItem = collectionsList.find(c => c.key === key);
      } else {
        availableItem = catalogsList.find(c => {
          const settingsKey = `${addonId}:${sItem.type}:${catalogId}`;
          return matchCatalogKey(settingsKey, c.key, activeAddons);
        });
      }
      
      if (availableItem) {
        result.push({
          ...availableItem,
          enabled: enabled,
          customTitle: customTitle || '',
          order: order
        });
        usedKeys.add(availableItem.key);
      }
    });
    
    allAvailable.forEach(item => {
      if (!usedKeys.has(item.key)) {
        result.push({
          ...item,
          enabled: true,
          customTitle: '',
          order: result.length
        });
      }
    });
    
    return result.map((item, idx) => ({ ...item, order: idx }));
  }, [collectionsList, catalogsList, authStore.homeCatalogSettings, activeAddons]);

  useEffect(() => {
    setLocalCatalogItems(mergedItems);
  }, [mergedItems]);

  const isDirty = useMemo(() => {
    if (!authStore.homeCatalogSettings) return false;
    const savedHideUnreleased = authStore.homeCatalogSettings.hide_unreleased_content || false;
    const savedHideUnderline = authStore.homeCatalogSettings.hide_catalog_underline || false;
    const savedLandscapePosters = authStore.homeCatalogSettings.landscape_posters || false;
    
    if (hideUnreleased !== savedHideUnreleased) return true;
    if (hideUnderline !== savedHideUnderline) return true;
    if (landscapePosters !== savedLandscapePosters) return true;
    
    if (localCatalogItems.length !== mergedItems.length) return true;
    for (let i = 0; i < localCatalogItems.length; i++) {
      const loc = localCatalogItems[i];
      const orig = mergedItems[i];
      if (loc.key !== orig.key) return true;
      if (loc.enabled !== orig.enabled) return true;
      if ((loc.customTitle || '').trim() !== (orig.customTitle || '').trim()) return true;
      if (loc.order !== orig.order) return true;
    }
    return false;
  }, [hideUnreleased, hideUnderline, landscapePosters, localCatalogItems, mergedItems, authStore.homeCatalogSettings]);


  const handleToggleItem = (key: string) => {
    const updated = localCatalogItems.map(item => 
      item.key === key ? { ...item, enabled: !item.enabled } : item
    );
    setLocalCatalogItems(updated);
  };

  const handleCustomTitleChange = (key: string, title: string) => {
    const updated = localCatalogItems.map(item => 
      item.key === key ? { ...item, customTitle: title } : item
    );
    setLocalCatalogItems(updated);
  };

  const handleMoveItem = (index: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= localCatalogItems.length) return;
    
    const updated = [...localCatalogItems];
    const temp = updated[index];
    updated[index] = updated[targetIdx];
    updated[targetIdx] = temp;
    
    const reordered = updated.map((item, idx) => ({ ...item, order: idx }));
    setLocalCatalogItems(reordered);
  };

  // Compute which list-item index a clientY falls into
  const getCatalogIndexFromClientY = (clientY: number): number => {
    if (!catalogListRef.current) return 0;
    const children = Array.from(catalogListRef.current.children) as HTMLElement[];
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return Math.max(0, children.length - 1);
  };

  const handleCatalogPointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragFromIdx.current = index;
    setDragOverIdx(index);
    setDraggingIndex(index);
  }, []);

  const handleCatalogPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragFromIdx.current === null) return;
    e.preventDefault();
    const idx = getCatalogIndexFromClientY(e.clientY);
    setDragOverIdx(idx);
  }, []);

  const handleCatalogPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragFromIdx.current === null) return;
    const from = dragFromIdx.current;
    const to = getCatalogIndexFromClientY(e.clientY);
    dragFromIdx.current = null;
    setDragOverIdx(null);
    setDraggingIndex(null);
    if (from === to) return;
    setLocalCatalogItems(items => {
      const newItems = [...items];
      const [removed] = newItems.splice(from, 1);
      newItems.splice(to, 0, removed);
      return newItems.map((item, idx) => ({ ...item, order: idx }));
    });
  }, []);

  const handleCatalogPointerCancel = useCallback(() => {
    dragFromIdx.current = null;
    setDragOverIdx(null);
    setDraggingIndex(null);
  }, []);

  const handleSaveCatalogSettings = useCallback(async () => {
    try {
      const itemsPayload = localCatalogItems.map(item => {
        if (item.isCollection) {
          return {
            addon_id: '',
            type: '',
            catalog_id: '',
            enabled: item.enabled,
            order: item.order,
            custom_title: item.customTitle.trim(),
            is_collection: true,
            collection_id: item.collectionId
          };
        } else {
          return {
            addon_id: item.addonId,
            type: item.type,
            catalog_id: item.catalogId,
            enabled: item.enabled,
            order: item.order,
            custom_title: item.customTitle.trim(),
            is_collection: false,
            collection_id: ''
          };
        }
      });
      
      const payload = {
        hide_unreleased_content: hideUnreleased,
        hide_catalog_underline: hideUnderline,
        landscape_posters: landscapePosters,
        items: itemsPayload
      };
      
      await authStore.updateHomeCatalogSettings(payload);
      alert(i18n.t('settings:nuvio.savedLayoutAlert'));
    } catch (e: any) {
      alert(translateNativeError(e.message) || i18n.t('settings:nuvio.failedSaveLayoutAlert'));
      throw e;
    }
  }, [localCatalogItems, hideUnreleased, hideUnderline, landscapePosters, authStore]);

  useEffect(() => {
    onUnsavedChangesChange?.(isDirty);
    useUIStore.setState({ nuvioHasUnsavedHomeLayout: isDirty });
    return () => {
      useUIStore.setState({ nuvioHasUnsavedHomeLayout: false });
    };
  }, [isDirty, onUnsavedChangesChange]);

  useEffect(() => {
    useUIStore.setState({ nuvioTabSaveFn: handleSaveCatalogSettings });
    return () => {
      useUIStore.setState({ nuvioTabSaveFn: null });
    };
  }, [handleSaveCatalogSettings]);

  useImperativeHandle(ref, () => ({
    save: handleSaveCatalogSettings
  }), [handleSaveCatalogSettings]);

  const handleResetCatalogSettings = async () => {
    if (confirm(i18n.t('settings:nuvio.resetLayoutConfirm'))) {
      try {
        const payload = {
          hide_unreleased_content: false,
          hide_catalog_underline: false,
          landscape_posters: false,
          items: []
        };
        await authStore.updateHomeCatalogSettings(payload);
        alert(i18n.t('settings:nuvio.resetLayoutAlert'));
      } catch (e: any) {
        alert(translateNativeError(e.message) || i18n.t('settings:nuvio.failedResetSettings'));
      }
    }
  };

  const handleSaveSettings = async () => {
    try {
      const updatedDebrid = {
        enabled: debridEnabled,
        cloudLibraryEnabled: cloudLibEnabled,
        preferredResolverProviderId: preferredDebrid,
        providerApiKeys: {
          realdebrid: realDebridKey.trim(),
          premiumize: premiumizeKey.trim(),
          torbox: torboxKey.trim()
        }
      };

      const updatedTmdb = {
        enabled: tmdbEnabled,
        apiKey: tmdbKey.trim(),
        language: tmdbLang.trim() || 'en'
      };

      await authStore.updateSettings({
        debrid_settings: updatedDebrid,
        tmdb_settings: updatedTmdb
      });
      alert(i18n.t('settings:nuvio.savedSettingsAlert'));
    } catch (e: any) {
      alert(translateNativeError(e.message) || i18n.t('settings:nuvio.failedSaveSettingsAlert'));
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!email || !password) {
      setAuthError(i18n.t('settings:nuvio.authRequired'));
      return;
    }
    try {
      if (isLoginMode) {
        await authStore.login(email, password);
      } else {
        await authStore.signup(email, password);
      }
      setEmail('');
      setPassword('');
    } catch (err: any) {
      setAuthError(translateNativeError(err.message) || i18n.t('settings:nuvio.authFailed'));
    }
  };

  const handleCreateProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileName.trim()) return;
    try {
      await authStore.createProfile(newProfileName, newProfileColor, null, null);
      setNewProfileName('');
      setShowCreateProfile(false);
    } catch (err: any) {
      alert(translateNativeError(err.message) || i18n.t('settings:nuvio.createProfileFailed'));
    }
  };

  const handleAddAddon = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddonError(null);
    if (!addonUrl.trim()) return;
    if (!token || !profile) {
      setAddonError(i18n.t('settings:nuvio.selectProfileFirst'));
      return;
    }
    setInstallingAddon(true);
    try {
      await addonsStore.addAddon(token, profile.profile_index, addonUrl.trim());
      setAddonUrl('');
      alert(i18n.t('settings:nuvio.addonInstalledAlert'));
    } catch (err: any) {
      setAddonError(err.message || i18n.t('settings:nuvio.installAddonFailed'));
    } finally {
      setInstallingAddon(false);
    }
  };

  const handleToggleAddon = async (addonId: string) => {
    if (!token || !profile) return;
    try {
      await addonsStore.toggleAddon(token, profile.profile_index, addonId);
    } catch (err: any) {
      alert(err.message || i18n.t('settings:nuvio.toggleAddonFailed'));
    }
  };

  const handleRemoveAddon = async (addonId: string) => {
    if (!token || !profile) return;
    if (confirm(i18n.t('settings:nuvio.uninstallAddonConfirm'))) {
      try {
        await addonsStore.removeAddon(token, profile.profile_index, addonId);
      } catch (err: any) {
        alert(err.message || i18n.t('settings:nuvio.removeAddonFailed'));
      }
    }
  };

  const handleAddRepository = async (e: React.FormEvent) => {
    e.preventDefault();
    setRepoError(null);
    if (!repoUrl.trim()) return;
    try {
      await pluginStore.addRepository(repoUrl);
      setRepoUrl('');
    } catch (err: any) {
      setRepoError(translateNativeError(err.message) || i18n.t('settings:nuvio.addRepoFailed'));
    }
  };

  const defaultColors = ['#00d4ff', '#ff007f', '#a020f0', '#00ff7f', '#ffaa00', '#ff0000', '#0088ff', '#ffffff'];

  return (
    <div className="settings-tab-content nuvio-settings-tab">
      {/* 1. Header & Dynamic Server Sync Info */}
      <div className="settings-section">
        <h3 style={{ margin: '0 0 8px 0', fontSize: '1rem', fontWeight: 600 }}>{i18n.t('settings:nuvio.title')}</h3>
        <p style={{ margin: '0 0 16px 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          {i18n.t('settings:nuvio.description')}
        </p>



        {/* 2. AUTH STATUS OR LOGIN FORM */}
        {!authStore.token ? (
          <div style={{
            background: 'var(--surface-color)',
            border: '1px solid var(--surface-border)',
            borderRadius: '8px',
            padding: '20px'
          }}>
            <h4 style={{ margin: '0 0 14px 0', fontSize: '0.9rem', fontWeight: 600 }}>
              {isLoginMode ? i18n.t('settings:nuvio.loginTab') : i18n.t('settings:nuvio.registerTab')}
            </h4>
            <form onSubmit={handleAuthSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <input
                  type="email"
                  placeholder={i18n.t('settings:nuvio.emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '6px',
                    padding: '10px',
                    fontSize: '0.85rem',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              <div>
                <input
                  type="password"
                  placeholder={i18n.t('settings:nuvio.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '6px',
                    padding: '10px',
                    fontSize: '0.85rem',
                    color: 'var(--text-primary)',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              {authError && (
                <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginTop: '2px' }}>
                  {authError}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
                <button
                  type="submit"
                  disabled={authStore.isSyncing}
                  style={{
                    background: 'linear-gradient(135deg, var(--accent-primary), #0088ff)',
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
                  {authStore.isSyncing ? i18n.t('settings:nuvio.saving') : isLoginMode ? i18n.t('settings:nuvio.loginTab') : i18n.t('settings:nuvio.registerTab')}
                </button>
                <button
                  type="button"
                  onClick={() => setIsLoginMode(!isLoginMode)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    fontSize: '0.75rem',
                    cursor: 'pointer',
                    textDecoration: 'underline'
                  }}
                >
                  {isLoginMode ? i18n.t('settings:nuvio.needRegister') : i18n.t('settings:nuvio.haveAccount')}
                </button>
              </div>
            </form>
            <p style={{
              margin: '14px 0 0 0',
              fontSize: '0.7rem',
              color: 'var(--text-muted)',
              lineHeight: 1.5,
              textAlign: 'center'
            }}>
              {i18n.t('settings:nuvio.disclaimer')}
            </p>
          </div>
        ) : (
          <div>
            {/* Logged in state */}
            <div style={{
              background: 'var(--surface-color)',
              border: '1px solid var(--surface-border)',
              borderRadius: '8px',
              padding: '16px',
              marginBottom: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, var(--text-muted))', fontWeight: 700, letterSpacing: '0.05em' }}>{i18n.t('settings:nuvio.signedInAs')}</div>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary, var(--text-primary))' }}>{authStore.user?.email}</div>
                {authStore.lastSyncTime && (
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted, var(--text-muted))', marginTop: '4px' }}>
                    {i18n.t('settings:nuvio.syncedAt', { time: formatTime(new Date(authStore.lastSyncTime)) })}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => authStore.syncNow(true)}
                  disabled={authStore.isSyncing}
                  style={{
background: 'var(--surface-glow)',
border: '1px solid var(--accent-glow)',
                    color: 'var(--accent-primary)',
                    borderRadius: '6px',
                    padding: '8px 14px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: authStore.isSyncing ? 'not-allowed' : 'pointer'
                  }}
                >
                  {authStore.isSyncing ? i18n.t('settings:nuvio.saving') : i18n.t('settings:nuvio.syncNow')}
                </button>
                <button
                  onClick={() => authStore.logout()}
                  style={{
                    background: 'rgba(255,79,79,0.12)',
                    border: '1px solid rgba(255,79,79,0.25)',
                    color: '#ff4f4f',
                    borderRadius: '6px',
                    padding: '8px 14px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  {i18n.t('settings:nuvio.signOut')}
                </button>
              </div>
            </div>

            {/* Profiles Section */}
            <div style={{ marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <h4 style={{ margin: 0, fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)' }}>{i18n.t('settings:nuvio.profilesTitle', { count: authStore.profiles.length })}</h4>
                {authStore.profiles.length < 4 && !showCreateProfile && (
                  <button
                    onClick={() => setShowCreateProfile(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--accent-primary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      padding: 0
                    }}
                  >
                    {i18n.t('settings:nuvio.addProfile')}
                  </button>
                )}
              </div>

              {showCreateProfile && (
                <form onSubmit={handleCreateProfileSubmit} style={{
                  background: 'var(--surface-color)',
                  border: '1px solid var(--surface-border)',
                  borderRadius: '8px',
                  padding: '14px',
                  marginBottom: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px'
                }}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <input
                      type="text"
                      placeholder={i18n.t('settings:nuvio.profileNamePlaceholder')}
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      style={{
                        flex: 1,
                        background: 'var(--bg-tertiary)',
                        border: '1px solid var(--surface-border)',
                        borderRadius: '6px',
                        padding: '8px',
                        fontSize: '0.8rem',
                        color: 'var(--text-primary)',
                        outline: 'none'
                      }}
                    />
                    <input
                      type="color"
                      value={newProfileColor}
                      onChange={(e) => setNewProfileColor(e.target.value)}
                      style={{
                        background: 'none',
                        border: 'none',
                        width: '32px',
                        height: '32px',
                        cursor: 'pointer',
                        padding: 0
                      }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {defaultColors.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewProfileColor(c)}
                        style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          background: c,
                          border: newProfileColor === c ? '2px solid #fff' : '1px solid rgba(0,0,0,0.3)',
                          cursor: 'pointer'
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
                    <button
                      type="button"
                      onClick={() => setShowCreateProfile(false)}
                      style={{
                        background: 'none',
                        border: '1px solid var(--surface-border)',
                        color: 'var(--text-secondary)',
                        borderRadius: '4px',
                        padding: '4px 10px',
                        fontSize: '0.75rem',
                        cursor: 'pointer'
                      }}
                    >
                      {i18n.t('common:cancel')}
                    </button>
                    <button
                      type="submit"
                      style={{
                        background: 'var(--accent-primary)',
                        border: 'none',
                        color: '#000',
                        borderRadius: '4px',
                        padding: '4px 12px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      {i18n.t('common:create')}
                    </button>
                  </div>
                </form>
              )}

              {/* Profiles List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {authStore.profiles.map((p) => {
                  const isActive = authStore.activeProfile?.profile_index === p.profile_index;
                  return (
                    <div
                      key={p.profile_index}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 14px',
                        borderRadius: '6px',
background: isActive ? 'var(--surface-glow)' : 'var(--surface-color)',
border: `1px solid ${isActive ? 'var(--accent-glow)' : 'var(--surface-border)'}`,
                      }}
                    >
                      <div
                        onClick={() => {
                          if (!isActive) {
                            if (p.pin_enabled) {
                              setPinPromptProfile(p);
                            } else {
                              authStore.selectProfile(p.profile_index);
                            }
                          }
                        }}
                        style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, cursor: isActive ? 'default' : 'pointer' }}
                      >
                        <div style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '50%',
                          backgroundColor: p.avatar_color_hex || '#00d4ff',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          fontSize: '1rem',
                          color: '#000'
                        }}>
                          {p.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <span style={{ fontSize: '0.85rem', fontWeight: isActive ? 600 : 500, color: isActive ? 'var(--text-primary)' : 'var(--text-primary)' }}>
                            {p.name}
                          </span>
                          {isActive && (
                            <span style={{
                              marginLeft: '8px',
                              fontSize: '0.62rem',
                              background: 'var(--accent-primary)',
                              color: '#000',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              fontWeight: 700
                            }}>
                              {i18n.t('settings:nuvio.active')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        {authStore.profiles.length > 1 && (
                          <button
                            onClick={() => {
                              showConfirm(
                                i18n.t('settings:nuvio.deleteProfile'),
                                i18n.t('settings:nuvio.deleteProfileConfirm', { name: p.name }),
                                () => authStore.deleteProfile(p.profile_index)
                              );
                            }}
                            title={i18n.t('settings:nuvio.deleteProfileTooltip')}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'rgba(255,79,79,0.5)',
                              fontSize: '0.75rem',
                              cursor: 'pointer',
                              padding: '4px'
                            }}
                          >
                            {i18n.t('settings:nuvio.deleteProfile')}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Profile Cloud Settings Section */}
            <div style={{
              background: 'var(--surface-color)',
              border: '1px solid var(--surface-border)',
              borderRadius: '8px',
              padding: '20px',
              marginBottom: '24px'
            }}>
              <h4 style={{ margin: '0 0 14px 0', fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {i18n.t('settings:nuvio.cloudSettings')}
              </h4>
              <p style={{ margin: '0 0 20px 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {i18n.t('settings:nuvio.cloudSettingsDesc')}
              </p>

              {/* TMDB SECTION */}
              <div style={{ marginBottom: '24px', borderBottom: '1px solid var(--surface-border)', paddingBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{i18n.t('settings:nuvio.tmdbTitle')}</span>
                  <label className="toggle-switch" style={{ transform: 'scale(0.85)' }}>
                    <input
                      type="checkbox"
                      checked={tmdbEnabled}
                      onChange={(e) => setTmdbEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                
                {tmdbEnabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '10px' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '4px' }}>{i18n.t('settings:nuvio.tmdbTokenLabel')}</label>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%' }}>
                        <input
                          type={showTmdbKey ? 'text' : 'password'}
                          placeholder={i18n.t('settings:nuvio.tmdbTokenPlaceholder')}
                          value={tmdbKey}
                          onChange={(e) => setTmdbKey(e.target.value)}
                          className="nuvio-input"
                          style={{ width: '100%', paddingRight: '36px' }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowTmdbKey(!showTmdbKey)}
                          title={showTmdbKey ? i18n.t('settings:nuvio.hideKey') : i18n.t('settings:nuvio.showKey')}
                          style={{
                            position: 'absolute',
                            right: '6px',
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-muted)',
                            cursor: 'pointer',
                            padding: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: '4px',
                            transition: 'color 0.2s, background 0.2s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--surface-color)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; }}
                        >
                          {showTmdbKey ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                              <line x1="1" y1="1" x2="23" y2="23" />
                            </svg>
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          )}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '4px' }}>{i18n.t('settings:nuvio.metadataLanguage')}</label>
                      <input
                        type="text"
                        placeholder="en"
                        value={tmdbLang}
                        onChange={(e) => setTmdbLang(e.target.value)}
                        className="nuvio-input"
                        style={{ width: '80px' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* DEBRID SECTION */}
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{i18n.t('settings:nuvio.debridTitle')}</span>
                  <label className="toggle-switch" style={{ transform: 'scale(0.85)' }}>
                    <input
                      type="checkbox"
                      checked={debridEnabled}
                      onChange={(e) => setDebridEnabled(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                {debridEnabled && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{i18n.t('settings:nuvio.cloudLibrary')}</span>
                      <label className="toggle-switch" style={{ transform: 'scale(0.75)' }}>
                        <input
                          type="checkbox"
                          checked={cloudLibEnabled}
                          onChange={(e) => setCloudLibEnabled(e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '4px' }}>{i18n.t('settings:nuvio.preferredProvider')}</label>
                      <select
                        value={preferredDebrid}
                        onChange={(e) => setPreferredDebrid(e.target.value)}
                        className="nuvio-input"
                        style={{ width: '100%', padding: '9px 12px' }}
                      >
                        <option value="">{i18n.t('settings:nuvio.noProvider')}</option>
                        <option value="realdebrid">Real-Debrid</option>
                        <option value="premiumize">Premiumize</option>
                        <option value="torbox">Torbox</option>
                      </select>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '4px', background: 'var(--bg-tertiary)', padding: '12px', borderRadius: '6px', border: '1px solid var(--surface-border)' }}>
                      <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>{i18n.t('settings:nuvio.providerKeys')}</span>
                      
                      <div>
                        <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>{i18n.t('settings:nuvio.realDebridKey')}</label>
                        <input
                          type="password"
                          placeholder={i18n.t('settings:nuvio.realDebridToken')}
                          value={realDebridKey}
                          onChange={(e) => setRealDebridKey(e.target.value)}
                          className="nuvio-input"
                          style={{ width: '100%', background: 'var(--bg-tertiary)' }}
                        />
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>{i18n.t('settings:nuvio.premiumizeKey')}</label>
                        <input
                          type="password"
                          placeholder={i18n.t('settings:nuvio.premiumizeToken')}
                          value={premiumizeKey}
                          onChange={(e) => setPremiumizeKey(e.target.value)}
                          className="nuvio-input"
                          style={{ width: '100%', background: 'var(--bg-tertiary)' }}
                        />
                      </div>

                      <div>
                        <label style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px' }}>{i18n.t('settings:nuvio.torboxKey')}</label>
                        <input
                          type="password"
                          placeholder={i18n.t('settings:nuvio.torboxToken')}
                          value={torboxKey}
                          onChange={(e) => setTorboxKey(e.target.value)}
                          className="nuvio-input"
                          style={{ width: '100%', background: 'var(--bg-tertiary)' }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* SAVE BUTTON */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
                <button
                  type="button"
                  onClick={handleSaveSettings}
                  disabled={authStore.isSyncing}
                  style={{
                    background: 'linear-gradient(135deg, var(--accent-primary), #0088ff)',
                    border: 'none',
                    color: '#000',
                    borderRadius: '6px',
                    padding: '8px 16px',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: authStore.isSyncing ? 'not-allowed' : 'pointer',
                    opacity: authStore.isSyncing ? 0.7 : 1
                  }}
                >
                  {authStore.isSyncing ? i18n.t('settings:nuvio.saving') : i18n.t('settings:nuvio.saveSettings')}
                </button>
              </div>
            </div>

            {/* Homepage Layout Customization */}
            <div style={{
              background: 'var(--surface-color)',
              border: '1px solid var(--surface-border)',
              borderRadius: '8px',
              padding: '20px',
              marginTop: '20px',
              marginBottom: '24px'
            }}>
              <h4 style={{ margin: '0 0 14px 0', fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {i18n.t('settings:nuvio.homeLayoutTitle')}
              </h4>
              <p style={{ margin: '0 0 20px 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {i18n.t('settings:nuvio.homeLayoutDesc')}
              </p>

              {/* Toggles */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px', borderBottom: '1px solid var(--surface-border)', paddingBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>{i18n.t('settings:nuvio.hideUnreleased')}</span>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px' }}>{i18n.t('settings:nuvio.hideUnreleasedSub')}</div>
                  </div>
                  <label className="toggle-switch" style={{ transform: 'scale(0.85)' }}>
                    <input
                      type="checkbox"
                      checked={hideUnreleased}
                      onChange={(e) => setHideUnreleased(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>{i18n.t('settings:nuvio.hideUnderline')}</span>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px' }}>{i18n.t('settings:nuvio.hideUnderlineSub')}</div>
                  </div>
                  <label className="toggle-switch" style={{ transform: 'scale(0.85)' }}>
                    <input
                      type="checkbox"
                      checked={hideUnderline}
                      onChange={(e) => setHideUnderline(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>{i18n.t('settings:nuvio.landscapePosters')}</span>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '2px' }}>{i18n.t('settings:nuvio.landscapePostersSub')}</div>
                  </div>
                  <label className="toggle-switch" style={{ transform: 'scale(0.85)' }}>
                    <input
                      type="checkbox"
                      checked={landscapePosters}
                      onChange={(e) => setLandscapePosters(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
              </div>

              {/* Continue Watching Style */}
              <div style={{ marginBottom: '20px', borderBottom: '1px solid var(--surface-border)', paddingBottom: '16px' }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>{i18n.t('settings:nuvio.continueWatchingStyle')}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '10px' }}>{i18n.t('settings:nuvio.continueWatchingStyleSub')}</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {['card', 'wide', 'poster'].map((style) => {
                    const current = localStorage.getItem('nuvio_cw_style') || 'card';
                    return (
                      <button
                        key={style}
                        type="button"
                        onClick={() => localStorage.setItem('nuvio_cw_style', style)}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          borderRadius: '6px',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          cursor: 'pointer',
background: current === style ? 'var(--surface-glow)' : 'var(--surface-color)',
border: current === style ? '1px solid var(--accent-primary)' : '1px solid var(--surface-border)',
color: current === style ? 'var(--accent-primary)' : 'var(--text-secondary)',
                          textTransform: 'capitalize',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        {style === 'card' ? i18n.t('settings:nuvio.cwCard') : style === 'wide' ? i18n.t('settings:nuvio.cwWide') : i18n.t('settings:nuvio.cwPoster')}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Hero Catalog Sources */}
              <div style={{ marginBottom: '20px', borderBottom: '1px solid var(--surface-border)', paddingBottom: '16px' }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>{i18n.t('settings:nuvio.heroBannerSources')}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
                  {i18n.t('settings:nuvio.heroBannerSourcesSub')}
                </div>
                  {(() => {
                  // Normalize: handle old string[] format too
                  const raw: any[] = JSON.parse(localStorage.getItem('nuvio_hero_catalogs') || '[]');
                  const heroEntries: { key: string; baseUrl: string }[] = raw.map((e: any) =>
                    typeof e === 'string' ? { key: e, baseUrl: '' } : e
                  );
                  const selectedKeys = heroEntries.map(e => e.key);
                  return (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: selectedKeys.length >= 2 ? '#ff4f4f' : 'var(--text-muted)', letterSpacing: '0.05em' }}>
                          {i18n.t('settings:nuvio.selectedCount', { count: selectedKeys.length })}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            localStorage.setItem('nuvio_hero_catalogs', '[]');
                            window.dispatchEvent(new Event('nuvioHeroCatalogsChanged'));
                          }}
                          style={{
                            background: 'rgba(255,79,79,0.1)',
                            border: '1px solid rgba(255,79,79,0.2)',
                            color: '#ff4f4f',
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            padding: '4px 10px',
                            borderRadius: '5px',
                            cursor: 'pointer',
                          }}
                        >
                          {i18n.t('settings:nuvio.resetSelection')}
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto', paddingRight: '4px' }}>
                        {catalogsList.map((cat) => {
                          const isSelected = selectedKeys.includes(cat.key);
                          const atLimit = selectedKeys.length >= 2;
                          return (
                            <label
                              key={cat.key}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                padding: '6px 10px',
                                borderRadius: '6px',
background: isSelected ? 'var(--surface-glow)' : 'var(--surface-color)',
border: isSelected ? '1px solid var(--accent-glow)' : '1px solid var(--surface-border)',
                                cursor: atLimit && !isSelected ? 'not-allowed' : 'pointer',
                                opacity: atLimit && !isSelected ? 0.4 : 1,
                                transition: 'all 0.15s ease',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                disabled={atLimit && !isSelected}
                                onChange={() => {
                                  const raw: any[] = JSON.parse(localStorage.getItem('nuvio_hero_catalogs') || '[]');
                                  const current: { key: string; baseUrl: string }[] = raw.map((e: any) =>
                                    typeof e === 'string' ? { key: e, baseUrl: '' } : e
                                  );
                                  if (isSelected) {
                                    localStorage.setItem('nuvio_hero_catalogs', JSON.stringify(current.filter((e) => e.key !== cat.key)));
                                  } else if (current.length < 2) {
                                    // Find the addon's baseUrl
                                    const addon = activeAddons.find(a => (a.manifest?.id || a.id) === cat.addonId);
                                    const baseUrl = addon?.baseUrl || cat.addonId;
                                    localStorage.setItem('nuvio_hero_catalogs', JSON.stringify([...current, { key: cat.key, baseUrl }]));
                                  }
                                  window.dispatchEvent(new Event('nuvioHeroCatalogsChanged'));
                                }}
                              />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: '0.8rem', fontWeight: 500, color: isSelected ? 'var(--text-primary)' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {cat.title || cat.catalogId}
                                </div>
                                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                                  {cat.addonName} · {cat.type}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                        {catalogsList.length === 0 && (
                          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: '10px 0' }}>
                            {i18n.t('settings:nuvio.noCatalogs')}
                          </div>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Catalog Rows list */}
              {localCatalogItems.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px', letterSpacing: '0.05em' }}>
                    {i18n.t('settings:nuvio.catalogOrder')}
                  </div>
                  <div
                    ref={catalogListRef}
                    onPointerMove={handleCatalogPointerMove}
                    onPointerUp={handleCatalogPointerUp}
                    onPointerCancel={handleCatalogPointerCancel}
                    style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '400px', overflowY: 'auto', paddingRight: '4px' }}
                  >
                    {localCatalogItems.map((item, index) => {
                      const isDragging = draggingIndex === index;
                      const isDragOver = dragOverIdx === index && draggingIndex !== null && draggingIndex !== index;
                      return (
                        <div
                          key={item.key}
                          style={{
                            background: isDragging
                              ? 'var(--accent-glow, var(--surface-glow))'
                              : isDragOver
                                ? 'var(--surface-color)'
                                : item.enabled ? 'var(--surface-color)' : 'var(--surface-color)',
                            border: isDragging
                              ? '1px solid var(--accent-primary, #00d4ff)'
                              : isDragOver
                                ? '1px dashed var(--accent-primary, #00d4ff)'
                                : '1px solid var(--surface-border)',
                            borderRadius: '6px',
                            padding: '10px 12px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            opacity: isDragging ? 0.7 : (item.enabled ? 1 : 0.6),
                            cursor: isDragging ? 'grabbing' : 'default',
                            transition: 'background 0.2s ease, border-color 0.2s ease, transform 0.1s ease',
                            transform: isDragging ? 'scale(1.02)' : 'none',
                            boxShadow: isDragging ? '0 4px 16px rgba(0, 0, 0, 0.4)' : 'none',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
                            {/* Drag Grip */}
                            <div
                              className="drag-grip"
                              style={{
                                cursor: isDragging ? 'grabbing' : 'grab',
                                padding: '4px 6px',
                                color: isDragging ? 'var(--accent-primary, #00d4ff)' : 'var(--text-muted)',
                                fontSize: '1.2rem',
                                userSelect: 'none',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                touchAction: 'none',
                                transition: 'color 0.15s ease',
                              }}
                              onPointerDown={(e) => handleCatalogPointerDown(e, index)}
                              onMouseEnter={(e) => {
                                if (draggingIndex === null) {
                                  (e.currentTarget as HTMLElement).style.color = 'var(--accent-primary, #00d4ff)';
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (draggingIndex === null) {
                                  (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
                                }
                              }}
                            >
                              ⋮⋮
                            </div>
  
                            {/* Reordering arrows */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                              <button
                                type="button"
                                onClick={() => handleMoveItem(index, 'up')}
                                disabled={index === 0}
                                style={{ background: 'none', border: 'none', color: index === 0 ? 'var(--text-muted)' : 'var(--text-secondary)', cursor: index === 0 ? 'default' : 'pointer', fontSize: '0.8rem', padding: '0 4px', lineHeight: 1 }}
                              >
                                ▲
                              </button>
                              <button
                                type="button"
                                onClick={() => handleMoveItem(index, 'down')}
                                disabled={index === localCatalogItems.length - 1}
                                style={{ background: 'none', border: 'none', color: index === localCatalogItems.length - 1 ? 'var(--text-muted)' : 'var(--text-secondary)', cursor: index === localCatalogItems.length - 1 ? 'default' : 'pointer', fontSize: '0.8rem', padding: '0 4px', lineHeight: 1 }}
                              >
                                ▼
                              </button>
                            </div>
                            
                            {/* Item Details */}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <input
                                type="text"
                                value={item.customTitle !== undefined ? (item.customTitle || item.title) : item.title}
                                placeholder={item.title}
                                onChange={(e) => handleCustomTitleChange(item.key, e.target.value)}
                                style={{
                                  background: 'transparent',
                                  border: 'none',
                                  borderBottom: '1px dashed var(--surface-border)',
                                  color: 'var(--text-primary)',
                                  fontSize: '0.82rem',
                                  fontWeight: 600,
                                  padding: '2px 0',
                                  width: '90%',
                                  outline: 'none'
                                }}
                              />
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                                {item.addonName} · {item.subtitle}
                              </div>
                            </div>
                          </div>
  
                          {/* Enabled Switch */}
                          <label className="toggle-switch" style={{ transform: 'scale(0.8)' }}>
                            <input
                              type="checkbox"
                              checked={item.enabled}
                              onChange={() => handleToggleItem(item.key)}
                            />
                            <span className="toggle-slider" />
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', border: '1px dashed var(--surface-border)', borderRadius: '6px' }}>
                  {i18n.t('settings:nuvio.noCatalogItems')}
                </div>
              )}

              {/* SAVE / RESET ACTIONS */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', borderTop: '1px solid var(--surface-border)', paddingTop: '14px' }}>
                <button
                  type="button"
                  onClick={handleResetCatalogSettings}
                  style={{
                    background: 'none',
                    border: '1px solid rgba(255,79,79,0.2)',
                    color: '#ff4f4f',
                    borderRadius: '6px',
                    padding: '6px 12px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  {i18n.t('settings:nuvio.resetLayout')}
                </button>
                <button
                  type="button"
                  onClick={handleSaveCatalogSettings}
                  disabled={authStore.isSyncing}
                  style={{
                    background: 'linear-gradient(135deg, var(--accent-primary), #0088ff)',
                    border: 'none',
                    color: '#000',
                    borderRadius: '6px',
                    padding: '8px 16px',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    cursor: authStore.isSyncing ? 'not-allowed' : 'pointer',
                    opacity: authStore.isSyncing ? 0.7 : 1
                  }}
                >
                  {authStore.isSyncing ? i18n.t('settings:nuvio.savingLayout') : i18n.t('settings:nuvio.saveLayout')}
                </button>
              </div>
            </div>

            {/* Addons Section */}
            <div style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '20px', marginTop: '20px' }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '0.9rem', fontWeight: 600 }}>{i18n.t('settings:nuvio.addonsTitle')}</h4>
              
              {/* Install Addon form */}
              <form onSubmit={handleAddAddon} style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <input
                  type="text"
                  placeholder={i18n.t('settings:nuvio.addonUrlPlaceholder')}
                  value={addonUrl}
                  onChange={(e) => setAddonUrl(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    fontSize: '0.8rem',
                    color: 'var(--text-primary)',
                    outline: 'none'
                  }}
                />
                <button
                  type="submit"
                  disabled={installingAddon || !addonUrl.trim()}
                  style={{
background: 'var(--surface-glow)',
border: '1px solid var(--accent-glow)',
                    color: 'var(--accent-primary)',
                    borderRadius: '6px',
                    padding: '8px 16px',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: installingAddon ? 'not-allowed' : 'pointer'
                  }}
                >
                  {installingAddon ? i18n.t('common:installing') : i18n.t('common:install')}
                </button>
              </form>
              {addonError && <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginBottom: '14px' }}>{addonError}</div>}
              {addonsStore.error && <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginBottom: '14px' }}>{addonsStore.error}</div>}

              {/* Installed Addons list */}
              {addonsStore.addons.length > 0 ? (
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px', letterSpacing: '0.05em' }}>
                    {i18n.t('settings:nuvio.installedAddons')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {addonsStore.addons.map((addon) => (
                      <div
                        key={`${addon.id}-${addon.baseUrl}`}
                        style={{
                          background: 'var(--surface-color)',
                          border: '1px solid var(--surface-border)',
                          borderRadius: '8px',
                          padding: '12px 14px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center'
                        }}
                      >
                        <div style={{ overflow: 'hidden', marginRight: '10px' }}>
                          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {addon.manifest.name} <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: '4px' }}>v{addon.manifest.version}</span>
                          </div>
                          {addon.manifest.description && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                              {addon.manifest.description}
                            </div>
                          )}
                          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {addon.baseUrl}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                          <button
                            onClick={() => handleToggleAddon(addon.id)}
                            style={{
                              background: 'none',
                              border: '1px solid var(--surface-border)',
                              color: 'var(--text-secondary)',
                              borderRadius: '4px',
                              padding: '4px 8px',
                              fontSize: '0.7rem',
                              cursor: 'pointer'
                            }}
                          >
                            {addon.enabled === false ? i18n.t('common:enable') : i18n.t('common:disable')}
                          </button>
                          <button
                            onClick={() => handleRemoveAddon(addon.id)}
                            style={{
                              background: 'none',
                              border: '1px solid rgba(255,79,79,0.25)',
                              color: '#ff4f4f',
                              borderRadius: '4px',
                              padding: '4px 8px',
                              fontSize: '0.7rem',
                              cursor: 'pointer'
                            }}
                          >
                            {i18n.t('settings:nuvio.uninstall')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '0.8rem',
                  border: '1px dashed var(--surface-border)',
                  borderRadius: '8px'
                }}>
                  {i18n.t('settings:nuvio.noAddons')}
                </div>
              )}
            </div>

            {/* Plugin Scrapers Section */}
            <div style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '20px', marginTop: '20px' }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '0.9rem', fontWeight: 600 }}>{i18n.t('settings:nuvio.pluginsTitle')}</h4>
              
              {/* Toggles */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px' }}>
                <div className="retry-setting-row" style={{ borderBottom: 'none', padding: 0 }}>
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label" style={{ fontSize: '0.85rem' }}>{i18n.t('settings:nuvio.enablePlugins')}</span>
                    <span className="timeshift-toggle-sub" style={{ fontSize: '0.75rem' }}>{i18n.t('settings:nuvio.enablePluginsSub')}</span>
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

                <div className="retry-setting-row" style={{ borderBottom: 'none', padding: 0 }}>
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label" style={{ fontSize: '0.85rem' }}>{i18n.t('settings:nuvio.groupByRepo')}</span>
                    <span className="timeshift-toggle-sub" style={{ fontSize: '0.75rem' }}>{i18n.t('settings:nuvio.groupByRepoSub')}</span>
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

              {/* Install repository form */}
              <form onSubmit={handleAddRepository} style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <input
                  type="text"
                  placeholder={i18n.t('settings:nuvio.pluginUrlPlaceholder')}
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  style={{
                    flex: 1,
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '6px',
                    padding: '8px 10px',
                    fontSize: '0.8rem',
                    color: 'var(--text-primary)',
                    outline: 'none'
                  }}
                />
                <button
                  type="submit"
                  disabled={pluginStore.isLoading}
                  style={{
background: 'var(--surface-glow)',
border: '1px solid var(--accent-glow)',
                    color: 'var(--accent-primary)',
                    borderRadius: '6px',
                    padding: '8px 16px',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: pluginStore.isLoading ? 'not-allowed' : 'pointer'
                  }}
                >
                  {i18n.t('common:install')}
                </button>
              </form>
              {repoError && <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginBottom: '14px' }}>{repoError}</div>}
              {pluginStore.error && <div style={{ color: '#ff4f4f', fontSize: '0.75rem', marginBottom: '14px' }}>{pluginStore.error}</div>}

              {/* Installed Repositories list */}
              {pluginStore.repositories.length > 0 ? (
                <div>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px', letterSpacing: '0.05em' }}>
                    {i18n.t('settings:nuvio.installedRepos')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {pluginStore.repositories.map((repo) => {
                      const repoScrapers = pluginStore.scrapers.filter(s => s.repositoryUrl === repo.manifestUrl);
                      return (
                        <div
                          key={repo.manifestUrl}
                          style={{
                            background: 'var(--surface-color)',
                            border: '1px solid var(--surface-border)',
                            borderRadius: '8px',
                            padding: '12px 14px',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div style={{ overflow: 'hidden', marginRight: '10px' }}>
                              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {repo.name} <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: '4px' }}>v{repo.version}</span>
                              </div>
                              {repo.description && (
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                  {repo.description}
                                </div>
                              )}
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {repo.manifestUrl}
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                              <button
                                onClick={() => pluginStore.refreshRepository(repo.manifestUrl)}
                                disabled={repo.isRefreshing}
                                style={{
                                  background: 'none',
                                  border: '1px solid var(--surface-border)',
                                  color: 'var(--text-secondary)',
                                  borderRadius: '4px',
                                  padding: '4px 8px',
                                  fontSize: '0.7rem',
                                  cursor: repo.isRefreshing ? 'not-allowed' : 'pointer'
                                }}
                              >
                                {repo.isRefreshing ? i18n.t('common:refreshing') : i18n.t('common:refresh')}
                              </button>
                              <button
                                onClick={() => pluginStore.removeRepository(repo.manifestUrl)}
                                style={{
                                  background: 'none',
                                  border: '1px solid rgba(255,79,79,0.25)',
                                  color: '#ff4f4f',
                                  borderRadius: '4px',
                                  padding: '4px 8px',
                                  fontSize: '0.7rem',
                                  cursor: 'pointer'
                                }}
                              >
                                {i18n.t('common:remove')}
                              </button>
                            </div>
                          </div>

                          {repo.errorMessage && (
                            <div style={{ color: '#ff4f4f', fontSize: '0.7rem', marginTop: '6px' }}>
                              {i18n.t('settings:nuvio.errorPrefix')}{repo.errorMessage}
                            </div>
                          )}

                          {/* Scrapers in repository */}
                          {repoScrapers.length > 0 && (
                            <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--surface-border)' }}>
                              <div style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>
                                {i18n.t('settings:nuvio.scrapers')}
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {repoScrapers.map((scraper) => (
                                  <div
                                    key={scraper.id}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      background: 'var(--surface-color)',
                                      borderRadius: '4px',
                                      padding: '6px 8px',
                                    }}
                                  >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                      {scraper.logo ? (
                                        <img src={scraper.logo} alt="" style={{ width: '16px', height: '16px', borderRadius: '2px', objectFit: 'contain' }} />
                                      ) : (
                                        <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent-primary)' }} />
                                      )}
                                      <div>
                                        <span style={{ fontSize: '0.78rem', fontWeight: 500, color: scraper.enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                                          {scraper.name}
                                        </span>
                                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '6px' }}>
                                          v{scraper.version}
                                        </span>
                                      </div>
                                    </div>
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
                </div>
              ) : (
                <div style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '0.8rem',
                  border: '1px dashed var(--surface-border)',
                  borderRadius: '8px'
                }}>
                  {i18n.t('settings:nuvio.noRepos')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Hover Details toggle for Nuvio */}
      <div className="retry-setting-row" style={{ borderBottom: 'none', paddingLeft: '20px', paddingRight: '20px', marginTop: '24px' }}>
        <div className="timeshift-toggle-info">
          <span className="timeshift-toggle-label">{i18n.t('settings:strem.hoverDetails')}</span>
          <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.hoverDetailsSub')}</span>
        </div>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={showNuvioHoverDetails}
            onChange={(e) => onShowNuvioHoverDetailsChange(e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
      </div>

      {/* Trakt Integration Section for Nuvio */}
      <div className="settings-section" style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '24px', marginTop: '24px' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>
          {i18n.t('settings:nuvio.traktTitle')}
        </h3>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          {i18n.t('settings:nuvio.traktDesc')}
        </p>

        <div className="retry-setting-row" style={{ borderBottom: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.connectionStatus')}</span>
            <span className="timeshift-toggle-sub">
              {traktConnected ? i18n.t('settings:nuvio.connectedToTrakt') : i18n.t('settings:nuvio.notConnectedToTrakt')}
            </span>
          </div>
          {!traktConnected ? (
            <button
              onClick={() => onNavigateToSettingsTab?.('scrobbling')}
              className="sync-btn"
              style={{ padding: '6px 12px', fontSize: '0.8rem' }}
            >
              {i18n.t('settings:scrobbling.connectBtn')}
            </button>
          ) : (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: '#2ed573', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 8px', borderRadius: '4px', background: 'rgba(46,213,115,0.1)' }}>
                {i18n.t('settings:scrobbling.connected')}
              </span>
              <button
                onClick={() => setShowTraktModal(true)}
                className="sync-btn"
                style={{ padding: '6px 12px', fontSize: '0.8rem' }}
              >
                {i18n.t('settings:nuvio.addTraktCatalogs')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Stream Auto-Play Settings for Nuvio */}
      <div className="settings-section" style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '24px', marginTop: '24px' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>
          {i18n.t('settings:nuvio.autoplayTitle')}
        </h3>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          {i18n.t('settings:nuvio.autoplayDesc')}
        </p>

        <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.autoStreamSelection')}</span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.autoStreamSelectionSub')}</span>
          </div>
          <select
            value={nuvioAutoPlayMode}
            onChange={(e) => onNuvioAutoPlayModeChange(e.target.value as StreamAutoPlayMode)}
            style={{
              background: 'var(--surface-color)',
              border: '1px solid var(--surface-border)',
              color: 'var(--text-primary)',
              borderRadius: '6px',
              padding: '6px 10px',
              fontSize: '0.8rem',
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            <option value="manual" style={{ background: '#1a1a1a' }}>{i18n.t('settings:nuvio.manualOff')}</option>
            <option value="first-stream" style={{ background: '#1a1a1a' }}>{i18n.t('settings:nuvio.firstStream')}</option>
            <option value="regex-match" style={{ background: '#1a1a1a' }}>{i18n.t('settings:nuvio.regexMatch')}</option>
          </select>
        </div>

        {nuvioAutoPlayMode !== 'manual' && (
          <>
            <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.selectionTimeout', { seconds: nuvioAutoPlayTimeout })}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.selectionTimeoutSub')}</span>
              </div>
              <input
                type="range"
                min="0"
                max="30"
                step="1"
                value={nuvioAutoPlayTimeout}
                onChange={(e) => onNuvioAutoPlayTimeoutChange(Number(e.target.value))}
                style={{
                  width: '120px',
                  accentColor: '#00d4ff',
                }}
              />
            </div>

            <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.sourceScope')}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.sourceScopeSub')}</span>
              </div>
              <select
                value={nuvioAutoPlaySourceScope}
                onChange={(e) => onNuvioAutoPlaySourceScopeChange(e.target.value as StreamAutoPlaySourceScope)}
                style={{
                  background: 'var(--surface-color)',
                  border: '1px solid var(--surface-border)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  fontSize: '0.8rem',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="all" style={{ background: '#1a1a1a' }}>{i18n.t('settings:nuvio.allSources')}</option>
                <option value="installed-addons" style={{ background: '#1a1a1a' }}>{i18n.t('settings:nuvio.installedAddonsOnly')}</option>
                <option value="enabled-plugins" style={{ background: '#1a1a1a' }}>{i18n.t('settings:nuvio.enabledPluginsOnly')}</option>
              </select>
            </div>

            {nuvioAutoPlayMode === 'regex-match' && (
              <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' }}>
                <div className="timeshift-toggle-info" style={{ width: '100%' }}>
                  <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.regexPattern')}</span>
                  <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.regexPatternSub')}</span>
                </div>
                <input
                  type="text"
                  placeholder={i18n.t('settings:nuvio.regexPlaceholder')}
                  value={nuvioAutoPlayRegex}
                  onChange={(e) => onNuvioAutoPlayRegexChange(e.target.value)}
                  style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--surface-border)',
                    color: 'var(--text-primary)',
                    borderRadius: '6px',
                    padding: '8px 12px',
                    fontSize: '0.82rem',
                    outline: 'none',
                    width: '100%',
                    boxSizing: 'border-box',
                    marginTop: '4px'
                  }}
                />
              </div>
            )}

            <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t(nuvioAutoPlayAllowedAddons.length === 0 ? 'settings:nuvio.allowedAddonsAll' : 'settings:nuvio.allowedAddonsCount', { count: nuvioAutoPlayAllowedAddons.length })}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.allowedAddonsSub')}</span>
              </div>
              <button
                onClick={() => setShowAddonDialog(true)}
                style={{
                  background: 'var(--surface-color)',
                  border: '1px solid var(--surface-border)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  outline: 'none'
                }}
              >
                {i18n.t('common:configure')}
              </button>
            </div>

            <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t(nuvioAutoPlayAllowedPlugins.length === 0 ? 'settings:nuvio.allowedPluginsAll' : 'settings:nuvio.allowedPluginsCount', { count: nuvioAutoPlayAllowedPlugins.length })}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.allowedPluginsSub')}</span>
              </div>
              <button
                onClick={() => setShowPluginDialog(true)}
                style={{
                  background: 'var(--surface-color)',
                  border: '1px solid var(--surface-border)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  outline: 'none'
                }}
              >
                {i18n.t('common:configure')}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Cache Fetch Results section for Nuvio */}
      <div className="settings-section" style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '24px', marginTop: '24px' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>
          {i18n.t('settings:nuvio.cacheTitle')}
        </h3>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          {i18n.t('settings:nuvio.cacheDesc')}
        </p>

        <div className="retry-setting-row" style={{ borderBottom: 'none' }}>
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.cacheResults')}</span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.cacheResultsSub')}</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={nuvioCacheFetchResults}
              onChange={(e) => onNuvioCacheFetchResultsChange(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {nuvioCacheFetchResults && (
          <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label">{i18n.t('settings:strem.cacheExpiration', { minutes: nuvioCacheFetchTimeout })}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:strem.cacheExpirationSub')}</span>
            </div>
            <input
              type="range"
              min="1"
              max="30"
              step="1"
              value={nuvioCacheFetchTimeout}
              onChange={(e) => onNuvioCacheFetchTimeoutChange(Number(e.target.value))}
              style={{
                width: '120px',
                accentColor: '#00d4ff',
              }}
            />
          </div>
        )}
      </div>

      {/* Stream Badges section for Nuvio */}
      <div className="settings-section" style={{ borderTop: '1px solid var(--surface-border)', paddingTop: '24px', marginTop: '24px' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-primary)' }}>
          {i18n.t('settings:nuvio.badgesTitle')}
        </h3>
        <p style={{ margin: '0 0 12px 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          {i18n.t('settings:nuvio.badgesDesc')}
        </p>

        <div className="retry-setting-row" style={{ borderBottom: 'none' }}>
          <div className="timeshift-toggle-info">
            <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.enableBadges')}</span>
            <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.enableBadgesSub')}</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={showNuvioStreamBadges}
              onChange={(e) => onShowNuvioStreamBadgesChange(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {showNuvioStreamBadges && (
          <>
            <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px' }}>
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.showFileSize')}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.showFileSizeSub')}</span>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={nuvioShowFileSizeBadges}
                  onChange={(e) => onNuvioShowFileSizeBadgesChange(e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="retry-setting-row" style={{ borderBottom: 'none', marginTop: '12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="timeshift-toggle-info">
                <span className="timeshift-toggle-label">{i18n.t('settings:nuvio.badgePosition')}</span>
                <span className="timeshift-toggle-sub">{i18n.t('settings:nuvio.badgePositionSub')}</span>
              </div>
              <select
                value={nuvioStreamBadgePlacement}
                onChange={(e) => onNuvioStreamBadgePlacementChange(e.target.value as 'top' | 'bottom')}
                style={{
                  background: 'var(--surface-color)',
                  border: '1px solid var(--surface-border)',
                  color: 'var(--text-primary)',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  fontSize: '0.8rem',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="bottom" style={{ background: '#1a1a1a' }}>{i18n.t('settings:nuvio.bottom')}</option>
                <option value="top" style={{ background: '#1a1a1a' }}>{i18n.t('settings:nuvio.top')}</option>
              </select>
            </div>

            <div className="retry-setting-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'stretch', gap: '10px', marginTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <span className="timeshift-toggle-label" style={{ fontSize: '0.85rem' }}>{i18n.t('settings:nuvio.badgeScale', { percent: nuvioBadgeSize })}</span>
              </div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', width: '100%', boxSizing: 'border-box' }}>
                <input
                  type="range"
                  min="80"
                  max="180"
                  step="5"
                  value={nuvioBadgeSize}
                  onChange={(e) => onNuvioBadgeSizeChange(Number(e.target.value))}
                  style={{
                    flex: 1,
                    accentColor: '#00d4ff',
                    cursor: 'pointer',
                    height: '6px',
                    borderRadius: '3px',
                    background: 'var(--surface-color)',
                    outline: 'none',
                  }}
                />
              </div>
              <div style={{ padding: '12px 16px', background: 'var(--bg-tertiary)', borderRadius: '8px', border: '1px solid var(--surface-border)', width: '100%', boxSizing: 'border-box' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 700, letterSpacing: '0.05em' }}>
                  {i18n.t('settings:nuvio.livePreview')}
                </div>
                <div className="stremio-detail-stream-badges" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', '--stremio-badge-scale': String(nuvioBadgeSize / 100) } as React.CSSProperties}>
                  <span className="stremio-stream-badge-img" style={{ backgroundColor: '#ffffff', borderColor: '#ffffff' }}>
                    <img src="https://raw.githubusercontent.com/nobnobz/Omni-Template-Bot-Bid-Raiser/main/Other/regex%20tags/4k.png" alt="4K" />
                  </span>
                  <span className="stremio-stream-badge-img" style={{ backgroundColor: '#ffffff', borderColor: '#ffffff' }}>
                    <img src="https://raw.githubusercontent.com/nobnobz/Omni-Template-Bot-Bid-Raiser/main/Other/regex%20tags/HDR.png" alt="HDR" />
                  </span>
                  <span className="stremio-stream-badge-img" style={{ backgroundColor: '#ffffff', borderColor: '#ffffff' }}>
                    <img src="https://raw.githubusercontent.com/ngreyx1/badges/refs/heads/main/images%20w:o%20logo/webdl-black.png" alt="WEB-DL" />
                  </span>
                  <span className="stremio-stream-badge-img" style={{ backgroundColor: '#ffffff', borderColor: '#ffffff' }}>
                    <img src="https://raw.githubusercontent.com/nobnobz/Omni-Template-Bot-Bid-Raiser/main/Other/regex%20tags/51.png" alt="5.1" />
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Fusion Badge Rules Importer */}
        <div style={{ marginTop: '20px', borderTop: '1px solid var(--surface-border)', paddingTop: '16px' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
            {i18n.t('settings:nuvio.fusionTitle')}
          </div>

          <input
            type="text"
            placeholder={i18n.t('settings:nuvio.fusionUrlPlaceholder')}
            value={badgeUrl}
            onChange={(e) => setBadgeUrl(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--surface-color)',
              border: '1px solid var(--surface-border)',
              color: 'var(--text-primary)',
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '0.8rem',
              outline: 'none',
              boxSizing: 'border-box',
              marginBottom: '8px',
            }}
          />

          <textarea
            placeholder={i18n.t('settings:nuvio.fusionPastePlaceholder')}
            value={badgePaste}
            onChange={(e) => setBadgePaste(e.target.value)}
            rows={3}
            style={{
              width: '100%',
              background: 'var(--surface-color)',
              border: '1px solid var(--surface-border)',
              color: 'var(--text-primary)',
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              outline: 'none',
              boxSizing: 'border-box',
              resize: 'vertical',
              marginBottom: '8px',
            }}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <button
              onClick={handleImportBadge}
              disabled={badgeImporting}
              style={{
background: 'var(--surface-glow)',
border: '1px solid var(--accent-glow)',
color: 'var(--accent-primary)',
                borderRadius: '6px',
                padding: '7px 16px',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: badgeImporting ? 'not-allowed' : 'pointer',
                opacity: badgeImporting ? 0.6 : 1,
              }}
            >
              {badgeImporting ? i18n.t('common:importing') : i18n.t('common:import')}
            </button>
            {badgeImportError && (
              <span style={{ fontSize: '0.75rem', color: '#ef4444' }}>{badgeImportError}</span>
            )}
          </div>

          {/* Imported Sources List */}
          {nuvioBadgeSources.length > 0 && (
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '8px', letterSpacing: '0.05em' }}>
                {i18n.t('settings:nuvio.importedSources')}
              </div>
              {nuvioBadgeSources.map((source) => {
                const isExpanded = expandedSourceUrl === source.url;
                return (
                  <div
                    key={source.url}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      background: 'var(--surface-color)',
                      border: `1px solid ${source.isActive ? 'var(--accent-glow)' : 'var(--surface-border)'}`,
                      marginBottom: '4px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <div
                        onClick={() => setExpandedSourceUrl(isExpanded ? null : source.url)}
                        style={{ flex: 1, overflow: 'hidden', cursor: 'pointer' }}
                      >
                        <div style={{
                          fontSize: '0.8rem',
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                        }}>
                          <span>{source.name}</span>
                          <span style={{
                            fontSize: '0.55rem',
                            color: 'var(--text-muted)',
                            transform: isExpanded ? 'rotate(90deg)' : 'none',
                            transition: 'transform 0.15s',
                            display: 'inline-block',
                          }}>
                            ▶
                          </span>
                        </div>
                        <div style={{
                          fontSize: '0.65rem',
                          color: 'var(--text-muted)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {i18n.t('settings:nuvio.filtersGroups', { filters: source.payload.filters.length, groups: source.payload.groups.length })}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '6px', marginLeft: '8px' }}>
                        <button
                          onClick={() => handleToggleSource(source.url)}
                          title={source.isActive ? i18n.t('common:active') : i18n.t('settings:nuvio.clickToActivate')}
                          style={{
                            background: source.isActive ? 'var(--surface-glow)' : 'var(--surface-color)',
                            border: `1px solid ${source.isActive ? 'var(--accent-glow)' : 'var(--surface-border)'}`,
                            color: source.isActive ? 'var(--accent-primary)' : 'var(--text-muted)',
                            borderRadius: '4px',
                            padding: '3px 8px',
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {source.isActive ? i18n.t('common:active') : i18n.t('common:inactive')}
                        </button>
                        {!source.isDefault && (
                          <button
                            onClick={() => handleDeleteSource(source.url)}
                            title={i18n.t('common:remove')}
                            style={{
                              background: 'rgba(239,68,68,0.1)',
                              border: '1px solid rgba(239,68,68,0.2)',
                              color: '#ef4444',
                              borderRadius: '4px',
                              padding: '3px 8px',
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            {i18n.t('common:delete')}
                          </button>
                        )}
                      </div>
                    </div>

                    {isExpanded && (
                      <div style={{
                        marginTop: '8px',
                        paddingTop: '8px',
                        borderTop: '1px solid var(--surface-border)',
                        width: '100%',
                        boxSizing: 'border-box'
                      }}>
                        <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '8px', fontWeight: 700, letterSpacing: '0.03em' }}>
                          {i18n.t('settings:nuvio.previewBadges', { count: source.payload.filters.length })}
                        </div>
                        <div className="stremio-detail-stream-badges" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', '--stremio-badge-scale': 'var(--nuvio-badge-scale, 1)' } as React.CSSProperties}>
                          {source.payload.filters.map((filter, fIdx) => {
                            const bgColor = convertArgbToRgba(filter.tagColor) || '#1a1a1a';
                            const isLightBg = isLightColor(bgColor);
                            const textColor = convertArgbToRgba(filter.textColor) || (isLightBg ? '#000000' : '#ffffff');
                            const borderColor = convertArgbToRgba(filter.borderColor) || 'transparent';

                            return filter.imageURL ? (
                              <span
                                key={filter.id || fIdx}
                                className="stremio-stream-badge-img"
                                style={{
                                  backgroundColor: bgColor,
                                  borderColor: borderColor,
                                }}
                              >
                                <img src={filter.imageURL} alt={filter.name} title={filter.name} />
                              </span>
                            ) : (
                              <span
                                key={filter.id || fIdx}
                                className="stremio-stream-badge"
                                style={{
                                  backgroundColor: bgColor,
                                  color: textColor,
                                  borderColor: borderColor,
                                }}
                              >
                                {filter.name}
                              </span>
                            );
                          })}
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

      {pinPromptProfile && (
        <NuvioPinModal
          profile={pinPromptProfile}
          onClose={() => setPinPromptProfile(null)}
        />
      )}

      {showAddonDialog && (
        <div className="nuvio-pin-modal-overlay" style={{ zIndex: 3000 }} onClick={() => setShowAddonDialog(false)}>
          <div className="nuvio-pin-modal-card" style={{ width: '400px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '10px' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>{i18n.t('settings:nuvio.allowedAddonsTitle')}</h3>
              <button
                onClick={() => setShowAddonDialog(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '1.2rem',
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                ✕
              </button>
            </div>
            
            <p style={{ margin: '0 0 16px 0', fontSize: '0.8rem', color: 'var(--text-muted)', width: '100%' }}>
              {i18n.t('settings:nuvio.allowedAddonsModalDesc')}
            </p>

            <div style={{
              flex: 1,
              width: '100%',
              overflowY: 'auto',
              minHeight: '200px',
              maxHeight: '350px',
              paddingRight: '4px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              {(() => {
                const uniqueAddonNames = Array.from(new Set((addonsStore.enabledAddons || []).map(a => a.manifest?.name || a.id).filter(Boolean)));
                if (uniqueAddonNames.length === 0) {
                  return <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>{i18n.t('settings:nuvio.noActiveAddons')}</div>;
                }
                return uniqueAddonNames.map(name => {
                  const isChecked = nuvioAutoPlayAllowedAddons.includes(name);
                  return (
                    <label
                      key={name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
background: isChecked ? 'var(--surface-glow)' : 'var(--surface-color)',
border: `1px solid ${isChecked ? 'var(--accent-glow)' : 'var(--surface-border)'}`,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      <span style={{ fontSize: '0.85rem', color: isChecked ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{name}</span>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          const next = isChecked
                            ? nuvioAutoPlayAllowedAddons.filter(n => n !== name)
                            : [...nuvioAutoPlayAllowedAddons, name];
                          onNuvioAutoPlayAllowedAddonsChange(next);
                        }}
                        style={{
                          accentColor: '#00d4ff',
                          cursor: 'pointer',
                          width: '16px',
                          height: '16px'
                        }}
                      />
                    </label>
                  );
                });
              })()}
            </div>

            <div style={{ marginTop: '20px', width: '100%', display: 'flex', gap: '10px' }}>
              <button
                className="nuvio-pin-btn nuvio-pin-btn-cancel"
                onClick={() => onNuvioAutoPlayAllowedAddonsChange([])}
              >
                {i18n.t('common:clearAll')}
              </button>
              <button
                className="nuvio-pin-btn nuvio-pin-btn-submit"
                onClick={() => setShowAddonDialog(false)}
              >
                {i18n.t('common:done')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPluginDialog && (
        <div className="nuvio-pin-modal-overlay" style={{ zIndex: 3000 }} onClick={() => setShowPluginDialog(false)}>
          <div className="nuvio-pin-modal-card" style={{ width: '400px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '10px' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' }}>{i18n.t('settings:nuvio.allowedPluginsTitle')}</h3>
              <button
                onClick={() => setShowPluginDialog(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '1.2rem',
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                ✕
              </button>
            </div>
            
            <p style={{ margin: '0 0 16px 0', fontSize: '0.8rem', color: 'var(--text-muted)', width: '100%' }}>
              {i18n.t('settings:nuvio.allowedPluginsModalDesc')}
            </p>

            <div style={{
              flex: 1,
              width: '100%',
              overflowY: 'auto',
              minHeight: '200px',
              maxHeight: '350px',
              paddingRight: '4px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              {(() => {
                const uniquePluginNames = Array.from(new Set((pluginStore.scrapers || []).filter(s => s.enabled).map(s => s.name).filter(Boolean)));
                if (uniquePluginNames.length === 0) {
                  return <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', padding: '40px 0' }}>{i18n.t('settings:nuvio.noActivePlugins')}</div>;
                }
                return uniquePluginNames.map(name => {
                  const isChecked = nuvioAutoPlayAllowedPlugins.includes(name);
                  return (
                    <label
                      key={name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
background: isChecked ? 'var(--surface-glow)' : 'var(--surface-color)',
border: `1px solid ${isChecked ? 'var(--accent-glow)' : 'var(--surface-border)'}`,
                        borderRadius: '8px',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      <span style={{ fontSize: '0.85rem', color: isChecked ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{name}</span>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {
                          const next = isChecked
                            ? nuvioAutoPlayAllowedPlugins.filter(n => n !== name)
                            : [...nuvioAutoPlayAllowedPlugins, name];
                          onNuvioAutoPlayAllowedPluginsChange(next);
                        }}
                        style={{
                          accentColor: '#00d4ff',
                          cursor: 'pointer',
                          width: '16px',
                          height: '16px'
                        }}
                      />
                    </label>
                  );
                });
              })()}
            </div>

            <div style={{ marginTop: '20px', width: '100%', display: 'flex', gap: '10px' }}>
              <button
                className="nuvio-pin-btn nuvio-pin-btn-cancel"
                onClick={() => onNuvioAutoPlayAllowedPluginsChange([])}
              >
                {i18n.t('common:clearAll')}
              </button>
              <button
                className="nuvio-pin-btn nuvio-pin-btn-submit"
                onClick={() => setShowPluginDialog(false)}
              >
                {i18n.t('common:done')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTraktModal && (
        <TraktCatalogsModal
          type="nuvio"
          onClose={() => setShowTraktModal(false)}
        />
      )}

      <ModalComponent />
    </div>
  );
});
