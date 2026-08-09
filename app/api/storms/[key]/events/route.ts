import { NextRequest, NextResponse } from 'next/server';
import { getStormEvents } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const events = getStormEvents(decodeURIComponent(key));
  return NextResponse.json(events);
}
