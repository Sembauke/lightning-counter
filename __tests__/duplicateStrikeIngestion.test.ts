/**
 * Reproduces and fixes a real production bug found on storm ES:1787269369744:3468
 * (975,729 reported total strikes — far beyond any other tracked storm, with the
 * persisted strike blob containing the same [lat,lon,time] triple duplicated up
 * to 24 times).
 *
 * Root cause #1 (server.mjs): lightningmaps does not give each stroke a stable
 * identity. Probing live.lightningmaps.org directly showed every stroke is sent
 * twice per connection, back-to-back, under two different sequential `id`s — and
 * connecting to both live/live2 mirrors doubles that again. The old dedup key
 * `${id}-${src}` never collides for any of these repeat deliveries, so every
 * physical strike was being counted 2-4x at the point it entered `recentStrikes`.
 *
 * Root cause #2 (app/api/strikes/route.ts absorbInto): totalStrikes (the numeric
 * counter) is protected from double-counting across split/merge cycles via the
 * ancestor-overlap map, but the persisted `allStrikes` replay blob was naively
 * concatenated on every merge with no equivalent correction — so a storm that
 * flaps (split → merge → split → merge) across a multi-day life accumulates
 * literal duplicate points in its stored blob on every re-merge, compounding
 * root cause #1's damage well beyond the base 2-4x.
 *
 * These tests mirror the fixed logic in isolation (server.mjs is a plain Node
 * script run directly by `node server.mjs`, not through the TS/vitest pipeline,
 * so its dedup function is mirrored here the same way stormEvents.test.ts
 * mirrors route.ts's absorbInto).
 */
import { describe, it, expect } from 'vitest';
import { detectStorms, type StrikePoint } from '../app/lib/stormClusters';

// ── Mirrors of server.mjs's WS-level dedup ──────────────────────────────────

