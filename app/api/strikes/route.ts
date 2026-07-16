import fs from 'fs';
import path from 'path';
import { getCountryCode } from '../../lib/geoCountry';
import { loadCounters, saveCounters, loadDailyStrikes, saveDailyAndPeaks, archiveGridStrikeBatch, upsertCountryPeakRates, pruneGridStrikes, upsertBiggestStorms, upsertStormRecords, upsertStorms, pruneStormStrikes, hasTimestampBurst, type BiggestStorm, type StormStrike } from '../../lib/db';
import { detectStorms, nearestCity, type CityTuple } from '../../lib/stormClusters';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── Persisted state ────────────────────────────────────────────────────
const { total, countries } = loadCounters();
let serverTotal = total;
const serverCountryCounts: Record<string, number> = { ...countries };
(globalThis as any)._serverTotal = serverTotal;
// Mutated in place, so other routes always see live per-country totals
(globalThis as any)._serverCountryCounts = serverCountryCounts;

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
function processStrike(lat: number, lon: number, time?: number) {
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

  // Prefer the upstream discharge time; fall back to arrival time when it is
  // missing or in the future
  const now = Date.now();
  const t = typeof time === 'number' && time <= now + 60_000 ? time : now;
  // Stale deliveries (reconnect backlogs) count toward the totals above, but
  // restamping them into the live window would fabricate storm bursts
  if (t > now - 10 * 60_000) {
    recentStrikes.push({ lat, lon, cc, time: t });
    if (recentStrikes.length > MAX_HISTORY) recentStrikes.shift();
    pendingGridStrikes.push({ lat, lon, time: t });
    broadcastSSE(`data: ${JSON.stringify({ lat, lon, cc, time: t })}\n\n`);
  }
}

// Register with server.mjs so it can call us for incoming WS strikes
(globalThis as any)._processStrike = processStrike;

// Drain any strikes that arrived before this module loaded
const queued: Array<{ lat: number; lon: number; time?: number }> = (globalThis as any)._strikeQueue ?? [];
(globalThis as any)._strikeQueue = [];
for (const { lat, lon, time } of queued) processStrike(lat, lon, time);

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

// ── Storm tracking across passes ────────────────────────────────────────
// A storm keeps its identity while it stays above the detection threshold,
// so records can say "from Amsterdam to Hoorn, 22:10 – 22:35" as it moves.
interface TrackedStorm {
  key: string;
  cc: string;
  originLat: number;
  originLon: number;
  originCity: string | null;
  startTime: number;
  lat: number;
  lon: number;
  city: string | null;
  peakCount: number;
  peakRate: number;
  traveledKm: number;
  // Travel is measured as displacement between 5-minute strides of the
  // footprint center: per-pass hops are noise-dominated (a 50 km/h storm moves
  // only ~0.4 km per 30 s pass, far less than window jitter), while over a
  // stride real drift adds up and jitter averages out.
  travelAnchor: { lat: number; lon: number } | null;
  posBuf: Array<{ lat: number; lon: number }>;
  lastSeen: number;
  // Full-life strike accumulation for the replay: passes overlap, so only
  // strikes newer than lastStrikeTime get appended; keepEvery thins the
  // stream once the array would outgrow ALL_STRIKES_MAX
  allStrikes: StormStrike[];
  lastStrikeTime: number;
  totalStrikes: number;
  keepEvery: number;
  appendSeq: number;
}
const trackedStorms: TrackedStorm[] = [];
// A cell within this distance of a tracked storm's last centroid is the same storm
const STORM_MATCH_KM = 60;
// Drop a storm after missing ~3 passes below the threshold
const STORM_DROP_MS = 100_000;
// No storm system moves faster than this — lifetime cap on distance traveled
const STORM_MAX_KMH = 120;
// Travel stride: passes per measurement, and the displacement band that counts
// as real drift (≥3 km ≈ 36 km/h sustained; >12 km ≈ re-merge, not motion)
const TRAVEL_STRIDE_PASSES = 10;
const TRAVEL_MIN_KM = 3;
const TRAVEL_MAX_KM = 12;

function meanPos(points: Array<{ lat: number; lon: number }>): { lat: number; lon: number } {
  let lat = 0, lon = 0;
  for (const p of points) { lat += p.lat; lon += p.lon; }
  return { lat: lat / points.length, lon: lon / points.length };
}
const STRIKE_SAMPLE_MAX = 4000;
// Cap on a storm's accumulated replay strikes; halved (and thinned) on overflow
const ALL_STRIKES_MAX = 24_000;
let stormSeq = 0;

function kmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (aLat - bLat) * 111.32;
  const dLon = (aLon - bLon) * 111.32 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

function roundPt(m: { lat: number; lon: number; time: number }): StormStrike {
  return [Math.round(m.lat * 1000) / 1000, Math.round(m.lon * 1000) / 1000, m.time];
}

