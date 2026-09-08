import { getGlobalDailyTotals } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const totals = getGlobalDailyTotals();
  const today = new Date().toISOString().slice(0, 10);
  const live = globalThis as typeof globalThis & {
    _todayDate?: string;
    _todayCounts?: Record<string, number>;
  };

  // Include strikes received since the last database save. The date guard
  // keeps yesterday's counters from being shown as today during rollover.
  if (live._todayDate === today && live._todayCounts) {
    const total = Object.values(live._todayCounts).reduce((sum, count) => sum + count, 0);
    const todayRow = totals.find(row => row.date === today);
    if (todayRow) todayRow.total = total;
    else totals.unshift({ date: today, total });
  }

  return Response.json(totals, { headers: { 'Cache-Control': 'no-store' } });
}
