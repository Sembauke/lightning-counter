import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import fs from 'fs';
import path from 'path';
import { getStormByKey, getStormRecords, getStormRank, getNextRankThreshold, getPrevRankThreshold } from '../../lib/db';
import StormDetailClient from './StormDetailClient';
import { SITE_URL } from '../../lib/site';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Props { params: Promise<{ key: string }> }

function loadStorm(key: string) {
  return getStormByKey(decodeURIComponent(key));
}

// Returns up to `max` city names within `radiusKm` of the given point,
// sorted nearest-first. Checks all country codes the storm passed through.
function nearbyCities(lat: number, lon: number, codes: string[], radiusKm = 150, max = 6): string[] {
  const cosLat = Math.cos(lat * Math.PI / 180);
  const r2 = (radiusKm / 111.32) ** 2;
  const found: { name: string; d: number }[] = [];
  const seen = new Set<string>();
  for (const cc of codes) {
    if (cc === 'XO') continue;
    try {
      const file = path.join(process.cwd(), 'public', 'cities', `${cc}.json`);
      const cities = JSON.parse(fs.readFileSync(file, 'utf8')) as [string, number, number][];
      for (const [name, cLat, cLon] of cities) {
        if (seen.has(name)) continue;
        const dLat = cLat - lat;
        const dLon = (cLon - lon) * cosLat;
        const d = dLat * dLat + dLon * dLon;
        if (d <= r2) { seen.add(name); found.push({ name, d }); }
      }
    } catch { /* country file missing */ }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, max).map(c => c.name);
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

  const codes = storm.countryPath?.length ? storm.countryPath : [storm.code];
  const nearby = nearbyCities(storm.lat, storm.lon, codes);
  // Exclude cities already mentioned in the journey so we don't repeat them
  const extraCities = nearby.filter(n => n !== city && n !== origin);

  const title = `Lightning Storm ${journey} — ${storm.date}`;
  const nearbyStr = extraCities.length ? ` Also near: ${extraCities.slice(0, 3).join(', ')}.` : '';
  const description = `Lightning storm ${journey} on ${storm.date}: ${parts}.${nearbyStr}`;
  const canonical = `${SITE_URL}/storms/${encodeURIComponent(key)}`;

  return {
    title,
    description,
    keywords: [
      'lightning storm', city, ...(origin ? [origin] : []),
      ...extraCities, storm.date,
      'real-time lightning', 'storm tracker', 'blitzortung',
    ],
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
