import { MetadataRoute } from 'next';
import { SITE_URL } from './lib/site';
import { loadCounters } from './lib/db';

// Country pages come from the live DB — must be generated at request time,
// the Docker build has no database
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [
    { url: SITE_URL,            changeFrequency: 'always', priority: 1 },
    { url: `${SITE_URL}/stats`, changeFrequency: 'always', priority: 0.8 },
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

  return entries;
}
