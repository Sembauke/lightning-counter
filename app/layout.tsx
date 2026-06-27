import type { Metadata } from 'next';
import './globals.css';
import Navbar from './components/Navbar';
import { SatelliteProvider } from './context/SatelliteContext';
import { SoundProvider } from './context/SoundContext';
import { LocaleProvider } from './context/LocaleContext';
import { HeatmapProvider } from './context/HeatmapContext';

const BASE = 'https://lightning-counter.fly.dev';

export const metadata: Metadata = {
  metadataBase: new URL(BASE),
  title: {
    default: 'Lightning Stats — Real-Time Global Lightning Tracker',
    template: '%s | Lightning Stats',
  },
  description:
    'Watch lightning discharges happen live anywhere on Earth. Real-time data from Blitzortung.org with sound alerts, satellite imagery, and discharge statistics by country.',
  keywords: [
    'lightning tracker', 'real-time lightning map', 'live lightning discharges',
    'blitzortung', 'storm tracker', 'weather map', 'lightning statistics',
    'thunder map', 'lightning counter', 'global lightning',
  ],
  authors: [{ name: 'Lightning Stats', url: BASE }],
  creator: 'Lightning Stats',
  openGraph: {
    type: 'website',
    url: BASE,
    siteName: 'Lightning Stats',
    title: 'Lightning Stats — Real-Time Global Lightning Tracker',
    description:
      'Watch lightning discharges happen live anywhere on Earth. Real-time data, satellite view, and per-country statistics.',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary',
    title: 'Lightning Stats — Real-Time Global Lightning Tracker',
    description:
      'Watch lightning discharges happen live anywhere on Earth. Real-time data, satellite view, and per-country statistics.',
  },
  robots: { index: true, follow: true },
  alternates: { canonical: BASE },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#0a0a0f" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'WebApplication',
              name: 'Lightning Stats',
              url: BASE,
              description:
                'Real-time global lightning strike tracker using live data from Blitzortung.org.',
              applicationCategory: 'WeatherApplication',
              operatingSystem: 'Any',
              offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            }),
          }}
        />
      </head>
      <body style={{ margin: 0, padding: 0 }}>
        <LocaleProvider>
          <SatelliteProvider>
            <SoundProvider>
              <HeatmapProvider>
                <Navbar />
                {children}
              </HeatmapProvider>
            </SoundProvider>
          </SatelliteProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
