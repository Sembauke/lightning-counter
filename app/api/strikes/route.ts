import { WebSocket } from 'ws';
import { getCountryCode } from '../../lib/geoCountry';
import { loadCounters, saveCounters, loadDailyStrikes, saveDailyAndPeaks, archiveGridStrikeBatch } from '../../lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── Persisted state ────────────────────────────────────────────────────
const { total, countries } = loadCounters();
let serverTotal = total;
const serverCountryCounts: Record<string, number> = { ...countries };
(globalThis as any)._serverTotal = serverTotal;

function todayDate() { return new Date().toISOString().slice(0, 10); }
let currentDay = todayDate();
let todayCounts: Record<string, number> = { ...loadDailyStrikes(currentDay) };
(globalThis as any)._todayCounts = todayCounts;
(globalThis as any)._todayDate = currentDay;

// ── Strike buffers ─────────────────────────────────────────────────────
interface RecentStrike { lat: number; lon: number; cc: string | null; time: number }
const recentStrikes: RecentStrike[] = [];
const MAX_HISTORY = 5000;
const HISTORY_LIFETIME_MS = 30 * 60 * 1000;

const pendingGridStrikes: Array<{ lat: number; lon: number; time: number }> = [];

// ── SSE client registry ────────────────────────────────────────────────
const enc = new TextEncoder();
const sseControllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

function broadcastSSE(chunk: string) {
  const buf = enc.encode(chunk);
  for (const ctrl of sseControllers) {
    try { ctrl.enqueue(buf); } catch { sseControllers.delete(ctrl); }
  }
}

// ── Deduplication (multiple WS servers relay the same strike) ──────────
// Blitzortung nanosecond timestamps are unique per strike globally
const seenNanos: number[] = [];
const SEEN_NANOS_MAX = 30_000;

function isDuplicate(nanoTime: number): boolean {
  // Binary search for fast lookup
  let lo = 0, hi = seenNanos.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (seenNanos[mid] === nanoTime) return true;
    if (seenNanos[mid] < nanoTime) lo = mid + 1; else hi = mid - 1;
  }
  seenNanos.splice(lo, 0, nanoTime);
  if (seenNanos.length > SEEN_NANOS_MAX) seenNanos.shift();
  return false;
}

// ── Strike handler ─────────────────────────────────────────────────────
function handleStrike(lat: number, lon: number, nanoTime: number) {
  if (isDuplicate(nanoTime)) return;

  const today = todayDate();
  if (today !== currentDay) {
    saveDailyAndPeaks(currentDay, todayCounts);
    todayCounts = {};
    currentDay = today;
    (globalThis as any)._todayDate = currentDay;
    (globalThis as any)._todayCounts = todayCounts;
  }

  let cc: string | null = null;
  try { cc = getCountryCode(lat, lon); } catch { /* non-fatal */ }

  serverTotal++;
  (globalThis as any)._serverTotal = serverTotal;
  if (cc) {
    serverCountryCounts[cc] = (serverCountryCounts[cc] ?? 0) + 1;
    todayCounts[cc] = (todayCounts[cc] ?? 0) + 1;
  }

  const now = Date.now();
  recentStrikes.push({ lat, lon, cc, time: now });
  if (recentStrikes.length > MAX_HISTORY) recentStrikes.shift();
  pendingGridStrikes.push({ lat, lon, time: now });

  broadcastSSE(`data: ${JSON.stringify({ lat, lon, cc })}\n\n`);
}

// ── Blitzortung WebSocket connections (module-level singletons) ────────
// Each server covers different detector stations; all four give global coverage
const BLITZ_SERVERS = [
  'wss://ws1.blitzortung.org:3000/',
  'wss://ws5.blitzortung.org:3000/',
  'wss://ws6.blitzortung.org:3000/',
  'wss://ws7.blitzortung.org:3000/',
];

let connectedCount = 0;

function connectBlitz(url: string) {
  const connect = () => {
    const ws = new WebSocket(url);

    ws.on('open', () => {
      connectedCount++;
      if (connectedCount === 1) broadcastSSE('event: status\ndata: live\n\n');
      ws.send(JSON.stringify({ time: 0 }));
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const d = JSON.parse(raw.toString()) as { lat?: number; lon?: number; time?: number };
        if (typeof d.lat === 'number' && typeof d.lon === 'number' && typeof d.time === 'number') {
          handleStrike(d.lat, d.lon, d.time);
        }
      } catch { /* ignore malformed */ }
    });

    ws.on('error', (err) => console.error(`[blitz ${url}]`, err.message));

    ws.on('close', () => {
      connectedCount = Math.max(0, connectedCount - 1);
      if (connectedCount === 0) broadcastSSE('event: status\ndata: reconnecting\n\n');
      setTimeout(connect, 5_000);
    });
  };
  connect();
}

BLITZ_SERVERS.forEach(connectBlitz);

// ── Periodic maintenance ───────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - HISTORY_LIFETIME_MS;
  while (recentStrikes.length > 0 && recentStrikes[0].time < cutoff) recentStrikes.shift();
}, 60_000);

setInterval(() => {
  try {
    saveCounters(serverTotal, serverCountryCounts);
    saveDailyAndPeaks(currentDay, todayCounts);
  } catch (err) { console.error('[db] flush failed:', err); }
}, 30_000);

setInterval(() => {
  if (pendingGridStrikes.length === 0) return;
  const batch = pendingGridStrikes.splice(0);
  try { archiveGridStrikeBatch(batch); } catch (err) { console.error('[db] grid batch failed:', err); }
}, 5_000);

// ── SSE endpoint ───────────────────────────────────────────────────────
export async function GET() {
  let ctrl: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      sseControllers.add(ctrl);
      heartbeat = setInterval(() => {
        try { ctrl.enqueue(enc.encode(': heartbeat\n\n')); }
        catch { clearInterval(heartbeat); sseControllers.delete(ctrl); }
      }, 25_000);

      ctrl.enqueue(enc.encode(
        `event: init\ndata: ${JSON.stringify({ total: serverTotal, countries: serverCountryCounts })}\n\n`
      ));
      if (recentStrikes.length > 0) {
        ctrl.enqueue(enc.encode(
          `event: history\ndata: ${JSON.stringify(recentStrikes)}\n\n`
        ));
      }
      if (connectedCount > 0) {
        ctrl.enqueue(enc.encode('event: status\ndata: live\n\n'));
      }
    },
    cancel() {
      clearInterval(heartbeat);
      sseControllers.delete(ctrl);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
