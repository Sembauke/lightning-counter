import { readGridArchive } from '../../../lib/gridArchiveReader';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { MAP_HISTORY_WINDOW_MS, MAP_HISTORY_PAGE_SIZE, type MapHistoryBounds, type MapHistoryPage } from '../../../lib/mapHistory';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Snapshot extends MapHistoryBounds {
  version: 1;
  since: number;
  until: number;
  snapshotId: number;
  strikeTime: number;
  id: number;
}

// Cursors survive development module reloads, but cannot be edited to change
// the snapshot's geography, time range or seek position between requests.
const globals = globalThis as typeof globalThis & { _viewportCursorKey?: Buffer };
const cursorKey = globals._viewportCursorKey ??= randomBytes(32);
const fields = ['minLat', 'maxLat', 'minLon', 'maxLon', 'since', 'until'] as const;

function numberParam(params: URLSearchParams, name: string): number {
  const text = params.get(name);
  if (text == null || text.trim() === '') throw new Error('Missing numeric parameter');
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error('Invalid numeric parameter');
  return value;
}

function validBounds(bounds: MapHistoryBounds): boolean {
  return [bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon].every(Number.isFinite)
    && bounds.minLat >= -90 && bounds.maxLat <= 90 && bounds.minLat <= bounds.maxLat
    && bounds.minLon >= -180 && bounds.minLon <= 180 && bounds.maxLon >= -180 && bounds.maxLon <= 180;
}

function validWindow(since: number, until: number): boolean {
  return Number.isSafeInteger(since) && Number.isSafeInteger(until)
    && since >= 0 && since <= until && until - since <= MAP_HISTORY_WINDOW_MS;
}

function signature(payload: string): Buffer {
  return createHmac('sha256', cursorKey).update(payload).digest();
}

function encodeCursor(snapshot: Snapshot): string {
  const payload = Buffer.from(JSON.stringify(snapshot)).toString('base64url');
  return `${payload}.${signature(payload).toString('base64url')}`;
}

function decodeCursor(cursor: string): Snapshot {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid cursor');
  const [payload, signed] = cursor.split('.');
  const provided = Buffer.from(signed, 'base64url'), expected = signature(payload);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error('Invalid cursor');
  const snapshot = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Snapshot;
  if (!snapshot || snapshot.version !== 1 || !validBounds(snapshot) || !validWindow(snapshot.since, snapshot.until)
      || !Number.isSafeInteger(snapshot.snapshotId) || snapshot.snapshotId <= 0
      || !Number.isSafeInteger(snapshot.id) || snapshot.id <= 0 || snapshot.id > snapshot.snapshotId
      || !Number.isSafeInteger(snapshot.strikeTime) || snapshot.strikeTime < snapshot.since || snapshot.strikeTime > snapshot.until) {
    throw new Error('Invalid cursor');
  }
  return snapshot;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  let bounds: MapHistoryBounds, since: number, until: number, snapshot: Snapshot | undefined;
  try {
    if (params.toString().length > 4096) throw new Error('Query too long');
    for (const name of params.keys()) if (![...fields, 'cursor'].includes(name)) throw new Error('Unsupported parameter');
    // Repeated keys are ambiguous when validating a snapshot continuation.
    for (const name of [...fields, 'cursor']) if (params.getAll(name).length > 1) throw new Error('Duplicate parameter');
    if (params.has('cursor')) {
      snapshot = decodeCursor(params.get('cursor')!);
      for (const name of fields) {
        if (params.has(name) && numberParam(params, name) !== snapshot[name]) throw new Error('Cursor parameters changed');
      }
      bounds = snapshot;
      ({ since, until } = snapshot);
    } else {
      bounds = {
        minLat: numberParam(params, 'minLat'), maxLat: numberParam(params, 'maxLat'),
        minLon: numberParam(params, 'minLon'), maxLon: numberParam(params, 'maxLon'),
      };
      const now = Date.now();
      until = params.has('until') ? numberParam(params, 'until') : now;
      since = params.has('since') ? numberParam(params, 'since') : until - MAP_HISTORY_WINDOW_MS;
      if (!Number.isSafeInteger(since) || since < 0) throw new Error('Invalid start time');
      // Older clients supply only since. Bound that request against server time
      // instead of allowing an unbounded scan or rejecting clock/network skew.
      if (!params.has('until')) since = Math.max(since, until - MAP_HISTORY_WINDOW_MS);
      if (!validBounds(bounds) || !validWindow(since, until)) throw new Error('Invalid bounds or time window');
      // A client clock ahead of the server must not make history unavailable.
      // Shift the entire requested span together; later pages bind this returned
      // window rather than consulting either machine's clock again.
      if (until > now) {
        since = Math.max(0, since - (until - now));
        until = now;
      }
    }
  } catch {
    return Response.json({ error: 'Invalid viewport parameters or cursor' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  let page;
  try {
    page = await readGridArchive({ kind: 'viewport', bounds, since, until, limit: MAP_HISTORY_PAGE_SIZE,
      snapshotId: snapshot?.snapshotId, after: snapshot ? { strikeTime: snapshot.strikeTime, id: snapshot.id } : undefined }, req.signal);
  } catch {
    return Response.json({ error: 'Archive temporarily unavailable' }, { status: 503,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' } });
  }
  const nextCursor = page.next ? encodeCursor({ ...bounds, version: 1, since, until,
    snapshotId: page.snapshotId, strikeTime: page.next.strikeTime, id: page.next.id }) : null;
  const body: MapHistoryPage = { strikes: page.strikes, nextCursor, complete: nextCursor === null, since, until };
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
