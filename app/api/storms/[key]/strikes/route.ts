import { NextRequest, NextResponse } from 'next/server';
import { getStormByKey } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const storm = getStormByKey(decodeURIComponent(key));
  if (!storm) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({
    strikes: storm.strikes ?? [],
    endTime: storm.endTime,
    count: storm.totalCount ?? storm.count,
  });
}
