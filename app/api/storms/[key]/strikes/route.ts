import { NextRequest, NextResponse } from 'next/server';
import { getStormByKey, getStormRank, getNextRankThreshold } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const storm = getStormByKey(decodeURIComponent(key));
  if (!storm) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // Accept client's live total (includes SSE strikes not yet flushed to DB)
  // so rank and next threshold are correct even between 30s tracker flushes
  const liveTotalParam = req.nextUrl.searchParams.get('liveTotal');
  const total = liveTotalParam ? parseInt(liveTotalParam, 10) : (storm.totalCount ?? storm.count);
  const rank = getStormRank(total);
  const nextRankThreshold = storm.stormKey ? getNextRankThreshold(storm.stormKey, total) : null;
  return NextResponse.json({
    strikes: storm.strikes ?? [],
    endTime: storm.endTime,
    totalCount: storm.totalCount,
    count: storm.count,
    rate: storm.rate,
    startTime: storm.startTime,
    traveledKm: storm.traveledKm,
    city: storm.city,
    originCity: storm.originCity,
    rank,
    nextRankThreshold,
  });
}
