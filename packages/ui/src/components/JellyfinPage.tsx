import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  jellyfinAuthenticate,
  jellyfinConfirmPlayback,
  jellyfinEmbedClose,
  jellyfinEmbedIsOpen,
  jellyfinEmbedNotifyPlaybackEnded,
  jellyfinEmbedOpen,
  jellyfinEmbedReenable,
  jellyfinEmbedResize,
  jellyfinEmbedSetVisible,
} from '../services/jellyfin';
import { useSettingsStore } from '../stores/settingsStore';
import type { JellyfinQueueItem } from '../types/media';
import { setJellyfinEmbedNavActive } from '../services/spatialNavigation';
import './JellyfinPage.css';

/**
 * Embedded Jellyfin web wrapper, shown as the "Jellyfin" titlebar tab.
 *
 * Instead of an <iframe>, the Jellyfin web UI is rendered in a native child
 * WebView docked below this page's toolbar. The user types the server URL and
 * presses Connect; Rust creates the child WebView and injects a script that
 * hands playback off to ynoTV's mpv. This component only manages that WebView's
 * lifetime and bounds (connect / disconnect / resize as the window changes).
 */

type ConnState = 'idle' | 'connecting' | 'connected';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface JellyfinPlayPayload {
  url: string;
  title?: string;
  // Jellyfin's web player provides the selected/default stream metadata;
  // preserve it so MPV can load external subtitle files too.
  itemId?: string;
  mediaSourceId?: string;
  subtitleStreamId?: number;
  subtitleUrl?: string;
  subtitleTracks?: Array<{
    index: number;
    title?: string;
    lang?: string;
    codec?: string;
    isExternal: boolean;
    deliveryUrl?: string;
    selected?: boolean;
    default?: boolean;
  }>;
  // Derived from the Jellyfin PlaybackInfo response (jellyfin-desktop-style
  // metadata handoff): poster for the Now Playing bar + audio stream list.
  posterUrl?: string;
  audioTracks?: Array<{
    index: number;
    title?: string;
    lang?: string;
    codec?: string;
    isDefault?: boolean;
  }>;
  audioStreamId?: number;
  // Chapter markers from the item DTO (Fields=Chapters), rendered as ticks on
  // the ynoTV seek bar. Ticks are 100ns units (StartPositionTicks / 1e7 = secs).
  chapters?: Array<{
    startPositionTicks?: number;
    name?: string;
  }>;
  // Series/episode context: server + token let the frontend build direct-play
  // URLs for adjacent episodes (prev/next nav), and the S/E numbers feed the
  // header info pill. `episodes` is the compact episode list for the series.
  serverUrl?: string;
  apiKey?: string;
  seriesId?: string;
  seriesName?: string;
  // Series-level metadata provider IDs (Imdb/Tmdb/...) captured by the bridge
  // from the series item DTO, so intro skip (IntroDB is keyed by IMDb ID) can
  // resolve without an extra API fetch.
  seriesProviderIds?: Record<string, string>;
  seriesProductionYear?: number | null;
  // Item-level metadata provider IDs (Imdb/Tmdb/year) for movie/standalone
  // plays that have no series — mirrors seriesProviderIds.
  itemProviderIds?: Record<string, string> | null;
  itemProductionYear?: number | null;
  episodeIndex?: number | null;
  episodeParentIndex?: number | null;
  episodeName?: string | null;
  // Remembered per-item subtitle selections (itemId -> stream index), captured
  // from the web client's own localStorage so prev/next and re-plays can start
  // with the user's subtitle.
  subtitlePrefs?: Record<string, number>;
  episodes?: Array<{
    id: string;
    indexNumber?: number | null;
    parentIndexNumber?: number | null;
    name?: string;
    positionTicks?: number;
  }>;
  // The web client's own play queue at handoff (a Jellyfin playlist, an album,
  // or a "play next" queue) in play order, plus the index of the item being
  // played. Prev/next and auto-play follow this instead of the series episode
  // list when it is present.
  queue?: {
    items: JellyfinQueueItem[];
    index: number;
    playlistId?: string | null;
    playlistName?: string | null;
  } | null;
  // Current Jellyfin user id — lets the frontend resolve details for queue
  // entries the page never opened.
  userId?: string;
}

interface JellyfinPageProps {
  /** Whether the Jellyfin tab is currently the active app view. */
  visible: boolean;
  /**
   * Called when Rust forwards a captured Jellyfin stream URL (the injected page
   * script found a direct-stream <video>/<audio> element). Resolves true when
   * the stream is playing through the app's own player.
   */
  onPlay?: (payload: JellyfinPlayPayload) => Promise<boolean>;
}

