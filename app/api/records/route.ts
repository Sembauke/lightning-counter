import { getStormRecords, getTopDailyPeak } from '../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return Response.json({
    storms: getStormRecords(),
    dailyPeak: getTopDailyPeak(),
  });
}
