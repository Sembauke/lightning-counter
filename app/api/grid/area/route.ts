import { serveGridArchive } from '../../../lib/gridArchiveRoute';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request) {
  return serveGridArchive(req);
}
