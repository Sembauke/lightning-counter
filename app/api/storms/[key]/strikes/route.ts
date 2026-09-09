import { NextRequest, NextResponse } from 'next/server';
import { getStormReplayByKey, getNearbyRankedStorms } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const storm = getStormReplayByKey(decodeURIComponent(key));
  if (!storm) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const nearbyRanked = storm.stormKey ? getNearbyRankedStorms(storm.stormKey, 10) : [];
  return NextResponse.json({
    stormKey: storm.stormKey,
    strikes: storm.strikes ?? [],
    endTime: storm.endTime,
    totalCount: storm.totalCount,
    count: storm.count,
    rate: storm.rate,
    startTime: storm.startTime,
    traveledKm: storm.traveledKm,
    city: storm.city,
    originCity: storm.originCity,
    nearbyRanked,
  });
}
