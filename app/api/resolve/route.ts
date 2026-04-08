import { NextRequest, NextResponse } from 'next/server';

function isYouTubeURL(url: string): boolean {
  // FIX: added music.youtube.com — YouTube Music links were falling through to
  // the HEAD probe which returned HTML (not audio), producing an unhelpful error.
  return /(?:(?:music\.)?youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/.test(url);
}
function isDirectAudioURL(url: string): boolean {
  return /\.(mp3|flac|wav|m4a|ogg|aac|opus)(\?.*)?$/i.test(url);
}
function isSoundCloudURL(url: string): boolean {
  // FIX: previously used url.includes('soundcloud.com') which would match
  // hostnames like 'fakesoundcloud.com'. Parse the hostname to be precise.
  try { return new URL(url).hostname === 'soundcloud.com'; } catch { return false; }
}

/**
 * FIX — Vercel timeout safety.
 * maxDuration is 30 s.  Wrapping ytdl.getInfo in a 25 s race gives the
 * function 5 s to marshal and return a structured error instead of letting
 * Vercel cut the connection mid-response, which leaves the client hanging
 * with no actionable feedback.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms
      )
    ),
  ]);
}

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get('url');

  if (!rawUrl) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  // FIX: searchParams.get() already percent-decodes the value.  Wrapping it in
  // decodeURIComponent() a second time would corrupt any URL that legitimately
  // contains a '%' character (e.g. a track title encoded as %25 would become '%'
  // instead of '%25').  Just validate and use the decoded value directly.
  const url = rawUrl;
  try { new URL(url); } // validate
  catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  // ── Direct audio file ──────────────────────────────────────────────────────
  if (isDirectAudioURL(url)) {
    const title = url.split('/').pop()?.split('?')[0]?.replace(/\.[^.]+$/, '') ?? 'Unknown';
    return NextResponse.json({ url, title, source: 'direct' });
  }

  // ── YouTube ────────────────────────────────────────────────────────────────
  if (isYouTubeURL(url)) {
    try {
      const ytdl = (await import('@distube/ytdl-core')).default;

      if (!ytdl.validateURL(url)) {
        return NextResponse.json({ error: 'Invalid or private YouTube URL' }, { status: 422 });
      }

      // 25 s race — leaves 5 s for the response to reach the client before
      // Vercel's 30 s hard limit kills the function.
      const info = await withTimeout(
        ytdl.getInfo(url, {
          requestOptions: {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
          },
        }),
        25_000,
        'YouTube extraction'
      );

      const title         = info.videoDetails.title;
      const audioFormats  = ytdl.filterFormats(info.formats, 'audioonly');
      // FIX: original order preferred webm/opus first, then mp4/aac.
      // webm/opus is not supported in Safari (iOS or macOS), so YouTube audio was
      // completely broken for all Apple users. Flip the priority: mp4/aac first
      // (universally supported), webm/opus as fallback for Chromium/Firefox where
      // it offers slightly better compression, then any remaining format.
      const format =
        audioFormats.find((f) => f.mimeType?.includes('audio/mp4')) ??
        audioFormats.find((f) => f.mimeType?.includes('audio/webm')) ??
        audioFormats[0];

      if (!format?.url) {
        return NextResponse.json({ error: 'No streamable audio format found' }, { status: 404 });
      }

      return NextResponse.json({
        url:         format.url,
        title,
        source:      'youtube',
        /**
         * FIX — include the original page URL in the response.
         * The client stores this in Track.originalUrl and sends it back when
         * the stream 403s (~6 h later) so the API can issue a fresh stream URL
         * without the user having to paste the link again.
         */
        originalUrl: url,
        thumbnail:   info.videoDetails.thumbnails[
          Math.floor(info.videoDetails.thumbnails.length / 2)
        ]?.url ?? null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'YouTube extraction failed';

      if (msg.includes('timed out')) {
        return NextResponse.json(
          { error: 'YouTube extraction timed out. The video may be too large or the network is slow. Try again.' },
          { status: 504 }
        );
      }
      if (msg.includes('private') || msg.includes('unavailable') || msg.includes('age')) {
        return NextResponse.json({ error: `Cannot access video: ${msg}` }, { status: 403 });
      }
      return NextResponse.json({ error: `Extraction failed: ${msg}` }, { status: 500 });
    }
  }

  // ── SoundCloud ─────────────────────────────────────────────────────────────
  if (isSoundCloudURL(url)) {
    return NextResponse.json(
      { error: 'SoundCloud links require authentication. Download the file and drop it in.' },
      { status: 422 }
    );
  }

  // ── Unknown URL — HEAD probe ───────────────────────────────────────────────
  // FIX: SSRF protection — block requests to private/loopback ranges before
  // ever opening a connection. Without this, an attacker could probe Vercel's
  // internal network (e.g. AWS metadata at 169.254.169.254, private subnets).
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    // Reject non-http(s) schemes, localhost, and RFC-1918 / link-local ranges
    if (!/^https?:$/.test(urlObj.protocol)) {
      return NextResponse.json({ error: 'Only http and https URLs are supported.' }, { status: 400 });
    }
    const privatePattern = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|\[::1\])/i;
    if (privatePattern.test(hostname)) {
      return NextResponse.json({ error: 'Private or loopback addresses are not allowed.' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'Invalid URL.' }, { status: 400 });
  }

  try {
    // FIX 1: added User-Agent — some CDN / media servers reject headless requests
    //         with 403/404 even for publicly accessible files.
    // FIX 2: added AbortController timeout — without it a slow server hangs the
    //         route handler until Vercel's hard 30 s limit kills the function,
    //         returning no response to the client.
    const controller  = new AbortController();
    const timer       = setTimeout(() => controller.abort(), 8_000);
    const probe       = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    clearTimeout(timer);
    const contentType = probe.headers.get('content-type') ?? '';

    if (contentType.startsWith('audio/') || contentType.startsWith('video/')) {
      const title = url.split('/').pop()?.split('?')[0] ?? 'Stream';
      return NextResponse.json({ url, title, source: 'direct' });
    }

    return NextResponse.json(
      { error: `Unsupported content type: ${contentType || 'unknown'}` },
      { status: 415 }
    );
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === 'AbortError';
    return NextResponse.json(
      { error: isTimeout
          ? 'The URL did not respond in time. Check that it is publicly accessible.'
          : 'Could not reach the provided URL. Check that it is publicly accessible.' },
      { status: isTimeout ? 504 : 502 }
    );
  }
}
