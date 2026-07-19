import { getStormsForDate, getStormByKey } from '../../lib/db';
import { getCountryCode } from '../../lib/geoCountry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (key) {
    return Response.json(getStormByKey(key));
  }
  const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
  const code = url.searchParams.get('code')?.toUpperCase() || undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: 'invalid date' }, { status: 400 });
  }
  // Cross-border storms get their origin country resolved so the UI can show both flags
  const rows = getStormsForDate(date, code).map(s => {
    let originCode: string | null = null;
    if (s.originLat != null && s.originLon != null) {
      try { originCode = getCountryCode(s.originLat, s.originLon); } catch { /* non-fatal */ }
    }
    return originCode && originCode !== s.code ? { ...s, originCode } : s;
  });
  return Response.json(rows);
}
