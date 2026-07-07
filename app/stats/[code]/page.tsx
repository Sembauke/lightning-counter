import type { Metadata } from 'next';
import CountryClient from './CountryClient';
import { SITE_URL } from '../../lib/site';
import { loadCounters } from '../../lib/db';

function countryName(code: string): string | null {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

// Only codes with recorded strikes get an indexable page — everything else
// (typos, CLDR pseudo-regions like ZZ "Unknown Region") is noindexed. Matches
// the set of pages listed in the sitemap.
function hasData(code: string): boolean {
  try {
    return (loadCounters().countries[code.toUpperCase()] ?? 0) > 0;
  } catch {
    return false;
  }
}

export function generateMetadata({ params }: { params: { code: string } }): Metadata {
  const code = params.code.toLowerCase();
  const name = /^[a-z]{2}$/.test(code) && hasData(code) ? countryName(code) : null;
  if (!name || name.toUpperCase() === code.toUpperCase()) {
    return { title: 'Country Statistics', robots: { index: false } };
  }

  const title = `Lightning in ${name} — Live Discharge Stats & History`;
  const description =
    `Live lightning activity in ${name}: today's discharge count, all-time daily record, ` +
    `and day-by-day strike history from the Blitzortung.org detection network.`;
  const url = `${SITE_URL}/stats/${code}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title: `${title} | Lightning Stats`, description, url },
  };
}

export default function CountryDetailPage() {
  return <CountryClient />;
}
