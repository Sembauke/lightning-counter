import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getStormByKey, getStormRecords, getStormRank, getNextRankThreshold, getPrevRankThreshold } from '../../lib/db';
import StormDetailClient from './StormDetailClient';
import { SITE_URL } from '../../lib/site';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Props { params: Promise<{ key: string }> }

function loadStorm(key: string) {
  return getStormByKey(decodeURIComponent(key));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params;
  const storm = loadStorm(key);
  if (!storm) return { title: 'Storm not found' };

  const total = storm.totalCount ?? storm.count;
  const city = storm.city ?? `${storm.lat.toFixed(1)}°N ${storm.lon.toFixed(1)}°E`;
  const origin = storm.originCity;
  const journey = origin && origin !== storm.city ? `${origin} to ${city}` : `near ${city}`;

  let durationStr = '';
  if (storm.startTime && storm.endTime) {
    const ms = storm.endTime - storm.startTime;
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    durationStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  const parts = [
    `${total.toLocaleString('en')} total strikes`,
    `${Math.round(storm.rate)}/min peak`,
    durationStr ? `${durationStr} duration` : null,
    storm.traveledKm && storm.traveledKm > 10 ? `${Math.round(storm.traveledKm)} km traveled` : null,
  ].filter(Boolean).join(' · ');

  const title = `Lightning Storm ${journey} — ${storm.date}`;
  const description = `Lightning storm ${journey} on ${storm.date}: ${parts}.`;
  const canonical = `${SITE_URL}/storms/${encodeURIComponent(key)}`;

  return {
    title,
    description,
    keywords: ['lightning storm', city, ...(origin ? [origin] : []), storm.date, 'real-time lightning', 'storm tracker', 'blitzortung'],
    alternates: { canonical },
    openGraph: {
      title: `${title} | Lightning Stats`,
      description,
      url: canonical,
      type: 'article',
      siteName: 'Lightning Stats',
    },
    twitter: { card: 'summary', title: `${title} | Lightning Stats`, description },
  };
}

export default async function StormDetailPage({ params }: Props) {
  const { key } = await params;
  const storm = loadStorm(key);
  if (!storm) notFound();
  const records = getStormRecords();
  const rank = getStormRank(storm.totalCount ?? storm.count);
  const total = storm.totalCount ?? storm.count;
  const nextRankThreshold = storm.stormKey ? getNextRankThreshold(storm.stormKey, total) : null;
  const prevRankThreshold = storm.stormKey ? getPrevRankThreshold(storm.stormKey, total) : null;
  return <StormDetailClient storm={storm} records={records} rank={rank} nextRankThreshold={nextRankThreshold} prevRankThreshold={prevRankThreshold} />;
}
