/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow audio streams from external origins to pass through
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
        ],
      },
    ];
  },
  // FIX: YouTube thumbnails are served from i.ytimg.com (and variants).
  // Without remotePatterns Next.js blocks <img src="...ytimg.com/..."> with a
  // 400 error in production. Using plain <img> (already done in Player.tsx with
  // the eslint-disable comment) bypasses Next's Image component, so this config
  // entry is mainly needed if the project ever switches to next/image.
  // It is still best practice to declare it so the intent is explicit.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: 'i3.ytimg.com' },
      { protocol: 'https', hostname: 'img.youtube.com' },
    ],
  },
  // Keep @distube/ytdl-core out of the serverless function bundle
  serverExternalPackages: ['@distube/ytdl-core'],
};

export default nextConfig;
