/**
 * logger.ts - Direct Tauri log plugin integration
 *
 * WHY THIS EXISTS:
 * `attachConsole()` from tauri-plugin-log hooks the webview console, but
 * the relay is unreliable in production builds.
 *
 * This module calls `info()`, `warn()`, `error()` from `@tauri-apps/plugin-log`
 * DIRECTLY, bypassing the console proxy entirely. This is the only reliable
 * way to get frontend logs into the log file in both Debug and Release builds.
 *
 * All functions are a COMPLETE NO-OP when debug logging is disabled in Settings,
 * so there is zero performance impact when it is off.
 *
 * Usage:
 *   import { logInfo, logWarn, logError } from '../utils/logger';
 *   logInfo('[Playback] Loading URL:', url);
 */

// We only import if we're running inside Tauri (not a plain browser)
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let _info: ((msg: string) => Promise<void>) | null = null;
let _warn: ((msg: string) => Promise<void>) | null = null;
let _error: ((msg: string) => Promise<void>) | null = null;

if (isTauri) {
  // Dynamic import so the module doesn't crash in non-Tauri environments
  import('@tauri-apps/plugin-log').then((log) => {
    _info = log.info;
    _warn = log.warn;
    _error = log.error;
  }).catch(() => { /* plugin not available */ });
}

/** Returns true only when the user has enabled debug logging in Settings. */
function isDebugEnabled(): boolean {
  return (window as any).__debugLoggingEnabled === true;
}

function stringify(...args: any[]): string {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

/** Log at INFO level. Complete no-op when debug logging is disabled. */
export function logInfo(...args: any[]): void {
  if (!isDebugEnabled()) return;
  const msg = stringify(...args);
  console.info(...args);
  if (_info) _info(msg).catch(() => {});
}

/** Log at WARN level. Complete no-op when debug logging is disabled. */
export function logWarn(...args: any[]): void {
  if (!isDebugEnabled()) return;
  const msg = stringify(...args);
  console.warn(...args);
  if (_warn) _warn(msg).catch(() => {});
}

/** Log at ERROR level. Complete no-op when debug logging is disabled. */
export function logError(...args: any[]): void {
  if (!isDebugEnabled()) return;
  const msg = stringify(...args);
  console.error(...args);
  if (_error) _error(msg).catch(() => {});
}
