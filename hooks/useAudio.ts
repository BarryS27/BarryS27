'use client';
import { useState, useRef, useEffect, useCallback, MutableRefObject } from 'react';

export interface Track {
  url:          string;
  title:        string;
  artist?:      string;
  album?:       string;
  coverArt?:    string;
  thumbnail?:   string;
  source?:      'local' | 'youtube' | 'direct';
  originalUrl?: string;
}

export interface AudioState {
  isPlaying:   boolean;
  isLoading:   boolean;
  currentTime: number;
  duration:    number;
  volume:      number;
  error:       string | null;
  errorCode:   number | null;
  trackEnded:  boolean;
}

export interface UseAudioReturn {
  audioRef:        MutableRefObject<HTMLAudioElement | null>;
  analyserRef:     MutableRefObject<AnalyserNode | null>;
  track:           Track | null;
  state:           AudioState;
  loadTrack:       (t: Track) => Promise<void>;
  updateStreamUrl: (freshUrl: string) => Promise<void>;
  togglePlay:      () => void;
  seek:            (time: number) => void;
  setVolume:       (vol: number) => void;
  clearTrack:      () => void;
}

const ERROR_MSGS: Record<number, string> = {
  1: 'Playback aborted.',
  2: 'Network error — the stream may be unavailable.',
  3: 'Decoding error — unsupported format or corrupted file.',
  4: 'Source not supported.',
};

