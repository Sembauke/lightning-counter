import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Lightning Stats — Real-Time Lightning Tracker',
    short_name: 'Lightning Stats',
    description: 'Watch lightning strikes happen live anywhere on Earth. Real-time data from Blitzortung.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0a0f',
    theme_color: '#ffe566',
    icons: [
      { src: '/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'maskable' },
      { src: '/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
    ],
    categories: ['weather', 'utilities'],
    orientation: 'any',
    lang: 'en',
  };
}
