import type { Metadata } from 'next';
import CountriesClient from './CountriesClient';

export const metadata: Metadata = {
  title: 'Strikes by Country',
  description:
    'Live lightning strike counts ranked by country. See which nations are experiencing the most electrical storm activity right now.',
  alternates: { canonical: 'https://lightning-counter.fly.dev/countries' },
  openGraph: {
    title: 'Lightning Strikes by Country | Lightning Stats',
    description: 'Live lightning strike counts ranked by country.',
    url: 'https://lightning-counter.fly.dev/countries',
  },
};

export default function CountriesPage() {
  return <CountriesClient />;
}
