import { getCountryHistory, getCountryPeak, getBiggestStorm, getStormReplayByKey } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 24 * 60 * 60_000).toISOString().slice(0, 10);
  const live = globalThis as typeof globalThis & {
    _todayCounts?: Record<string, number>;
    _todayDate?: string;
  };
  const byDate = new Map(getCountryHistory(code).map(row => [row.date, row.count]));

  // Before the first midnight delivery, memory still contains yesterday's
  // final unflushed count. Apply it to yesterday, never to the new UTC day.
  if (live._todayCounts && (live._todayDate === today || live._todayDate === yesterday)) {
    byDate.set(live._todayDate, live._todayCounts[code] ?? 0);
  }
  const todayCount = byDate.get(today) ?? 0;
  byDate.set(today, todayCount);
  const history = [...byDate].map(([date, count]) => ({ date, count })).sort((a, b) => b.date.localeCompare(a.date));

  const peak = getCountryPeak(code);
  let peakCount = peak?.count ?? 0;
  let peakDate = peak?.date ?? '';
  for (const date of [yesterday, today]) {
    const count = byDate.get(date) ?? 0;
    // Match persisted record semantics: ties keep the existing record date.
    if (count > peakCount) { peakCount = count; peakDate = date; }
  }
  const summary = { row: { code, today: todayCount, peakCount, peakDate }, history };
  const headers = { 'Cache-Control': 'no-store' };
  if (new URL(req.url).searchParams.get('summary') === '1') return Response.json(summary, { headers });

  let biggestStorm = getBiggestStorm(code);
  if (biggestStorm?.stormKey) {
    getStormReplayByKey(biggestStorm.stormKey);
    // Recovery mirrors its persisted sample here. Re-read this copy so an
    // older, independently retained country replay is preserved when no
    // recovery was possible in the canonical storms row.
    biggestStorm = getBiggestStorm(code) ?? biggestStorm;
  }
  return Response.json({ ...summary, biggestStorm }, { headers });
}
