'use client';
import { useRef, useEffect } from 'react';
import styles from './Aura.module.css';

interface AuraProps {
  analyserNode: AnalyserNode | null;
  isPlaying:    boolean;
  coverColor?:  string;
}

const TAU = Math.PI * 2;

async function extractDominantHue(src: string): Promise<number | null> {
  return new Promise(resolve => {
    const img     = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const SIZE   = 24;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
        let rSum  = 0;
        let gSum  = 0;
        let bSum  = 0;
        for (let i = 0; i < data.length; i += 4) {
          rSum += data[i];
          gSum += data[i + 1];
          bSum += data[i + 2];
        }
        const pixels = SIZE * SIZE;
        const r = rSum / pixels / 255;
        const g = gSum / pixels / 255;
        const b = bSum / pixels / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max === min) return resolve(null);
        let h = 0;
        const d = max - min;
        if      (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else                h = ((r - g) / d + 4) / 6;
        resolve(Math.round(h * 360));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export default function Aura({ analyserNode, isPlaying, coverColor }: AuraProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const rafRef       = useRef<number>(0);
  const hueOffsetRef = useRef<number>(0);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  useEffect(() => {
    if (!coverColor) {
      hueOffsetRef.current = 0;
      return;
    }
    let cancelled = false;
    extractDominantHue(coverColor).then(hue => {
      if (!cancelled) hueOffsetRef.current = hue !== null ? hue - 170 : 0;
    });
    return () => { cancelled = true; };
  }, [coverColor]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let phase       = 0;
    let prevEnergy  = 0;

    const freqData = analyserNode ? new Uint8Array(analyserNode.frequencyBinCount) : null;
    const waveData = analyserNode ? new Uint8Array(analyserNode.fftSize) : null;

    const resize = () => {
      const dpr     = window.devicePixelRatio || 1;
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      if (w === 0 || h === 0) return;
      const cx    = w / 2;
      const cy    = h / 2;
      const baseR = Math.min(w, h) * 0.30;
      ctx.clearRect(0, 0, w, h);
      phase += 0.008;
      const hueOff = hueOffsetRef.current;

      if (analyserNode && isPlayingRef.current && freqData && waveData) {
        const bufLen = analyserNode.frequencyBinCount;
        analyserNode.getByteFrequencyData(freqData);
        analyserNode.getByteTimeDomainData(waveData);

        let energySum = 0;
        for (let i = 0; i < bufLen; i++) energySum += freqData[i];
        const energy       = energySum / bufLen / 255;
        const smoothEnergy = prevEnergy * 0.85 + energy * 0.15;
        prevEnergy = smoothEnergy;

        const glowR = baseR * (1 + smoothEnergy * 0.4);
        const glow  = ctx.createRadialGradient(cx, cy, baseR * 0.6, cx, cy, glowR * 1.5);
        glow.addColorStop(0,   `rgba(15,248,224, ${smoothEnergy * 0.15})`);
        glow.addColorStop(0.5, `rgba(124,58,237, ${smoothEnergy * 0.08})`);
        glow.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(cx, cy, glowR * 1.5, 0, TAU);
        ctx.fillStyle = glow;
        ctx.fill();

        const bars = Math.min(bufLen, 128);
        ctx.save();
        ctx.lineWidth  = 2;
        ctx.shadowBlur = 0;
        for (let i = 0; i < bars; i++) {
          const t      = i / bars;
          const angle  = t * TAU - Math.PI / 2;
          const amp    = freqData[Math.floor(t * bufLen)] / 255;
          const inner  = baseR * (0.95 + amp * 0.05);
          const outer  = inner + amp * baseR * 0.65;
          const hue    = (170 + hueOff + t * 140) % 360;
          ctx.strokeStyle = `hsla(${hue}, 85%, 68%, ${0.35 + amp * 0.65})`;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
          ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
          ctx.stroke();
        }
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = `rgba(15,248,224, ${0.12 + smoothEnergy * 0.2})`;
        ctx.lineWidth   = 1;
        ctx.beginPath();
        const wLen = waveData.length;
        for (let i = 0; i < wLen; i++) {
          const angle = (i / wLen) * TAU - Math.PI / 2;
          const r     = baseR * (1 + ((waveData[i] / 128) - 1) * 0.05);
          const x     = cx + Math.cos(angle) * r;
          const y     = cy + Math.sin(angle) * r;
          if (i === 0) ctx.moveTo(x, y);
          else         ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();

        const orbR = baseR * (0.14 + smoothEnergy * 0.10);
        const orb  = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR);
        orb.addColorStop(0,   'rgba(255,255,255, 0.9)');
        orb.addColorStop(0.3, 'rgba(15,248,224, 0.8)');
        orb.addColorStop(0.7, 'rgba(124,58,237, 0.4)');
        orb.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(cx, cy, orbR, 0, TAU);
        ctx.fillStyle = orb;
        ctx.fill();

      } else {
        prevEnergy *= 0.92;

        const breathe = Math.sin(phase * 2.5) * 0.15 + 0.85;
        const orbR    = baseR * 0.13 * breathe;
        ctx.save();
        for (let ring = 0; ring < 3; ring++) {
          const ringR = baseR * (0.95 + ring * 0.15);
          const alpha = (0.04 - ring * 0.01) * (0.7 + Math.sin(phase + ring) * 0.3);
          ctx.beginPath();
          ctx.arc(cx, cy, ringR, 0, TAU);
          ctx.strokeStyle = `rgba(15,248,224,${alpha})`;
          ctx.lineWidth   = 0.5;
          ctx.stroke();
        }
        ctx.restore();
        const orb = ctx.createRadialGradient(cx, cy, 0, cx, cy, orbR);
        orb.addColorStop(0,   'rgba(255,255,255,0.7)');
        orb.addColorStop(0.4, 'rgba(15,248,224, 0.5)');
        orb.addColorStop(0.8, 'rgba(124,58,237, 0.2)');
        orb.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(cx, cy, orbR, 0, TAU);
        ctx.fillStyle = orb;
        ctx.fill();
      }
    };

    draw();
    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, [analyserNode]);

  return <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />;
}
