import type { Metadata } from 'next';
import CountriesClient from './CountriesClient';
import { SITE_URL } from '../lib/site';

export const metadata: Metadata = {
  title: 'Discharges by Country',
  description:
    'Live lightning discharge counts ranked by country. See which nations are experiencing the most electrical storm activity right now.',
  alternates: { canonical: `${SITE_URL}/countries` },
  openGraph: {
    title: 'Lightning Discharges by Country | Lightning Stats',
    description: 'Live lightning discharge counts ranked by country.',
    url: `${SITE_URL}/countries`,
  },
};

export default function CountriesPage() {
  return <CountriesClient />;
}
