import { getGridCellPage } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: { cellId: string } }
) {
  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const limit = 25;
  const cellId = decodeURIComponent(params.cellId);
  const data = getGridCellPage(cellId, page, limit);
  const pages = data.total > 0 ? Math.ceil(data.total / limit) : 0;
  return Response.json({ ...data, page, pages, limit });
}
