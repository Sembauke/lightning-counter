import type { Metadata } from 'next';
import StormsClient from './StormsClient';
import { SITE_URL } from '../lib/site';

export const metadata: Metadata = {
  title: 'Storm Log',
  description:
    'Every lightning storm tracked, day by day: where it started, where it went, how many strikes it produced — with a strike replay for recent storms.',
  alternates: { canonical: `${SITE_URL}/storms` },
  openGraph: {
    title: 'Storm Log | Lightning Stats',
    description: 'Every tracked lightning storm, day by day, with strike replays.',
    url: `${SITE_URL}/storms`,
  },
};

export default function StormsPage() {
  return <StormsClient />;
}
