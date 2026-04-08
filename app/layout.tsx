import type { Metadata, Viewport } from 'next';
import { Cormorant, Syne } from 'next/font/google';
import './globals.css';

const cormorant = Cormorant({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  variable: '--font-cormorant',
  display: 'swap',
});

const syne = Syne({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-syne',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Aeolian',
  description: 'A zero-distraction audio medium. Drop a file or paste a URL.',
  // FIX: without a viewport meta tag the browser renders at desktop width and
  // scales down, making the UI tiny and unreadable on phones.
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='14' fill='none' stroke='%230ff8e0' stroke-width='1.5'/><circle cx='16' cy='16' r='5' fill='%230ff8e0' opacity='0.6'/></svg>",
  },
};

// Next.js 14 App Router: viewport is exported separately from metadata
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${cormorant.variable} ${syne.variable}`}>
      <body>{children}</body>
    </html>
  );
}