export function JellyfinPage({ visible, onPlay }: JellyfinPageProps) {
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [state, setState] = useState<ConnState>('idle');
  const [userName, setUserName] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  // The child WebView is positioned relative to the native app window, so use
  // the frame's viewport rectangle rather than coordinates relative to this
  // React component.
  const pageRef = useRef<HTMLDivElement>(null);
  const videoAreaRef = useRef<HTMLDivElement>(null);
  const connectedRef = useRef(false);
  const aliveRef = useRef(true);
  const serverUrlRef = useRef('');
  useEffect(() => {
    serverUrlRef.current = serverUrl;
  }, [serverUrl]);

  /**
   * Compute the bounds for the embedded WebView (the frame below the wrapper
   * toolbar and any notice). `getBoundingClientRect` returns viewport CSS px,
   * while the native child WebView is positioned relative to the app window;
   * passing the rectangle directly prevents it from covering the toolbar.
   */
  const computeBounds = useCallback((): Bounds | null => {
    const frame = videoAreaRef.current;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    const x = rect.left;
    const y = rect.top;
    const width = rect.width;
    const height = rect.height;
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
  }, []);

  /** Create the child WebView fresh at the current bounds (hard reload). */
  const applyBoundsOpen = useCallback(
    async (url: string, boundsMaybe?: Bounds | null): Promise<boolean> => {
      const bounds = boundsMaybe ?? computeBounds();
      if (!bounds) return false;
      try {
        const debugLogging = useSettingsStore.getState().jellyfinDebugLoggingEnabled;
        await jellyfinEmbedOpen(url, bounds, debugLogging);
        return true;
      } catch (e) {
        console.warn('[Jellyfin] Failed to open embedded webview:', e);
        return false;
      }
    },
    [computeBounds],
  );

  // Restore the saved URL + username (and auto-reconnect) once settings load.
  useEffect(() => {
    (async () => {
      try {
        const res = await (window as any).storage.getSettings();
        const url = res?.data?.jellyfinServerUrl || '';
        const savedUser = res?.data?.jellyfinUsername || '';
        if (url) {
          setServerUrl(url);
          setState('connected');
          connectedRef.current = true;
        }
        if (savedUser) setUsername(savedUser);
      } catch (e) {
        console.warn('[Jellyfin] Failed to load saved settings:', e);
      }
    })();
  }, []);

  // Keep the child WebView alive while connected so the page state, scroll
  // position, and navigation history are preserved when returning from video
  // playback or switching tabs. It is hidden while off-screen and revealed
  // (with updated geometry) on return.
  useEffect(() => {
    if (!visible) {
      setJellyfinEmbedNavActive(false);
      void jellyfinEmbedSetVisible(false).catch(() => {});
      return;
    }
    const url = serverUrlRef.current;
    if (state !== 'connected' || !url) return;

    connectedRef.current = true;
    let cancelled = false;
    let timer: number | undefined;

    (async () => {
      try {
        const isOpen = await jellyfinEmbedIsOpen();
        if (cancelled || !aliveRef.current) return;
        if (isOpen) {
          const bounds = computeBounds();
          if (bounds) {
            await jellyfinEmbedResize(bounds).catch(() => {});
          }
          await jellyfinEmbedSetVisible(true).catch(() => {});
        } else {
          const delays = [120, 400, 1000];
          const openAttempt = (attempt: number) => {
            timer = window.setTimeout(async () => {
              if (cancelled || !aliveRef.current) return;
              const opened = await applyBoundsOpen(url);
              if (!opened && !cancelled && attempt + 1 < delays.length) {
                openAttempt(attempt + 1);
              }
            }, delays[attempt]);
          };
          openAttempt(0);
        }
      } catch (e) {
        console.warn('[Jellyfin] Failed to sync webview visibility:', e);
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [visible, state, applyBoundsOpen, computeBounds]);

  // Keep the child WebView synced to the window on resize while connected.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onResized(() => {
          if (connectedRef.current && visible) {
            const bounds = computeBounds();
            if (bounds) {
              jellyfinEmbedResize(bounds).catch((e) =>
                console.warn('[Jellyfin] Failed to resize webview:', e),
              );
            }
          }
        });
      } catch (e) {
        console.warn('[Jellyfin] Failed to attach resize listener:', e);
      }
    })();
    return () => {
      unlisten?.();
    };
  }, [computeBounds, visible]);

  // Keep the onPlay prop fresh (it may be re-created by App on re-renders).
  const onPlayRef = useRef(onPlay);
  useEffect(() => {
    onPlayRef.current = onPlay;
  }, [onPlay]);

  // Rust forwards a captured Jellyfin stream URL as a `jellyfin:play` event
  // (the page script writes it to document.title; the embed's title-change
  // callback emits it). Drive it through the app's normal play pipeline via the
  // onPlay prop. On success hide the child WebView until the page unmounts — it
  // must not linger over the fullscreen player surface — and confirm playback
  // to Rust so its idle listener can later signal "playback ended". On failure
  // re-arm Jellyfin's own web player so the page stays usable.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenDiag: (() => void) | undefined;
    let disposed = false;
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        if (disposed) return;
        unlistenDiag = await listen('jellyfin:bridge-diagnostic', (e: any) => {
          console.info('[Jellyfin bridge]', e.payload);
        });
        unlisten = await listen('jellyfin:play', async (e: any) => {
          const payload = (e.payload || {}) as JellyfinPlayPayload;
          if (!payload.url) return;
          const ok = onPlayRef.current ? await onPlayRef.current(payload) : false;
          if (ok) {
            // Hide the child while the fullscreen player is up. The page
            // unmount cleanup closes it, and the next mount opens a fresh
            // surface using the persisted Jellyfin session.
            try {
              await jellyfinEmbedSetVisible(false);
            } catch (err) {
              console.warn('[Jellyfin] Failed to hide embed after handoff:', err);
            }
            try {
              await jellyfinConfirmPlayback(payload.url);
            } catch (err) {
              console.warn('[Jellyfin] confirm_playback failed:', err);
            }
          } else {
            try {
              await jellyfinEmbedReenable();
            } catch (err) {
              console.warn('[Jellyfin] Failed to re-enable web player:', err);
            }
            setError(
              "Couldn't hand off to ynoTV's player — switched back to the Jellyfin web player. Press play again on the item.",
            );
          }
        });
      })
      .catch((e) => console.warn('[Jellyfin] Failed to attach play listener:', e));
    return () => {
      disposed = true;
      unlisten?.();
      unlistenDiag?.();
    };
  }, []);

  // The shared WebView2 profile preserves Jellyfin's login/session data when
  // the child is recreated; close it for real only on unmount (app teardown).
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      jellyfinEmbedClose().catch(() => {});
    };
  }, []);

  const persist = useCallback(async (patch: Record<string, unknown>) => {
    try {
      await (window as any).storage.updateSettings(patch);
    } catch (e) {
      console.warn('[Jellyfin] Failed to persist settings:', e);
    }
  }, []);

  const handleConnect = async () => {
    const url = serverUrl.trim();
    setError('');
    setMessage('');
    if (!url) {
      setError('Enter the Jellyfin server URL first.');
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http(s)');
    } catch {
      setError('That URL is not valid — include http:// or https:// (e.g. http://192.168.1.10:8096).');
      return;
    }

    setState('connecting');
    try {
      // Optional credential validation against the Jellyfin API.
      if (username.trim() && password) {
        const session = await jellyfinAuthenticate(url, username.trim(), password);
        if (!session || !session.token) {
          setError('Login failed — double-check your username and password.');
          setState('idle');
          return;
        }
        setUserName(session.displayName || username.trim());
        if (session.userId) setUsername(username.trim());
      }
      await persist({ jellyfinServerUrl: url });
      if (username.trim()) await persist({ jellyfinUsername: username.trim() });

      setState('connected');
      connectedRef.current = true;
      if (username.trim()) setMessage(`Connected — authenticated as ${username.trim()}.`);
      else setMessage('Connected.');
    } catch (e) {
      console.warn('[Jellyfin] Connect failed:', e);
      setError('Could not reach that server URL.');
      setState('idle');
      connectedRef.current = false;
    }
  };

  const handleReload = async () => {
    const url = serverUrl.trim() || (await (window as any).storage.getSettings())?.data?.jellyfinServerUrl || '';
    if (!url) return;
    setMessage('');
    setError('');
    await applyBoundsOpen(url);
  };

  const handleDisconnect = async () => {
    setState('idle');
    connectedRef.current = false;
    setMessage('');
    setError('');
    setPassword('');
    setUserName(null);
    try {
      await jellyfinEmbedClose();
    } catch (e) {
      console.warn('[Jellyfin] Failed to close webview:', e);
    }
    await persist({ jellyfinServerUrl: '' });
  };

  return (
    <div className="jellyfin-page" ref={pageRef}>
      <div className="jellyfin-toolbar">
        <div className="jellyfin-fields">
          <input
            className="jellyfin-input jellyfin-url"
            type="text"
            placeholder="Server URL — e.g. http://192.168.1.10:8096"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            autoComplete="url"
            spellCheck={false}
          />
          <input
            className="jellyfin-input"
            type="text"
            placeholder="Username (if required)"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            spellCheck={false}
          />
          <input
            className="jellyfin-input"
            type="password"
            placeholder="Password (if required)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="jellyfin-actions">
          {state === 'connected' ? (
            <>
              <button className="jellyfin-btn" onClick={handleReload} disabled={!connectedRef.current}>
                Reload
              </button>
              <button className="jellyfin-btn jellyfin-btn-ghost" onClick={handleDisconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <button className="jellyfin-btn jellyfin-btn-primary" onClick={handleConnect} disabled={state === 'connecting'}>
              {state === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
        {userName && <span className="jellyfin-user">{userName}</span>}
      </div>

      {(message || error) && (
        <div className={`jellyfin-notice ${error ? 'is-error' : ''}`}>{error || message}</div>
      )}      <div className="jellyfin-frame-wrap" ref={videoAreaRef}>
        {state === 'idle' ? (
          <div className="jellyfin-empty">
            <div className="jellyfin-empty-title">Jellyfin</div>
            <p className="jellyfin-empty-text">
              Enter your Jellyfin server URL above and press Connect to load it here.
              Add a username and password when the server requires them.
            </p>
          </div>
        ) : (
          <div className="jellyfin-embed-host" />
        )}
      </div>
    </div>
  );
}