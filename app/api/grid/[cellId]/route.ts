import { serveGridArchive } from '../../../lib/gridArchiveRoute';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ cellId: string }> }
) {
  return serveGridArchive(req, (await params).cellId);
}
