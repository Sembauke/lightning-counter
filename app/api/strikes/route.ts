import fs from 'fs';
import path from 'path';
import { getCountryCode } from '../../lib/geoCountry';
import { loadCounters, saveCounters, loadDailyStrikes, saveDailyAndPeaks, archiveGridStrikeBatch, upsertCountryPeakRates, pruneGridStrikes, upsertBiggestStorms, upsertStormRecords, upsertStorms, pruneStormStrikes, pruneStormEvents, saveTrackedStorms, loadTrackedStorms, hasTimestampBurst, hasMissingCountryPaths, enrichStormCountryPaths, deleteStorm, consolidateNearbyStorms, getTrackedStormKeys, getRecentStormPositions, getStormByKey, recordStormEvent, countSplitEvents, type BiggestStorm, type StormStrike } from '../../lib/db';
import { dispatchStrike as dispatchToStormSubscribers } from '../../lib/strikeStream';
import { detectStorms, nearestCity, type CityTuple } from '../../lib/stormClusters';

// Wider than the detection MERGE_KM (75 km) so that two tracked identities
// from the same large storm system get consolidated even when their centroids
// are far apart (large MCS can span 100+ km).
const TRACKER_MERGE_KM = 100;

// When two DB-loaded storms merge with no ancestor tracking, absorbInto falls
// into Branch 3 and returns small.totalStrikes — the full lifetime count, not
// the genuine new contribution. We can't distinguish a restart re-merge from a
// first-time merge of two long-lived storms at this point, so we suppress the
// count (record null) to avoid showing a misleading number.

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
// Survive HMR module reloads in dev — same pattern as _serverTotal/_serverCountryCounts
const recentStrikes: RecentStrike[] = (globalThis as any)._recentStrikes ?? [];
(globalThis as any)._recentStrikes = recentStrikes;
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
// Increment a global generation counter on each module load. broadcastSSE checks
// this so that stale module instances (hot-reload survivors without the processStrike
// staleness guard) cannot send broadcasts to current clients.
const myGeneration: number = ((globalThis as any)._sseBcastGen = ((globalThis as any)._sseBcastGen ?? 0) + 1);

function broadcastSSE(chunk: string) {
  if ((globalThis as any)._sseBcastGen !== myGeneration) return;
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
  const countCc = cc ?? 'XO';
  serverCountryCounts[countCc] = (serverCountryCounts[countCc] ?? 0) + 1;
  todayCounts[countCc] = (todayCounts[countCc] ?? 0) + 1;

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
    dispatchToStormSubscribers(lat, lon, t);
  }
}

// Register with server.mjs so it can call us for incoming WS strikes
(globalThis as any)._processStrike = processStrike;

// Drain any strikes that arrived before this module loaded
const queued: Array<{ lat: number; lon: number; time?: number }> = (globalThis as any)._strikeQueue ?? [];
(globalThis as any)._strikeQueue = [];
for (const { lat, lon, time } of queued) processStrike(lat, lon, time);

// ── Stale-interval cleanup ─────────────────────────────────────────────
// Use named globalThis slots (_iv_*) for every interval so that ANY module
// load — regardless of when it was created or what cleanup code it had —
// kills the previous instance's timers. clearInterval on a named slot is
// unconditional: it works even for modules loaded before this mechanism
// existed, because it targets the timer object itself, not a tracking list.
// Also clear the old _routeIntervals list for modules that used that approach.
for (const id of ((globalThis as any)._routeIntervals ?? [])) clearInterval(id as ReturnType<typeof setInterval>);
(globalThis as any)._routeIntervals = [];
for (const k of ['_iv_histPrune', '_iv_dbFlush', '_iv_gridBatch', '_iv_hourly']) {
  if ((globalThis as any)[k]) clearInterval((globalThis as any)[k]);
}

