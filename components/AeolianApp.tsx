'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useAudio }    from '@/hooks/useAudio';
import { useMetadata } from '@/hooks/useMetadata';
import type { Track }  from '@/hooks/useAudio';
import Player          from './Player';
import styles          from './AeolianApp.module.css';

const Aura = dynamic(() => import('./Aura'), { ssr: false });

const ACCEPTED_MIME = new Set(['audio/mpeg', 'audio/flac', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/webm']);
const ACCEPTED_EXT  = /\.(mp3|flac|wav|m4a|aac|ogg|opus|webm)$/i;
const HISTORY_KEY  = 'aeolian_history';
const MAX_HISTORY  = 20;

function isAudioFile(f: File) {
  const mime = f.type.split(';')[0].trim();
  return ACCEPTED_MIME.has(mime) || ACCEPTED_EXT.test(f.name);
}

type AppPhase = 'idle' | 'resolving' | 'playing' | 'error';

interface QueueEntry {
  id:    string;
  track: Track;
}

interface HistoryEntry {
  id:        string;
  title:     string;
  artist?:   string;
  source?:   Track['source'];
  replayUrl: string;
  playedAt:  number;
}

function isValidHistoryEntry(h: unknown): h is HistoryEntry {
  return (
    h !== null &&
    typeof h === 'object' &&
    typeof (h as HistoryEntry).id        === 'string' &&
    typeof (h as HistoryEntry).title     === 'string' &&
    typeof (h as HistoryEntry).replayUrl === 'string' &&
    typeof (h as HistoryEntry).playedAt  === 'number'
  );
}

function loadHistory(): HistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidHistoryEntry);
  } catch {
    return [];
  }
}