function footprintCenter(members: Array<{ lat: number; lon: number }>): { lat: number; lon: number } {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const m of members) {
    if (m.lat < minLat) minLat = m.lat;
    if (m.lat > maxLat) maxLat = m.lat;
    if (m.lon < minLon) minLon = m.lon;
    if (m.lon > maxLon) maxLon = m.lon;
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

function sampleCell(members: Array<{ lat: number; lon: number; time: number }>): StormStrike[] {
  const step = Math.max(1, Math.ceil(members.length / STRIKE_SAMPLE_MAX));
  const sample: StormStrike[] = [];
  for (let i = 0; i < members.length; i += step) sample.push(roundPt(members[i]));
  return sample;
}

/** Append a pass's new strikes to the storm's full-life accumulation */
function accumulateStrikes(st: TrackedStorm, members: Array<{ lat: number; lon: number; time: number }>): void {
  let newest = st.lastStrikeTime;
  for (const m of members) {
    if (m.time <= st.lastStrikeTime) continue;
    st.totalStrikes++;
    if (st.appendSeq++ % st.keepEvery === 0) st.allStrikes.push(roundPt(m));
    if (m.time > newest) newest = m.time;
  }
  st.lastStrikeTime = newest;
  if (st.allStrikes.length > ALL_STRIKES_MAX) {
    st.allStrikes = st.allStrikes.filter((_, i) => i % 2 === 0);
    st.keepEvery *= 2;
  }
}

setInterval(() => {
  try {
    saveCounters(serverTotal, serverCountryCounts);
    saveDailyAndPeaks(currentDay, todayCounts);

    // Compute current 5-min rates and persist any new peaks
    const WINDOW_MS = 5 * 60 * 1000;
    const nowMs = Date.now();
    const cutoff5m = nowMs - WINDOW_MS;
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

    // Match detected cells to tracked storms, spawning new tracks as needed
    const matched = new Set<TrackedStorm>();
    for (const [cc, strikes] of Object.entries(byCountry)) {
      for (const cell of detectStorms(strikes, WINDOW_MS)) {
        const sample = sampleCell(cell.members);
        // A backlog flush can masquerade as a huge storm — never track those
        if (hasTimestampBurst(sample)) continue;

        let best: TrackedStorm | null = null;
        let bestKm = STORM_MATCH_KM;
        for (const st of trackedStorms) {
          if (st.cc !== cc || matched.has(st)) continue;
          const km = kmBetween(st.lat, st.lon, cell.lat, cell.lon);
          if (km <= bestKm) { bestKm = km; best = st; }
        }

        const city = nearestCity(citiesFor(cc), cell.lat, cell.lon)?.name ?? null;
        const foot = footprintCenter(cell.members);
        if (best) {
          best.posBuf.push(foot);
          if (best.posBuf.length >= TRAVEL_STRIDE_PASSES) {
            // Smooth the stride endpoint over its last few passes
            const cur = meanPos(best.posBuf.slice(-3));
            if (best.travelAnchor) {
              const hop = kmBetween(best.travelAnchor.lat, best.travelAnchor.lon, cur.lat, cur.lon);
              if (hop >= TRAVEL_MIN_KM && hop <= TRAVEL_MAX_KM) best.traveledKm += hop;
            }
            best.travelAnchor = cur;
            best.posBuf = [];
          }
          best.lat = cell.lat;
          best.lon = cell.lon;
          best.city = city;
          best.lastSeen = nowMs;
          if (cell.count > best.peakCount) {
            best.peakCount = cell.count;
            best.peakRate = cell.rate;
          }
          accumulateStrikes(best, cell.members);
          matched.add(best);
        } else {
          let firstStrike = Infinity;
          for (const m of cell.members) if (m.time < firstStrike) firstStrike = m.time;
          const fresh: TrackedStorm = {
            key: `${cc}:${nowMs}:${stormSeq++}`,
            cc,
            originLat: cell.lat, originLon: cell.lon, originCity: city,
            startTime: firstStrike,
            lat: cell.lat, lon: cell.lon, city,
            peakCount: cell.count, peakRate: cell.rate,
            traveledKm: 0,
            travelAnchor: { lat: foot.lat, lon: foot.lon }, posBuf: [],
            lastSeen: nowMs,
            allStrikes: [], lastStrikeTime: 0, totalStrikes: 0, keepEvery: 1, appendSeq: 0,
          };
          accumulateStrikes(fresh, cell.members);
          trackedStorms.push(fresh);
          matched.add(fresh);
        }
      }
    }

    // Offer every storm seen this pass as a record candidate; the upsert only
    // accepts ones that beat the stored count or already hold the record
    const records: BiggestStorm[] = [];
    for (const st of trackedStorms) {
      if (st.lastSeen !== nowMs) continue;
      // Physical backstop: accumulated hops can never exceed what a real storm
      // system could cover in this lifetime
      const maxTravel = ((st.lastSeen - st.startTime) / 3_600_000) * STORM_MAX_KMH;
      records.push({
        code: st.cc, count: st.peakCount, rate: st.peakRate,
        lat: st.lat, lon: st.lon, city: st.city, date: currentDay,
        originLat: st.originLat, originLon: st.originLon, originCity: st.originCity,
        startTime: st.startTime, endTime: st.lastSeen, stormKey: st.key,
        traveledKm: Math.round(Math.min(st.traveledKm, maxTravel)), totalCount: st.totalStrikes,
        strikes: st.allStrikes,
      });
    }
    upsertBiggestStorms(records);
    upsertStormRecords(records);
    upsertStorms(records);

    // Expire storms that fell below the threshold for several passes
    let i = trackedStorms.length;
    while (i--) {
      if (nowMs - trackedStorms[i].lastSeen > STORM_DROP_MS) trackedStorms.splice(i, 1);
    }
  } catch (err) { console.error('[db] flush failed:', err); }
}, 30_000);

setInterval(() => {
  if (pendingGridStrikes.length === 0) return;
  const batch = pendingGridStrikes.splice(0);
  try { archiveGridStrikeBatch(batch); } catch (err) { console.error('[db] grid batch failed:', err); }
}, 5_000);

setInterval(() => {
  try {
    pruneGridStrikes();
    pruneStormStrikes();
  } catch (err) { console.error('[db] prune failed:', err); }
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
