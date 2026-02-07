import { useState } from 'react';
import { createPortal } from 'react-dom';
import { exportAllData, importAllData } from '../../utils/exportImport';

export function ImportExportTab() {
    const [isProcessing, setIsProcessing] = useState(false);
    const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [showImportConfirm, setShowImportConfirm] = useState(false);

    const handleExport = async () => {
        setIsProcessing(true);
        setStatus(null);
        try {
            const result = await exportAllData();
            if (result.success) {
                setStatus({
                    type: 'success',
                    message: `Export successful! Saved to ${result.filePath}`
                });
            } else if (result.error) {
                setStatus({ type: 'error', message: result.error });
            }
        } catch (error) {
            setStatus({ type: 'error', message: String(error) });
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
                setStatus({
                    type: 'success',
                    message: 'Import successful! Please restart the application to apply changes.'
                });
                // Check if we can prompt for reload using native confirm for reload
                // Or we could implement another modal, but standard reload prompt is often native
                if (confirm('Import successful! The application needs to restart to apply changes. Restart now?')) {
                    window.location.reload();
                }
            } else if (result.error) {
                setStatus({ type: 'error', message: result.error });
            }
        } catch (error) {
            setStatus({ type: 'error', message: String(error) });
        } finally {
            setIsProcessing(false);
        }
    };

    const handleImportClick = () => {
        setShowImportConfirm(true);
    };

    return (
        <div className="settings-tab-content">
            <div className="settings-section">
                <div className="section-header">
                    <h3>System Backup & Restoration</h3>
                </div>
                <p className="section-description">
                    Export your configuration to a JSON file to transfer between devices or create backups.
                    Includes Sources, Settings, Favorites, and Category customizations.
                </p>

                {status && (
                    <div className={`sync-status-item ${status.type === 'success' ? 'success' : 'error'}`} style={{ marginBottom: '20px' }}>
                        <span className="status-name">{status.message}</span>
                    </div>
                )}

                <div className="settings-section" style={{ marginTop: '1.5rem', border: 'none', padding: 0 }}>
                    <div className="section-header">
                        <h3>Export Configuration</h3>
                    </div>
                    <p className="section-description" style={{ marginBottom: '1rem' }}>
                        Save your current setup to a file. <br />
                        <span style={{ color: '#ff9900' }}>Warning: The exported file contains your source passwords in plain text. Keep it safe.</span>
                    </p>
                    <button
                        className="sync-btn"
                        onClick={handleExport}
                        disabled={isProcessing}
                        style={{ maxWidth: '200px', borderColor: 'rgba(255,255,255,0.2)' }}
                    >
                        {isProcessing ? 'Processing...' : 'Export to File'}
                    </button>
                </div>

                <div className="settings-section" style={{ marginTop: '1rem', border: 'none', padding: 0 }}>
                    <div className="section-header">
                        <h3>Import Configuration</h3>
                    </div>
                    <p className="section-description" style={{ marginBottom: '1rem' }}>
                        Restore configuration from a previously exported file. <br />
                        <span style={{ color: '#ff4444' }}>Caution: This will replace all your current sources and settings.</span>
                    </p>
                    <button
                        className="sync-btn"
                        onClick={handleImportClick}
                        disabled={isProcessing}
                        style={{ maxWidth: '200px', borderColor: 'rgba(255,255,255,0.2)' }}
                    >
                        {isProcessing ? 'Processing...' : 'Import from File'}
                    </button>
                </div>
            </div>

            {showImportConfirm && createPortal(
                <div className="source-form-overlay">
                    <div className="source-form" style={{ maxWidth: '400px', height: 'auto' }}>
                        <h3>Import Configuration</h3>
                        <p style={{ color: 'rgba(255,255,255,0.8)', marginBottom: '24px', lineHeight: '1.5' }}>
                            WARNING: Importing will overwrite all current sources and settings. Application data will be cleared.
                            <br /><br />
                            Are you sure you want to continue?
                        </p>
                        <div className="form-actions" style={{ marginTop: '0' }}>
                            <button
                                className="cancel-btn"
                                onClick={() => setShowImportConfirm(false)}
                            >
                                Cancel
                            </button>
                            <button
                                className="save-btn"
                                onClick={confirmImport}
                                style={{ borderColor: '#ff4444', color: '#ff4444', background: 'rgba(255, 68, 68, 0.1)' }}
                            >
                                Yes, Import Data
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}
