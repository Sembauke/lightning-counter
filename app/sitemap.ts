import { MetadataRoute } from 'next';

const BASE = 'https://lightning-counter.fly.dev';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: BASE,                   changeFrequency: 'always', priority: 1 },
    { url: `${BASE}/countries`,    changeFrequency: 'always', priority: 0.8 },
    { url: `${BASE}/stats`,        changeFrequency: 'daily',  priority: 0.6 },
  ];
}
