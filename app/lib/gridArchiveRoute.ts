import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MapHistoryBounds } from './mapHistory';
import { GRID_ARCHIVE_PAGE_SIZE, GRID_ARCHIVE_WINDOW_MS, type GridArchivePage } from './gridArchiveTypes';
import { readGridArchive } from './gridArchiveReader';

interface Snapshot {
  version: 1;
  kind: 'area' | 'cell';
  bounds?: MapHistoryBounds;
  cellId?: string;
  since: number;
  until: number;
  snapshotId: number;
  total: number;
  page: number;
  issuedAt: number;
  after: { strikeTime: number; id: number };
}

const globals = globalThis as typeof globalThis & { _gridArchiveCursorKey?: Buffer };
const secret = globals._gridArchiveCursorKey ??= randomBytes(32);
const boundsFields = ['minLat', 'maxLat', 'minLon', 'maxLon'] as const;
const fields = [...boundsFields, 'since', 'until', 'page', 'cursor'] as const;
const headers = { 'Cache-Control': 'no-store' };

function number(params: URLSearchParams, name: string): number {
  const text = params.get(name);
  if (text === null || !text.trim()) throw new Error('Missing parameter');
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error('Invalid number');
  return value;
}

function validBounds(bounds: MapHistoryBounds): boolean {
  return boundsFields.every(field => Number.isFinite(bounds[field]))
    && bounds.minLat >= -90 && bounds.maxLat <= 90 && bounds.minLat <= bounds.maxLat
    && Math.abs(bounds.minLon) <= 180 && Math.abs(bounds.maxLon) <= 180;
}

function sign(payload: string): Buffer { return createHmac('sha256', secret).update(payload).digest(); }
function encode(snapshot: Snapshot): string {
  const payload = Buffer.from(JSON.stringify(snapshot)).toString('base64url');
  return `${payload}.${sign(payload).toString('base64url')}`;
}

function decode(cursor: string, now: number): Snapshot {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid cursor');
  const [payload, encoded] = cursor.split('.');
  const signature = Buffer.from(encoded, 'base64url');
  if (signature.length !== 32 || !timingSafeEqual(signature, sign(payload))) throw new Error('Invalid signature');
  const snapshot = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Snapshot;
  if (snapshot.version !== 1 || !['cell', 'area'].includes(snapshot.kind)
    || !Number.isSafeInteger(snapshot.issuedAt) || snapshot.issuedAt > now || now - snapshot.issuedAt > 15 * 60_000
    || !Number.isSafeInteger(snapshot.page) || snapshot.page < 2
    || !Number.isSafeInteger(snapshot.total) || snapshot.total < 1
    || snapshot.page > Math.ceil(snapshot.total / GRID_ARCHIVE_PAGE_SIZE)
    || !Number.isSafeInteger(snapshot.snapshotId) || snapshot.snapshotId < 1
    || !Number.isSafeInteger(snapshot.after?.id) || snapshot.after.id < 1 || snapshot.after.id > snapshot.snapshotId
    || !Number.isSafeInteger(snapshot.after.strikeTime) || snapshot.after.strikeTime < snapshot.since || snapshot.after.strikeTime > snapshot.until) {
    throw new Error('Invalid snapshot');
  }
  return snapshot;
}

/** Bounded, cursor-only retained archive paging for the map drawer and legacy cells. */
export async function serveGridArchive(req: Request, cellId?: string): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const now = Date.now();
  const kind = cellId === undefined ? 'area' : 'cell';
  let bounds: MapHistoryBounds | undefined;
  let since: number, until: number;
  let snapshot: Snapshot | undefined;
  try {
    if (params.toString().length > 4096) throw new Error('Query too long');
    for (const key of params.keys()) if (!(fields as readonly string[]).includes(key)) throw new Error('Unsupported parameter');
    for (const field of fields) if (params.getAll(field).length > 1) throw new Error('Repeated parameter');
    if (cellId !== undefined && (!/^-?\d{1,6},-?\d{1,6}$/.test(cellId)
      || cellId.split(',').some(value => !Number.isSafeInteger(Number(value)) || Math.abs(Number(value)) > 100_000))) {
      throw new Error('Invalid cell');
    }
    if (params.has('cursor')) {
      snapshot = decode(params.get('cursor')!, now);
      if (snapshot.kind !== kind || snapshot.cellId !== cellId) throw new Error('Cursor target changed');
      bounds = snapshot.bounds;
      ({ since, until } = snapshot);
      for (const field of boundsFields) {
        if (params.has(field) && number(params, field) !== bounds?.[field]) throw new Error('Cursor bounds changed');
      }
      for (const field of ['since', 'until', 'page'] as const) {
        if (params.has(field) && number(params, field) !== snapshot[field]) throw new Error('Cursor window changed');
      }
    } else {
      if (params.has('page') && number(params, 'page') !== 1) throw new Error('Use the next-page cursor');
      if (kind === 'area') bounds = { minLat: number(params, 'minLat'), maxLat: number(params, 'maxLat'),
        minLon: number(params, 'minLon'), maxLon: number(params, 'maxLon') };
      until = params.has('until') ? number(params, 'until') : now;
      since = params.has('since') ? number(params, 'since') : until - GRID_ARCHIVE_WINDOW_MS;
      if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || since > until
        || until - since > GRID_ARCHIVE_WINDOW_MS) throw new Error('Invalid window');
      if (until > now) { since -= until - now; until = now; }
      since = Math.max(since, now - GRID_ARCHIVE_WINDOW_MS);
    }
    if (bounds && !validBounds(bounds)) throw new Error('Invalid bounds');
    if (since > until || until < now - GRID_ARCHIVE_WINDOW_MS) throw new Error('Outside retained archive');
  } catch {
    return Response.json({ error: 'Invalid archive parameters or expired cursor' }, { status: 400, headers });
  }

  try {
    const result = await readGridArchive({ kind, bounds, cellId, since, until, limit: GRID_ARCHIVE_PAGE_SIZE,
      snapshotId: snapshot?.snapshotId, after: snapshot?.after, total: snapshot?.total }, req.signal);
    const page = snapshot?.page ?? 1;
    const total = result.total!;
    const nextCursor = result.next ? encode({ version: 1, kind, bounds, cellId, since, until,
      snapshotId: result.snapshotId, total, page: page + 1, issuedAt: snapshot?.issuedAt ?? now, after: result.next }) : null;
    const body: GridArchivePage = { strikes: result.strikes, total, page,
      pages: Math.ceil(total / GRID_ARCHIVE_PAGE_SIZE), limit: GRID_ARCHIVE_PAGE_SIZE, since, until, nextCursor };
    return Response.json(kind === 'cell' ? { ...body, cell: result.cell } : body, { headers });
  } catch {
    return Response.json({ error: 'Archive temporarily unavailable' }, { status: 503,
      headers: { ...headers, 'Retry-After': '2' } });
  }
}
