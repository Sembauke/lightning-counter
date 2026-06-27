import type { Metadata } from 'next';
import StatsClient from './StatsClient';

export const metadata: Metadata = {
  title: 'Discharge Archive',
  description:
    'Historical lightning discharge archive with all-time highs, daily records, and filterable history for every country.',
  alternates: { canonical: 'https://lightning-counter.fly.dev/stats' },
  openGraph: {
    title: 'Lightning Discharge Archive | Lightning Stats',
    description: 'Historical lightning data with all-time highs and daily records by country.',
    url: 'https://lightning-counter.fly.dev/stats',
  },
};

export default function StatsPage() {
  return <StatsClient />;
}
