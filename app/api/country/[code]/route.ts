import { getCountryHistory, getBiggestStorm, getStormReplayByKey } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { code: string } }) {
  const { code } = params;
  const todayCounts: Record<string, number> = (globalThis as any)._todayCounts ?? {};
  const todayDate: string = (globalThis as any)._todayDate ?? new Date().toISOString().slice(0, 10);

  const history = getCountryHistory(code);

  const todayInDb = history.find(h => h.date === todayDate);
  if (!todayInDb && todayCounts[code]) {
    history.unshift({ date: todayDate, count: todayCounts[code] });
  } else if (todayInDb && todayCounts[code]) {
    todayInDb.count = todayCounts[code];
  }

  let biggestStorm = getBiggestStorm(code);
  if (biggestStorm?.stormKey) {
    getStormReplayByKey(biggestStorm.stormKey);
    // Recovery mirrors its persisted sample here. Re-read this copy so an
    // older, independently retained country replay is preserved when no
    // recovery was possible in the canonical storms row.
    biggestStorm = getBiggestStorm(code) ?? biggestStorm;
  }
  return Response.json({ history, biggestStorm });
}
