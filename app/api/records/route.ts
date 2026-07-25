import { getStormRecords, getBiggestStormPerDay } from '../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return Response.json({
    storms: getStormRecords(),
    dailyBest: getBiggestStormPerDay(),
  });
}
