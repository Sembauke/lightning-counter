import fs from 'fs';
import path from 'path';
import { getCountryCode } from '../../lib/geoCountry';
import { loadCounters, saveCounters, loadDailyStrikes, saveDailyAndPeaks, archiveGridStrikeBatch, upsertCountryPeakRates, pruneGridStrikes, upsertBiggestStorms, type BiggestStorm } from '../../lib/db';
import { detectStorms, nearestCity, type CityTuple } from '../../lib/stormClusters';

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
// Must fully cover the storm widget's 5-minute window (+1 min slack) even at
// peak global rates (~100/s), or its rates collapse on every page refresh.
// Older map visuals are seeded from the DB archive, not this buffer.
const MAX_HISTORY = 40_000;
const HISTORY_LIFETIME_MS = 6 * 60 * 1000;

const pendingGridStrikes: Array<{ lat: number; lon: number; time: number }> = [];

// ── SSE client registry (shared with server.mjs via globalThis) ────────
const enc = new TextEncoder();
// server.mjs stores controllers here; register our Set so it can broadcast
const sseControllers: Set<ReadableStreamDefaultController<Uint8Array>> = (() => {
  if (!(globalThis as any)._sseControllers) {
    (globalThis as any)._sseControllers = new Set();
  }
  return (globalThis as any)._sseControllers;
})();

function broadcastSSE(chunk: string) {
  const buf = enc.encode(chunk);
  for (const ctrl of sseControllers) {
    try { ctrl.enqueue(buf); } catch { sseControllers.delete(ctrl); }
  }
}

// ── Core strike processor — registered on globalThis for server.mjs ────
function processStrike(lat: number, lon: number) {
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

// Register with server.mjs so it can call us for incoming WS strikes
(globalThis as any)._processStrike = processStrike;

// Drain any strikes that arrived before this module loaded
const queued: Array<{ lat: number; lon: number }> = (globalThis as any)._strikeQueue ?? [];
(globalThis as any)._strikeQueue = [];
for (const { lat, lon } of queued) processStrike(lat, lon);

// ── Periodic maintenance ───────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - HISTORY_LIFETIME_MS;
  while (recentStrikes.length > 0 && recentStrikes[0].time < cutoff) recentStrikes.shift();
}, 60_000);

// Per-country city lists for naming record storms, loaded from disk on demand
const cityCache = new Map<string, CityTuple[]>();
function citiesFor(cc: string): CityTuple[] {
  let list = cityCache.get(cc);
  if (!list) {
    try {
      list = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'cities', `${cc}.json`), 'utf8')) as CityTuple[];
    } catch { list = []; }
    cityCache.set(cc, list);
  }
  return list;
}

setInterval(() => {
  try {
    saveCounters(serverTotal, serverCountryCounts);
    saveDailyAndPeaks(currentDay, todayCounts);

    // Compute current 5-min rates and persist any new peaks
    const WINDOW_MS = 5 * 60 * 1000;
    const cutoff5m = Date.now() - WINDOW_MS;
    const fiveMinCounts: Record<string, number> = {};
    const byCountry: Record<string, RecentStrike[]> = {};
    for (const s of recentStrikes) {
      if (s.time > cutoff5m && s.cc) {
        fiveMinCounts[s.cc] = (fiveMinCounts[s.cc] ?? 0) + 1;
        (byCountry[s.cc] ??= []).push(s);
      }
    }
    const rates: Record<string, number> = {};
    for (const [cc, count] of Object.entries(fiveMinCounts)) rates[cc] = count / 5;
    upsertCountryPeakRates(rates);

    // Track each country's biggest storm cell on record
    const records: BiggestStorm[] = [];
    for (const [cc, strikes] of Object.entries(byCountry)) {
      const top = detectStorms(strikes, WINDOW_MS)[0];
      if (!top) continue;
      const near = nearestCity(citiesFor(cc), top.lat, top.lon);
      records.push({
        code: cc, count: top.count, rate: top.rate,
        lat: top.lat, lon: top.lon,
        city: near?.name ?? null, date: currentDay,
      });
    }
    upsertBiggestStorms(records);
  } catch (err) { console.error('[db] flush failed:', err); }
}, 30_000);

setInterval(() => {
  if (pendingGridStrikes.length === 0) return;
  const batch = pendingGridStrikes.splice(0);
  try { archiveGridStrikeBatch(batch); } catch (err) { console.error('[db] grid batch failed:', err); }
}, 5_000);

setInterval(() => {
  try { pruneGridStrikes(); } catch (err) { console.error('[db] prune failed:', err); }
}, 60 * 60 * 1000);

// ── SSE endpoint ───────────────────────────────────────────────────────
export async function GET() {
  const activeSources: Set<string> = (globalThis as any)._activeSources ?? new Set();
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
      ctrl.enqueue(enc.encode(
        `event: history\ndata: ${JSON.stringify(recentStrikes)}\n\n`
      ));
      if (activeSources.size > 0) {
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
