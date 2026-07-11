import { getCountryPeaks, getCountryPeakRates, loadCounters } from '../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const todayCounts: Record<string, number> = (globalThis as any)._todayCounts ?? {};
  // Live in-memory totals; falls back to the DB if the strike stream hasn't started yet
  const totalCounts: Record<string, number> = (globalThis as any)._serverCountryCounts ?? loadCounters().countries;
  const peaks = getCountryPeaks();
  const peakRates = getCountryPeakRates();

  const peakMap: Record<string, { count: number; date: string }> = {};
  for (const p of peaks) peakMap[p.code] = { count: p.count, date: p.date };

  const peakRateMap: Record<string, number> = {};
  for (const p of peakRates) peakRateMap[p.code] = p.rate;

  const allCodes = new Set([...Object.keys(todayCounts), ...Object.keys(peakMap), ...Object.keys(totalCounts)]);
  const result = [...allCodes].map(code => ({
    code,
    total: totalCounts[code] ?? 0,
    today: todayCounts[code] ?? 0,
    peakCount: peakMap[code]?.count ?? 0,
    peakDate: peakMap[code]?.date ?? '',
    peakRate: peakRateMap[code] ?? 0,
  })).sort((a, b) => b.today - a.today || b.peakCount - a.peakCount);

  return Response.json(result);
}
