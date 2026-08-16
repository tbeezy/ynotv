import { useState, useEffect } from 'react';
import { getDvrSettings, saveDvrSetting } from '../../db';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';
import '../Settings.css';

export function DvrTab() {
    useTranslation();
    const [storagePath, setStoragePath] = useState('');
    const downloadsPath = useSettingsStore((s) => s.downloadsPath);
    const setDownloadsPath = useSettingsStore((s) => s.setDownloadsPath);
    const [startPadding, setStartPadding] = useState(60);
    const [endPadding, setEndPadding] = useState(300);
    const [customEndPaddingInput, setCustomEndPaddingInput] = useState('');
    const [autoConvertFormat, setAutoConvertFormat] = useState('none');
    const [autoCleanup, setAutoCleanup] = useState(false);
    const [maxDiskUsage, setMaxDiskUsage] = useState(80);
    const [keepDays, setKeepDays] = useState<number | null>(30);
    const [allowPermissiveHls, setAllowPermissiveHls] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

    async function loadSettings() {
        setLoading(true);
        try {
            const settings = await getDvrSettings();
            setStoragePath(settings.storage_path || '');
            setStartPadding(settings.default_start_padding_sec || 60);
            const endSec = settings.default_end_padding_sec || 300;
            setEndPadding(endSec);
            const mins = endSec / 60;
            setCustomEndPaddingInput(Number(mins.toFixed(2)).toString());
            setAutoConvertFormat(settings.auto_convert_format || 'none');
            setAutoCleanup(settings.auto_cleanup_enabled !== false);
            setMaxDiskUsage(settings.max_disk_usage_percent || 80);
            setKeepDays(settings.keep_recordings_days !== undefined ? settings.keep_recordings_days : 30);
            setAllowPermissiveHls(settings.allow_permissive_hls_extensions === true || settings.allow_permissive_hls_extensions === 'true');
            // downloadsPath is read from the settings store (hydrated at boot),
            // so no IPC round-trip is needed here.
        } catch (error) {
            console.error('Failed to load DVR settings:', error);
        } finally {
            setLoading(false);
        }
    }

    async function handleSelectPath() {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: i18n.t('settings:dvr.selectStorageDir'),
            });

            if (selected && typeof selected === 'string') {
                setStoragePath(selected);
                await saveDvrSetting('storage_path', selected);
            }
        } catch (error) {
            console.error('Failed to select directory:', error);
            alert(i18n.t('settings:dvr.errSelectDir'));
        }
    }

    async function handleSelectDownloadsPath() {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: i18n.t('settings:dvr.selectDownloadsDir'),
            });

            if (selected && typeof selected === 'string') {
                setDownloadsPath(selected);
            }
        } catch (error) {
            console.error('Failed to select downloads directory:', error);
            alert(i18n.t('settings:dvr.errSelectDownloadsDir'));
        }
    }

    async function handleStartPaddingChange(value: number) {
        setStartPadding(value);
        await saveDvrSetting('default_start_padding_sec', value);
    }

    async function handleEndPaddingChange(value: number) {
        setEndPadding(value);
        const mins = value / 60;
        setCustomEndPaddingInput(Number(mins.toFixed(2)).toString());
        await saveDvrSetting('default_end_padding_sec', value);
    }

    async function handleSaveCustomEndPadding() {
        const mins = parseFloat(customEndPaddingInput);
        if (!isNaN(mins) && mins >= 0) {
            const seconds = Math.round(mins * 60);
            await handleEndPaddingChange(seconds);
        }
    }

    async function handleAutoConvertChange(value: string) {
        setAutoConvertFormat(value);
        await saveDvrSetting('auto_convert_format', value);
    }

    async function handleAutoCleanupChange(value: boolean) {
        setAutoCleanup(value);
        await saveDvrSetting('auto_cleanup_enabled', value);
    }

    async function handleMaxDiskUsageChange(value: number) {
        setMaxDiskUsage(value);
        await saveDvrSetting('max_disk_usage_percent', value);
    }

    async function handleKeepDaysChange(value: number | null) {
        setKeepDays(value);
        await saveDvrSetting('keep_recordings_days', value);
    }

    async function handleAllowPermissiveHlsChange(value: boolean) {
        setAllowPermissiveHls(value);
        await saveDvrSetting('allow_permissive_hls_extensions', value);
    }

    const formatDuration = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        if (mins < 1) return `${seconds}s`;
        if (mins === 1) return i18n.t('settings:dvr.min', { count: 1 });
        return i18n.t('settings:dvr.min', { count: mins });
    };

    if (loading) {
        return (
            <div className="settings-tab-content">
                <div className="settings-section">
                    <p className="section-description">{i18n.t('common:loading')}</p>
                </div>
            </div>
        );
    }

    return (
        <div className="settings-tab-content">
            {/* Storage Location */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:dvr.storageLocation')}</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    {i18n.t('settings:dvr.storageLocationSub')}
                    {!storagePath && (
                        <span className="dvr-warning-msg" style={{ display: 'block', marginTop: '4px' }}>
                            ⚠️ {i18n.t('settings:dvr.storagePathRequired')}
                        </span>
                    )}
                </p>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <input
                        type="text"
                        className="dvr-path-input"
                        value={storagePath || i18n.t('settings:dvr.defaultLocation')}
                        readOnly
                    />
                    <button
                        className="sync-btn dvr-browse-btn"
                        onClick={handleSelectPath}
                        type="button"
                    >
                        {i18n.t('common:browse')}
                    </button>
                </div>
            </div>

            {/* Downloads Location */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:dvr.downloadsLocation')}</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    {i18n.t('settings:dvr.downloadsLocationSub')}
                </p>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <input
                        type="text"
                        className="dvr-path-input"
                        value={downloadsPath || i18n.t('settings:dvr.askEveryTime')}
                        readOnly
                    />
                    <button
                        className="sync-btn dvr-browse-btn"
                        onClick={handleSelectDownloadsPath}
                        type="button"
                    >
                        {i18n.t('common:browse')}
                    </button>
                </div>
            </div>

            {/* Recording Padding */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:dvr.recordingPadding')}</h3>
                </div>
                <p className="section-description">
                    {i18n.t('settings:dvr.recordingPaddingSub')}
                </p>

                <div style={{ marginBottom: '20px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <label className="dvr-setting-label">{i18n.t('settings:dvr.startPadding')}</label>
                        <span className="dvr-duration-badge">
                            {formatDuration(startPadding)}
                        </span>
                    </div>
                    <input
                        type="range"
                        className="dvr-range-slider"
                        min="0"
                        max="300"
                        step="15"
                        value={startPadding}
                        onChange={(e) => handleStartPaddingChange(parseInt(e.target.value))}
                    />
                    <div className="dvr-range-limits">
                        <span>{i18n.t('common:none')}</span>
                        <span>{i18n.t('settings:dvr.min', { count: 5 })}</span>
                    </div>
                </div>

                <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <label className="dvr-setting-label">{i18n.t('settings:dvr.endPadding')}</label>
                        <span className="dvr-duration-badge">
                            {formatDuration(endPadding)}
                        </span>
                    </div>
                    <input
                        type="range"
                        className="dvr-range-slider"
                        min="0"
                        max={Math.max(900, endPadding)}
                        step="30"
                        value={endPadding}
                        onChange={(e) => handleEndPaddingChange(parseInt(e.target.value))}
                    />
                    <div className="dvr-range-limits">
                        <span>{i18n.t('common:none')}</span>
                        <span>{formatDuration(Math.max(900, endPadding))}</span>
                    </div>

                    {/* Custom End Padding Input */}
                    <div className="dvr-custom-padding-box">
                        <div style={{ flex: 1 }}>
                            <label className="dvr-sublabel" style={{ marginBottom: '4px' }}>
                                {i18n.t('settings:dvr.customEndPadding')}
                            </label>
                            <input
                                type="number"
                                className="dvr-number-input"
                                min="0"
                                placeholder={i18n.t('settings:dvr.customMinutesPlaceholder')}
                                value={customEndPaddingInput}
                                onChange={(e) => setCustomEndPaddingInput(e.target.value)}
                            />
                        </div>
                        <button
                            type="button"
                            onClick={handleSaveCustomEndPadding}
                            disabled={customEndPaddingInput === '' || isNaN(parseFloat(customEndPaddingInput)) || parseFloat(customEndPaddingInput) < 0}
                            className="sync-btn dvr-save-btn"
                        >
                            {i18n.t('common:save')}
                        </button>
                    </div>
                </div>
            </div>

            {/* Storage Management & Auto-Cleanup */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:dvr.storageManagement')}</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    {i18n.t('settings:dvr.storageManagementSub')}
                </p>

                {/* Enable Auto-Cleanup Toggle */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                    <div>
                        <label className="dvr-setting-label" style={{ display: 'block', fontWeight: 500 }}>
                            {i18n.t('settings:dvr.autoCleanup')}
                        </label>
                        <span className="dvr-sublabel">
                            {i18n.t('settings:dvr.autoCleanupSub')}
                        </span>
                    </div>
                    <div style={{ display: 'inline-flex', alignItems: 'center' }}>
                        <input
                            type="checkbox"
                            id="autoCleanup"
                            checked={autoCleanup}
                            onChange={(e) => handleAutoCleanupChange(e.target.checked)}
                            style={{ display: 'none' }}
                        />
                        <label
                            htmlFor="autoCleanup"
                            className="dvr-toggle-switch"
                            style={{
                                background: autoCleanup ? 'linear-gradient(135deg, #00d4ff, #0072ff)' : undefined,
                            }}
                        >
                            <span
                                style={{
                                    left: autoCleanup ? '24px' : '2px',
                                }}
                            />
                        </label>
                    </div>
                </div>

                {autoCleanup && (
                    <>
                        {/* Max Disk Usage Slider */}
                        <div style={{ marginBottom: '20px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                <label className="dvr-setting-label">{i18n.t('settings:dvr.maxDiskUsage')}</label>
                                <span className="dvr-duration-badge">
                                    {maxDiskUsage}%
                                </span>
                            </div>
                            <input
                                type="range"
                                className="dvr-range-slider"
                                min="50"
                                max="95"
                                step="5"
                                value={maxDiskUsage}
                                onChange={(e) => handleMaxDiskUsageChange(parseInt(e.target.value))}
                            />
                            <p className="dvr-sublabel" style={{ marginTop: '6px' }}>
                                {i18n.t('settings:dvr.maxDiskUsageSub')}
                            </p>
                        </div>

                        {/* Keep Recordings Days Dropdown */}
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                <label className="dvr-setting-label">{i18n.t('settings:dvr.keepRecordingsFor')}</label>
                            </div>
                            <select
                                className="dvr-select-dropdown"
                                value={keepDays === null || keepDays === undefined || (keepDays as any) === 'none' ? 'none' : keepDays.toString()}
                                onChange={(e) => handleKeepDaysChange(e.target.value === 'none' ? null : parseInt(e.target.value))}
                            >
                                <option value="none">{i18n.t('settings:dvr.indefinitely')}</option>
                                <option value="7">{i18n.t('settings:dvr.days', { count: 7 })}</option>
                                <option value="14">{i18n.t('settings:dvr.days', { count: 14 })}</option>
                                <option value="30">{i18n.t('settings:dvr.days', { count: 30 })}</option>
                                <option value="90">{i18n.t('settings:dvr.days', { count: 90 })}</option>
                            </select>
                        </div>
                    </>
                )}
            </div>

            {/* Auto-Convert Settings */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:dvr.autoConvert')}</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    {i18n.t('settings:dvr.autoConvertSub')}
                </p>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <select
                        className="dvr-select-dropdown"
                        value={autoConvertFormat}
                        onChange={(e) => handleAutoConvertChange(e.target.value)}
                    >
                        <option value="none">{i18n.t('settings:dvr.keepOriginal')}</option>
                        <option value="mp4">MP4 (.mp4)</option>
                        <option value="mkv">MKV (.mkv)</option>
                    </select>
                </div>
            </div>

            {/* Stream Compatibility & Security */}
            <div className="settings-section" style={{ paddingTop: '8px', paddingBottom: '8px' }}>
                <div className="section-header">
                    <h3>{i18n.t('settings:dvr.streamCompatibility')}</h3>
                </div>
                <p className="section-description" style={{ marginBottom: '12px' }}>
                    {i18n.t('settings:dvr.streamCompatibilitySub')}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ paddingRight: '16px' }}>
                            <div className="dvr-setting-label">
                                {i18n.t('settings:dvr.permissiveHls')}
                            </div>
                            <div className="dvr-sublabel" style={{ marginTop: '2px', lineHeight: '1.4' }}>
                                {i18n.t('settings:dvr.permissiveHlsSub')}
                            </div>
                        </div>
                        <div style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
                            <input
                                type="checkbox"
                                id="allowPermissiveHls"
                                checked={allowPermissiveHls}
                                onChange={(e) => handleAllowPermissiveHlsChange(e.target.checked)}
                                style={{ display: 'none' }}
                            />
                            <label
                                htmlFor="allowPermissiveHls"
                                className="dvr-toggle-switch"
                                style={{
                                    background: allowPermissiveHls ? 'linear-gradient(135deg, #00d4ff, #0072ff)' : undefined,
                                }}
                            >
                                <span
                                    style={{
                                        left: allowPermissiveHls ? '24px' : '2px',
                                    }}
                                />
                            </label>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
