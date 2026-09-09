import { serveGridArchive } from '../../../lib/gridArchiveRoute';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: { cellId: string } }) {
  return serveGridArchive(req, params.cellId);
}
