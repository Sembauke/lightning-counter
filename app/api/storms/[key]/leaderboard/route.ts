import { NextResponse } from 'next/server';
import { getStormLeaderboardPage } from '../../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_KEY_LENGTH = 256;
const headers = { 'Cache-Control': 'no-store' };

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  let key: string;
  try {
    key = decodeURIComponent((await params).key);
  } catch {
    return NextResponse.json({ error: 'invalid storm key' }, { status: 400, headers });
  }
  const before = new URL(req.url).searchParams.get('before');
  if (!key || key.length > MAX_KEY_LENGTH || (before !== null && (!before || before.length > MAX_KEY_LENGTH))) {
    return NextResponse.json({ error: 'invalid storm key' }, { status: 400, headers });
  }
  const page = getStormLeaderboardPage(key, before ?? undefined);
  if (!page) return NextResponse.json({ error: 'not found' }, { status: 404, headers });
  return NextResponse.json(page, { headers });
}
