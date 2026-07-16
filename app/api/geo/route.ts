import { getCountryCode } from '../../lib/geoCountry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Country + today's live strike count for a map coordinate (hover tooltip) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get('lat') ?? '');
  const lon = parseFloat(url.searchParams.get('lon') ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: 'invalid coordinates' }, { status: 400 });
  }

  let cc: string | null = null;
  try { cc = getCountryCode(lat, lon); } catch { /* non-fatal */ }
  const todayCounts: Record<string, number> = (globalThis as any)._todayCounts ?? {};

  return Response.json({ cc, today: cc ? todayCounts[cc] ?? 0 : 0 });
}
