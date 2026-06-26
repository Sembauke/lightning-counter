import { getCountryPeaks } from '../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const todayCounts: Record<string, number> = (globalThis as any)._todayCounts ?? {};
  const peaks = getCountryPeaks();

  const peakMap: Record<string, { count: number; date: string }> = {};
  for (const p of peaks) peakMap[p.code] = { count: p.count, date: p.date };

  const allCodes = new Set([...Object.keys(todayCounts), ...Object.keys(peakMap)]);
  const result = [...allCodes].map(code => ({
    code,
    today: todayCounts[code] ?? 0,
    peakCount: peakMap[code]?.count ?? 0,
    peakDate: peakMap[code]?.date ?? '',
  })).sort((a, b) => b.today - a.today || b.peakCount - a.peakCount);

  return Response.json(result);
}
