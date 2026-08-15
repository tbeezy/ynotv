import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';
import ar from './locales/ar.json';
import tr from './locales/tr.json';
import es from './locales/es.json';
import ptBR from './locales/pt-BR.json';
import it from './locales/it.json';
import de from './locales/de.json';
import pl from './locales/pl.json';
import sr from './locales/sr.json';
import hr from './locales/hr.json';
import bs from './locales/bs.json';
import sq from './locales/sq.json';
import ru from './locales/ru.json';
import el from './locales/el.json';
import nl from './locales/nl.json';
import fa from './locales/fa.json';
import hi from './locales/hi.json';
import ur from './locales/ur.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import vi from './locales/vi.json';
import hu from './locales/hu.json';

/** Locale registry. Locales ship with app code (Vite bundles the JSON imports). */
export const SUPPORTED_LOCALES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'ar', label: 'العربية' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'es', label: 'Español' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'it', label: 'Italiano' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pl', label: 'Polski' },
  { code: 'sr', label: 'Srpski' },
  { code: 'hr', label: 'Hrvatski' },
  { code: 'bs', label: 'Bosanski' },
  { code: 'sq', label: 'Shqip' },
  { code: 'ru', label: 'Русский' },
  { code: 'el', label: 'Ελληνικά' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'fa', label: 'فارسی' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ur', label: 'اردو' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'hu', label: 'Magyar' },
];

// NOTE: Full RTL mirroring for Arabic is intentionally disabled. Setting
// dir="rtl" flipped the entire UI, and several surfaces compute positions with
// physical pixel math in JS (EPG timeline blocks, drag/resize handles, hover
// cards), which broke under the mirror. The app stays LTR; Arabic text renders
// correctly inside the LTR container (lang is still synced for fonts/spellcheck).
// Re-enable RTL only after verifying every JS-positioned surface under dir="rtl".
function applyDocumentDirection(lng: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('dir', 'ltr');
  document.documentElement.setAttribute('lang', lng);
}

export function isSupportedLocale(code: string): boolean {
  return SUPPORTED_LOCALES.some((l) => l.code === code);
}

function getInitialLanguage(): string {
  try {
    const localData = typeof localStorage !== 'undefined' ? localStorage.getItem('app-settings') : null;
    if (localData) {
      const parsed = JSON.parse(localData);
      if (typeof parsed.language === 'string' && isSupportedLocale(parsed.language)) {
        return parsed.language;
      }
    }
  } catch (e) {
    // fall through to default
  }
  return 'en';
}

i18n.use(initReactI18next).init({
  resources: {
    // `as any`: i18next's Resource type expects flat `{ [key: string]: string }` per namespace,
    // but en.json is nested by namespace (`common`/`settings`/`nav`). The typed shape lives in
    // i18next.d.ts (CustomTypeOptions) which is what t() key-checking uses at compile time.
    // Do not "clean up"; typing it here would fight the runtime structure i18next actually wants.
    en: en as any,
    fr: fr as any,
    ar: ar as any,
    tr: tr as any,
    es: es as any,
    'pt-BR': ptBR as any,
    it: it as any,
    de: de as any,
    pl: pl as any,
    sr: sr as any,
    hr: hr as any,
    bs: bs as any,
    sq: sq as any,
    ru: ru as any,
    el: el as any,
    nl: nl as any,
    fa: fa as any,
    hi: hi as any,
    ur: ur as any,
    'zh-CN': zhCN as any,
    'zh-TW': zhTW as any,
    vi: vi as any,
    hu: hu as any,
  },
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  defaultNS: 'common',
  ns: Object.keys(en),
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
  missingKeyHandler: (lngs, ns, key, fallbackValue) => {
    if (import.meta.env.DEV) {
      console.warn(`[i18n:missing] Key "${ns}:${key}" missing for locale "${lngs.join(',')}". Fallback: "${fallbackValue}"`);
    }
  },
  react: {
    useSuspense: false,
  },
});

// Keep the document lang (and an explicit LTR direction) in sync with the active locale.
i18n.on('languageChanged', applyDocumentDirection);
applyDocumentDirection(getInitialLanguage());

export default i18n;

export const changeLanguage = (lang: string): ReturnType<typeof i18n.changeLanguage> => i18n.changeLanguage(lang);

/**
 * Translate known backend/native error strings (Rust commands, local-adapter clients)
 * that surface raw via `res.error` / `result.error` / `err.message` at display sites.
 * Unknown strings (dynamic network details, HTTP text, plugin internals) pass through.
 */
export function translateNativeError(msg: string | null | undefined): string {
  if (!msg) return '';
  // Prefix matches for Rust command wrappers with dynamic detail ("Failed to …: {cause}")
  if (msg.startsWith('Conflict:')) return i18n.t('contextMenu.conflictMessage');
  if (msg.startsWith('Failed to schedule recording:')) return i18n.t('contextMenu.failedScheduleRecording');
  if (msg.startsWith('Failed to start instant recording:')) return i18n.t('dvr:failedToStartRecording');
  if (msg.startsWith('Failed to convert recording:')) return i18n.t('dvr:failedToConvertRecording');
  if (msg.startsWith('Failed to resolve stream URL:')) return i18n.t('contextMenu.failedResolveStreamUrl');
  if (msg.startsWith('Download interrupted by network error:')) return i18n.t('common:epgDownloadInterrupted');
  if (msg.startsWith('Download interrupted:')) return i18n.t('common:epgDownloadInterrupted');
  if (msg.startsWith('Stream parse EPG failed:')) return i18n.t('common:epgParseFailed');
  if (msg.startsWith('Stream parse EPG multi failed:')) return i18n.t('common:epgParseFailed');
  if (msg.startsWith('mpv process (pid=')) return i18n.t('player:mpvDiedStartup');
  if (msg.startsWith('Failed to launch media receiver:')) return i18n.t('cast:failedToLaunchReceiver');
  if (msg.startsWith('Reconnect receiver channel failed:')) return i18n.t('cast:failedToConnect');
  if (msg.startsWith('Reconnect heartbeat failed:')) return i18n.t('cast:failedToConnect');
  if (msg.startsWith('Reconnect to ')) return i18n.t('cast:failedToConnect');
  switch (msg) {
    case 'Authentication failed':
      return i18n.t('common:authenticationFailed');
    case 'Proxy is not enabled or proxy server field is empty':
      return i18n.t('settings:proxy.notEnabled');
    case 'Download not found or already finished':
      return i18n.t('common:downloadNotFoundOrFinished');
    case 'Recording not found':
      return i18n.t('common:recordingNotFound');
    case 'Interrupted by app restart':
      return i18n.t('common:interruptedRestart');
    case 'No media session':
      return i18n.t('player:noMediaSession');
    case 'Max retries exceeded for database operation':
      return i18n.t('common:epgMaxRetriesExceeded');
    case 'Main window not found':
      return i18n.t('player:mainWindowNotFound');
    case 'IPC not connected':
      return i18n.t('player:mpvNotConnected');
    case 'Timeout':
      return i18n.t('player:mpvTimeout');
    case 'Channel closed':
      return i18n.t('player:mpvChannelClosed');
    default:
      return msg;
  }
}