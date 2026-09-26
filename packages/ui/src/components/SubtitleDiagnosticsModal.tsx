import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSubtitleDebugStore } from '../stores/subtitleDebugStore';
import { Bridge, type SupportBundle } from '../services/tauri-bridge';

interface SubtitleDiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SubtitleDiagnosticsModal({ isOpen, onClose }: SubtitleDiagnosticsModalProps) {
  const { t } = useTranslation('subtitles');
  const entries = useSubtitleDebugStore((s) => s.entries);
  const clearSubLogs = useSubtitleDebugStore((s) => s.clearSubLogs);
  const [copied, setCopied] = useState(false);
  const [mpvLog, setMpvLog] = useState('');
  const [mpvLogPath, setMpvLogPath] = useState('');
  const [verboseOn, setVerboseOn] = useState(false);
  const [mpvLoading, setMpvLoading] = useState(false);
  const [bundleLoading, setBundleLoading] = useState(false);
  const jsBodyRef = useRef<HTMLTextAreaElement>(null);
  const mpvBodyRef = useRef<HTMLTextAreaElement>(null);

  const refreshMpvLog = async (enabled?: boolean) => {
    setMpvLoading(true);
    try {
      if (enabled !== undefined) {
        await Bridge.setMpvVerboseLogging(enabled);
        setVerboseOn(enabled);
      }
      const result = await Bridge.getMpvLog(600);
      setMpvLog(result.log);
      setMpvLogPath(result.path);
      if (mpvBodyRef.current) {
        mpvBodyRef.current.scrollTop = mpvBodyRef.current.scrollHeight;
      }
    } catch (e) {
      setMpvLog(t('failedReadMpvLog', { error: String(e) }));
    } finally {
      setMpvLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      refreshMpvLog();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && jsBodyRef.current) {
      jsBodyRef.current.scrollTop = jsBodyRef.current.scrollHeight;
    }
  }, [isOpen, entries]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const jsText = entries.length
    ? entries.map((e) => `[${e.time}] (${e.area}) ${e.msg}`).join('\n')
    : t('noDiagnostics');

  /**
   * One paste for a bug report: the app log, both mpv logs (unfiltered — the
   * panel below only shows subtitle-related lines), the engine command line and
   * the playback settings that shaped it. Credentials are masked in Rust.
   */
  const copySupportBundle = async () => {
    setBundleLoading(true);
    try {
      const bundle: SupportBundle = await Bridge.getSupportBundle(1200);
      const sections: string[] = [
        `ynoTV support bundle — app ${bundle.app_version} on ${bundle.os}`,
        '',
        `=== Engine command line (${bundle.spawn_args.length} args) ===`,
        bundle.spawn_args.join('\n'),
        '',
        `=== Effective playback settings ===`,
        JSON.stringify(bundle.settings, null, 2),
        '',
        `=== App log (${bundle.app_log_path || 'not found'}) ===`,
        bundle.app_log || '(empty)',
        '',
        `=== MPV log (${bundle.mpv_log_path || 'not found'}) ===`,
        bundle.mpv_log || '(empty)',
        '',
        `=== MPV log, previous engine start (${bundle.previous_mpv_log_path || 'not found'}) ===`,
        bundle.previous_mpv_log || '(empty)',
        '',
        '=== App / JS log (this session) ===',
        jsText,
      ];
      await navigator.clipboard.writeText(sections.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setMpvLog(t('failedSupportBundle', { error: String(e) }));
    } finally {
      setBundleLoading(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error('Failed to copy diagnostics:', e);
    }
  };

  const fullText = `=== App / JS log ===\n${jsText}\n\n=== MPV log (${mpvLogPath}) ===\n${mpvLog}`;

  return (
    <div className="subtitle-diagnostics-overlay" onClick={onClose}>
      <div className="subtitle-diagnostics" onClick={(e) => e.stopPropagation()}>
        <div className="subtitle-diagnostics-header">
          <h3>{t('diagnosticsTitle')}</h3>
          <button className="subtitle-modal-close" onClick={onClose}>×</button>
        </div>
        <div className="subtitle-diagnostics-actions">
          <button className="subtitle-diagnostics-btn" onClick={() => copy(fullText)}>
            {copied ? t('copied') : t('copyAll')}
          </button>
          <button className="subtitle-diagnostics-btn" onClick={() => copy(jsText)}>{t('copyAppLog')}</button>
          <button
            className="subtitle-diagnostics-btn"
            disabled={bundleLoading}
            onClick={copySupportBundle}
            title={t('copySupportBundleTitle')}
          >
            {bundleLoading ? t('loading') : t('copySupportBundle')}
          </button>
          <button className="subtitle-diagnostics-btn" onClick={() => copy(mpvLog)}>{t('copyMpvLog')}</button>
          <button
            className={`subtitle-diagnostics-btn ${verboseOn ? 'subtitle-diagnostics-btn-active' : ''}`}
            onClick={() => refreshMpvLog(!verboseOn)}
          >
            {verboseOn ? t('verboseOn') : t('enableVerbose')}
          </button>
          <button className="subtitle-diagnostics-btn" onClick={() => refreshMpvLog()}>
            {mpvLoading ? t('loading') : t('refreshMpvLog')}
          </button>
          <button className="subtitle-diagnostics-btn" onClick={clearSubLogs}>{t('clearAppLog')}</button>
        </div>
        <div className="subtitle-diagnostics-tabs">
          <span className="subtitle-diagnostics-tab">{t('appJsLog', { count: entries.length })}</span>
          <span className="subtitle-diagnostics-tab">{t('mpvLog')}</span>
        </div>
        <textarea
          ref={jsBodyRef}
          className="subtitle-diagnostics-text subtitle-diagnostics-text-js"
          readOnly
          value={jsText}
          spellCheck={false}
        />
        <textarea
          ref={mpvBodyRef}
          className="subtitle-diagnostics-text subtitle-diagnostics-text-mpv"
          readOnly
          value={mpvLog || t('mpvLogEmpty')}
          spellCheck={false}
        />
      </div>
    </div>
  );
}
