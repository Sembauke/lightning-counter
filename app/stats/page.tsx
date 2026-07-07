import type { Metadata } from 'next';
import StatsClient from './StatsClient';
import { SITE_URL } from '../lib/site';

export const metadata: Metadata = {
  title: 'Discharge Archive',
  description:
    'Historical lightning discharge archive with all-time highs, daily records, and filterable history for every country.',
  alternates: { canonical: `${SITE_URL}/stats` },
  openGraph: {
    title: 'Lightning Discharge Archive | Lightning Stats',
    description: 'Historical lightning data with all-time highs and daily records by country.',
    url: `${SITE_URL}/stats`,
  },
};

export default function StatsPage() {
  return <StatsClient />;
}
