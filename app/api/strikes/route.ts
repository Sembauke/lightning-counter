import fs from 'fs';
import path from 'path';
import { getCountryCode } from '../../lib/geoCountry';
import { loadCounters, saveCounters, loadDailyStrikes, saveDailyAndPeaks, archiveGridStrikeBatch, upsertCountryPeakRates, pruneGridStrikes, upsertBiggestStorms, upsertStormRecords, upsertStorms, pruneStormStrikes, pruneStormEvents, saveTrackedStorms, loadTrackedStorms, hasTimestampBurst, hasMissingCountryPaths, enrichStormCountryPaths, reconcileCountryPaths, backfillGappedStormTails, deleteStorm, getTrackedStormKeys, getStormByKey, recordStormAlias, recordStormEvent, countSplitEvents, type BiggestStorm, type StormStrike } from '../../lib/db';
import { dispatchStrike as dispatchToStormSubscribers, publishStormOwnership } from '../../lib/strikeStream';
import { nearestCity, MIN_STORM_RATE, type CityTuple, type StrikePoint } from '../../lib/stormClusters';
import { detectStormFootprints } from '../../lib/stormFootprint';
import { combineStormLifecycle, lifecycleStrikeId, reconcileStormLifecycle, stormLifecycleSummaries, type StormLifecycleState } from '../../lib/stormLifecycle';
import { collectReplayTails, rememberReplayAnchors, type ReplayTailStorm } from '../../lib/stormReplayTail';
import { updateStormReplay } from '../../lib/db';
import { compactStormCounting, emptyStormCounting, mergeStormCounting, remapStormCountingKeys, rememberCountedStrike, sharedStormStrikeCount, type StormCountingState } from '../../lib/stormCounting';
import { restoreStormCounting } from '../../lib/stormCountingMigration';

