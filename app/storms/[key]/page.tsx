import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getStormByKey } from '../../lib/db';
import StormDetailClient from './StormDetailClient';
import { SITE_URL } from '../../lib/site';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Props { params: Promise<{ key: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params;
  const storm = getStormByKey(decodeURIComponent(key));
  if (!storm) return { title: 'Storm not found' };
  const name = storm.city ?? `${storm.lat.toFixed(2)}, ${storm.lon.toFixed(2)}`;
  return {
    title: `Storm near ${name} — ${storm.date}`,
    description: `Lightning storm tracked on ${storm.date}: ${Math.round(storm.rate)}/min peak rate, ${storm.totalCount ?? storm.count} strikes.`,
    alternates: { canonical: `${SITE_URL}/storms/${encodeURIComponent(key)}` },
    openGraph: {
      title: `Storm near ${name} | Lightning Stats`,
      url: `${SITE_URL}/storms/${encodeURIComponent(key)}`,
    },
  };
}

export default async function StormDetailPage({ params }: Props) {
  const { key } = await params;
  const storm = getStormByKey(decodeURIComponent(key));
  if (!storm) notFound();
  return <StormDetailClient storm={storm} />;
}
