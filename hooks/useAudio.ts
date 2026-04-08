'use client';
import { useState, useRef, useEffect, useCallback, MutableRefObject } from 'react';

export interface Track {
  url: string;
  title: string;
  artist?: string;
  album?: string;
  coverArt?: string;
  thumbnail?: string;
  source?: 'local' | 'youtube' | 'direct';
  /**
   * Original YouTube page URL.  Stored so AeolianApp can silently re-resolve
   * a fresh stream when the ~6 h expiry returns a 403.
   */
  originalUrl?: string;
}

export interface AudioState {
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  error: string | null;
  /** Raw MediaError.code — lets AeolianApp decide whether to attempt a YouTube stream refresh. */
  errorCode: number | null;
  /** Flips to true when the track plays to the end; reset on each new load. */
  trackEnded: boolean;
}

export interface UseAudioReturn {
  audioRef: MutableRefObject<HTMLAudioElement | null>;
  analyserRef: MutableRefObject<AnalyserNode | null>;
  track: Track | null;
  state: AudioState;
  loadTrack: (t: Track) => Promise<void>;
  /**
   * Swap in a fresh stream URL without resetting the player UI.
   * Used for YouTube 403 / link-expiry recovery.
   */
  updateStreamUrl: (freshUrl: string) => Promise<void>;
  togglePlay: () => void;
  seek: (time: number) => void;
  setVolume: (vol: number) => void;
  clearTrack: () => void;
}

