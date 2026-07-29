import { getStormsForDate, getStormByKey, getStormRanks, getNextRankThreshold, getLiveStorms } from '../../lib/db';
import { getCountryCode } from '../../lib/geoCountry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (key) {
    return Response.json(getStormByKey(key));
  }
  // Lightweight live-storms list for map rank matching — no date or size filter
  if (url.searchParams.get('live') === '1') {
    const live = getLiveStorms();
    const ranks = getStormRanks(live.map(s => s.stormKey));
    return Response.json(live.map(s => {
      const rank = ranks[s.stormKey] ?? null;
      const total = s.totalCount ?? s.count;
      const nextRankThreshold = rank != null && rank > 1 ? getNextRankThreshold(s.stormKey, total) : null;
      return { stormKey: s.stormKey, lat: s.lat, lon: s.lon, rank, nextRankThreshold, totalCount: s.totalCount, count: s.count };
    }));
  }
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const code = url.searchParams.get('code')?.toUpperCase() || undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: 'invalid date' }, { status: 400 });
  }
  // Cross-border storms get their origin country resolved so the UI can show both flags
  const base = getStormsForDate(date, code);
  const ranks = getStormRanks(base.map(s => s.stormKey));
  const rows = base.map(s => {
    let originCode: string | null = null;
    if (s.originLat != null && s.originLon != null) {
      try { originCode = getCountryCode(s.originLat, s.originLon); } catch { /* non-fatal */ }
    }
    const withOrigin = originCode && originCode !== s.code ? { ...s, originCode } : s;
    const rank = ranks[s.stormKey] ?? null;
    const total = s.totalCount ?? s.count;
    const nextRankThreshold = rank != null && rank > 1 ? getNextRankThreshold(s.stormKey, total) : null;
    return { ...withOrigin, rank, nextRankThreshold };
  });
  return Response.json(rows);
}
