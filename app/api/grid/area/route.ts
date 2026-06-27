import { getGridAreaPage } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minLat = parseFloat(url.searchParams.get('minLat') ?? 'NaN');
  const maxLat = parseFloat(url.searchParams.get('maxLat') ?? 'NaN');
  const minLon = parseFloat(url.searchParams.get('minLon') ?? 'NaN');
  const maxLon = parseFloat(url.searchParams.get('maxLon') ?? 'NaN');
  const page   = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const limit  = 25;

  if (isNaN(minLat) || isNaN(maxLat) || isNaN(minLon) || isNaN(maxLon)) {
    return Response.json({ error: 'Invalid bounds' }, { status: 400 });
  }

  const data  = getGridAreaPage(minLat, maxLat, minLon, maxLon, page, limit);
  const pages = data.total > 0 ? Math.ceil(data.total / limit) : 0;
  return Response.json({ ...data, page, pages, limit });
}
