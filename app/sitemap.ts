import { MetadataRoute } from 'next';
import { SITE_URL } from './lib/site';
import { loadCounters, getTop100Storms, getBiggestStormPerDay } from './lib/db';

// All entries come from the live DB — must be generated at request time,
// the Docker build has no database
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [
    { url: SITE_URL,              changeFrequency: 'always', priority: 1 },
    { url: `${SITE_URL}/stats`,   changeFrequency: 'always', priority: 0.8 },
    { url: `${SITE_URL}/records`, changeFrequency: 'always', priority: 0.7 },
    { url: `${SITE_URL}/storms`,  changeFrequency: 'always', priority: 0.7 },
  ];

  try {
    const { countries } = loadCounters();
    for (const code of Object.keys(countries).sort()) {
      entries.push({
        url: `${SITE_URL}/stats/${code.toLowerCase()}`,
        changeFrequency: 'daily',
        priority: 0.5,
      });
    }
  } catch { /* DB unavailable — serve the static entries */ }

  // Storm detail pages — top 100 all-time + best-per-day
  const top100Keys = new Set<string>();
  try {
    for (const s of getTop100Storms()) {
      if (!s.stormKey) continue;
      top100Keys.add(s.stormKey);
      entries.push({
        url: `${SITE_URL}/storms/${encodeURIComponent(s.stormKey)}`,
        lastModified: s.endTime ? new Date(s.endTime) : undefined,
        changeFrequency: 'monthly',
        priority: 0.7,
      });
    }
  } catch { /* DB unavailable */ }

  try {
    for (const s of getBiggestStormPerDay()) {
      if (!s.stormKey || top100Keys.has(s.stormKey)) continue;
      entries.push({
        url: `${SITE_URL}/storms/${encodeURIComponent(s.stormKey)}`,
        lastModified: s.endTime ? new Date(s.endTime) : undefined,
        changeFrequency: 'monthly',
        priority: 0.6,
      });
    }
  } catch { /* DB unavailable */ }

  return entries;
}