export function useAudio(): UseAudioReturn {
  const audioRef           = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const analyserRef        = useRef<AnalyserNode | null>(null);
  const sourceConnectedRef = useRef(false);
  /**
   * FIX — stale-closure bug (original: `audio.volume = state.volume` inside
   * useCallback with `state.volume` as a dependency).
   *
   * Problem: if the user changes volume and immediately triggers loadTrack
   * before React flushes the state update, the captured state.volume is still
   * the old value.
   *
   * Fix: write every volume change into this ref immediately in setVolume, then
   * read volumeRef.current inside loadTrack / updateStreamUrl.  The ref is
   * always in sync — no render cycle required, no stale closure possible.
   */
  const volumeRef = useRef(0.85);

  const [track, setTrack] = useState<Track | null>(null);
  const [state, setState] = useState<AudioState>({
    isPlaying:   false,
    isLoading:   false,
    currentTime: 0,
    duration:    0,
    volume:      0.85,
    error:       null,
    errorCode:   null,
    trackEnded:  false,
  });

  // ── Bootstrap audio element ────────────────────────────────────────────────
  useEffect(() => {
    const audio      = new Audio();
    // FIX: do NOT set crossOrigin here. Setting crossOrigin='anonymous'
    // unconditionally tells the browser to make every request in CORS mode.
    // YouTube CDN streams deliberately omit Access-Control-Allow-Origin headers,
    // so the browser rejects them with a CORS error and audio never plays.
    // crossOrigin is now set per-track in loadTrack/updateStreamUrl: 'anonymous'
    // only for local blob: URLs (needed for the Web Audio analyser) and direct
    // audio files; left unset (null) for YouTube/external streams.
    audio.preload    = 'metadata';
    audioRef.current = audio;

    // FIX: setting audio.src='' then audio.load() (done in loadTrack to flush
    // the previous source) fires a synthetic error event with code 4
    // (MEDIA_ERR_SRC_NOT_SUPPORTED). Without this guard that ghost error briefly
    // sets state.error and can misfire the YouTube retry logic.
    // We arm the flag to true only after assigning a real src in loadTrack /
    // updateStreamUrl, and disarm it again when we clear.
    let srcIsReal = false;
    const setSrcReal = (v: boolean) => { srcIsReal = v; };
    (audio as HTMLAudioElement & { _setSrcReal: typeof setSrcReal })._setSrcReal = setSrcReal;

    const on = (e: string, fn: () => void) => audio.addEventListener(e, fn);

    on('timeupdate', () => {
      setState((p) => ({ ...p, currentTime: audio.currentTime }));
      // FIX: update MediaSession position so the OS lock-screen / notification
      // scrubber reflects the current playback position. Without this the
      // scrubber stays at 0 on Android Chrome and some desktop platforms.
      if (
        typeof navigator !== 'undefined' &&
        'mediaSession' in navigator &&
        isFinite(audio.duration) &&
        audio.duration > 0
      ) {
        try {
          navigator.mediaSession.setPositionState({
            duration:     audio.duration,
            playbackRate: audio.playbackRate,
            position:     audio.currentTime,
          });
        } catch { /* setPositionState not supported on this platform */ }
      }
    });
    on('durationchange', () =>
      setState((p) => ({ ...p, duration: isFinite(audio.duration) ? audio.duration : 0 }))
    );
    on('play',    () => {
      // FIX: resume the AudioContext when playback starts so the analyser runs.
      if (audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {});
      }
      // FIX: keep MediaSession.playbackState in sync — without this, OS media
      // controls (lock screen, notification bar) show stale state on some platforms.
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
      setState((p) => ({ ...p, isPlaying: true, isLoading: false }));
    });
    on('pause',   () => {
      // FIX: suspend the AudioContext when paused — without this the analyser node
      // keeps pulling data and the browser can't sleep the audio thread, draining
      // CPU and battery even while nothing is playing.
      if (audioCtxRef.current?.state === 'running') {
        audioCtxRef.current.suspend().catch(() => {});
      }
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
      setState((p) => ({ ...p, isPlaying: false }));
    });
    on('ended', () => {
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'none';
      }
      setState((p) => ({ ...p, isPlaying: false, trackEnded: true }));
    });
    on('waiting', () => setState((p) => ({ ...p, isLoading: true })));
    on('canplay', () => setState((p) => ({ ...p, isLoading: false })));
    on('error',   () => {
      if (!srcIsReal) return; // ignore the synthetic error from clearing src
      const code = audio.error?.code ?? 0;
      const msgs: Record<number, string> = {
        1: 'Playback aborted.',
        2: 'Network error — the stream may be unavailable.',
        3: 'Decoding error — unsupported format or corrupted file.',
        4: 'Source not supported.',
      };
      setState((p) => ({
        ...p,
        isLoading: false,
        isPlaying: false,
        error:     msgs[code] ?? 'Unknown playback error.',
        errorCode: code,
      }));
    });

    audio.volume = volumeRef.current;

    return () => {
      audio.pause();
      // FIX: disarm before clearing src so the synthetic error(4) fired by
      // setting src='' on unmount doesn't try to setState on an unmounted component.
      setSrcReal(false);
      audio.src        = '';
      audioRef.current = null;
      audioCtxRef.current?.close();
      audioCtxRef.current        = null;
      analyserRef.current        = null;
      sourceConnectedRef.current = false;
    };
  }, []);

  // ── Media Session API ──────────────────────────────────────────────────────
  // FIX — Media Session was entirely absent.
  // Adding it enables lock-screen / notification-bar transport controls and
  // headset-button support (Chrome desktop, iOS Safari 15+, Android WebView).
  useEffect(() => {
    if (!track || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const artwork: MediaImage[] = [];
    const artSrc = track.coverArt ?? track.thumbnail;
    if (artSrc) artwork.push({ src: artSrc });

    navigator.mediaSession.metadata = new MediaMetadata({
      title:   track.title,
      artist:  track.artist ?? '',
      album:   track.album  ?? '',
      artwork,
    });

    const audio = audioRef.current;
    type Pair = [MediaSessionAction, MediaSessionActionHandler | null];
    const handlers: Pair[] = [
      ['play',  () => audio?.play()],
      ['pause', () => audio?.pause()],
      ['seekbackward', ({ seekOffset }) => {
        if (audio) audio.currentTime = Math.max(0, audio.currentTime - (seekOffset ?? 10));
      }],
      ['seekforward', ({ seekOffset }) => {
        if (audio)
          audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (seekOffset ?? 10));
      }],
      ['seekto', ({ seekTime }) => {
        if (audio && seekTime != null) audio.currentTime = seekTime;
      }],
    ];

    for (const [action, handler] of handlers) {
      try { navigator.mediaSession.setActionHandler(action, handler); }
      catch { /* action not supported on this platform */ }
    }

    return () => {
      for (const [action] of handlers) {
        try { navigator.mediaSession.setActionHandler(action, null); }
        catch { /* ok */ }
      }
    };
  }, [track]);

  // ── Setup Web Audio context (lazy — needs a user gesture first) ────────────
  const ensureAudioContext = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || sourceConnectedRef.current) return;

    try {
      const ctx     = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize               = 512;
      analyser.smoothingTimeConstant = 0.8;

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);

      audioCtxRef.current        = ctx;
      analyserRef.current        = analyser;
      sourceConnectedRef.current = true;
    } catch (err) {
      console.warn('AudioContext setup failed:', err);
    }
  }, []);

  // ── Load & play a track ────────────────────────────────────────────────────
  const loadTrack = useCallback(
    async (newTrack: Track) => {
      const audio = audioRef.current;
      if (!audio) return;

      setState((p) => ({
        ...p,
        isLoading:   true,
        error:       null,
        errorCode:   null,
        currentTime: 0,
        duration:    0,
        trackEnded:  false,
      }));
      setTrack(newTrack);

      audio.pause();
      // Disarm before clearing src so the synthetic error(4) is suppressed
      (audio as HTMLAudioElement & { _setSrcReal?: (v: boolean) => void })._setSrcReal?.(false);
      audio.src = '';
      audio.load();

      // FIX: replaced the arbitrary 50ms setTimeout with an 'emptied' event wait.
      // 'emptied' fires when the browser has fully released the previous resource
      // (after src='' + load()). The old 50ms was a guess that fails on slow
      // devices. We cap at 300ms to avoid hanging if the event never fires
      // (some browsers skip it when src was already empty).
      await new Promise<void>((resolve) => {
        const onEmptied = () => { audio.removeEventListener('emptied', onEmptied); resolve(); };
        audio.addEventListener('emptied', onEmptied);
        setTimeout(resolve, 300); // safety cap
      });

      // FIX: set crossOrigin per-track. 'anonymous' is needed for blob: URLs so
      // the Web Audio API can connect a MediaElementSource (same-origin policy
      // for AudioContext). For YouTube/external streams, crossOrigin must be null
      // — those CDNs do not send CORS headers and the browser would block them.
      audio.crossOrigin = newTrack.source === 'local' ? 'anonymous' : null;
      (audio as HTMLAudioElement & { _setSrcReal?: (v: boolean) => void })._setSrcReal?.(true);
      audio.src    = newTrack.url;
      audio.volume = volumeRef.current; // FIX: was state.volume (stale closure)

      try {
        ensureAudioContext();
        if (audioCtxRef.current?.state === 'suspended') {
          await audioCtxRef.current.resume();
        }
        await audio.play();
        setState((p) => ({ ...p, isPlaying: true, isLoading: false }));
      } catch (err) {
        setState((p) => ({
          ...p,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Playback failed.',
        }));
      }
    },
    [ensureAudioContext] // `state.volume` intentionally removed — volumeRef handles it
  );

  // ── Hot-swap stream URL (YouTube ~6 h expiry recovery) ──────────────────────
  // FIX — new addition.
  // YouTube direct stream URLs expire after ~6 hours.  Resuming a long-paused
  // session returns HTTP 403 / MediaError code 2.  AeolianApp detects this
  // combination (youtube source + errorCode 2 or 4) and calls updateStreamUrl
  // with a freshly resolved URL, transparently continuing playback.
  const updateStreamUrl = useCallback(
    async (freshUrl: string) => {
      const audio = audioRef.current;
      if (!audio) return;

      setState((p) => ({ ...p, isLoading: true, error: null, errorCode: null }));
      setTrack((prev) => (prev ? { ...prev, url: freshUrl } : null));

      audio.pause();
      // Arm immediately — updateStreamUrl always sets a real src.
      // Keep existing crossOrigin setting (the track source hasn't changed).
      (audio as HTMLAudioElement & { _setSrcReal?: (v: boolean) => void })._setSrcReal?.(true);
      audio.src    = freshUrl;
      audio.volume = volumeRef.current;

      try {
        ensureAudioContext();
        if (audioCtxRef.current?.state === 'suspended') {
          await audioCtxRef.current.resume();
        }
        await audio.play();
        setState((p) => ({ ...p, isPlaying: true, isLoading: false }));
      } catch (err) {
        setState((p) => ({
          ...p,
          isLoading: false,
          error: err instanceof Error ? err.message : 'Stream refresh failed.',
        }));
      }
    },
    [ensureAudioContext]
  );

  // ── Controls ───────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;

    if (state.isPlaying) {
      audio.pause();
    } else {
      ensureAudioContext();
      // FIX: resume() returns a Promise — must be awaited (or at least handled)
      // so the context is running before audio.play() is called.
      if (audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().then(() => audio.play().catch(() => {}));
        return;
      }
      audio.play().catch(() => {});
    }
  }, [state.isPlaying, ensureAudioContext]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(time, audio.duration || 0));
  }, []);

  const setVolume = useCallback((vol: number) => {
    const v = Math.max(0, Math.min(1, vol));
    volumeRef.current = v;                               // write ref immediately
    if (audioRef.current) audioRef.current.volume = v;
    setState((p) => ({ ...p, volume: v }));
  }, []);

  const clearTrack = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      // FIX: disarm before clearing src — audio.src='' fires MediaError(4)
      // which would set state.error on the now-cleared player if srcIsReal=true.
      (audio as HTMLAudioElement & { _setSrcReal?: (v: boolean) => void })._setSrcReal?.(false);
      audio.src = '';
      // FIX: call audio.load() after clearing src — without it, Firefox and
      // Safari keep the previous resource buffered in memory and may fire
      // stale timeupdate or ended events for the old track.
      audio.load();
    }
    setTrack(null);
    setState((p) => ({
      ...p,
      isPlaying:   false,
      isLoading:   false,
      currentTime: 0,
      duration:    0,
      error:       null,
      errorCode:   null,
      trackEnded:  false,
    }));
  }, []);

  return {
    audioRef, analyserRef, track, state,
    loadTrack, updateStreamUrl, togglePlay, seek, setVolume, clearTrack,
  };
}
