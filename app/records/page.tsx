import type { Metadata } from 'next';
import RecordsClient from './RecordsClient';
import { SITE_URL } from '../lib/site';

export const metadata: Metadata = {
  title: 'Storm Records',
  description:
    'Global lightning storm hall of fame: the biggest, longest-lived, farthest-traveled, and fastest-moving storms ever tracked, each with a strike replay.',
  alternates: { canonical: `${SITE_URL}/records` },
  openGraph: {
    title: 'Storm Records | Lightning Stats',
    description: 'The biggest, longest, farthest and fastest lightning storms ever tracked.',
    url: `${SITE_URL}/records`,
  },
};

export default function RecordsPage() {
  return <RecordsClient />;
}