// ── Periodic maintenance ───────────────────────────────────────────────
(globalThis as any)._iv_histPrune = setInterval(() => {
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
  currentRate: number;
  inDb: boolean;
  // Full-life strike accumulation for the replay: passes overlap, so only
  // strikes newer than lastStrikeTime get appended
  allStrikes: StormStrike[];
  lastStrikeTime: number;
  totalStrikes: number;
  // Ordered list of every country code the storm has passed through
  countryCodes: string[];
  // Per-ancestor overlap map: ancestorKey → number of strikes that ancestor
  // already counted from this storm's territory at the time of the split.
  // Empty for storms that formed independently.
  // Used by absorbInto to apply the exact double-count correction for any
  // ancestor that re-absorbs this storm, regardless of how many intermediate
  // merges or key-adoptions occurred in between.
  initialStrikesByAncestor: Record<string, number>;
  // allStrikes thinning: once allStrikes exceeds ALL_STRIKES_MAX, keepEvery
  // doubles and the array is halved so memory stays bounded for long storms.
  keepEvery: number;
  appendSeq: number;
  // Set to true the first time split detection assigns a parent. Used as the
  // split-detection guard so Phase 1/2 absorptions (which also populate
  // initialStrikesByAncestor) don't incorrectly suppress re-detection.
  splitDetected: boolean;
  // Timestamp when this storm was first detected as a split candidate (ms).
  // Null until split detection marks it. The split event is only recorded
  // after SPLIT_CONFIRM_MS to filter transient clusters that re-merge quickly.
  splitCandidateAt: number | null;
  // Human-readable label assigned when split detection fires (e.g. "F1", "F2").
  // Null for storms that formed independently. Carried through merges so that
  // absorbing a known fragment can surface the label in the event log.
  fragmentLabel: string | null;
}
// Maximum match window — a cell within this distance of a tracked storm's last
// centroid is a candidate. The effective window is further capped by velocity:
// a storm last seen 5 min ago can't be 60 km away at any realistic speed.
const STORM_MATCH_KM = 60;
// Minimum match window regardless of elapsed time (absorbs centroid jitter)
const STORM_MATCH_MIN_KM = 15;
// Keep a storm alive for 1 hour after it drops below the detection threshold.
// Beyond that, a re-appearing cell in the same area is a new storm, not a
// continuation — the 6-hour window was causing unrelated evening storms to
// inherit morning storm identities, inflating counts and durations.
const STORM_DROP_MS = 1 * 60 * 60 * 1000;
// No storm system moves faster than this — lifetime cap on distance traveled
const STORM_MAX_KMH = 120;
// A storm enters the storm log only once it has accumulated this many total strikes;
// biggest-storm and record tables are exempt — they're superlatives, not a log
const STORM_LOG_MIN_STRIKES = 5000;
const trackedStorms: TrackedStorm[] = (() => {
  try {
    const saved = loadTrackedStorms() as TrackedStorm[];
    const cutoff = Date.now() - STORM_DROP_MS;
    const loaded = saved.filter(st => st.lastSeen > cutoff && st.key && st.cc && typeof st.lat === 'number');
    // Mark storms that are already in the DB so the map can link them immediately
    const dbKeys = getTrackedStormKeys();
    // Nudge stale lastSeen into the 5-min active window so the first connect-time
    // broadcast includes them. After a hot-reload or restart the saved timestamps
    // can be >5 min old, causing labels=0 until the first 30s interval fires.
    // The interval resets lastSeen to the real match time on its first pass.
    const minLastSeen = Date.now() - 4 * 60 * 1000;
    for (const st of loaded) {
      st.inDb = dbKeys.has(st.key);
      st.initialStrikesByAncestor = st.initialStrikesByAncestor ?? {};
      st.keepEvery = st.keepEvery ?? 1;
      st.appendSeq = st.appendSeq ?? (st.allStrikes?.length ?? 0);
      st.splitDetected = st.splitDetected ?? false;
      st.splitCandidateAt = st.splitCandidateAt ?? null;
      st.fragmentLabel = st.fragmentLabel ?? null;
      if (st.lastSeen < minLastSeen) st.lastSeen = minLastSeen;
      // If allStrikes is missing or unusually short (e.g. lost on prev restart),
      // seed from the DB strikes blob which has the full historical coverage.
      if (st.inDb && (!st.allStrikes || st.allStrikes.length < 100)) {
        try {
          const dbStorm = getStormByKey(st.key);
          if (dbStorm?.strikes && dbStorm.strikes.length > (st.allStrikes?.length ?? 0)) {
            st.allStrikes = dbStorm.strikes;
            st.lastStrikeTime = Math.max(...dbStorm.strikes.map(s => s[2]));
          }
        } catch { /* non-fatal */ }
      }
    }
    return loaded;
  } catch { return []; }
})();
// Startup tasks run async so they don't delay the first SSE response.
// inDb flags are re-validated in the connect-time handler (below) instead.
setImmediate(() => {
  try { if (hasMissingCountryPaths()) enrichStormCountryPaths(getCountryCode); } catch { /* non-fatal */ }
  try {
    consolidateNearbyStorms(TRACKER_MERGE_KM);
    // After consolidation some in-memory storms may have had their DB row deleted
    // (consolidation keeps the highest-count row and deletes others). Re-key any
    // orphaned in-memory storms to the surviving DB entry so they don't lose TRACKING.
    const liveKeys = getTrackedStormKeys();
    const livePositions = getRecentStormPositions();
    for (const st of trackedStorms) {
      if (liveKeys.has(st.key)) {
        st.inDb = true;
      } else if (st.inDb) {
        // Key was deleted by consolidation — find the nearby surviving DB storm and adopt it.
        let bestKey: string | null = null;
        let bestKm = Infinity;
        for (const [key, pos] of livePositions) {
          const d = kmBetween(st.lat, st.lon, pos.lat, pos.lon);
          if (d < TRACKER_MERGE_KM && d < bestKm) { bestKm = d; bestKey = key; }
        }
        if (bestKey) {
          st.key = bestKey;
          st.inDb = true;
          livePositions.delete(bestKey); // prevent two storms from claiming the same DB key
        } else {
          st.inDb = false;
        }
      }
    }
  } catch { /* non-fatal */ }
});
// Travel stride: passes per measurement, and the displacement band that counts
// as real drift (≥3 km ≈ 36 km/h sustained; >20 km ≈ re-merge, not motion)
const TRAVEL_STRIDE_PASSES = 10;
const TRAVEL_MIN_KM = 3;
const TRAVEL_MAX_KM = 20;

function meanPos(points: Array<{ lat: number; lon: number }>): { lat: number; lon: number } {
  let lat = 0, lon = 0;
  for (const p of points) { lat += p.lat; lon += p.lon; }
  return { lat: lat / points.length, lon: lon / points.length };
}
const STRIKE_SAMPLE_MAX = 4000;
const ALL_STRIKES_MAX = 24_000;
// Persisted on globalThis so hot-reloads in dev don't reset it and create
// duplicate in-memory identities for the same physical storm.
let stormSeq: number = (globalThis as any)._stormSeq ?? 0;

function kmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (aLat - bLat) * 111.32;
  const dLon = (aLon - bLon) * 111.32 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

// Deduplicate active storms before broadcasting: remove entries within 75 km of a
// higher-priority entry so duplicate in-memory identities (e.g. from a dev
// hot-reload that reset stormSeq) don't pollute the broadcast.
// Priority: DB-linked (inDb=true) beats non-DB; within same tier, more totalStrikes wins.
function dedupeActiveStorms(storms: TrackedStorm[], nowMs: number): TrackedStorm[] {
  const active = storms.filter(st => nowMs - st.lastSeen < 5 * 60_000);
  const sorted = [...active].sort((a, b) => {
    if (a.inDb !== b.inDb) return (b.inDb ? 1 : 0) - (a.inDb ? 1 : 0);
    return b.totalStrikes - a.totalStrikes;
  });
  const kept: TrackedStorm[] = [];
  for (const st of sorted) {
    const tooClose = kept.some(k => kmBetween(k.lat, k.lon, st.lat, st.lon) < 20);
    if (!tooClose) kept.push(st);
  }
  return kept.sort((a, b) => (b.currentRate ?? 0) - (a.currentRate ?? 0)).slice(0, 20);
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
    st.keepEvery *= 2;
    st.allStrikes = st.allStrikes.filter((_, i) => i % 2 === 0);
  }
}

