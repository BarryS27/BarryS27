'use client';
import { useCallback, useRef } from 'react';
import type { Track, AudioState } from '@/hooks/useAudio';
import styles from './Player.module.css';

interface PlayerProps {
  track:          Track;
  state:          AudioState;
  onTogglePlay:   () => void;
  onSeek:         (t: number) => void;
  onVolume:       (v: number) => void;
  onClose:        () => void;
  onSkipPrev?:    () => void;
  onSkipNext?:    () => void;
  canSkipPrev?:   boolean;
  canSkipNext?:   boolean;
  queueLength?:   number;
  onToggleQueue?: () => void;
}

export default function Player({
  track, state,
  onTogglePlay, onSeek, onVolume, onClose,
  onSkipPrev, onSkipNext, canSkipPrev, canSkipNext,
  queueLength, onToggleQueue,
}: PlayerProps) {
  const { isPlaying, currentTime, duration, volume, isLoading } = state;

  const currentTimeRef   = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const fmt = (s: number, totalDuration = duration) => {
    if (!isFinite(s) || s < 0) return '–:––';
    const useHours = isFinite(totalDuration) && totalDuration >= 3600;
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return useHours ? `${h}:${m.toString().padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  };

  const progress = (duration > 0 && isFinite(duration))
    ? Math.min(100, Math.max(0, (currentTime / duration) * 100))
    : 0;

  const isSeekable    = duration > 0 && isFinite(duration);
  const seekTrackRef  = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);

  const seekFromPointer = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSeekable) return;
    const rect = seekTrackRef.current?.getBoundingClientRect();
    if (!rect) return;
    onSeek(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration);
  }, [isSeekable, duration, onSeek]);

  const onSeekPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.dataset.dragging = '';
    isDraggingRef.current = true;
    seekFromPointer(e);
  }, [seekFromPointer]);

  const onSeekPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) seekFromPointer(e);
  }, [seekFromPointer]);

  const onSeekPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    delete e.currentTarget.dataset.dragging;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  const handleSeekKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isSeekable) return;
    const t    = currentTimeRef.current;
    const STEP = 5;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        onSeek(Math.min(duration, t + STEP));
        break;
      case 'ArrowLeft':
        e.preventDefault();
        onSeek(Math.max(0, t - STEP));
        break;
      case 'Home':
        e.preventDefault();
        onSeek(0);
        break;
      case 'End':
        e.preventDefault();
        onSeek(duration);
        break;
    }
  }, [isSeekable, duration, onSeek]);

  const coverSrc    = track.coverArt ?? track.thumbnail;
  const coverSrcCss = coverSrc ? coverSrc.replace(/"/g, '%22') : null;

  return (
    <div className={styles.player}>
      {coverSrcCss && (
        <div className={styles.coverBlur} style={{ backgroundImage: `url("${coverSrcCss}")` }} aria-hidden="true" />
      )}

      <div className={styles.inner}>
        <div className={styles.cover}>
          {coverSrc ? (
            <img
              src={coverSrc} alt={`Album art for ${track.title}`}
              className={styles.coverImg} loading="lazy" decoding="async"
            />
          ) : (
            <div className={styles.coverPlaceholder}>
              <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="20" cy="20" r="14" stroke="currentColor" strokeWidth="1" strokeOpacity="0.4" />
                <circle cx="20" cy="20" r="4"  fill="currentColor"   fillOpacity="0.5" />
                <path   d="M20 6 Q27 13 20 20" stroke="currentColor" strokeWidth="1" strokeOpacity="0.3" fill="none" />
              </svg>
            </div>
          )}
        </div>

        <div className={styles.meta} aria-live="polite" aria-atomic="true">
          <p className={styles.title}>{track.title}</p>
          {track.artist && <p className={styles.artist}>{track.artist}</p>}
        </div>

        <div className={styles.transport}>
          <button className={styles.skipBtn} onClick={onSkipPrev} disabled={!canSkipPrev} aria-label="Previous">
            <svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="4" width="2" height="12" rx="1" />
              <path d="M17 4.5L7 10l10 5.5V4.5z" />
            </svg>
          </button>

          <button
            className={`${styles.playBtn} ${isLoading ? styles.loading : ''}`}
            onClick={onTogglePlay}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoading ? (
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={styles.spinner}>
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" strokeDasharray="40" strokeDashoffset="10" />
              </svg>
            ) : isPlaying ? (
              <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <rect x="6"  y="4" width="4" height="16" rx="1.5" />
                <rect x="14" y="4" width="4" height="16" rx="1.5" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M7 4.5l12.5 7.5L7 19.5V4.5z" />
              </svg>
            )}
          </button>

          <button className={styles.skipBtn} onClick={onSkipNext} disabled={!canSkipNext} aria-label="Next">
            <svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
              <rect x="15" y="4" width="2" height="12" rx="1" />
              <path d="M3 4.5L13 10 3 15.5V4.5z" />
            </svg>
          </button>

          {onToggleQueue && (
            <button className={styles.queueBtn} onClick={onToggleQueue} aria-label="Toggle queue" title="Queue">
              <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <line x1="3"  y1="6"  x2="17" y2="6"  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="3"  y1="10" x2="17" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="3"  y1="14" x2="12" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              {queueLength != null && queueLength > 1 && (
                <span className={styles.queueBadge}>{queueLength}</span>
              )}
            </button>
          )}
        </div>

        <div className={styles.timeRow}>
          <span className={styles.time}>{fmt(currentTime)}</span>
          <span className={styles.time}>{fmt(duration)}</span>
        </div>

        <div
          ref={seekTrackRef}
          className={`${styles.seekTrack} ${isLoading || !isSeekable ? styles.seekDisabled : ''}`}
          style={{ '--progress': progress } as React.CSSProperties}
          onPointerDown={onSeekPointerDown}
          onPointerMove={onSeekPointerMove}
          onPointerUp={onSeekPointerUp}
          onPointerCancel={onSeekPointerUp}
          onKeyDown={handleSeekKeyDown}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={isFinite(duration) ? Math.round(duration) : 0}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${fmt(currentTime)} of ${fmt(duration)}`}
        >
          <div className={styles.seekFill} />
          <div className={styles.seekThumb} />
        </div>

        <div className={styles.volumeRow}>
          <svg className={styles.volIcon} viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 7h3l4-3v12l-4-3H3V7z" fill="currentColor" fillOpacity="0.6" />
            {volume > 0.5 && (
              <path d="M13 5.5c1.5 1.2 2.5 2.7 2.5 4.5s-1 3.3-2.5 4.5"
                stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.6" fill="none" />
            )}
            {volume > 0.1 && (
              <path d="M11.5 7.5c.8.7 1.3 1.5 1.3 2.5s-.5 1.8-1.3 2.5"
                stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.6" fill="none" />
            )}
          </svg>
          <input
            type="range"
            className={styles.volSlider}
            min={0} max={1} step={0.01}
            value={volume}
            onChange={e => {
              const v = parseFloat(e.target.value);
              onVolume(isNaN(v) ? 0 : v);
            }}
            aria-label="Volume"
          />
        </div>
      </div>

      <button className={styles.closeBtn} onClick={onClose} aria-label="Close player">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
