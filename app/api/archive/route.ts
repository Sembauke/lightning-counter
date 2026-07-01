import { getCountryPeaks, getCountryPeakRates } from '../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const todayCounts: Record<string, number> = (globalThis as any)._todayCounts ?? {};
  const peaks = getCountryPeaks();
  const peakRates = getCountryPeakRates();

  const peakMap: Record<string, { count: number; date: string }> = {};
  for (const p of peaks) peakMap[p.code] = { count: p.count, date: p.date };

  const peakRateMap: Record<string, number> = {};
  for (const p of peakRates) peakRateMap[p.code] = p.rate;

  const allCodes = new Set([...Object.keys(todayCounts), ...Object.keys(peakMap)]);
  const result = [...allCodes].map(code => ({
    code,
    today: todayCounts[code] ?? 0,
    peakCount: peakMap[code]?.count ?? 0,
    peakDate: peakMap[code]?.date ?? '',
    peakRate: peakRateMap[code] ?? 0,
  })).sort((a, b) => b.today - a.today || b.peakCount - a.peakCount);

  return Response.json(result);
}