(globalThis as any)._iv_dbFlush = setInterval(() => {
  if ((globalThis as any)._processStrike !== processStrike) return;
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
      if (s.time > cutoff5m) {
        const rcc = s.cc ?? 'XO';
        fiveMinCounts[rcc] = (fiveMinCounts[rcc] ?? 0) + 1;
        (byCountry[rcc] ??= []).push(s);
      }
    }
    const rates: Record<string, number> = {};
    for (const [cc, count] of Object.entries(fiveMinCounts)) rates[cc] = count / 5;
    upsertCountryPeakRates(rates);

    // Re-validate inDb flags each pass. Startup consolidateNearbyStorms (setImmediate)
    // fires AFTER the first SSE connect-time re-validation, so it can delete a key
    // that was still valid at connect time. Without this, the stale inDb=true persists
    // indefinitely and the TRACKING link leads to a 404.
    // NOTE: we do NOT call consolidateNearbyStorms here — that would create a race
    // where it deletes keys we're about to upsert. Only the startup call (setImmediate)
    // is allowed; this pass only clears flags for keys already gone from the DB.
    try {
      const liveDbKeys = getTrackedStormKeys();
      for (const st of trackedStorms) {
        if (st.inDb && !liveDbKeys.has(st.key)) st.inDb = false;
      }
    } catch { /* non-fatal */ }

    // Detect storm cells across ALL countries (including sea strikes) so storms
    // that cross borders or move offshore are tracked as one continuous system.
    const allRecentStrikes = recentStrikes.filter(s => s.time > cutoff5m);
    const matched = new Set<TrackedStorm>();
    // Storms created for the first time this pass — used for split detection below
    const freshThisPass = new Set<TrackedStorm>();
    for (const cell of detectStorms(allRecentStrikes, WINDOW_MS)) {
      const sample = sampleCell(cell.members);
      // A backlog flush can masquerade as a huge storm — never track those
      if (hasTimestampBurst(sample)) continue;

      // Derive the cell's country from whichever cc is most common in its members
      const ccCounts: Record<string, number> = {};
      for (const m of cell.members) if (m.cc) ccCounts[m.cc] = (ccCounts[m.cc] ?? 0) + 1;
      let cc = Object.entries(ccCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      // Velocity-capped match window: a storm can only move STORM_MAX_KMH km/h,
      // so shrink the search radius based on how long ago it was last seen.
      const matchWindow = (st: TrackedStorm) => {
        const elapsedHours = (nowMs - st.lastSeen) / 3_600_000;
        return Math.min(STORM_MATCH_KM, Math.max(STORM_MATCH_MIN_KM, elapsedHours * STORM_MAX_KMH));
      };

      // If no land strikes in this cluster, try to inherit cc from a nearby tracked
      // storm — this keeps offshore-drifting storms alive in the log.
      // If still no cc, track as 'XO' (open ocean) so large ocean storms are ranked.
      if (!cc) {
        let nearestSt: TrackedStorm | null = null;
        let nearestKm = Infinity;
        for (const st of trackedStorms) {
          const km = kmBetween(st.lat, st.lon, cell.lat, cell.lon);
          if (km < matchWindow(st) && km < nearestKm) { nearestKm = km; nearestSt = st; }
        }
        if (nearestSt) cc = nearestSt.cc;
        else cc = 'XO';
      }

      // Among all tracked storms within range, pick the biggest (by peak count)
      // so that when two storms converge into one cell, the smaller merges into
      // the bigger rather than the bigger being silently dropped.
      let best: TrackedStorm | null = null;
      for (const st of trackedStorms) {
        if (matched.has(st)) continue;
        const km = kmBetween(st.lat, st.lon, cell.lat, cell.lon);
        if (km > matchWindow(st)) continue;
        if (!best || st.peakCount > best.peakCount) best = st;
      }

      const city = cc === 'XO' ? 'Open Ocean' : (nearestCity(citiesFor(cc), cell.lat, cell.lon)?.name ?? null);
      const foot = footprintCenter(cell.members);
      if (best) {
        // Add every country present in this cluster (not just the dominant one).
        // A storm straddling SI/HR will have cc='SI' but HR strikes should still
        // appear in the path.
        for (const c of Object.keys(ccCounts)) {
          if (!best.countryCodes.includes(c)) best.countryCodes.push(c);
        }
        if (cc !== best.cc) best.cc = cc;
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
        best.currentRate = cell.rate;
        if (cell.count > best.peakCount) {
          best.peakCount = cell.count;
          best.peakRate = cell.rate;
        }
        accumulateStrikes(best, cell.members);
        matched.add(best);
      } else {
        const freshKey = `${cc}:${nowMs}:${stormSeq++}`;
        (globalThis as any)._stormSeq = stormSeq;
        const fresh: TrackedStorm = {
          key: freshKey,
          cc,
          originLat: cell.lat, originLon: cell.lon, originCity: city,
          startTime: nowMs,
          lat: cell.lat, lon: cell.lon, city,
          peakCount: cell.count, peakRate: cell.rate,
          traveledKm: 0,
          travelAnchor: { lat: foot.lat, lon: foot.lon }, posBuf: [],
          lastSeen: nowMs,
          currentRate: cell.rate,
          inDb: false,
          allStrikes: [], lastStrikeTime: 0, totalStrikes: 0,
          countryCodes: Object.keys(ccCounts),
          initialStrikesByAncestor: {},
          keepEvery: 1, appendSeq: 0, splitDetected: false, splitCandidateAt: null, fragmentLabel: null,
        };
        accumulateStrikes(fresh, cell.members);
        trackedStorms.push(fresh);
        matched.add(fresh);
        freshThisPass.add(fresh);
      }
    }

    // Consolidate tracker identities within TRACKER_MERGE_KM of each other.
    //
    // Two phases:
    // 1. Matched pairs: both identities were assigned live clusters this pass but
    //    are close enough to be the same system. Absorb the smaller into the bigger
    //    and remove the smaller from `matched` so it won't be written back to the DB.
    // 2. Unmatched strays: an old identity that didn't get a cluster this pass but
    //    is still within range of a matched winner — fold it in and delete from DB.
    // Returns the net-new strike count added to big (used by call sites to record
    // the merge event under the correct canonical key after any key adoption).
    function absorbInto(big: TrackedStorm, small: TrackedStorm): number {
      if (small.peakCount > big.peakCount) { big.peakCount = small.peakCount; big.peakRate = small.peakRate; }
      if (small.startTime < big.startTime) {
        big.startTime = small.startTime;
        big.originLat = small.originLat; big.originLon = small.originLon; big.originCity = small.originCity;
      }
      big.traveledKm = Math.max(big.traveledKm, small.traveledKm);

      // Per-ancestor overlap map lookup:
      // overlapInBig   = strikes big already counted from small's territory (normal re-merge)
      // overlapInSmall = strikes small already counted from big's territory (reverse re-merge)
      const overlapInBig   = small.initialStrikesByAncestor[big.key];
      const overlapInSmall = big.initialStrikesByAncestor[small.key];

      let netNew: number;
      if (overlapInBig !== undefined) {
        // Normal re-merge: small is a descendant of big.
        netNew = Math.max(0, small.totalStrikes - overlapInBig);
        // Merge small's other ancestor overlaps into big by adding (they represent
        // independent territory neither storm has fully reconciled yet).
        for (const [k, v] of Object.entries(small.initialStrikesByAncestor)) {
          if (k === big.key) continue;
          big.initialStrikesByAncestor[k] = (big.initialStrikesByAncestor[k] ?? 0) + v;
        }
        // Clean up any stale reverse-ancestry entry (small is being consumed).
        delete big.initialStrikesByAncestor[small.key];
      } else if (overlapInSmall !== undefined) {
        // Reverse re-merge: big is a descendant of small (child outgrew parent).
        netNew = Math.max(0, small.totalStrikes - overlapInSmall);
        // Remove the consumed parent entry and inherit small's ancestor overlaps
        // so any grandparent that later re-absorbs big gets the right correction.
        delete big.initialStrikesByAncestor[small.key];
        for (const [k, v] of Object.entries(small.initialStrikesByAncestor)) {
          big.initialStrikesByAncestor[k] = v;
        }
      } else {
        // No direct ancestry (independent, sibling, or third-party).
        netNew = small.totalStrikes;
        // Accumulate small's ancestor overlaps into big by adding so any shared
        // ancestor that re-absorbs big applies the combined correction.
        for (const [k, v] of Object.entries(small.initialStrikesByAncestor)) {
          big.initialStrikesByAncestor[k] = (big.initialStrikesByAncestor[k] ?? 0) + v;
        }
      }

      big.totalStrikes += netNew;
      for (const c of small.countryCodes) if (!big.countryCodes.includes(c)) big.countryCodes.push(c);
      for (const s of small.allStrikes) big.allStrikes.push(s);
      if (big.allStrikes.length > ALL_STRIKES_MAX) {
        big.keepEvery *= 2;
        big.allStrikes = big.allStrikes.filter((_, i) => i % 2 === 0);
      }
      return netNew;
    }

    // Phase 1: merge matched pairs — avoids the cycle where removing one matched
    // storm from memory causes its cluster to spawn a fresh identity next pass.
    {
      let anyMerged = true;
      while (anyMerged) {
        anyMerged = false;
        const matchedArr = Array.from(matched);
        outer: for (let i = 0; i < matchedArr.length; i++) {
          for (let j = i + 1; j < matchedArr.length; j++) {
            const a = matchedArr[i], b = matchedArr[j];
            if (kmBetween(a.lat, a.lon, b.lat, b.lon) >= TRACKER_MERGE_KM) continue;
            const big = a.peakCount >= b.peakCount ? a : b;
            const small = a.peakCount >= b.peakCount ? b : a;
            // Capture small's identity before absorption in case the event needs it.
            const smallKey1 = small.key, smallCity1 = small.city, smallCc1 = small.cc;
            const smallFragLabel1 = small.fragmentLabel;
            // Capture big's pre-adoption identity (city/cc won't change inside absorbInto,
            // but key may change below, so capture here for the event payload).
            const bigKey1 = big.key, bigCity1 = big.city, bigCc1 = big.cc;
            const bigFragLabel1 = big.fragmentLabel;
            const hadAncestor1 = small.key in big.initialStrikesByAncestor || big.key in small.initialStrikesByAncestor;
            const netNew1 = absorbInto(big, small);
            // Only record a count when ancestry is tracked — Branch 1/2 give a
            // reliable delta; Branch 3 would show small.totalStrikes (the full
            // lifetime count, not the genuine contribution since last absorption).
            const reportedNew1 = hadAncestor1 ? netNew1 : null;
            matched.delete(small);
            trackedStorms.splice(trackedStorms.indexOf(small), 1);
            // If the loser had a DB entry but the winner doesn't, adopt its key so
            // the TRACKING link survives the merge without a 404 gap.
            if (small.inDb && !big.inDb) {
              big.key = small.key;
              big.inDb = true;
              // Patch every storm whose ancestor map references big's old key.
              for (const st of trackedStorms) {
                if (bigKey1 in st.initialStrikesByAncestor) {
                  st.initialStrikesByAncestor[big.key] = st.initialStrikesByAncestor[bigKey1];
                  delete st.initialStrikesByAncestor[bigKey1];
                }
              }
              // small.key is now big's key — don't delete the DB row.
              // Record merge on the new canonical key; the "other" storm was big's old identity.
              try { recordStormEvent(big.key, 'merge', nowMs, bigKey1, bigCity1, bigCc1, reportedNew1, bigFragLabel1); } catch { /* non-fatal */ }
            } else {
              if (small.key) try { deleteStorm(small.key); } catch { /* non-fatal */ }
              // Patch any surviving storm that references the absorbed storm's key
              // in its ancestor map — it is now carried by big, so redirect to big.key.
              for (const st of trackedStorms) {
                if (smallKey1 in st.initialStrikesByAncestor) {
                  st.initialStrikesByAncestor[big.key] = st.initialStrikesByAncestor[smallKey1];
                  delete st.initialStrikesByAncestor[smallKey1];
                }
              }
              // big.key is already the canonical key.
              try { recordStormEvent(big.key, 'merge', nowMs, smallKey1, smallCity1, smallCc1, reportedNew1, smallFragLabel1); } catch { /* non-fatal */ }
            }
            anyMerged = true;
            break outer;
          }
        }
      }
    }

    // Phase 2: fold unmatched strays into nearby matched winners.
    for (const st of [...trackedStorms]) {
      if (matched.has(st) || nowMs - st.lastSeen > STORM_DROP_MS) continue;
      for (const m of matched) {
        if (kmBetween(st.lat, st.lon, m.lat, m.lon) >= TRACKER_MERGE_KM) continue;
        // Capture identities before absorption, same rationale as Phase 1.
        const stKey2 = st.key, stCity2 = st.city, stCc2 = st.cc;
        const stFragLabel2 = st.fragmentLabel;
        const mKey2 = m.key, mCity2 = m.city, mCc2 = m.cc;
        const mFragLabel2 = m.fragmentLabel;
        const hadAncestor2 = st.key in m.initialStrikesByAncestor || m.key in st.initialStrikesByAncestor;
        const netNew2 = absorbInto(m, st);
        const reportedNew2 = hadAncestor2 ? netNew2 : null;
        trackedStorms.splice(trackedStorms.indexOf(st), 1);
        // If the absorbed stray had a DB entry but the winner doesn't, adopt its key
        // so the existing TRACKING link continues to work without a 404 gap.
        if (st.inDb && !m.inDb) {
          m.key = st.key;
          m.inDb = true;
          // Patch ancestor maps that reference m's old key.
          for (const survivor of trackedStorms) {
            if (mKey2 in survivor.initialStrikesByAncestor) {
              survivor.initialStrikesByAncestor[m.key] = survivor.initialStrikesByAncestor[mKey2];
              delete survivor.initialStrikesByAncestor[mKey2];
            }
          }
          // st.key is now m's key — don't delete the DB row.
          // Record merge on the new canonical key; the "other" storm was m's old identity.
          try { recordStormEvent(m.key, 'merge', nowMs, mKey2, mCity2, mCc2, reportedNew2, mFragLabel2); } catch { /* non-fatal */ }
        } else {
          if (st.key) try { deleteStorm(st.key); } catch { /* non-fatal */ }
          // Patch surviving storms that referenced the absorbed stray's key.
          for (const survivor of trackedStorms) {
            if (stKey2 in survivor.initialStrikesByAncestor) {
              survivor.initialStrikesByAncestor[m.key] = survivor.initialStrikesByAncestor[stKey2];
              delete survivor.initialStrikesByAncestor[stKey2];
            }
          }
          // m.key is already the canonical key.
          try { recordStormEvent(m.key, 'merge', nowMs, stKey2, stCity2, stCc2, reportedNew2, stFragLabel2); } catch { /* non-fatal */ }
        }
        break;
      }
    }

    // Split detection — two-phase:
    // Phase A (candidate): mark a fresh storm that survives near an existing storm.
    //   Sets the ancestor overlap immediately (needed for absorbInto correctness)
    //   but does NOT fire the event yet.
    // Phase B (confirmation): after SPLIT_CONFIRM_MS the fragment must still be
    //   active and near a parent. Only then is the event recorded. This filters
    //   out transient blobs that immediately re-merge.
    const SPLIT_DETECT_KM = 75;
    const SPLIT_CONFIRM_MS = 5 * 60_000;

    for (const freshSt of freshThisPass) {
      if (!matched.has(freshSt) || freshSt.splitDetected || freshSt.splitCandidateAt != null) continue;
      let nearestParent: TrackedStorm | null = null;
      let nearestKm = Infinity;
      for (const st of matched) {
        if (st === freshSt || freshThisPass.has(st)) continue;
        const km = kmBetween(freshSt.lat, freshSt.lon, st.lat, st.lon);
        if (km < nearestKm && km < SPLIT_DETECT_KM) { nearestKm = km; nearestParent = st; }
      }
      if (nearestParent) {
        // Set ancestor overlap immediately so absorbInto can apply the correct
        // double-count correction if this fragment re-merges before confirmation.
        freshSt.initialStrikesByAncestor[nearestParent.key] = freshSt.totalStrikes;
        for (const [k, v] of Object.entries(nearestParent.initialStrikesByAncestor)) {
          freshSt.initialStrikesByAncestor[k] = Math.min(freshSt.totalStrikes, v);
        }
        freshSt.splitCandidateAt = nowMs;
      }
    }

    // Confirmation pass: fire the split event for candidates that have survived
    // long enough and are still active near a parent.
    for (const st of trackedStorms) {
      if (st.splitDetected || st.splitCandidateAt == null) continue;
      if (!matched.has(st)) continue;
      if (nowMs - st.splitCandidateAt < SPLIT_CONFIRM_MS) continue;
      let nearestParentC: TrackedStorm | null = null;
      let nearestKmC = Infinity;
      for (const other of matched) {
        if (other === st || freshThisPass.has(other)) continue;
        const km = kmBetween(st.lat, st.lon, other.lat, other.lon);
        if (km < nearestKmC && km < SPLIT_DETECT_KM) { nearestKmC = km; nearestParentC = other; }
      }
      if (!nearestParentC) {
        // Parent gone or diverged too far — cancel the candidate.
        st.splitCandidateAt = null;
        continue;
      }
      st.splitDetected = true;
      try {
        const splitCount = countSplitEvents(nearestParentC.key);
        const label = `F${splitCount + 1}`;
        st.fragmentLabel = label;
        recordStormEvent(nearestParentC.key, 'split', nowMs, st.key, st.city, st.cc, null, label);
      } catch { /* non-fatal */ }
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
        countryPath: st.countryCodes.length > 1 ? st.countryCodes : null,
      });
    }
    upsertBiggestStorms(records);
    upsertStormRecords(records);
    const loggable = records.filter(r => (r.totalCount ?? r.count) >= STORM_LOG_MIN_STRIKES);
    upsertStorms(loggable);
    // Mark in-memory storms as persisted so the next broadcast can link to their pages
    const loggedKeys = new Set(loggable.map(r => r.stormKey).filter(Boolean));
    for (const st of trackedStorms) { if (loggedKeys.has(st.key)) st.inDb = true; }

    // Expire storms that fell below the threshold for several passes
    let i = trackedStorms.length;
    while (i--) {
      if (nowMs - trackedStorms[i].lastSeen > STORM_DROP_MS) trackedStorms.splice(i, 1);
    }

    // Persist in-flight storm state so a server restart doesn't wipe live storms
    saveTrackedStorms(trackedStorms);
    // NOTE: consolidateNearbyStorms is NOT called here. It runs once at startup
    // (setImmediate) to clean up leftover DB rows from previous server runs.
    // Calling it periodically causes a race: it merges the freshly-upserted
    // current storm key into an older DB row with a higher count, deleting the
    // current key and permanently preventing the storm from getting TRACKING.
    // In-memory Phase 1/2 merges already handle per-pass deduplication.

    // Push authoritative storm summaries to all SSE clients so map rank labels
    // use server-tracked positions and lifetime totals — no client-side matching needed.
    const activeStorms = dedupeActiveStorms(trackedStorms, nowMs);
    if (activeStorms.length > 0) {
      broadcastSSE(`event: storms\ndata: ${JSON.stringify(activeStorms.map((st, i) => ({
        key: st.key, lat: st.lat, lon: st.lon, totalStrikes: st.totalStrikes,
        cc: st.cc, rate: st.currentRate ?? 0, rank: i + 1,
        hasPage: st.inDb === true,
      })))}\n\n`);
    }
  } catch (err) { console.error('[db] flush failed:', err); }
}, 30_000);