function hasMediaSession() {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function useAudio(): UseAudioReturn {
  const audioRef           = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef        = useRef<AudioContext | null>(null);
  const analyserRef        = useRef<AnalyserNode | null>(null);
  const sourceConnectedRef = useRef(false);
  const volumeRef          = useRef(0.85);
  const srcIsRealRef       = useRef(false);

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

  useEffect(() => {
    const audio      = new Audio();
    audio.preload    = 'metadata';
    audioRef.current = audio;

    const handlers: [string, () => void][] = [];
    const on = (event: string, fn: () => void) => {
      audio.addEventListener(event, fn);
      handlers.push([event, fn]);
    };

    on('timeupdate', () => {
      setState(p => ({ ...p, currentTime: audio.currentTime }));
      if (!hasMediaSession() || !isFinite(audio.duration) || audio.duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState({
          duration:     audio.duration,
          playbackRate: audio.playbackRate,
          position:     Math.min(audio.currentTime, audio.duration),
        });
      } catch { /* not supported */ }
    });
    on('durationchange', () =>
      setState(p => ({ ...p, duration: isFinite(audio.duration) ? audio.duration : 0 }))
    );
    on('play', () => {
      if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {});
      if (hasMediaSession()) navigator.mediaSession.playbackState = 'playing';
      setState(p => ({ ...p, isPlaying: true, isLoading: false }));
    });
    on('pause', () => {
      if (audioCtxRef.current?.state === 'running') audioCtxRef.current.suspend().catch(() => {});
      if (hasMediaSession()) navigator.mediaSession.playbackState = 'paused';
      setState(p => ({ ...p, isPlaying: false }));
    });
    on('ended', () => {
      if (hasMediaSession()) navigator.mediaSession.playbackState = 'none';
      setState(p => ({ ...p, isPlaying: false, trackEnded: true }));
    });
    on('waiting', () => setState(p => ({ ...p, isLoading: true })));
    on('stalled', () => setState(p => ({ ...p, isLoading: true })));
    on('canplay', () => setState(p => ({ ...p, isLoading: false })));
    on('error',   () => {
      if (!srcIsRealRef.current) return;
      const code = audio.error?.code ?? 0;
      setState(p => ({
        ...p,
        isLoading: false,
        isPlaying: false,
        error:     ERROR_MSGS[code] ?? 'Unknown playback error.',
        errorCode: code,
      }));
    });

    audio.volume = volumeRef.current;

    return () => {
      audio.pause();
      srcIsRealRef.current       = false;
      audio.src                  = '';
      for (const [event, fn] of handlers) audio.removeEventListener(event, fn);
      audioRef.current           = null;
      audioCtxRef.current?.close();
      audioCtxRef.current        = null;
      analyserRef.current        = null;
      sourceConnectedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!hasMediaSession()) return;
    if (!track) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const artSrc = track.coverArt ?? track.thumbnail;
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   track.title,
      artist:  track.artist  ?? '',
      album:   track.album   ?? '',
      artwork: artSrc ? [{ src: artSrc }] : [],
    });
    const audio = audioRef.current;
    type Pair = [MediaSessionAction, MediaSessionActionHandler | null];
    const sessionHandlers: Pair[] = [
      ['play',         () => audio?.play().catch(() => {})],
      ['pause',        () => audio?.pause()],
      ['seekbackward', ({ seekOffset }) => {
        if (audio) audio.currentTime = Math.max(0, audio.currentTime - (seekOffset ?? 10));
      }],
      ['seekforward', ({ seekOffset }) => {
        if (!audio) return;
        const cap = isFinite(audio.duration) ? audio.duration : Infinity;
        audio.currentTime = Math.min(cap, audio.currentTime + (seekOffset ?? 10));
      }],
      ['seekto', ({ seekTime }) => {
        if (audio && seekTime != null) audio.currentTime = seekTime;
      }],
    ];
    for (const [action, handler] of sessionHandlers) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* ok */ }
    }
    return () => {
      for (const [action] of sessionHandlers) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* ok */ }
      }
    };
  }, [track]);

  const ensureAudioContext = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || sourceConnectedRef.current) return;
    try {
      const ctx      = new AudioContext();
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

  const startPlayback = useCallback(async (errMsg = 'Playback failed.') => {
    const audio = audioRef.current;
    if (!audio) return;
    ensureAudioContext();
    if (audioCtxRef.current?.state === 'suspended') await audioCtxRef.current.resume();
    try {
      await audio.play();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setState(p => ({ ...p, isLoading: false, error: err instanceof Error ? err.message : errMsg }));
    }
  }, [ensureAudioContext]);

  const loadTrack = useCallback(async (newTrack: Track) => {
    const audio = audioRef.current;
    if (!audio) return;
    setState(p => ({
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
    srcIsRealRef.current = false;
    audio.src            = '';
    audio.load();

    await new Promise<void>(resolve => {
      let done = false;
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const onEmptied = () => {
        if (done) return;
        done = true;
        clearTimeout(timerId);
        audio.removeEventListener('emptied', onEmptied);
        resolve();
      };
      audio.addEventListener('emptied', onEmptied);
      timerId = setTimeout(() => {
        if (done) return;
        done = true;
        audio.removeEventListener('emptied', onEmptied);
        resolve();
      }, 300);
    });

    audio.crossOrigin    = newTrack.source === 'local' ? 'anonymous' : null;
    if (audioRef.current === null) return;
    srcIsRealRef.current = true;
    audio.src            = newTrack.url;
    audio.volume         = volumeRef.current;
    await startPlayback();
  }, [startPlayback]);

  const updateStreamUrl = useCallback(async (freshUrl: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    setState(p => ({ ...p, isLoading: true, error: null, errorCode: null }));
    setTrack(prev => prev ? { ...prev, url: freshUrl } : null);
    audio.pause();
    srcIsRealRef.current = true;
    audio.src            = freshUrl;
    audio.volume         = volumeRef.current;
    await startPlayback('Stream refresh failed.');
  }, [startPlayback]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !srcIsRealRef.current) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (isFinite(audio.duration) && audio.currentTime >= audio.duration) {
      audio.currentTime = 0;
    }
    ensureAudioContext();
    if (audioCtxRef.current?.state === 'suspended') {
      audioCtxRef.current.resume().then(() => audio.play().catch(() => {}));
      return;
    }
    audio.play().catch(() => {});
  }, [ensureAudioContext]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const cap = isFinite(audio.duration) ? audio.duration : 0;
    audio.currentTime = Math.max(0, Math.min(time, cap));
  }, []);

  const setVolume = useCallback((vol: number) => {
    const v = Math.max(0, Math.min(1, vol));
    volumeRef.current = v;
    if (audioRef.current) audioRef.current.volume = v;
    setState(p => ({ ...p, volume: v }));
  }, []);

  const clearTrack = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      srcIsRealRef.current = false;
      audio.src            = '';
      audio.load();
    }
    setTrack(null);
    setState(p => ({
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

  return { audioRef, analyserRef, track, state, loadTrack, updateStreamUrl, togglePlay, seek, setVolume, clearTrack };
}
