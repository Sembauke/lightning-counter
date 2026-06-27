import { getViewportStrikes } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url    = new URL(req.url);
  const minLat = parseFloat(url.searchParams.get('minLat') ?? 'NaN');
  const maxLat = parseFloat(url.searchParams.get('maxLat') ?? 'NaN');
  const minLon = parseFloat(url.searchParams.get('minLon') ?? 'NaN');
  const maxLon = parseFloat(url.searchParams.get('maxLon') ?? 'NaN');
  const since  = parseInt(url.searchParams.get('since')  ?? 'NaN', 10);

  if ([minLat, maxLat, minLon, maxLon, since].some(n => isNaN(n))) {
    return Response.json({ error: 'Invalid params' }, { status: 400 });
  }

  const strikes = getViewportStrikes(minLat, maxLat, minLon, maxLon, since);
  return Response.json({ strikes });
}