(globalThis as any)._iv_gridBatch = setInterval(() => {
  if (pendingGridStrikes.length === 0) return;
  const batch = pendingGridStrikes.splice(0);
  try { archiveGridStrikeBatch(batch); } catch (err) { console.error('[db] grid batch failed:', err); }
}, 5_000);

(globalThis as any)._iv_hourly = setInterval(() => {
  try {
    pruneGridStrikes();
    pruneStormStrikes();
    pruneStormEvents();
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
      // Cap history payload to the most-recent 10 k strikes (≈ 2 min at peak
      // global rate) — the full 40 k buffer is ~2 MB of JSON and makes the
      // initial page load noticeably slow for no visible benefit (dots that
      // are >2 min old are nearly transparent anyway).
      const historySlice = recentStrikes.length > 10_000 ? recentStrikes.slice(-10_000) : recentStrikes;
      ctrl.enqueue(enc.encode(
        `event: history\ndata: ${JSON.stringify(historySlice)}\n\n`
      ));
      // Send current tracked storms immediately so rank labels appear without waiting 30 s.
      // Re-validate inDb from the DB first: startup consolidation (setImmediate) may have
      // deleted keys that were marked inDb=true at module load time.
      try {
        const freshKeys = getTrackedStormKeys();
        for (const st of trackedStorms) {
          if (st.inDb && !freshKeys.has(st.key)) st.inDb = false;
        }
      } catch { /* non-fatal */ }
      const connectNow = Date.now();
      const connectStorms = dedupeActiveStorms(trackedStorms, connectNow);
      if (connectStorms.length > 0) {
        ctrl.enqueue(enc.encode(`event: storms\ndata: ${JSON.stringify(connectStorms.map((st, i) => ({
          key: st.key, lat: st.lat, lon: st.lon, totalStrikes: st.totalStrikes,
          cc: st.cc, rate: st.currentRate ?? 0, rank: i + 1,
          hasPage: st.inDb === true,
        })))}\n\n`));
      }
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