// Merge events without a known relationship retain a null contribution: old
// sampled snapshots cannot prove their historical overlap. Modern overlap
// arithmetic is tracked independently of replay sampling and relationship labels.

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
// Cover the ten-minute physical footprint as well as five-minute rates at
// peak global rates (~100/s). Older map visuals use the DB archive.
const MAX_HISTORY = 100_000;
const HISTORY_LIFETIME_MS = 10 * 60 * 1000;

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
interface TrackedStorm extends ReplayTailStorm {
  lifecycle?: StormLifecycleState;
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
  // A small, fixed-size, never-thinned sample of this storm's true earliest
  // strikes (its own — adopted from an ancestor's if that ancestor's origin
  // turns out to be earlier, see absorbInto). Guards against allStrikes'
  // uniform-halving thinning erasing all evidence of where a long-lived
  // storm actually began.
  originSample: StormStrike[];
  lastStrikeTime: number;
  totalStrikes: number;
  counting?: StormCountingState;
  // Ordered list of every country code the storm has passed through
  countryCodes: string[];
  // Birth/merge relationship metadata, also read when migrating old snapshots.
  // New overlap arithmetic uses counting provenance, never inferred ancestry.
  initialStrikesByAncestor: Record<string, number>;
  // allStrikes thinning: once allStrikes exceeds ALL_STRIKES_MAX, keepEvery
  // doubles and the array is halved so memory stays bounded for long storms.
  keepEvery: number;
  appendSeq: number;
  // Legacy persisted fragment marker; authoritative pending state is lifecycle.
  splitDetected: boolean;
  // Kept when loading older snapshots; no longer used to confirm transitions.
  splitCandidateAt: number | null;
  // Human-readable label assigned when split detection fires (e.g. "F1", "F2").
  // Null for storms that formed independently. Carried through merges so that
  // absorbing a known fragment can surface the label in the event log.
  fragmentLabel: string | null;
}
// Keep a storm available for matching for 1 hour after it drops below the
// detection threshold. A still-arriving replay tail is retained separately.
// Beyond that, a re-appearing cell in the same area is a new storm, not a
// continuation — the 6-hour window was causing unrelated evening storms to
// inherit morning storm identities, inflating counts and durations.
const STORM_DROP_MS = 1 * 60 * 60 * 1000;
// No storm system moves faster than this — lifetime cap on distance traveled
const STORM_MAX_KMH = 120;
// A storm enters the storm log only once it has accumulated this many total strikes;
// biggest-storm and record tables are exempt — they're superlatives, not a log
const STORM_LOG_MIN_STRIKES = 5000;
// allStrikes is thinned by uniformly halving the whole array every time it
// grows past ALL_STRIKES_MAX. Over a multi-day storm that runs through many
// halvings, points near the front (its origin — often the country_path's
// first entries, e.g. where it first crossed the detection threshold) have
// survived every halving since they were added, while recently-appended
// points have survived few or none — an exponential bias against the
// oldest history. That let country_path list countries the storm passed
// through hours or days ago while every strike from that leg had been
// thinned out of the replay entirely. originSample is a small, fixed,
// never-thinned reservoir of a storm's true earliest strikes so the replay
// always has some evidence for the start of its journey, however long it lives.
const ORIGIN_SAMPLE_MAX = 200;
const trackedStorms: TrackedStorm[] = (() => {
  try {
    const saved = loadTrackedStorms() as TrackedStorm[];
    const cutoff = Date.now() - STORM_DROP_MS;
    const loaded = saved.filter(st => Math.max(st.lastSeen, st.lastReplayTime ?? 0) > cutoff && st.key && st.cc && typeof st.lat === 'number');
    // Mark storms that are already in the DB so the map can link them immediately
    const dbKeys = getTrackedStormKeys();
    // Keep the real detection timestamp: nudging it forward would turn a fading
    // replay back into an officially active storm on every restart.
    for (const st of loaded) {
      st.inDb = dbKeys.has(st.key);
      st.initialStrikesByAncestor = st.initialStrikesByAncestor ?? {};
      st.originSample = st.originSample ?? [];
      st.keepEvery = st.keepEvery ?? 1;
      st.appendSeq = st.appendSeq ?? (st.allStrikes?.length ?? 0);
      st.splitDetected = st.splitDetected ?? false;
      st.splitCandidateAt = st.splitCandidateAt ?? null;
      st.fragmentLabel = st.fragmentLabel ?? null;
      // If allStrikes is missing or unusually short (e.g. lost on prev restart),
      // seed from the DB strikes blob which has the full historical coverage.
      if (st.inDb && (!st.allStrikes || st.allStrikes.length < 100)) {
        try {
          const dbStorm = getStormByKey(st.key);
          if (dbStorm?.strikes && dbStorm.strikes.length > (st.allStrikes?.length ?? 0)) {
            st.allStrikes = dbStorm.strikes;
            // Replay-only fading points may be newer than the official count
            // watermark. Reloading them must not suppress counts on revival.
            if (!Number.isFinite(st.lastStrikeTime)) {
              st.lastStrikeTime = Math.min(st.lastSeen, Math.max(...dbStorm.strikes.map(s => s[2])));
            }
            // The persisted blob is the closest available proxy for the storm's
            // true beginning after a cold restart wiped the in-memory reservoir —
            // seed it from the earliest points (sorted, since a merge can have
            // appended out of order) rather than starting a fresh reservoir now.
            if (st.originSample.length === 0) {
              st.originSample = [...dbStorm.strikes].sort((a, b) => a[2] - b[2]).slice(0, ORIGIN_SAMPLE_MAX);
            }
          }
        } catch { /* non-fatal */ }
      }
    }
    restoreStormCounting(loaded, Date.now());
    compactStormCounting(loaded, Date.now());
    return loaded;
  } catch { return []; }
})();
// A short restart must not turn a joined footprint into a new identity merely
// because the ingestion buffer has only collected a few seconds of lightning.
// Restore recent observation ownership without ingesting/counting it again.
{
  const now = Date.now();
  const restored = new Map(recentStrikes.map(p => [lifecycleStrikeId(p), p]));
  for (const st of trackedStorms) {
    const points: StrikePoint[] = st.lifecycle?.members ?? st.replayAnchors?.map(([lat, lon, time]) => ({ lat, lon, time })) ?? [];
    for (const p of points) {
      if (p.time <= now && p.time > now - HISTORY_LIFETIME_MS) {
        const id = lifecycleStrikeId(p);
        // Explicit null is ocean. Legacy anchors without metadata need their
        // own location lookup; a coastal storm's country is not a safe proxy.
        if (!restored.has(id)) {
          let cc = p.cc;
          if (cc === undefined) {
            try { cc = getCountryCode(p.lat, p.lon); } catch { cc = null; }
          }
          restored.set(id, { ...p, cc });
        }
      }
    }
  }
  const points = [...restored.values()].sort((a, b) => a.time - b.time).slice(-MAX_HISTORY);
  recentStrikes.length = 0;
  for (const point of points) recentStrikes.push(point);
}
publishStormOwnership(trackedStorms, Date.now());
// Startup tasks run async so they don't delay the first SSE response.
// inDb flags are re-validated in the connect-time handler (below) instead.
setImmediate(() => {
  try { if (hasMissingCountryPaths()) enrichStormCountryPaths(getCountryCode); } catch { /* non-fatal */ }
  try { reconcileCountryPaths(getCountryCode); } catch { /* non-fatal */ }
  // Self-limiting (only storms with an end_time inside grid_strikes' 3-day
  // retention are even considered), so safe to attempt on every startup —
  // a storm already fully reconstructed, or whose window has since aged out
  // of the archive, is just a no-op.
  try {
    const backfilled = backfillGappedStormTails();
    if (backfilled.length > 0) {
      console.log(`[db] storm tail backfill: ${backfilled.length} storm(s) attempted — ${JSON.stringify(backfilled)}`);
    }
  } catch (err) { console.error('[db] storm tail backfill failed:', err); }
  // Nearby identities are reconciled only by observed, timed transitions.
  // Restart cleanup must never silently merge pending or confirmed storms.
});
// Travel stride: passes per measurement, and the displacement band that counts
// as real drift (≥3 km ≈ 36 km/h sustained; >20 km ≈ re-merge, not motion)
const TRAVEL_STRIDE_PASSES = 10;
const TRAVEL_MIN_KM = 3;
const TRAVEL_MAX_KM = 20;