export default function AeolianApp() {
  const {
    analyserRef, track, state,
    loadTrack, updateStreamUrl, togglePlay, seek, setVolume, clearTrack,
  } = useAudio();
  const { extractMetadata } = useMetadata();

  const [phase,      setPhase]    = useState<AppPhase>('idle');
  const [statusMsg,  setStatusMsg]= useState('');
  const dragCounterRef            = useRef(0);
  const rootRef                   = useRef<HTMLDivElement>(null);
  const objUrlsRef                = useRef<Set<string>>(new Set());

  const [queue,      setQueue]      = useState<QueueEntry[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [showQueue,  setShowQueue]  = useState(false);

  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);

  const abortRef    = useRef<AbortController | null>(null);
  const ytAbortRef  = useRef<AbortController | null>(null);
  const mountedRef  = useRef(true);
  const ytRetryRef  = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      ytAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (state.error) {
      setPhase('error');
      setStatusMsg(state.error);
    } else if (state.isPlaying) {
      setPhase('playing');
    }
  }, [state.error, state.isPlaying]);

  // Shared fetch helper used by both handleURL and the YouTube expiry recovery.
  const resolveStream = useCallback(async (url: string, signal: AbortSignal) => {
    const res  = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`, { signal });
    const data = await res.json();
    if (!res.ok || data.error) throw Object.assign(new Error(data.error ?? 'Resolution failed.'), { isApiError: true });
    return data as { url: string; title: string; thumbnail?: string; source: Track['source']; originalUrl?: string };
  }, []);

  useEffect(() => {
    if (!state.errorCode || !track?.originalUrl || track.source !== 'youtube') return;
    if (ytRetryRef.current) return;
    if (state.errorCode !== 2 && state.errorCode !== 4) return;

    ytRetryRef.current = true;
    setPhase('resolving');
    setStatusMsg('Stream expired — refreshing…');

    const controller  = new AbortController();
    ytAbortRef.current = controller;
    resolveStream(track.originalUrl, controller.signal)
      .then(data => {
        ytRetryRef.current = false;
        updateStreamUrl(data.url);
        setPhase('playing');
      })
      .catch(err => {
        if (err?.name === 'AbortError') return;
        setPhase('error');
        setStatusMsg(err.isApiError ? err.message : 'Network error while refreshing stream.');
      });
    return () => controller.abort();
  }, [state.errorCode, track, resolveStream, updateStreamUrl]);

  const revokeObjUrls = useCallback(() => {
    objUrlsRef.current.forEach(u => URL.revokeObjectURL(u));
    objUrlsRef.current.clear();
  }, []);

  const persistToHistory = useCallback((t: Track) => {
    if (t.source === 'local') return;
    const entry: HistoryEntry = {
      id:        crypto.randomUUID(),
      title:     t.title,
      artist:    t.artist,
      source:    t.source,
      replayUrl: t.originalUrl ?? t.url,
      playedAt:  Date.now(),
    };
    setHistory(prev => {
      const updated = [entry, ...prev.filter(h => h.replayUrl !== entry.replayUrl)].slice(0, MAX_HISTORY);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch { /* quota */ }
      return updated;
    });
  }, []);

  const enqueueAndPlay = useCallback(async (newTrack: Track) => {
    ytRetryRef.current = false;
    setQueue(prev => [...prev, { id: crypto.randomUUID(), track: newTrack }]);
    setQueueIndex(prev => prev + 1);
    persistToHistory(newTrack);
    await loadTrack(newTrack);
  }, [loadTrack, persistToHistory]);

  const playAtIndex = useCallback(async (index: number, closeQueue = false) => {
    const entry = queue[index];
    if (!entry) return;
    ytRetryRef.current = false;
    setQueueIndex(index);
    if (closeQueue) setShowQueue(false);
    persistToHistory(entry.track);
    await loadTrack(entry.track);
  }, [queue, persistToHistory, loadTrack]);

  const skipNext = useCallback(async () => {
    const next = queueIndex + 1;
    if (next < queue.length) await playAtIndex(next);
  }, [queueIndex, queue.length, playAtIndex]);

  const skipPrev = useCallback(async () => {
    if (state.currentTime > 3) {
      seek(0);
      return;
    }
    const prev = queueIndex - 1;
    if (prev >= 0) await playAtIndex(prev);
    else seek(0);
  }, [queueIndex, state.currentTime, seek, playAtIndex]);

  const canSkipNext = queueIndex < queue.length - 1;
  const canSkipPrev = queueIndex > 0 || state.currentTime > 3;

  useEffect(() => {
    if (!state.trackEnded) return;
    if (canSkipNext) skipNext();
    else setPhase('idle');
  }, [state.trackEnded, canSkipNext, skipNext]);

  const handleFile = useCallback(async (file: File) => {
    if (!isAudioFile(file)) {
      setPhase('error');
      setStatusMsg('Unsupported file type. Try MP3, FLAC, WAV, or M4A.');
      return;
    }
    if (phase !== 'playing') {
      setPhase('resolving');
      setStatusMsg('Reading file…');
    }
    const url = URL.createObjectURL(file);
    objUrlsRef.current.add(url);
    const meta = await extractMetadata(file);
    if (!mountedRef.current) return;
    await enqueueAndPlay({
      url,
      title:    meta.title ?? file.name,
      artist:   meta.artist,
      album:    meta.album,
      coverArt: meta.coverArt,
      source:   'local',
    });
  }, [phase, extractMetadata, enqueueAndPlay]);

  const handleURL = useCallback(async (rawUrl: string) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      setPhase('error');
      setStatusMsg('Invalid URL — please paste a valid http/https link.');
      return;
    }
    setPhase('resolving');
    setStatusMsg('Resolving stream…');
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const data = await resolveStream(parsed.href, controller.signal);
      if (!mountedRef.current) return;
      await enqueueAndPlay({
        url:         data.url,
        title:       data.title,
        thumbnail:   data.thumbnail,
        source:      data.source,
        originalUrl: data.originalUrl,
      });
    } catch (err) {
      if (!mountedRef.current || (err instanceof Error && err.name === 'AbortError')) return;
      setPhase('error');
      setStatusMsg((err as { isApiError?: boolean; message?: string }).isApiError
        ? ((err as { message?: string }).message ?? 'Resolution failed.')
        : 'Network error — could not resolve the URL.');
    }
  }, [resolveStream, enqueueAndPlay]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (text && /^https?:\/\//.test(text)) handleURL(text);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [handleURL]);

  useEffect(() => () => revokeObjUrls(), [revokeObjUrls]);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    rootRef.current?.setAttribute('data-drag-over', '');
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (--dragCounterRef.current === 0) rootRef.current?.removeAttribute('data-drag-over');
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => e.preventDefault(), []);
  const onDrop     = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    rootRef.current?.removeAttribute('data-drag-over');
    const files = Array.from(e.dataTransfer.files).filter(isAudioFile);
    if (!files.length) {
      setPhase('error');
      setStatusMsg('Unsupported file type. Try MP3, FLAC, WAV, or M4A.');
      return;
    }
    files.reduce((chain, file) => chain.then(() => handleFile(file)), Promise.resolve());
  }, [handleFile]);

  useEffect(() => {
    const clearDrag = () => {
      dragCounterRef.current = 0;
      rootRef.current?.removeAttribute('data-drag-over');
    };
    window.addEventListener('dragend', clearDrag);
    document.addEventListener('visibilitychange', clearDrag);
    return () => {
      window.removeEventListener('dragend', clearDrag);
      document.removeEventListener('visibilitychange', clearDrag);
    };
  }, []);

  const fileRef       = useRef<HTMLInputElement>(null);
  const queueDrawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showQueue) queueDrawerRef.current?.focus();
  }, [showQueue]);

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []).filter(isAudioFile);
    if (files.length) files.reduce((chain, f) => chain.then(() => handleFile(f)), Promise.resolve());
    e.target.value = '';
  }, [handleFile]);

  const reset = useCallback(() => {
    clearTrack();
    revokeObjUrls();
    abortRef.current?.abort();
    ytAbortRef.current?.abort();
    setPhase('idle');
    setStatusMsg('');
    setShowQueue(false);
    setQueue([]);
    setQueueIndex(-1);
    ytRetryRef.current = false;
  }, [clearTrack, revokeObjUrls]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const actions: [MediaSessionAction, (() => void) | null][] = [
      ['previoustrack', canSkipPrev ? () => skipPrev() : null],
      ['nexttrack',     canSkipNext ? () => skipNext() : null],
    ];
    for (const [action, handler] of actions) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* ok */ }
    }
    return () => {
      for (const [action] of actions) {
        try { navigator.mediaSession.setActionHandler(action, null); } catch { /* ok */ }
      }
    };
  }, [canSkipPrev, canSkipNext, skipPrev, skipNext]);

  const isPlay = phase === 'playing';

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="mesh-bg" aria-hidden="true">
        <div className="mesh-orb mesh-orb-1" />
        <div className="mesh-orb mesh-orb-2" />
        <div className="mesh-orb mesh-orb-3" />
        <div className="mesh-orb mesh-orb-4" />
      </div>
      <div className="mesh-grain" aria-hidden="true" />

      <main className={styles.stage}>
        <header className={styles.header}>
          <span className={styles.logo}>Aeolian</span>
        </header>

        <div className={styles.auraWrap}>
          <Aura
            analyserNode={analyserRef.current}
            isPlaying={state.isPlaying}
            coverColor={track?.coverArt ?? track?.thumbnail}
          />
        </div>

        {phase === 'idle' && (
          <div className={styles.idlePrompt}>
            <button className={styles.plusBtn} onClick={() => fileRef.current?.click()} aria-label="Open file">
              <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="16" y1="6"  x2="16" y2="26" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="6"  y1="16" x2="26" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <p className={styles.hint}>
              Drop a file <span className={styles.sep}>·</span> Paste a URL
            </p>

            {history.length > 0 && (
              <div className={styles.history}>
                <p className={styles.historyLabel}>Recent</p>
                <div className={styles.historyList}>
                  {history.slice(0, 6).map(entry => (
                    <button key={entry.id} className={styles.historyItem} onClick={() => handleURL(entry.replayUrl)}>
                      <span className={styles.historyTitle}>{entry.title}</span>
                      {entry.source && (
                        <span className={`${styles.historyBadge} ${styles[`badge_${entry.source}`]}`}>
                          {entry.source}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {phase === 'resolving' && (
          <div className={styles.status} role="status" aria-live="polite">
            <div className={styles.resolveSpinner} aria-hidden="true" />
            <span>{statusMsg}</span>
          </div>
        )}

        {phase === 'error' && (
          <div className={styles.errorBox} role="alert" aria-live="assertive">
            <svg className={styles.errorIcon} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1" />
              <path d="M10 6v5M10 13.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p className={styles.errorText}>{statusMsg}</p>
            <button className={styles.retryBtn} onClick={reset}>Try again</button>
          </div>
        )}

        {isPlay && track && (
          <Player
            track={track} state={state}
            onTogglePlay={togglePlay} onSeek={seek} onVolume={setVolume}
            onClose={reset} onSkipPrev={skipPrev} onSkipNext={skipNext}
            canSkipPrev={canSkipPrev} canSkipNext={canSkipNext}
            queueLength={queue.length}
            onToggleQueue={queue.length > 1 ? () => setShowQueue(v => !v) : undefined}
          />
        )}
      </main>

      {showQueue && isPlay && queue.length > 1 && (
        <>
          <div className={styles.queueBackdrop} onClick={() => setShowQueue(false)} aria-hidden="true" />
          <div
            ref={queueDrawerRef}
            className={styles.queueDrawer}
            role="dialog"
            aria-label="Queue"
            aria-modal="true"
            tabIndex={-1}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setShowQueue(false);
              }
            }}
          >
            <div className={styles.queueDrawerHeader}>
              <span className={styles.queueDrawerTitle}>Queue</span>
              <span className={styles.queueDrawerCount}>{queue.length} tracks</span>
              <button className={styles.queueDrawerClose} onClick={() => setShowQueue(false)} aria-label="Close queue">
                <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className={styles.queueList}>
              {queue.map((entry, i) => (
                <button
                  key={entry.id}
                  className={`${styles.queueItem} ${i === queueIndex ? styles.queueItemActive : ''}`}
                  onClick={() => playAtIndex(i, true)}
                >
                  <span className={styles.queueItemNum}>{i + 1}</span>
                  <div className={styles.queueItemMeta}>
                    <span className={styles.queueItemTitle}>{entry.track.title}</span>
                    {entry.track.artist && (
                      <span className={styles.queueItemArtist}>{entry.track.artist}</span>
                    )}
                  </div>
                  {i === queueIndex && (
                    <span className={styles.queueItemNowPlaying} aria-label="Now playing">
                      <svg viewBox="0 0 12 12" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                        <rect x="0" y="2" width="2" height="8" rx="1" />
                        <rect x="4" y="0" width="2" height="12" rx="1" />
                        <rect x="8" y="3" width="2" height="7" rx="1" />
                      </svg>
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <footer className={styles.footer}>
        <p>
          Aeolian is an open-source, neutral media player.
          It does not host, store, or distribute content.
          All copyright belongs to the original creators and platforms.
        </p>
      </footer>

      <input
        ref={fileRef}
        type="file"
        accept=".mp3,.flac,.wav,.m4a,.aac,.ogg,.opus,.webm"
        multiple
        className={styles.fileInput}
        onChange={onFileChange}
        tabIndex={-1}
      />
    </div>
  );
}
