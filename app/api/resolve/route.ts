import { NextRequest, NextResponse } from 'next/server';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be']);
const YOUTUBE_PATHS = /^\/(?:watch|shorts\/[^/]+|embed\/[^/]+)/;
const PRIVATE_HOST  = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|\[::1\]|\[fe[89a-f][0-9a-f]|\[f[cd])/i;
const UA            = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const maxDuration = 30;

function isYouTubeURL(url: string) {
  try {
    const p = new URL(url);
    return YOUTUBE_HOSTS.has(p.hostname) &&
      (p.hostname === 'youtu.be' || YOUTUBE_PATHS.test(p.pathname));
  } catch {
    return false;
  }
}

function isDirectAudioURL(url: string) {
  return /\.(mp3|flac|wav|m4a|ogg|aac|opus)(\?.*)?$/i.test(url.split('#')[0]);
}

function isSoundCloudURL(url: string) {
  try {
    const host = new URL(url).hostname;
    return host === 'soundcloud.com' || host === 'www.soundcloud.com' || host === 'm.soundcloud.com';
  } catch {
    return false;
  }
}

function titleFromUrl(url: string): string {
  const raw = url.split('/').pop()?.split('?')[0]?.replace(/\.[^.]+$/, '') || 'Unknown';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, rej) => {
    timerId = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timerId)), timeout]);
}

export async function GET(request: NextRequest) {
  const rawUrl = new URL(request.url).searchParams.get('url');
  if (!rawUrl) return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  const url = parsed.href;

  if (!/^https?:$/.test(parsed.protocol)) {
    return NextResponse.json({ error: 'Only http and https URLs are supported.' }, { status: 400 });
  }
  if (PRIVATE_HOST.test(parsed.hostname)) {
    return NextResponse.json({ error: 'Private or loopback addresses are not allowed.' }, { status: 400 });
  }

  if (isDirectAudioURL(url)) {
    return NextResponse.json({ url, title: titleFromUrl(url), source: 'direct' });
  }

  if (isYouTubeURL(url)) {
    try {
      const ytdl = (await import('@distube/ytdl-core')).default;
      if (!ytdl.validateURL(url)) {
        return NextResponse.json({ error: 'Invalid or private YouTube URL' }, { status: 422 });
      }
      const info = await withTimeout(
        ytdl.getInfo(url, { requestOptions: { headers: { 'User-Agent': UA } } }),
        25_000,
        'YouTube extraction'
      );
      const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
      const format =
        audioFormats.find(f => f.mimeType?.includes('audio/mp4'))  ??
        audioFormats.find(f => f.mimeType?.includes('audio/webm')) ??
        audioFormats[0];
      if (!format?.url) {
        return NextResponse.json({ error: 'No streamable audio format found' }, { status: 404 });
      }
      const thumbs = info.videoDetails.thumbnails;
      return NextResponse.json({
        url:         format.url,
        title:       info.videoDetails.title,
        source:      'youtube',
        originalUrl: url,
        thumbnail:   thumbs[Math.floor(thumbs.length / 2)]?.url ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'YouTube extraction failed';
      if (msg.includes('timed out')) {
        return NextResponse.json({ error: 'YouTube extraction timed out. Try again.' }, { status: 504 });
      }
      if (msg.includes('private') || msg.includes('unavailable') || msg.includes('age')) {
        return NextResponse.json({ error: `Cannot access video: ${msg}` }, { status: 403 });
      }
      return NextResponse.json({ error: `Extraction failed: ${msg}` }, { status: 500 });
    }
  }

  if (isSoundCloudURL(url)) {
    return NextResponse.json(
      { error: 'SoundCloud links require authentication. Download the file and drop it in.' },
      { status: 422 }
    );
  }

  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 8_000);
    const probe      = await fetch(url, {
      method:  'HEAD',
      redirect: 'follow',
      signal:  controller.signal,
      headers: { 'User-Agent': UA },
    });
    clearTimeout(timer);
    if (probe.url && probe.url !== url) {
      try {
        if (PRIVATE_HOST.test(new URL(probe.url).hostname)) {
          return NextResponse.json({ error: 'Private or loopback addresses are not allowed.' }, { status: 400 });
        }
      } catch { /* malformed redirect — treat as unreachable */ }
    }
    const ct = probe.headers.get('content-type') ?? '';
    if (ct.startsWith('audio/') || ct.startsWith('video/')) {
      return NextResponse.json({ url, title: titleFromUrl(url), source: 'direct' });
    }
    return NextResponse.json({ error: `Unsupported content type: ${ct || 'unknown'}` }, { status: 415 });
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === 'AbortError';
    return NextResponse.json({
      error: isTimeout
        ? 'The URL did not respond in time. Check that it is publicly accessible.'
        : 'Could not reach the provided URL. Check that it is publicly accessible.',
    }, { status: isTimeout ? 504 : 502 });
  }
}
