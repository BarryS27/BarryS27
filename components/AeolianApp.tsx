'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useAudio }    from '@/hooks/useAudio';
import { useMetadata } from '@/hooks/useMetadata';
import type { Track }  from '@/hooks/useAudio';
import Player          from './Player';
import styles          from './AeolianApp.module.css';

const Aura = dynamic(() => import('./Aura'), { ssr: false });

// ── Constants ──────────────────────────────────────────────────────────────
const ACCEPTED     = ['audio/mpeg', 'audio/flac', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/aac', 'audio/ogg'];
const ACCEPTED_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|opus)$/i;
const HISTORY_KEY  = 'aeolian_history';
const MAX_HISTORY  = 20;

function isAudioFile(f: File) {
  return ACCEPTED.some((t) => f.type.startsWith(t)) || ACCEPTED_EXT.test(f.name);
}

// ── Types ──────────────────────────────────────────────────────────────────
type AppPhase = 'idle' | 'resolving' | 'playing' | 'error';

interface QueueEntry {
  id:    string;
  track: Track;
}

interface HistoryEntry {
  id:       string;
  title:    string;
  artist?:  string;
  source?:  Track['source'];
  /** URL to pass back to handleURL() — originalUrl for YouTube, direct url otherwise. */
  replayUrl: string;
  playedAt:  number;
}

