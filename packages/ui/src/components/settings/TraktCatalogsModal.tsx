import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { scrobbler, TRAKT_CATALOG_DEFINITIONS } from '../../services/scrobbler';
import { useSetTraktCatalogRefreshToken } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import '../Modal.css';
import './PlaybackTab.css';

interface TraktCatalogsModalProps {
  type: 'strem' | 'nuvio';
  onClose: () => void;
}

export function TraktCatalogsModal({ type, onClose }: TraktCatalogsModalProps) {
  const isNuvio = type === 'nuvio';
  useTranslation();
  const bumpRefreshToken = useSetTraktCatalogRefreshToken();

  const [catalogSettings, setCatalogSettings] = useState<Record<string, boolean>>({});
  const [catalogOrder, setCatalogOrder] = useState<string[]>([]);
  const [catalogsBeforeAddon, setCatalogsBeforeAddon] = useState(false);
  const [traktEnabledLists, setTraktEnabledLists] = useState<{ id: string; name: string }[]>([]);

  // Nuvio settings
  const [nuvioCatalogSettings, setNuvioCatalogSettings] = useState<Record<string, boolean>>({});
  const [nuvioCatalogOrder, setNuvioCatalogOrder] = useState<string[]>([]);
  const [nuvioCatalogsBeforeAddon, setNuvioCatalogsBeforeAddon] = useState(false);
  const [nuvioTraktEnabledLists, setNuvioTraktEnabledLists] = useState<{ id: string; name: string }[]>([]);

  const [traktLists, setTraktLists] = useState<{ id: { trakt: number; slug: string }; name: string }[]>([]);
  const [listsLoading, setListsLoading] = useState(false);

  const loadSettings = async () => {
    // Settings live in the store (hydrated at boot; setters keep it current).
    const s = useSettingsStore.getState();

    setCatalogSettings(s.traktCatalogsEnabled || {});
    setCatalogOrder(s.traktCatalogOrder || []);
    setCatalogsBeforeAddon(s.traktCatalogsBeforeAddon ?? false);
    setTraktEnabledLists(s.traktEnabledLists || []);

    // Load Nuvio settings
    setNuvioCatalogSettings(s.traktNuvioCatalogsEnabled || {});
    setNuvioCatalogOrder(s.traktNuvioCatalogOrder || []);
    setNuvioCatalogsBeforeAddon(s.traktNuvioCatalogsBeforeAddon ?? false);
    setNuvioTraktEnabledLists(s.traktNuvioEnabledLists || []);
  };

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSettingUpdate = (update: any) => {
    useSettingsStore.getState().setTraktSettings(update);
  };

  const handleCatalogToggle = async (catType: string, enabled: boolean) => {
    const currentSettings = isNuvio ? nuvioCatalogSettings : catalogSettings;
    const currentOrder = isNuvio ? nuvioCatalogOrder : catalogOrder;

    const nextSettings = { ...currentSettings, [catType]: enabled };
    let nextOrder = currentOrder;
    if (enabled && !nextOrder.includes(catType)) {
      nextOrder = [...nextOrder, catType];
    }

    if (isNuvio) {
      setNuvioCatalogSettings(nextSettings);
      setNuvioCatalogOrder(nextOrder);
      await handleSettingUpdate({
        traktNuvioCatalogsEnabled: nextSettings,
        traktNuvioCatalogOrder: nextOrder,
      });
    } else {
      setCatalogSettings(nextSettings);
      setCatalogOrder(nextOrder);
      await handleSettingUpdate({
        traktCatalogsEnabled: nextSettings,
        traktCatalogOrder: nextOrder,
      });
    }
    bumpRefreshToken(Date.now());
  };

  const handleListToggle = async (listId: string, listName: string, enabled: boolean) => {
    const key = `list-${listId}`;
    const currentEnabledLists = isNuvio ? nuvioTraktEnabledLists : traktEnabledLists;
    const currentOrder = isNuvio ? nuvioCatalogOrder : catalogOrder;

    const nextEnabledLists = enabled
      ? [...currentEnabledLists, { id: listId, name: listName }]
      : currentEnabledLists.filter(l => l.id !== listId);

    let nextOrder = currentOrder;
    if (enabled && !nextOrder.includes(key)) {
      nextOrder = [...nextOrder, key];
    }

    if (isNuvio) {
      setNuvioTraktEnabledLists(nextEnabledLists);
      setNuvioCatalogOrder(nextOrder);
      await handleSettingUpdate({
        traktNuvioEnabledLists: nextEnabledLists,
        traktNuvioCatalogOrder: nextOrder,
      });
    } else {
      setTraktEnabledLists(nextEnabledLists);
      setCatalogOrder(nextOrder);
      await handleSettingUpdate({
        traktEnabledLists: nextEnabledLists,
        traktCatalogOrder: nextOrder,
      });
    }
    bumpRefreshToken(Date.now());
  };

  const toggleCatalogsBeforeAddon = async (before: boolean) => {
    if (isNuvio) {
      setNuvioCatalogsBeforeAddon(before);
      await handleSettingUpdate({ traktNuvioCatalogsBeforeAddon: before });
    } else {
      setCatalogsBeforeAddon(before);
      await handleSettingUpdate({ traktCatalogsBeforeAddon: before });
    }
    bumpRefreshToken(Date.now());
  };

  const loadTraktLists = async () => {
    setListsLoading(true);
    try {
      const lists = await scrobbler.fetchTraktLists();
      setTraktLists(lists);
    } catch (e) {
      console.error('Failed to load Trakt lists:', e);
    }
    setListsLoading(false);
  };

  const currentSettings = isNuvio ? nuvioCatalogSettings : catalogSettings;
  const currentOrder = isNuvio ? nuvioCatalogOrder : catalogOrder;
  const currentEnabledLists = isNuvio ? nuvioTraktEnabledLists : traktEnabledLists;
  const currentBeforeAddon = isNuvio ? nuvioCatalogsBeforeAddon : catalogsBeforeAddon;

  // Build ordered catalog list
  const allEntries: { key: string; label: string; description: string; isEnabled: boolean }[] = [];

  for (const def of TRAKT_CATALOG_DEFINITIONS) {
    allEntries.push({
      key: def.type,
      label: def.label,
      description: def.description,
      isEnabled: currentSettings[def.type] === true,
    });
  }

  for (const list of traktLists) {
    allEntries.push({
      key: `list-${list.id.slug}`,
      label: list.name,
      description: i18n.t('settings:traktCatalogs.yourCustomList'),
      isEnabled: currentEnabledLists.some(l => l.id === list.id.slug),
    });
  }

  const ordered: typeof allEntries = [];
  const disabled: typeof allEntries = [];

  if (currentOrder.length > 0) {
    for (const key of currentOrder) {
      const entry = allEntries.find(e => e.key === key);
      if (entry && entry.isEnabled) ordered.push(entry);
    }
    for (const entry of allEntries) {
      if (entry.isEnabled && !ordered.find(o => o.key === entry.key)) ordered.push(entry);
      if (!entry.isEnabled) disabled.push(entry);
    }
  } else {
    for (const entry of allEntries) {
      if (entry.isEnabled) ordered.push(entry);
      else disabled.push(entry);
    }
  }

  // Drag-and-drop reordering
  const dragFromIdx = useRef<number | null>(null);
  const dragListRef = useRef<HTMLDivElement>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const getIndexFromClientY = useCallback((clientY: number): number => {
    if (!dragListRef.current) return 0;
    const children = Array.from(dragListRef.current.children) as HTMLElement[];
    for (let i = 0; i < children.length; i++) {
      const rect = children[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return Math.max(0, children.length - 1);
  }, []);

  const handleDragPointerDown = useCallback((e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragFromIdx.current = index;
    setDragOverIdx(index);
  }, []);

  const handleDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragFromIdx.current === null) return;
    e.preventDefault();
    setDragOverIdx(getIndexFromClientY(e.clientY));
  }, [getIndexFromClientY]);

  const handleDragPointerUp = useCallback(async (e: React.PointerEvent) => {
    if (dragFromIdx.current === null) return;
    const from = dragFromIdx.current;
    const to = getIndexFromClientY(e.clientY);
    dragFromIdx.current = null;
    setDragOverIdx(null);
    if (from === to) return;
    const next = ordered.map(entry => entry.key);
    const [removed] = next.splice(from, 1);
    next.splice(to, 0, removed);

    if (isNuvio) {
      setNuvioCatalogOrder(next);
      await handleSettingUpdate({ traktNuvioCatalogOrder: next });
    } else {
      setCatalogOrder(next);
      await handleSettingUpdate({ traktCatalogOrder: next });
    }
    bumpRefreshToken(Date.now());
  }, [ordered, getIndexFromClientY, bumpRefreshToken, isNuvio]);

  const handleDragPointerCancel = useCallback(() => {
    dragFromIdx.current = null;
    setDragOverIdx(null);
  }, []);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '560px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h3 className="modal-title">{isNuvio ? i18n.t('settings:traktCatalogs.nuvioTitle') : i18n.t('settings:traktCatalogs.stremTitle')}</h3>
          <button className="modal-close-btn" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="modal-body strem-catalogs-modal-body" style={{ maxHeight: '60vh', overflowY: 'auto', paddingBottom: '8px' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0 0 16px 0', lineHeight: '1.5' }}>
            {isNuvio
              ? i18n.t('settings:traktCatalogs.nuvioSub')
              : i18n.t('settings:traktCatalogs.stremSub')}
          </p>

          {/* Position toggle */}
          <div className="timeshift-toggle-row" style={{ padding: '10px 0', marginBottom: '12px' }}>
            <div className="timeshift-toggle-info">
              <span className="timeshift-toggle-label" style={{ fontSize: '0.9rem' }}>{i18n.t('settings:traktCatalogs.showBeforeAddon')}</span>
              <span className="timeshift-toggle-sub">{i18n.t('settings:traktCatalogs.showBeforeAddonSub')}</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={currentBeforeAddon}
                onChange={(e) => toggleCatalogsBeforeAddon(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          {/* Enabled catalogs with reorder */}
          {ordered.length > 0 && (
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                {i18n.t('settings:traktCatalogs.enabledCatalogs')}
                <span style={{ marginLeft: '8px', fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  ({i18n.t('settings:traktCatalogs.dragReorder')})
                </span>
              </div>
              <div
                ref={dragListRef}
                onPointerMove={handleDragPointerMove}
                onPointerUp={handleDragPointerUp}
                onPointerCancel={handleDragPointerCancel}
                style={{ touchAction: 'none' }}
              >
                {ordered.map((entry, idx) => {
                  const isDragging = dragFromIdx.current === idx;
                  const isDragOver = dragOverIdx === idx && dragFromIdx.current !== null && dragFromIdx.current !== idx;
                  return (
                    <div
                      key={entry.key}
                      className="timeshift-toggle-row"
                      style={{
                        padding: '10px 0',
                        opacity: isDragging ? 0.6 : 1,
                        borderTop: isDragOver ? '3px solid #00d4ff' : '1px solid var(--surface-border)',
                        background: isDragging ? 'var(--surface-glow)' : 'transparent',
                        transform: isDragging ? 'scale(1.01)' : 'none',
                        transition: 'opacity 0.15s, transform 0.15s',
                      }}
                    >
                      <span
                        style={{
                          touchAction: 'none',
                          cursor: 'grab',
                          userSelect: 'none',
                          color: 'var(--text-muted)',
                          fontSize: '1.1rem',
                          lineHeight: 1,
                          padding: '4px 6px 4px 2px',
                        }}
                        onPointerDown={(e) => handleDragPointerDown(e, idx)}
                      >⋮⋮</span>
                      <div className="timeshift-toggle-info">
                        <span className="timeshift-toggle-label" style={{ fontSize: '0.9rem' }}>{entry.label}</span>
                        <span className="timeshift-toggle-sub">{entry.description}</span>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={true}
                          onChange={(e) => {
                            if (!e.target.checked) {
                              if (entry.key.startsWith('list-')) {
                                const slug = entry.key.slice(5);
                                handleListToggle(slug, entry.label, false);
                              } else {
                                handleCatalogToggle(entry.key, false);
                              }
                            }
                          }}
                        />
                        <span className="toggle-slider"></span>
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Disabled catalogs */}
          {disabled.length > 0 && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '8px' }}>
                {i18n.t('settings:traktCatalogs.disabledCatalogs')}
              </div>
              {disabled.map((entry) => (
                <div key={entry.key} className="timeshift-toggle-row" style={{ padding: '10px 0' }}>
                  <div className="timeshift-toggle-info">
                    <span className="timeshift-toggle-label" style={{ fontSize: '0.9rem' }}>{entry.label}</span>
                    <span className="timeshift-toggle-sub">{entry.description}</span>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={(e) => {
                        if (e.target.checked) {
                          if (entry.key.startsWith('list-')) {
                            const slug = entry.key.slice(5);
                            handleListToggle(slug, entry.label, true);
                          } else {
                            handleCatalogToggle(entry.key, true);
                          }
                        }
                      }}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>
              ))}
            </div>
          )}

          {/* Load custom lists button */}
          <div style={{ marginTop: '8px' }}>
            <button
              className="sync-btn"
              onClick={loadTraktLists}
              disabled={listsLoading}
              style={{ padding: '6px 16px', fontSize: '0.85rem' }}
            >
              {listsLoading ? i18n.t('common:loading') : i18n.t('settings:traktCatalogs.loadMyLists')}
            </button>
            {traktLists.length === 0 && !listsLoading && (
              <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '8px 0 0 0', lineHeight: '1.5' }}>
                {i18n.t('settings:traktCatalogs.loadListsHint')}
              </p>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn-primary" onClick={onClose}>
            {i18n.t('common:done')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
