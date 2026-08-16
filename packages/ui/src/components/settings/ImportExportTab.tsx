import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import i18n, { translateNativeError } from '../../i18n';
import { exportAllData, importAllData } from '../../utils/exportImport';
import { RecoveryScreen } from '../RecoveryScreen';
import { getDbHealth, isDbUnhealthy, formatBytes, RECOVERY_SCREEN_ENABLED, type DbHealth } from '../../services/recovery';
import {
    runAutoBackupNow,
    listBackups,
    getBackupDirPath,
    openBackupFolder,
    getLastBackupAt,
    pickBackupFolder,
    hasCustomBackupDir
} from '../../services/autoBackup';
import { useSettingsStore } from '../../stores/settingsStore';

export function ImportExportTab() {
    useTranslation();
    const [isProcessing, setIsProcessing] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [showImportConfirm, setShowImportConfirm] = useState(false);
    const [showRestartConfirm, setShowRestartConfirm] = useState(false);
    const [recoveryHealth, setRecoveryHealth] = useState<DbHealth | null>(null);
    const [checkingHealth, setCheckingHealth] = useState(false);
    const [healthChecked, setHealthChecked] = useState(false);

    // Automated backup settings
    // Auto-backup settings — settings-store backed (single source of truth)
    const autoBackupEnabled = useSettingsStore((s) => s.autoBackupEnabled);
    const autoBackupIntervalHours = useSettingsStore((s) => s.autoBackupIntervalHours);
    const autoBackupMaxBackups = useSettingsStore((s) => s.autoBackupMaxBackups);
    const setAutoBackupSettings = useSettingsStore((s) => s.setAutoBackupSettings);
    const [autoBackupProcessing, setAutoBackupProcessing] = useState(false);
    const [autoBackupStatus, setAutoBackupStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [backupFolder, setBackupFolder] = useState('');
    const [backupCount, setBackupCount] = useState(0);
    const [lastBackupAt, setLastBackupAt] = useState<number | null>(getLastBackupAt());
    const [isCustomFolder, setIsCustomFolder] = useState(false);

    useEffect(() => {
        const load = async () => {
            try {
                const dir = await getBackupDirPath();
                setBackupFolder(dir);
                setIsCustomFolder(await hasCustomBackupDir());
                setBackupCount((await listBackups(dir)).length);
            } catch (e) {
                console.warn('[ImportExport] Failed to load backup folder info:', e);
            }
        };
        load();
    }, []);

    const handleAutoBackupEnabledChange = (enabled: boolean) => {
        setAutoBackupSettings({ enabled });
    };

    const handleAutoBackupIntervalChange = (hours: number) => {
        setAutoBackupSettings({ intervalHours: hours });
    };

    const handleAutoBackupMaxBackupsChange = (max: number) => {
        setAutoBackupSettings({ maxBackups: max });
    };

    const handleBackupNow = async () => {
        setAutoBackupProcessing(true);
        setAutoBackupStatus(null);
        try {
            const result = await runAutoBackupNow();
            if (result.success) {
                setAutoBackupStatus({
                    type: 'success',
                    message: i18n.t('settings:exportImport.autoBackup.backupNowSuccess', { filePath: result.filePath })
                });
                setLastBackupAt(Date.now());
            } else {
                setAutoBackupStatus({
                    type: 'error',
                    message: i18n.t('settings:exportImport.autoBackup.backupNowError', { error: result.error || '' })
                });
            }
        } catch (e) {
            setAutoBackupStatus({ type: 'error', message: String(e) });
        } finally {
            setAutoBackupProcessing(false);
            try {
                setBackupCount((await listBackups(await getBackupDirPath())).length);
            } catch (e) {
                // Ignore listing errors after a manual backup.
            }
        }
    };

    const handleChooseFolder = async () => {
        const dir = await pickBackupFolder();
        if (!dir) return;
        setIsCustomFolder(true);
        setBackupFolder(dir);
        setAutoBackupSettings({ directory: dir });
        try {
            setBackupCount((await listBackups(dir)).length);
        } catch (e) {
            // Ignore listing errors right after choosing a folder.
        }
    };

    const handleUseDefaultFolder = async () => {
        setIsCustomFolder(false);
        setAutoBackupSettings({ directory: '' });
        try {
            const dir = await getBackupDirPath();
            setBackupFolder(dir);
            setBackupCount((await listBackups(dir)).length);
        } catch (e) {
            // Ignore listing errors when resetting the folder.
        }
    };

    const handleCheckHealth = async () => {
        setCheckingHealth(true);
        setHealthChecked(false);
        try {
            const health = await getDbHealth();
            setRecoveryHealth(health);
            setHealthChecked(true);
        } catch (error) {
            console.error('[Settings] Failed to check database health:', error);
            setStatus({ type: 'error', message: String(error) });
        } finally {
            setCheckingHealth(false);
        }
    };

    const handleExport = async () => {
        setIsProcessing(true);
        setStatus(null);
        try {
            const result = await exportAllData();
            if (result.success) {
                setStatus({
                    type: 'success',
                    message: i18n.t('settings:importExport.exportSuccess', { filePath: result.filePath })
                });
            } else if (result.error) {
                setStatus({ type: 'error', message: translateNativeError(result.error) || result.error });
            }
        } catch (error) {
            setStatus({ type: 'error', message: translateNativeError(String(error)) || String(error) });
        } finally {
            setIsProcessing(false);
        }
    };

    const confirmImport = async () => {
        setShowImportConfirm(false);
        setIsProcessing(true);
        setStatus(null);
        try {
            const result = await importAllData();
            if (result.success) {
                // Show restart confirmation modal instead of native confirm
                setShowRestartConfirm(true);
            } else if (result.error) {
                setStatus({ type: 'error', message: translateNativeError(result.error) || result.error });
            }
        } catch (error) {
            setStatus({ type: 'error', message: translateNativeError(String(error)) || String(error) });
        } finally {
            setIsProcessing(false);
        }
    };

    const handleRestart = () => {
        console.log('[Import] User confirmed restart');
        setShowRestartConfirm(false);
        // Small delay to ensure modal closes before reload
        setTimeout(() => {
            window.location.reload();
        }, 100);
    };

    const handleImportClick = () => {
        setShowImportConfirm(true);
    };

    return (
        <div className="settings-tab-content">
            {/* System Backup & Restoration - Main header */}
            <div className="settings-section" style={{ paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:exportImport.title')}</h3>
                </div>
                <p className="section-description">
                    {i18n.t('settings:exportImport.description')}
                </p>

                {status && (
                    <div className={`sync-status-item ${status.type === 'success' ? 'success' : 'error'}`} style={{ marginBottom: '16px' }}>
                        <span className="status-name">{status.message}</span>
                    </div>
                )}
            </div>

            {/* Export Configuration */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:exportImport.exportTitle')}</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    {i18n.t('settings:exportImport.exportDescription')}<br />
                    <span style={{ color: '#ff9900' }}>{i18n.t('settings:exportImport.exportWarning')}</span>
                </p>
                <button
                    className="sync-btn"
                    onClick={handleExport}
                    disabled={isProcessing}
                    style={{ maxWidth: '200px', borderColor: 'var(--surface-border)' }}
                >
                    {isProcessing ? i18n.t('settings:exportImport.processing') : i18n.t('settings:exportImport.exportBtn')}
                </button>
            </div>

            {/* Automated Backup */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:exportImport.autoBackup.title')}</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    {i18n.t('settings:exportImport.autoBackup.description')}
                </p>

                <label className="genre-checkbox" style={{ maxWidth: '320px' }}>
                    <input
                        type="checkbox"
                        checked={autoBackupEnabled}
                        onChange={(e) => handleAutoBackupEnabledChange(e.target.checked)}
                    />
                    <span className="genre-name">{i18n.t('settings:exportImport.autoBackup.enabled')}</span>
                </label>

                {autoBackupEnabled && (
                    <div className="tmdb-form" style={{ marginTop: '1rem', maxWidth: '320px' }}>
                        <label className="settings-label" style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                            {i18n.t('settings:exportImport.autoBackup.intervalLabel')}
                        </label>
                        <select
                            value={autoBackupIntervalHours}
                            onChange={(e) => handleAutoBackupIntervalChange(parseInt(e.target.value, 10))}
                            style={{
                                width: '100%',
                                padding: '0.5rem',
                                backgroundColor: 'var(--bg-tertiary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '6px',
                                color: 'var(--text-primary)',
                                fontSize: '0.85rem'
                            }}
                        >
                            <option value={1}>{i18n.t('settings:exportImport.autoBackup.intervalOptions.1h')}</option>
                            <option value={6}>{i18n.t('settings:exportImport.autoBackup.intervalOptions.6h')}</option>
                            <option value={12}>{i18n.t('settings:exportImport.autoBackup.intervalOptions.12h')}</option>
                            <option value={24}>{i18n.t('settings:exportImport.autoBackup.intervalOptions.24h')}</option>
                            <option value={48}>{i18n.t('settings:exportImport.autoBackup.intervalOptions.48h')}</option>
                            <option value={168}>{i18n.t('settings:exportImport.autoBackup.intervalOptions.168h')}</option>
                        </select>

                        <label className="settings-label" style={{ display: 'block', marginBottom: '0.5rem', marginTop: '1rem', color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                            {i18n.t('settings:exportImport.autoBackup.maxBackupsLabel')}
                        </label>
                        <select
                            value={autoBackupMaxBackups}
                            onChange={(e) => handleAutoBackupMaxBackupsChange(parseInt(e.target.value, 10))}
                            style={{
                                width: '100%',
                                padding: '0.5rem',
                                backgroundColor: 'var(--bg-tertiary)',
                                border: '1px solid var(--border-color)',
                                borderRadius: '6px',
                                color: 'var(--text-primary)',
                                fontSize: '0.85rem'
                            }}
                        >
                            <option value={1}>{i18n.t('settings:exportImport.autoBackup.maxOptions.1')}</option>
                            <option value={3}>{i18n.t('settings:exportImport.autoBackup.maxOptions.3')}</option>
                            <option value={5}>{i18n.t('settings:exportImport.autoBackup.maxOptions.5')}</option>
                            <option value={10}>{i18n.t('settings:exportImport.autoBackup.maxOptions.10')}</option>
                            <option value={20}>{i18n.t('settings:exportImport.autoBackup.maxOptions.20')}</option>
                        </select>
                    </div>
                )}

                <div style={{ marginTop: '1rem' }}>
                    <div style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-primary)' }}>
                        {i18n.t('settings:exportImport.autoBackup.folderLabel')}
                        {isCustomFolder && (
                            <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginLeft: '0.5rem' }}>
                                {i18n.t('settings:exportImport.autoBackup.customFolderBadge')}
                            </span>
                        )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button
                            className="sync-btn"
                            onClick={() => void handleChooseFolder()}
                            style={{ maxWidth: '200px', borderColor: 'var(--surface-border)' }}
                        >
                            {i18n.t('settings:exportImport.autoBackup.chooseFolder')}
                        </button>
                        {isCustomFolder && (
                            <button
                                className="sync-btn"
                                onClick={() => void handleUseDefaultFolder()}
                                style={{ maxWidth: '200px', borderColor: 'var(--surface-border)' }}
                            >
                                {i18n.t('settings:exportImport.autoBackup.useDefaultFolder')}
                            </button>
                        )}
                    </div>
                </div>

                <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <button
                        className="sync-btn"
                        onClick={handleBackupNow}
                        disabled={autoBackupProcessing}
                        style={{ maxWidth: '200px', borderColor: 'var(--surface-border)' }}
                    >
                        {autoBackupProcessing ? i18n.t('settings:exportImport.autoBackup.processing') : i18n.t('settings:exportImport.autoBackup.backupNow')}
                    </button>
                    {backupFolder && (
                        <button
                            className="sync-btn"
                            onClick={() => void openBackupFolder()}
                            style={{ maxWidth: '200px', borderColor: 'var(--surface-border)' }}
                        >
                            {i18n.t('settings:exportImport.autoBackup.openFolder')}
                        </button>
                    )}
                </div>

                {autoBackupStatus && (
                    <div className={`sync-status-item ${autoBackupStatus.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: '12px' }}>
                        <span className="status-name">{autoBackupStatus.message}</span>
                    </div>
                )}

                <div style={{ marginTop: '12px', fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                    <div>
                        {i18n.t('settings:exportImport.autoBackup.lastBackup', {
                            time: lastBackupAt ? new Date(lastBackupAt).toLocaleString() : i18n.t('settings:exportImport.autoBackup.never')
                        })}
                    </div>
                    {backupFolder && (
                        <div style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                            {backupFolder}
                        </div>
                    )}
                    <div>
                        {i18n.t('settings:exportImport.autoBackup.backupCount', { count: backupCount })}
                    </div>
                </div>
            </div>

            {/* Import Configuration */}
            <div className="settings-section" style={{ paddingTop: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:exportImport.importTitle')}</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    {i18n.t('settings:exportImport.importDescription')}<br />
                    <span style={{ color: '#ff4444' }}>{i18n.t('settings:exportImport.importWarning')}</span>
                </p>
                <button
                    className="sync-btn"
                    onClick={handleImportClick}
                    disabled={isProcessing}
                    style={{ maxWidth: '200px', borderColor: 'var(--surface-border)' }}
                >
                    {isProcessing ? i18n.t('settings:exportImport.processing') : i18n.t('settings:exportImport.importBtn')}
                </button>
            </div>

            {/* Database Health & Recovery */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>Database Health</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    Check the size and openability of the app database. A large database is normal
                    with big EPG/VOD caches; this is informational. {RECOVERY_SCREEN_ENABLED ? 'The recovery screen can export your data and rebuild the database to a smaller size.' : ''}
                </p>
                <button
                    className="sync-btn"
                    onClick={handleCheckHealth}
                    disabled={checkingHealth}
                    style={{ maxWidth: '220px', borderColor: 'var(--surface-border)' }}
                >
                    {checkingHealth ? 'Checking…' : 'Check database health'}
                </button>
                {healthChecked && recoveryHealth && (
                    <div style={{ marginTop: '12px', fontSize: '0.85rem', lineHeight: 1.6 }}>
                        <div>
                            Database:{' '}
                            <b>{formatBytes(recoveryHealth.db_size)}</b>
                            {'  ·  '}WAL:{' '}
                            <b>{formatBytes(recoveryHealth.wal_size)}</b>
                            {'  ·  '}Opens:{' '}
                            <b style={{ color: recoveryHealth.opens_ok ? '#4CAF50' : '#ff4444' }}>
                                {recoveryHealth.opens_ok ? 'yes' : 'no'}
                            </b>
                        </div>
                        {isDbUnhealthy(recoveryHealth) && (
                            <div style={{ marginTop: '8px', color: '#ff9900' }}>
                                A large or unopenable database was detected.
                            </div>
                        )}
                    </div>
                )}
            </div>

            {RECOVERY_SCREEN_ENABLED && recoveryHealth && (
                <RecoveryScreen
                    health={recoveryHealth}
                    onContinue={() => setRecoveryHealth(null)}
                />
            )}

            {RECOVERY_SCREEN_ENABLED && healthChecked && recoveryHealth && !isDbUnhealthy(recoveryHealth) && (
                <button
                    className="sync-btn"
                    onClick={() => setRecoveryHealth({ ...recoveryHealth })}
                    style={{ maxWidth: '220px', marginTop: '12px', borderColor: 'var(--surface-border)' }}
                >
                    Open recovery screen
                </button>
            )}

            {showImportConfirm && createPortal(
                <div className="source-form-overlay">
                    <div className="source-form" style={{ maxWidth: '400px', height: 'auto' }}>
                        <h3>{i18n.t('settings:exportImport.confirmTitle')}</h3>
                        <p style={{ color: 'var(--text-primary)', marginBottom: '24px', lineHeight: '1.5' }}>
                            {i18n.t('settings:exportImport.confirmMessage')}
                        </p>
                        <div className="form-actions" style={{ marginTop: '0' }}>
                            <button
                                className="cancel-btn"
                                onClick={() => setShowImportConfirm(false)}
                            >
                                {i18n.t('settings:exportImport.cancel')}
                            </button>
                            <button
                                className="save-btn"
                                onClick={confirmImport}
                                style={{ borderColor: '#ff4444', color: '#ff4444', background: 'rgba(255, 68, 68, 0.1)' }}
                            >
                                {i18n.t('settings:exportImport.continue')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            {showRestartConfirm && createPortal(
                <div className="source-form-overlay">
                    <div className="source-form" style={{ maxWidth: '400px', height: 'auto' }}>
                        <h3>{i18n.t('settings:exportImport.restartTitle')}</h3>
                        <p style={{ color: 'var(--text-primary)', marginBottom: '24px', lineHeight: '1.5' }}>
                            {i18n.t('settings:exportImport.restartMessage')}
                            <br /><br />
                            {i18n.t('settings:exportImport.restartQuestion')}
                        </p>
                        <div className="form-actions" style={{ marginTop: '0' }}>
                            <button
                                className="cancel-btn"
                                onClick={() => setShowRestartConfirm(false)}
                            >
                                {i18n.t('settings:exportImport.restartLater')}
                            </button>
                            <button
                                className="save-btn"
                                onClick={handleRestart}
                                style={{ borderColor: '#4CAF50', color: '#4CAF50', background: 'rgba(76, 175, 80, 0.1)' }}
                            >
                                {i18n.t('settings:exportImport.restartNow')}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