// ── Component ──────────────────────────────────────────────────────────────
export default function AeolianApp() {
  const {
    audioRef, analyserRef, track, state,
    loadTrack, updateStreamUrl, togglePlay, seek, setVolume, clearTrack,
  } = useAudio();
  const { extractMetadata } = useMetadata();

  // App state
  const [phase,      setPhase]     = useState<AppPhase>('idle');
  const [isDragOver, setDragOver]  = useState(false);
  const [statusMsg,  setStatusMsg] = useState('');
  const dragCounterRef             = useRef(0);
  const objUrlRef                  = useRef<string>('');

  // Queue state
  const [queue,      setQueue]      = useState<QueueEntry[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [showQueue,  setShowQueue]  = useState(false);

  // History state — loaded once from localStorage on mount
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      // FIX: validate shape before trusting — corrupted/mismatched localStorage
      // data would silently produce wrong types and crash the history list render.
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (h): h is HistoryEntry =>
          h !== null &&
          typeof h === 'object' &&
          typeof h.id        === 'string' &&
          typeof h.title     === 'string' &&
          typeof h.replayUrl === 'string' &&
          typeof h.playedAt  === 'number',
      );
    } catch {
      return [];
    }
  });

  // YouTube 403 retry guard — allow only one automatic retry per track load
  const ytRetryRef = useRef(false);

  // ── Phase sync ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.error) {
      setPhase('error');
      setStatusMsg(state.error);
    } else if (track) {
      setPhase('playing');
    }
  }, [state.error, track]);

  // ── YouTube stream-expiry auto-recovery ───────────────────────────────────
  // FIX: YouTube direct URLs expire after ~6 h.  When the audio element fires
  // an error on a youtube source, we silently re-resolve a fresh stream URL
  // using the originalUrl stored in the track, then resume without UI reset.
  // A single retry guard prevents infinite loops on genuine errors.
  useEffect(() => {
    if (!state.errorCode || !track?.originalUrl || track.source !== 'youtube') return;
    if (ytRetryRef.current) return; // already tried once for this track
    if (state.errorCode !== 2 && state.errorCode !== 4) return; // not a network/src error

    ytRetryRef.current = true;
    setPhase('resolving');
    setStatusMsg('Stream expired — refreshing…');

    fetch(`/api/resolve?url=${encodeURIComponent(track.originalUrl)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.url) {
          updateStreamUrl(data.url);
          setPhase('playing');
        } else {
          setPhase('error');
          setStatusMsg(data.error ?? 'Stream refresh failed.');
        }
      })
      .catch(() => {
        setPhase('error');
        setStatusMsg('Network error while refreshing stream.');
      });
  }, [state.errorCode, track, updateStreamUrl]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const revokeObjUrl = () => {
    if (objUrlRef.current) {
      URL.revokeObjectURL(objUrlRef.current);
      objUrlRef.current = '';
    }
  };

  const persistToHistory = useCallback((t: Track) => {
    if (t.source === 'local') return; // blob URLs can't be persisted
    const entry: HistoryEntry = {
      id:        crypto.randomUUID(),
      title:     t.title,
      artist:    t.artist,
      source:    t.source,
      replayUrl: t.originalUrl ?? t.url,
      playedAt:  Date.now(),
    };
    setHistory((prev) => {
      // De-duplicate by replayUrl, cap at MAX_HISTORY
      const updated = [entry, ...prev.filter((h) => h.replayUrl !== entry.replayUrl)].slice(0, MAX_HISTORY);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch { /* quota */ }
      return updated;
    });
  }, []);

  /** Add a track to the queue and begin playing it. */
  const enqueueAndPlay = useCallback(
    async (newTrack: Track) => {
      ytRetryRef.current = false;
      // FIX: both setQueue and setQueueIndex use functional updaters so they read
      // the real current state at flush time, not a captured closure snapshot.
      // Previously: `let newIndex = 0; setQueue(prev => { newIndex = prev.length; ... });
      //              setQueueIndex(newIndex)` — React runs updaters asynchronously so
      // newIndex was always 0 when setQueueIndex was called.
      setQueue((prev) => [...prev, { id: crypto.randomUUID(), track: newTrack }]);
      setQueueIndex((prev) => prev + 1);
      persistToHistory(newTrack);
      await loadTrack(newTrack);
    },
    [loadTrack, persistToHistory]
  );

  /** Jump to a specific queue position. */
  const playFromQueue = useCallback(
    async (index: number) => {
      const entry = queue[index];
      if (!entry) return;
      ytRetryRef.current = false;
      setQueueIndex(index);
      setShowQueue(false);
      await loadTrack(entry.track);
    },
    [queue, loadTrack]
  );

  const skipNext = useCallback(async () => {
    const nextIndex = queueIndex + 1;
    if (nextIndex >= queue.length) return;
    ytRetryRef.current = false;
    const nextTrack = queue[nextIndex].track;
    setQueueIndex(nextIndex);
    await loadTrack(nextTrack);
  }, [queueIndex, queue, loadTrack]);

  // ── Auto-advance queue on track end ───────────────────────────────────────
  // FIX: moved below skipNext declaration; skipNext is now in the dep array so
  // the effect always holds a fresh closure (not the stale initial one).
  useEffect(() => {
    if (state.trackEnded) skipNext();
  }, [state.trackEnded, skipNext]);

  const skipPrev = useCallback(async () => {
    // If more than 3 s in, restart the current track
    if (state.currentTime > 3) {
      seek(0);
      return;
    }
    const prevIndex = queueIndex - 1;
    if (prevIndex < 0) { seek(0); return; }
    ytRetryRef.current = false;
    const prevTrack = queue[prevIndex].track;
    setQueueIndex(prevIndex);
    await loadTrack(prevTrack);
  }, [queueIndex, queue, state.currentTime, seek, loadTrack]);

  // ── Handle local audio file ───────────────────────────────────────────────
  const handleFile = useCallback(
    async (file: File) => {
      if (!isAudioFile(file)) {
        setPhase('error');
        setStatusMsg('Unsupported file type. Try MP3, FLAC, WAV, or M4A.');
        return;
      }

      setPhase('resolving');
      setStatusMsg('Reading file…');
      revokeObjUrl();

      const url  = URL.createObjectURL(file);
      objUrlRef.current = url;

      const meta = await extractMetadata(file);

      await enqueueAndPlay({
        url,
        title:    meta.title   ?? file.name,
        artist:   meta.artist,
        album:    meta.album,
        coverArt: meta.coverArt,
        source:   'local',
      });
    },
    [extractMetadata, enqueueAndPlay]
  );

  // ── Handle URL paste / resolve ─────────────────────────────────────────────
  const handleURL = useCallback(
    async (rawUrl: string) => {
      let url: URL;
      try { url = new URL(rawUrl); }
      catch { return; }

      revokeObjUrl();
      setPhase('resolving');
      setStatusMsg('Resolving stream…');

      try {
        const res  = await fetch(`/api/resolve?url=${encodeURIComponent(url.href)}`);
        const data = await res.json();

        if (!res.ok || data.error) {
          setPhase('error');
          setStatusMsg(data.error ?? 'Resolution failed.');
          return;
        }

        await enqueueAndPlay({
          url:         data.url,
          title:       data.title,
          thumbnail:   data.thumbnail,
          source:      data.source,
          originalUrl: data.originalUrl, // present for YouTube tracks
        });
      } catch {
        setPhase('error');
        setStatusMsg('Network error — could not resolve the URL.');
      }
    },
    [enqueueAndPlay]
  );

  // ── Global paste handler ───────────────────────────────────────────────────
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (text && /^https?:\/\//.test(text)) handleURL(text);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [handleURL]);

  // FIX: Revoke any live blob URL when the component unmounts to prevent memory leaks.
  useEffect(() => {
    return () => { revokeObjUrl(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Drag & Drop ────────────────────────────────────────────────────────────
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragOver(false);
  };
  const onDragOver = (e: React.DragEvent) => e.preventDefault();
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(isAudioFile);
    if (files.length === 0) {
      setPhase('error');
      setStatusMsg('Unsupported file type. Try MP3, FLAC, WAV, or M4A.');
      return;
    }
    files.reduce(
      (chain, file) => chain.then(() => handleFile(file)),
      Promise.resolve()
    );
  };

  // FIX: dragCounterRef can get stuck > 0 if the user alt-tabs, minimises, or
  // the OS cancels the drag — no dragLeave/drop fires in those cases, so the
  // overlay stays visible indefinitely. Reset on dragend and visibilitychange.
  useEffect(() => {
    const resetDrag = () => { dragCounterRef.current = 0; setDragOver(false); };
    window.addEventListener('dragend', resetDrag);
    document.addEventListener('visibilitychange', resetDrag);
    return () => {
      window.removeEventListener('dragend', resetDrag);
      document.removeEventListener('visibilitychange', resetDrag);
    };
  }, []);

  // ── File input fallback ────────────────────────────────────────────────────
  const fileRef = useRef<HTMLInputElement>(null);
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // FIX: handle multiple files from the picker sequentially (same as multi-drop)
    const files = Array.from(e.target.files ?? []).filter(isAudioFile);
    if (files.length > 0) {
      files.reduce(
        (chain, file) => chain.then(() => handleFile(file)),
        Promise.resolve()
      );
    }
    e.target.value = '';
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    clearTrack();
    revokeObjUrl();
    setPhase('idle');
    setStatusMsg('');
    setShowQueue(false);
    // FIX: clear queue state so the next load starts fresh at index 0
    setQueue([]);
    setQueueIndex(-1);
    // FIX: reset retry guard so the next YouTube track can retry on stream expiry
    ytRetryRef.current = false;
  }, [clearTrack]);

  // ── Derived flags ──────────────────────────────────────────────────────────
  const isIdle    = phase === 'idle';
  const isResolve = phase === 'resolving';
  const isPlay    = phase === 'playing';
  const isError   = phase === 'error';

  const canSkipNext = queueIndex < queue.length - 1;
  const canSkipPrev = queueIndex > 0 || state.currentTime > 3;

  // FIX: Register MediaSession previoustrack/nexttrack so headset buttons and
  // OS lock-screen / notification controls can skip between queue items.
  // These handlers live here (not in useAudio) because skipNext/skipPrev are
  // defined in AeolianApp — useAudio has no knowledge of the queue.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const actions: [MediaSessionAction, (() => void) | null][] = [
      ['previoustrack', canSkipPrev ? () => skipPrev() : null],
      ['nexttrack',     canSkipNext ? () => skipNext() : null],
    ];
    for (const [action, handler] of actions) {
      try { navigator.mediaSession.setActionHandler(action, handler); }
      catch { /* not supported on this platform */ }
    }
  }, [canSkipPrev, canSkipNext, skipPrev, skipNext]);

  return (
    <div
      className={`${styles.root} ${isDragOver ? styles.dragOver : ''}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Animated mesh background */}
      <div className="mesh-bg" aria-hidden="true">
        <div className="mesh-orb mesh-orb-1" />
        <div className="mesh-orb mesh-orb-2" />
        <div className="mesh-orb mesh-orb-3" />
        <div className="mesh-orb mesh-orb-4" />
      </div>
      <div className="mesh-grain" aria-hidden="true" />

      {/* Drag overlay */}
      {isDragOver && (
        <div className={styles.dragOverlay} aria-hidden="true">
          <div className={styles.dragLabel}>Drop to play</div>
        </div>
      )}

      {/* Main stage */}
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

        {/* Idle — prompt + history */}
        {isIdle && (
          <div className={styles.idlePrompt}>
            <button
              className={styles.plusBtn}
              onClick={() => fileRef.current?.click()}
              aria-label="Open file"
            >
              <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="16" y1="6"  x2="16" y2="26" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="6"  y1="16" x2="26" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <p className={styles.hint}>
              Drop a file <span className={styles.sep}>·</span> Paste a URL
            </p>

            {/* Recent tracks */}
            {history.length > 0 && (
              <div className={styles.history}>
                <p className={styles.historyLabel}>Recent</p>
                <div className={styles.historyList}>
                  {history.slice(0, 6).map((entry) => (
                    <button
                      key={entry.id}
                      className={styles.historyItem}
                      onClick={() => handleURL(entry.replayUrl)}
                    >
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

        {/* Resolving spinner */}
        {isResolve && (
          <div className={styles.status}>
            <div className={styles.resolveSpinner} aria-hidden="true" />
            <span>{statusMsg}</span>
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className={styles.errorBox}>
            <svg className={styles.errorIcon} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1" />
              <path d="M10 6v5M10 13.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p className={styles.errorText}>{statusMsg}</p>
            <button className={styles.retryBtn} onClick={reset}>Try again</button>
          </div>
        )}

        {/* Player */}
        {isPlay && track && (
          <Player
            track={track}
            state={state}
            onTogglePlay={togglePlay}
            onSeek={seek}
            onVolume={setVolume}
            onClose={reset}
            onSkipPrev={skipPrev}
            onSkipNext={skipNext}
            canSkipPrev={canSkipPrev}
            canSkipNext={canSkipNext}
            queueLength={queue.length}
            onToggleQueue={queue.length > 1 ? () => setShowQueue((v) => !v) : undefined}
          />
        )}
      </main>

      {/* Queue drawer */}
      {showQueue && isPlay && queue.length > 1 && (
        <>
          <div
            className={styles.queueBackdrop}
            onClick={() => setShowQueue(false)}
            aria-hidden="true"
          />
          <div className={styles.queueDrawer} role="dialog" aria-label="Queue">
            <div className={styles.queueDrawerHeader}>
              <span className={styles.queueDrawerTitle}>Queue</span>
              <span className={styles.queueDrawerCount}>{queue.length} tracks</span>
              <button
                className={styles.queueDrawerClose}
                onClick={() => setShowQueue(false)}
                aria-label="Close queue"
              >
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
                  onClick={() => playFromQueue(i)}
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

      {/* Footer */}
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
        accept=".mp3,.flac,.wav,.m4a,.aac,.ogg,.opus"
        multiple
        className={styles.fileInput}
        onChange={onFileChange}
        tabIndex={-1}
      />
    </div>
  );
}