/** The old, buggy dedup key — mirrors server.mjs before the fix. */
function isWsDuplicateOld(seen: Set<string>, id: number, src: number): boolean {
  const key = `${id}-${src}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

/** The fixed dedup key — mirrors server.mjs's isWsDuplicate after the fix. */
function isWsDuplicateFixed(seen: Set<string>, lat: number, lon: number, time: number): boolean {
  const key = `${lat},${lon},${time}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

interface RawStroke { lat: number; lon: number; time: number; id: number; src: number }

/** Simulates lightningmaps re-sending the same physical stroke under fresh ids. */
function withWsDuplication(strikes: Array<{ lat: number; lon: number; time: number }>, copiesPerStrike: number): RawStroke[] {
  const out: RawStroke[] = [];
  let nextId = 1;
  for (const s of strikes) {
    for (let i = 0; i < copiesPerStrike; i++) {
      out.push({ lat: s.lat, lon: s.lon, time: s.time, id: nextId++, src: 2 });
    }
  }
  return out;
}

describe('WS ingestion dedup — id/src vs content key', () => {
  it('old id/src key does not catch a repeat delivery of the same physical strike (reproduces the bug)', () => {
    const seen = new Set<string>();
    const stroke = { lat: 44.859, lon: 16.675, time: 1787335378032 };
    // lightningmaps resends the same stroke under a new id — the id/src key can't tell
    const firstIsDupe = isWsDuplicateOld(seen, 101, 2);
    const secondIsDupe = isWsDuplicateOld(seen, 102, 2); // different id, same physical strike
    expect(firstIsDupe).toBe(false);
    expect(secondIsDupe).toBe(false); // BUG: should be true, both are the same strike
    void stroke;
  });

  it('content key correctly catches the same repeat delivery', () => {
    const seen = new Set<string>();
    const first = isWsDuplicateFixed(seen, 44.859, 16.675, 1787335378032);
    const second = isWsDuplicateFixed(seen, 44.859, 16.675, 1787335378032);
    expect(first).toBe(false);
    expect(second).toBe(true); // FIXED: caught regardless of id
  });

  it('content key does not falsely collide on two genuinely distinct strikes', () => {
    const seen = new Set<string>();
    expect(isWsDuplicateFixed(seen, 44.859, 16.675, 1787335378032)).toBe(false);
    expect(isWsDuplicateFixed(seen, 44.860, 16.675, 1787335378032)).toBe(false); // different lat
    expect(isWsDuplicateFixed(seen, 44.859, 16.675, 1787335378099)).toBe(false); // different time
  });

  it('filters a realistic 3x-duplicated feed (single connection double-send + a mirror connection) down to the true unique count', () => {
    const strikes = Array.from({ length: 200 }, (_, i) => ({
      lat: 44.8 + i * 0.001, lon: 16.7 + i * 0.001, time: 1_000_000 + i * 100,
    }));
    const raw = withWsDuplication(strikes, 3);
    expect(raw.length).toBe(600);

    const seenOld = new Set<string>();
    const survivedOld = raw.filter(s => !isWsDuplicateOld(seenOld, s.id, s.src));
    expect(survivedOld.length).toBe(600); // every id is unique → old key catches nothing

    const seenFixed = new Set<string>();
    const survivedFixed = raw.filter(s => !isWsDuplicateFixed(seenFixed, s.lat, s.lon, s.time));
    expect(survivedFixed.length).toBe(200); // exactly the true unique count
  });
});

// ── End-to-end: duplicated WS feed through the real storm-detection pipeline ─

/** Mirrors route.ts's accumulateStrikes (time-gated append, no thinning). */
function accumulateStrikes(
  storm: { totalStrikes: number; allStrikes: [number, number, number][]; lastStrikeTime: number },
  members: StrikePoint[],
): void {
  let newest = storm.lastStrikeTime;
  for (const m of members) {
    if (m.time <= storm.lastStrikeTime) continue;
    storm.totalStrikes++;
    storm.allStrikes.push([m.lat, m.lon, m.time]);
    if (m.time > newest) newest = m.time;
  }
  storm.lastStrikeTime = newest;
}

describe('end-to-end: WS duplication inflates a tracked storm unless deduped at ingestion', () => {
  const WINDOW_5MIN = 5 * 60_000;

  function makeGroundTruthStrikes(count: number, now: number): StrikePoint[] {
    // Tight cluster well inside a single 0.25° grid cell (44.9, 16.6 ± 0.03 never
    // crosses a cell boundary) so detectStorms's BFS bucketing doesn't drop
    // boundary strikes into an undersized neighbor cell — that's a separate,
    // pre-existing property of the clustering grid, not something this test
    // is about. Well above MIN_RATE_PER_MIN so detectStorms tracks it as one storm.
    return Array.from({ length: count }, (_, i) => ({
      lat: 44.9 + Math.sin(i) * 0.03,
      lon: 16.6 + Math.cos(i) * 0.03,
      time: now - WINDOW_5MIN + 1000 + i * 500,
    }));
  }

  it('reproduces the bug: undeduped WS feed multiplies the storm total by the duplication factor', () => {
    const now = Date.now();
    const truth = makeGroundTruthStrikes(150, now);
    const raw = withWsDuplication(truth, 3); // 3x duplication, matching what we measured live

    // Old pipeline: id/src dedup never fires, so every duplicate reaches recentStrikes.
    const seenOld = new Set<string>();
    const ingested = raw
      .filter(s => !isWsDuplicateOld(seenOld, s.id, s.src))
      .map(s => ({ lat: s.lat, lon: s.lon, time: s.time }));
    expect(ingested.length).toBe(raw.length); // nothing filtered — the bug

    const storm = { totalStrikes: 0, allStrikes: [] as [number, number, number][], lastStrikeTime: 0 };
    const [cluster] = detectStorms(ingested, WINDOW_5MIN);
    accumulateStrikes(storm, cluster.members);

    // The bug: reported total is ~3x the real number of physical strikes.
    expect(storm.totalStrikes).toBeGreaterThan(truth.length * 2.5);
  });

  it('fixed: content-based dedup at ingestion keeps the storm total accurate', () => {
    const now = Date.now();
    const truth = makeGroundTruthStrikes(150, now);
    const raw = withWsDuplication(truth, 3);

    const seenFixed = new Set<string>();
    const ingested = raw
      .filter(s => !isWsDuplicateFixed(seenFixed, s.lat, s.lon, s.time))
      .map(s => ({ lat: s.lat, lon: s.lon, time: s.time }));
    expect(ingested.length).toBe(truth.length);

    const storm = { totalStrikes: 0, allStrikes: [] as [number, number, number][], lastStrikeTime: 0 };
    const [cluster] = detectStorms(ingested, WINDOW_5MIN);
    accumulateStrikes(storm, cluster.members);

    expect(storm.totalStrikes).toBe(truth.length);
    expect(storm.allStrikes.length).toBe(truth.length);
  });

  it('fixed: replaying the storm across many overlapping 30s passes still lands on the true total', () => {
    // Emulates the real tracker: the same 5-min window gets re-clustered every 30s,
    // and the WS feed keeps re-sending duplicates of strikes already seen.
    const now = Date.now();
    const truth = makeGroundTruthStrikes(300, now);
    const seenFixed = new Set<string>();
    const storm = { totalStrikes: 0, allStrikes: [] as [number, number, number][], lastStrikeTime: 0 };
    const recentStrikes: StrikePoint[] = [];

    // Simulate strikes arriving in small batches, each re-delivered 2-4x by the WS layer.
    const batchSize = 20;
    for (let i = 0; i < truth.length; i += batchSize) {
      const batch = truth.slice(i, i + batchSize);
      const dupFactor = 2 + (i % 3); // varies 2x-4x, like the real feed
      const raw = withWsDuplication(batch, dupFactor);
      for (const s of raw) {
        if (!isWsDuplicateFixed(seenFixed, s.lat, s.lon, s.time)) {
          recentStrikes.push({ lat: s.lat, lon: s.lon, time: s.time });
        }
      }
      const [cluster] = detectStorms(recentStrikes, WINDOW_5MIN);
      if (cluster) accumulateStrikes(storm, cluster.members);
    }

    expect(storm.totalStrikes).toBe(truth.length);
    expect(storm.allStrikes.length).toBe(truth.length);
    // No duplicate [lat,lon,time] triples survived into the persisted blob.
    const uniqueKeys = new Set(storm.allStrikes.map(s => s.join(',')));
    expect(uniqueKeys.size).toBe(storm.allStrikes.length);
  });
});

// ── absorbInto: allStrikes blob must not re-duplicate on merge ─────────────

interface MergeStorm {
  key: string;
  totalStrikes: number;
  allStrikes: [number, number, number][];
  initialStrikesByAncestor: Record<string, number>;
}

/** Mirrors the fixed absorbInto's allStrikes merge (dedup by content key). */
function mergeAllStrikes(big: MergeStorm, small: MergeStorm): void {
  const bigKeys = new Set(big.allStrikes.map(s => `${s[0]},${s[1]},${s[2]}`));
  for (const s of small.allStrikes) {
    const key = `${s[0]},${s[1]},${s[2]}`;
    if (bigKeys.has(key)) continue;
    bigKeys.add(key);
    big.allStrikes.push(s);
  }
}

describe('absorbInto — allStrikes blob dedup on merge', () => {
  it('does not duplicate points a split fragment already shares with its parent', () => {
    const sharedPoint: [number, number, number] = [44.9, 16.7, 1_000];
    const big: MergeStorm = {
      key: 'A', totalStrikes: 500,
      allStrikes: [sharedPoint, [44.91, 16.71, 900]],
      initialStrikesByAncestor: {},
    };
    // small split off from big and its early allStrikes overlap with big's
    const small: MergeStorm = {
      key: 'B', totalStrikes: 50,
      allStrikes: [sharedPoint, [44.92, 16.72, 1_100]], // one shared point, one new
      initialStrikesByAncestor: { A: 1 },
    };
    mergeAllStrikes(big, small);
    const keys = big.allStrikes.map(s => s.join(','));
    expect(keys.filter(k => k === sharedPoint.join(',')).length).toBe(1); // not duplicated
    expect(big.allStrikes.length).toBe(3); // shared + 2 unique
  });

  it('repeated flap cycles (split/merge/split/merge) never accumulate duplicate points', () => {
    const big: MergeStorm = { key: 'A', totalStrikes: 0, allStrikes: [], initialStrikesByAncestor: {} };
    const basePoints: [number, number, number][] = Array.from({ length: 50 }, (_, i) => [44.9, 16.7 + i * 0.001, 1000 + i]);
    for (const p of basePoints) big.allStrikes.push(p);

    // Simulate 5 flap cycles where the same fragment re-splits and re-merges,
    // each time carrying the same historical points plus a couple of new ones.
    for (let cycle = 0; cycle < 5; cycle++) {
      const small: MergeStorm = {
        key: 'B', totalStrikes: 0,
        allStrikes: [...basePoints, [44.9, 20 + cycle, 2000 + cycle]],
        initialStrikesByAncestor: { A: basePoints.length },
      };
      mergeAllStrikes(big, small);
    }

    const uniqueKeys = new Set(big.allStrikes.map(s => s.join(',')));
    expect(uniqueKeys.size).toBe(big.allStrikes.length); // no duplicates survived
    expect(big.allStrikes.length).toBe(basePoints.length + 5); // base + one new point per cycle
  });
});
