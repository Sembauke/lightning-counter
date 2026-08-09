import type { Metadata } from 'next';
import RecordsClient from './RecordsClient';
import { SITE_URL } from '../lib/site';
import { getBiggestStormPerDay, getTop100Storms } from '../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Storm Records',
  description:
    'Global lightning storm hall of fame: the biggest, longest-lived, and farthest-traveled storms ever tracked, each with a strike replay.',
  alternates: { canonical: `${SITE_URL}/records` },
  openGraph: {
    title: 'Storm Records | Lightning Stats',
    description: 'The biggest, longest-lived, and farthest-traveled lightning storms ever tracked.',
    url: `${SITE_URL}/records`,
  },
};

export default function RecordsPage() {
  const dailyBest = getBiggestStormPerDay();
  const top100 = getTop100Storms();
  return <RecordsClient dailyBest={dailyBest} top100={top100} />;
}
