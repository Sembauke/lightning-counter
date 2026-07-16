import { getStormsForDate, getStormByKey } from '../../lib/db';

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
  return Response.json(getStormsForDate(date, code));
}
