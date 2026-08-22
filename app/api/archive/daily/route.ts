import { getGlobalDailyTotals } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return Response.json(getGlobalDailyTotals());
}