function meanPos(points: Array<{ lat: number; lon: number }>): { lat: number; lon: number } {
  let lat = 0, sinLon = 0, cosLon = 0;
  for (const p of points) {
    lat += p.lat;
    sinLon += Math.sin(p.lon * Math.PI / 180);
    cosLon += Math.cos(p.lon * Math.PI / 180);
  }
  return { lat: lat / points.length, lon: Math.atan2(sinLon, cosLon) * 180 / Math.PI };
}
const STRIKE_SAMPLE_MAX = 4000;
const ALL_STRIKES_MAX = 24_000;
// Persisted on globalThis so hot-reloads in dev don't reset it and create
// duplicate in-memory identities for the same physical storm.
let stormSeq: number = (globalThis as any)._stormSeq ?? 0;

function kmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (aLat - bLat) * 111.32;
  const dLon = ((aLon - bLon + 540) % 360 - 180) * 111.32 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

function roundPt(m: { lat: number; lon: number; time: number }): StormStrike {
  return [Math.round(m.lat * 1000) / 1000, Math.round(m.lon * 1000) / 1000, m.time];
}

function footprintCenter(members: Array<{ lat: number; lon: number }>): { lat: number; lon: number } {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  const anchorLon = members[0]?.lon ?? 0;
  for (const m of members) {
    if (m.lat < minLat) minLat = m.lat;
    if (m.lat > maxLat) maxLat = m.lat;
    const lon = anchorLon + ((m.lon - anchorLon + 540) % 360 - 180);
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { lat: (minLat + maxLat) / 2, lon: (((minLon + maxLon) / 2 + 540) % 360) - 180 };
}

function sampleCell(members: Array<{ lat: number; lon: number; time: number }>): StormStrike[] {
  const step = Math.max(1, Math.ceil(members.length / STRIKE_SAMPLE_MAX));
  const sample: StormStrike[] = [];
  for (let i = 0; i < members.length; i += step) sample.push(roundPt(members[i]));
  return sample;
}

/** Combines the permanent origin reservoir with the (possibly thinned) recent
 *  sample for persistence, without duplicating points present in both. */
function withOriginSample(origin: StormStrike[], recent: StormStrike[]): StormStrike[] {
  if (origin.length === 0) return recent;
  const seen = new Set(recent.map(s => `${s[0]},${s[1]},${s[2]}`));
  const extra = origin.filter(s => !seen.has(`${s[0]},${s[1]},${s[2]}`));
  return extra.length ? [...extra, ...recent] : recent;
}

/** Append a pass's new strikes to the storm's full-life accumulation */
function accumulateStrikes(st: TrackedStorm, members: Array<{ lat: number; lon: number; time: number }>): void {
  let newest = st.lastStrikeTime;
  let newestMember: { lat: number; lon: number; time: number } | null = null;
  // A re-strengthening cell can qualify points already saved in its quiet
  // replay tail. Count them once officially, but keep one replay copy.
  const saved = new Set(st.allStrikes.map(s => `${s[0]},${s[1]},${s[2]}`));
  for (const m of members) {
    if (m.time <= st.lastStrikeTime) continue;
    st.totalStrikes++;
    rememberCountedStrike(st, m);
    const p = roundPt(m);
    const id = `${p[0]},${p[1]},${p[2]}`;
    if (st.appendSeq++ % st.keepEvery === 0 && !saved.has(id)) {
      st.allStrikes.push(p);
      saved.add(id);
    }
    if (st.originSample.length < ORIGIN_SAMPLE_MAX) st.originSample.push(roundPt(m));
    if (m.time > newest) { newest = m.time; newestMember = m; }
  }
  st.lastStrikeTime = newest;
  if (st.allStrikes.length > ALL_STRIKES_MAX) {
    st.keepEvery *= 2;
    st.allStrikes = st.allStrikes.filter((_, i) => i % 2 === 0);
  }
  // Sub-sampling (keepEvery) can skip the pass's genuinely newest strike, and for
  // a long-lived storm keepEvery grows large — leaving the replay's tail stuck up
  // to tens of minutes behind the storm's real last-seen moment ("ends abruptly").
  // Guarantee it's always represented (pushed last, after thinning, so the halving
  // filter above can never be the thing that drops it) — bounds that lag to a
  // single pass (~30s) instead of however large keepEvery has grown.
  if (newestMember) {
    const p = roundPt(newestMember);
    if (!st.allStrikes.some(s => s[0] === p[0] && s[1] === p[1] && s[2] === p[2])) st.allStrikes.push(p);
  }
  rememberReplayAnchors(st, members.map(roundPt), Date.now());
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

    // Page availability can change independently of the current observation.
    try {
      const liveDbKeys = getTrackedStormKeys();
      for (const st of trackedStorms) {
        if (st.inDb && !liveDbKeys.has(st.key)) st.inDb = false;
      }
    } catch { /* non-fatal */ }

    // Physical footprint connectivity and identity ownership are resolved before
    // any official count, record, label or merge event can change.
    const allRecentStrikes = recentStrikes.filter(s => s.time > cutoff5m);
    const observations = detectStormFootprints(recentStrikes, nowMs)
      .filter(cell => !hasTimestampBurst(sampleCell(cell.activeMembers)));
    const matched = new Set<TrackedStorm>();
    const reserved = new Set(observations.filter(cell => cell.activeMembers.length >= MIN_STORM_RATE * WINDOW_MS / 60_000).flatMap(cell => cell.activeMembers));
    for (const st of trackedStorms) st.currentRate = 0;
    function memberLocation(members: StrikePoint[], parent?: TrackedStorm) {
      const ccCounts: Record<string, number> = {};
      for (const m of members) if (m.cc) ccCounts[m.cc] = (ccCounts[m.cc] ?? 0) + 1;
      const cc = Object.entries(ccCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? parent?.cc ?? 'XO';
      const { lat, lon } = meanPos(members);
      const city = cc === 'XO' ? 'Open Ocean' : (nearestCity(citiesFor(cc), lat, lon)?.name ?? null);
      return { ccCounts, cc, lat, lon, city };
    }
    const plan = reconcileStormLifecycle(trackedStorms, observations, nowMs, (members, parent) => {
      const { ccCounts, cc, lat, lon, city } = memberLocation(members, parent);
      const freshKey = `${cc}:${nowMs}:${stormSeq++}`;
      (globalThis as any)._stormSeq = stormSeq;
      return {
        key: freshKey, cc, originLat: lat, originLon: lon, originCity: city,
        startTime: nowMs, lat, lon, city, peakCount: 0, peakRate: 0,
        traveledKm: 0, travelAnchor: footprintCenter(members), posBuf: [],
        lastSeen: nowMs, currentRate: 0, inDb: false,
        allStrikes: [], originSample: [], lastStrikeTime: 0, totalStrikes: 0,
        counting: emptyStormCounting(),
        countryCodes: Object.keys(ccCounts), initialStrikesByAncestor: {},
        keepEvery: 1, appendSeq: 0, splitDetected: !!parent, splitCandidateAt: null, fragmentLabel: null,
      } satisfies TrackedStorm;
    });
    for (const [st, members] of plan.assignments) {
      const { ccCounts, cc, lat, lon, city } = memberLocation(members, st);
      for (const code of Object.keys(ccCounts)) if (!st.countryCodes.includes(code)) st.countryCodes.push(code);
      st.cc = cc;
      st.posBuf.push(footprintCenter(members));
      if (st.posBuf.length >= TRAVEL_STRIDE_PASSES) {
        const cur = meanPos(st.posBuf.slice(-3));
        if (st.travelAnchor) {
          const hop = kmBetween(st.travelAnchor.lat, st.travelAnchor.lon, cur.lat, cur.lon);
          if (hop >= TRAVEL_MIN_KM && hop <= TRAVEL_MAX_KM) st.traveledKm += hop;
        }
        st.travelAnchor = cur;
        st.posBuf = [];
      }
      st.lat = lat; st.lon = lon; st.city = city;
      st.lastSeen = nowMs;
      st.currentRate = members.length / 5;
      if (members.length > st.peakCount) { st.peakCount = members.length; st.peakRate = st.currentRate; }
      // One call per owner is essential: split branches share one time watermark.
      accumulateStrikes(st, members);
      matched.add(st);
      for (const p of members) reserved.add(p);
    }
    for (const { parent, child } of plan.splits) {
      // Historical replay stays intact, but fading-tail competition must use
      // each confirmed branch's current footprint rather than the old union.
      const retained = new Set(parent.lifecycle!.members.map(lifecycleStrikeId));
      parent.replayAnchors = parent.replayAnchors?.filter(([lat, lon, time]) => retained.has(lifecycleStrikeId({ lat, lon, time })));
      rememberReplayAnchors(child, child.lifecycle!.members.map(roundPt), nowMs);
      child.initialStrikesByAncestor[parent.key] = sharedStormStrikeCount(parent, child);
      for (const other of trackedStorms) {
        if (other === parent || other === child) continue;
        const shared = sharedStormStrikeCount(other, child);
        if (shared > 0) child.initialStrikesByAncestor[other.key] = shared;
      }
      try {
        const label = `F${countSplitEvents(parent.key) + 1}`;
        child.fragmentLabel = label;
        recordStormEvent(parent.key, 'split', nowMs, child.key, child.city, child.cc, null, label);
      } catch { /* non-fatal */ }
    }

    // Confirmation keeps the existing ancestry-aware accumulation and canonical
    // key adoption, while all pending observations remain separate above.
    function absorbInto(big: TrackedStorm, small: TrackedStorm): number {
      if (small.peakCount > big.peakCount) { big.peakCount = small.peakCount; big.peakRate = small.peakRate; }
      if (small.startTime < big.startTime) {
        big.startTime = small.startTime;
        big.originLat = small.originLat; big.originLon = small.originLon; big.originCity = small.originCity;
        // small is the true earlier origin — its own reservoir already captured
        // its true beginning, so adopt it in place of big's (which no longer
        // reflects the storm's actual start once big's origin fields are overwritten above).
        big.originSample = small.originSample;
      }
      big.traveledKm = Math.max(big.traveledKm, small.traveledKm);

      const netNew = mergeStormCounting(big, small);
      Object.assign(big.initialStrikesByAncestor, small.initialStrikesByAncestor);
      delete big.initialStrikesByAncestor[big.key];
      delete big.initialStrikesByAncestor[small.key];
      rememberReplayAnchors(big, small.replayAnchors ?? small.allStrikes, nowMs);
      for (const c of small.countryCodes) if (!big.countryCodes.includes(c)) big.countryCodes.push(c);
      // small.allStrikes can overlap big.allStrikes — e.g. a fragment that split
      // off and later re-merges carries strikes big already recorded before the
      // split, or the flapping split/merge cycle re-adds the same points on every
      // cycle. totalStrikes is already overlap-corrected above (netNew); the
      // stored replay blob needs the same dedup or it silently accumulates
      // repeated [lat,lon,time] points across a storm's lifetime.
      const bigStrikeKeys = new Set(big.allStrikes.map(s => `${s[0]},${s[1]},${s[2]}`));
      for (const s of small.allStrikes) {
        const key = `${s[0]},${s[1]},${s[2]}`;
        if (bigStrikeKeys.has(key)) continue;
        bigStrikeKeys.add(key);
        big.allStrikes.push(s);
      }
      if (big.allStrikes.length > ALL_STRIKES_MAX) {
        big.keepEvery *= 2;
        big.allStrikes = big.allStrikes.filter((_, i) => i % 2 === 0);
      }
      return netNew;
    }

    for (const { winner: big, losers, outline } of plan.merges) {
      const whole = [big, ...losers].flatMap(st => plan.assignments.get(st) ?? []);
      combineStormLifecycle(big, losers, nowMs, outline);
      for (const small of losers) {
        const oldBigKey = big.key, oldSmallKey = small.key;
        const adopted = small.inDb && !big.inDb;
        const related = adopted ? big : small;
        const eventIdentity = { key: related.key, city: related.city, cc: related.cc, fragment: related.fragmentLabel };
        const hadAncestor = small.key in big.initialStrikesByAncestor || big.key in small.initialStrikesByAncestor;
        const netNew = absorbInto(big, small);
        matched.delete(small);
        trackedStorms.splice(trackedStorms.indexOf(small), 1);
        if (adopted) { big.key = small.key; big.inDb = true; }
        remapStormCountingKeys(trackedStorms, adopted ? oldBigKey : oldSmallKey, big.key);
        // Bookmark redirects and event/record ownership change only at confirmation.
        recordStormAlias(adopted ? oldBigKey : oldSmallKey, big.key);
        if (!adopted) try { deleteStorm(small.key); } catch { /* non-fatal */ }
        for (const survivor of trackedStorms) {
          const replaced = adopted ? oldBigKey : oldSmallKey;
          if (replaced in survivor.initialStrikesByAncestor) {
            survivor.initialStrikesByAncestor[big.key] = survivor.initialStrikesByAncestor[replaced];
            delete survivor.initialStrikesByAncestor[replaced];
          }
          if (survivor !== big) {
            const shared = sharedStormStrikeCount(big, survivor);
            if (shared > 0 || survivor.key in big.initialStrikesByAncestor) big.initialStrikesByAncestor[survivor.key] = shared;
            if (shared > 0 || big.key in survivor.initialStrikesByAncestor) survivor.initialStrikesByAncestor[big.key] = shared;
          }
        }
        try { recordStormEvent(big.key, 'merge', nowMs, eventIdentity.key, eventIdentity.city, eventIdentity.cc, hadAncestor ? netNew : null, eventIdentity.fragment); } catch { /* non-fatal */ }
      }
      if (whole.length) {
        const location = memberLocation(whole, big);
        big.lat = location.lat; big.lon = location.lon; big.city = location.city; big.cc = location.cc;
        big.currentRate = whole.length / 5;
        if (whole.length > big.peakCount) { big.peakCount = whole.length; big.peakRate = big.currentRate; }
      }
    }

    collectReplayTails(trackedStorms, allRecentStrikes, reserved, matched, nowMs);

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
        strikes: withOriginSample(st.originSample, st.allStrikes),
        countryPath: st.countryCodes.length > 1 ? st.countryCodes : null,
      });
    }
    upsertBiggestStorms(records);
    upsertStormRecords(records);
    const loggable = records.filter(r => (r.totalCount ?? r.count) >= STORM_LOG_MIN_STRIKES);
    upsertStorms(loggable);
    // Fading lightning updates existing replay copies only: it cannot extend
    // the official duration, alter rankings, or create a new storm record.
    for (const st of trackedStorms) {
      if (!st.replayDirty) continue;
      updateStormReplay(st.key, withOriginSample(st.originSample, st.allStrikes));
      st.replayDirty = false;
    }
    // Mark in-memory storms as persisted so the next broadcast can link to their pages
    const loggedKeys = new Set(loggable.map(r => r.stormKey).filter(Boolean));
    for (const st of trackedStorms) { if (loggedKeys.has(st.key)) st.inDb = true; }

    // Retain a fading replay as long as its own lightning continues arriving.
    let i = trackedStorms.length;
    while (i--) {
      const st = trackedStorms[i];
      if (nowMs - Math.max(st.lastSeen, st.lastReplayTime ?? 0) > STORM_DROP_MS) trackedStorms.splice(i, 1);
    }

    // Persist in-flight storm state so a server restart doesn't wipe live storms
    compactStormCounting(trackedStorms, nowMs);
    saveTrackedStorms(trackedStorms);
    publishStormOwnership(trackedStorms, nowMs);
    // Both initial and periodic clients receive the same authoritative state.
    broadcastSSE(`event: storms\ndata: ${JSON.stringify(stormLifecycleSummaries(trackedStorms, nowMs))}\n\n`);
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
      // Re-validate page availability before publishing the initial state.
      try {
        const freshKeys = getTrackedStormKeys();
        for (const st of trackedStorms) {
          if (st.inDb && !freshKeys.has(st.key)) st.inDb = false;
        }
      } catch { /* non-fatal */ }
      const connectNow = Date.now();
      const connectStorms = stormLifecycleSummaries(trackedStorms, connectNow);
      ctrl.enqueue(enc.encode(`event: storms\ndata: ${JSON.stringify(connectStorms)}\n\n`));
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
