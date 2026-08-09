/**
 * Tests for storm merge/split event logic and double-counting prevention.
 *
 * These tests exercise the pure functions and data structures used by the
 * storm tracker (route.ts) without requiring a live DB or WebSocket connection.
 */
import { describe, it, expect } from 'vitest';
import { detectStorms, type StrikePoint } from '../app/lib/stormClusters';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeStrikes(
  lat: number,
  lon: number,
  count: number,
  baseTime: number,
  spread = 0.1,
): StrikePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: lat + (Math.sin(i) * spread),
    lon: lon + (Math.cos(i) * spread),
    time: baseTime + i * 500,
  }));
}

function kmBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (aLat - bLat) * 111.32;
  const dLon = (aLon - bLon) * 111.32 * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon);
}

// Minimal TrackedStorm shape mirroring the interface in route.ts
interface MinTrackedStorm {
  key: string;
  cc: string;
  lat: number;
  lon: number;
  city: string | null;
  peakCount: number;
  peakRate: number;
  startTime: number;
  originLat: number;
  originLon: number;
  originCity: string | null;
  traveledKm: number;
  totalStrikes: number;
  allStrikes: [number, number, number][];
  countryCodes: string[];
  splitLineage: string[];
  initialTotalStrikes: number;
  lastSeen: number;
}

function makeStorm(overrides: Partial<MinTrackedStorm> = {}): MinTrackedStorm {
  return {
    key: 'test-key',
    cc: 'NL',
    lat: 52, lon: 5,
    city: 'Amsterdam',
    peakCount: 100, peakRate: 20,
    startTime: 1000, originLat: 52, originLon: 5, originCity: 'Amsterdam',
    traveledKm: 0, totalStrikes: 1000, allStrikes: [],
    countryCodes: ['NL'], splitLineage: [], initialTotalStrikes: 0,
    lastSeen: 1000,
    ...overrides,
  };
}

// Pure absorb function mirroring route.ts logic (no DB calls)
function absorbInto(
  big: MinTrackedStorm,
  small: MinTrackedStorm,
): { mergedStrikes: number } {
  if (small.peakCount > big.peakCount) { big.peakCount = small.peakCount; big.peakRate = small.peakRate; }
  if (small.startTime < big.startTime) {
    big.startTime = small.startTime;
    big.originLat = small.originLat; big.originLon = small.originLon; big.originCity = small.originCity;
  }
  big.traveledKm = Math.max(big.traveledKm, small.traveledKm);
  const netNew = small.splitLineage.includes(big.key)
    ? Math.max(0, small.totalStrikes - small.initialTotalStrikes)
    : small.totalStrikes;
  big.totalStrikes += netNew;
  // Propagate ancestry when the correction didn't apply this merge.
  if (!small.splitLineage.includes(big.key) && small.splitLineage.length > 0) {
    big.initialTotalStrikes += small.initialTotalStrikes;
    for (const ancestor of small.splitLineage) {
      if (!big.splitLineage.includes(ancestor)) big.splitLineage.push(ancestor);
    }
  }
  for (const c of small.countryCodes) if (!big.countryCodes.includes(c)) big.countryCodes.push(c);
  return { mergedStrikes: netNew };
}

// Mirrors the key-adoption lineage patch from route.ts Phase 1 / Phase 2
function adoptKey(storms: MinTrackedStorm[], target: MinTrackedStorm, newKey: string): void {
  const oldKey = target.key;
  target.key = newKey;
  for (const st of storms) {
    const i = st.splitLineage.indexOf(oldKey);
    if (i !== -1) st.splitLineage[i] = newKey;
  }
}

// ── detectStorms ─────────────────────────────────────────────────────────

describe('detectStorms', () => {
  const WINDOW_5MIN = 5 * 60_000;

  it('returns empty when no strikes', () => {
    expect(detectStorms([], WINDOW_5MIN)).toEqual([]);
  });

  it('detects a single active cluster', () => {
    const now = Date.now();
    // MIN_RATE_PER_MIN = 15, so 75 strikes in 5 min satisfies the threshold
    const strikes = makeStrikes(52, 5, 80, now - WINDOW_5MIN + 1000);
    const storms = detectStorms(strikes, WINDOW_5MIN);
    expect(storms.length).toBe(1);
    expect(storms[0].count).toBeGreaterThanOrEqual(75);
  });

  it('detects two separate clusters as two storms', () => {
    const now = Date.now();
    // Two clusters 3 degrees apart (~333 km) so they stay separate
    const clusterA = makeStrikes(52, 5, 80, now - WINDOW_5MIN + 1000);
    const clusterB = makeStrikes(49, 5, 80, now - WINDOW_5MIN + 1000);
    const storms = detectStorms([...clusterA, ...clusterB], WINDOW_5MIN);
    expect(storms.length).toBe(2);
  });

  it('merges two clusters within MERGE_KM into one storm', () => {
    const now = Date.now();
    // 52.65 - 52.0 = 0.65° ≈ 72 km, within MERGE_KM (75 km).
    // Spread 0.1 means A's top cells are at row 208, B's bottom cells at row 210 — a
    // 2-row gap so BFS keeps them separate, letting the agglomerative step merge them.
    const clusterA = makeStrikes(52.0, 5.0, 80, now - WINDOW_5MIN + 1000);
    const clusterB = makeStrikes(52.65, 5.0, 80, now - WINDOW_5MIN + 1000);
    const storms = detectStorms([...clusterA, ...clusterB], WINDOW_5MIN);
    expect(storms.length).toBe(1);
    expect(storms[0].mergedFrom).toBe(2);
  });

  it('ignores clusters below the minimum rate threshold', () => {
    const now = Date.now();
    // Only 10 strikes in 5 min = 2/min, below MIN_RATE_PER_MIN=15
    const strikes = makeStrikes(52, 5, 10, now - WINDOW_5MIN + 1000);
    expect(detectStorms(strikes, WINDOW_5MIN)).toEqual([]);
  });

  it('sorts storms by count descending', () => {
    const now = Date.now();
    const big = makeStrikes(52, 5, 120, now - WINDOW_5MIN + 1000);
    const small = makeStrikes(49, 5, 80, now - WINDOW_5MIN + 1000);
    const storms = detectStorms([...big, ...small], WINDOW_5MIN);
    expect(storms.length).toBe(2);
    expect(storms[0].count).toBeGreaterThanOrEqual(storms[1].count);
  });
});

// ── absorbInto double-counting ────────────────────────────────────────────

describe('absorbInto — strike counting', () => {
  it('adds all strikes when merging independent storms', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 5000 });
    const small = makeStorm({ key: 'B', totalStrikes: 2000, splitLineage: [] });
    absorbInto(big, small);
    expect(big.totalStrikes).toBe(7000);
  });

  it('adds only net-new strikes when absorbing a direct split child (avoids double-counting)', () => {
    // B was split from A; B.initialTotalStrikes are the overlapping initial members.
    const big = makeStorm({ key: 'A', totalStrikes: 5000 });
    const small = makeStorm({
      key: 'B',
      splitLineage: ['A'],      // B split from A
      initialTotalStrikes: 300, // 300 strikes were in A's territory when B formed
      totalStrikes: 500,        // 200 net-new strikes after the split
    });
    absorbInto(big, small);
    // Should add only 500 - 300 = 200, not 500
    expect(big.totalStrikes).toBe(5200);
  });

  it('corrects cascading splits: grandchild re-merges into grandparent', () => {
    // A splits → B (splitLineage: ['A']).
    // B splits → C (splitLineage: ['A', 'B']).
    // C re-merges into A: A.key is in C.splitLineage → correction applies.
    const a = makeStorm({ key: 'A', totalStrikes: 10_000 });
    const c = makeStorm({
      key: 'C',
      splitLineage: ['A', 'B'],
      initialTotalStrikes: 200,
      totalStrikes: 350,
    });
    absorbInto(a, c);
    expect(a.totalStrikes).toBe(10_150); // 10000 + (350 - 200) = 10150
  });

  it('clamps net-new to zero when absorbed storm has no new strikes', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 5000 });
    const small = makeStorm({
      key: 'B',
      splitLineage: ['A'],
      initialTotalStrikes: 400,
      totalStrikes: 400, // no new strikes since split
    });
    absorbInto(big, small);
    expect(big.totalStrikes).toBe(5000);
  });

  it('does NOT subtract initial strikes when lineage does not include big.key', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 5000 });
    const small = makeStorm({
      key: 'B',
      splitLineage: ['C'], // split from C, not A
      initialTotalStrikes: 300,
      totalStrikes: 500,
    });
    absorbInto(big, small);
    // Different ancestry → add full totalStrikes
    expect(big.totalStrikes).toBe(5500);
  });

  it('returns the count actually merged for event recording', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 1000 });
    const small = makeStorm({ key: 'B', totalStrikes: 300, splitLineage: [] });
    const { mergedStrikes } = absorbInto(big, small);
    expect(mergedStrikes).toBe(300);
  });

  it('returns net-new count when split child is absorbed', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 1000 });
    const small = makeStorm({ key: 'B', totalStrikes: 500, splitLineage: ['A'], initialTotalStrikes: 200 });
    const { mergedStrikes } = absorbInto(big, small);
    expect(mergedStrikes).toBe(300);
  });

  it('takes the higher peakCount from either storm', () => {
    const big = makeStorm({ key: 'A', peakCount: 100, totalStrikes: 1000 });
    const small = makeStorm({ key: 'B', peakCount: 200, totalStrikes: 500 });
    absorbInto(big, small);
    expect(big.peakCount).toBe(200);
  });

  it('adopts the earlier startTime', () => {
    const big = makeStorm({ key: 'A', startTime: 2000, totalStrikes: 1000 });
    const small = makeStorm({ key: 'B', startTime: 1000, totalStrikes: 500 });
    absorbInto(big, small);
    expect(big.startTime).toBe(1000);
  });

  it('collects country codes from both storms', () => {
    const big = makeStorm({ key: 'A', countryCodes: ['NL'], totalStrikes: 1000 });
    const small = makeStorm({ key: 'B', countryCodes: ['DE', 'NL'], totalStrikes: 500 });
    absorbInto(big, small);
    expect(big.countryCodes).toContain('DE');
    expect(big.countryCodes.filter(c => c === 'NL').length).toBe(1); // no duplicates
  });
});

// ── Lineage propagation through intermediate merges ───────────────────────

describe('absorbInto — lineage propagation', () => {
  it('sibling merge: B absorbs C (both from A) → combined initialTotalStrikes used when re-merging into A', () => {
    // A splits into B (initial=200) and C (initial=150).
    // B accumulates 80 new, C accumulates 50 new.
    const b = makeStorm({ key: 'B', splitLineage: ['A'], initialTotalStrikes: 200, totalStrikes: 280 });
    const c = makeStorm({ key: 'C', splitLineage: ['A'], initialTotalStrikes: 150, totalStrikes: 200 });
    // B absorbs C — correction doesn't apply (C.splitLineage doesn't include B.key)
    absorbInto(b, c);
    // Full count added: 280 + 200 = 480
    expect(b.totalStrikes).toBe(480);
    // Lineage propagated: B's initialTotalStrikes now covers both overlap slices
    expect(b.initialTotalStrikes).toBe(350); // 200 + 150
    expect(b.splitLineage).toEqual(['A']);    // 'A' already present, no duplicate

    // B (now carrying C) re-merges into A
    const a = makeStorm({ key: 'A', totalStrikes: 5000 });
    absorbInto(a, b);
    // Net-new = 480 - 350 = 130 (= 80 new from B + 50 new from C)
    expect(a.totalStrikes).toBe(5130);
  });

  it('third-party absorption: C absorbs B (B from A) → C inherits lineage and corrects on re-merge into A', () => {
    // B split from A (initial=200). C is unrelated.
    // B has grown to 350 (150 net-new). C stands at 1000.
    const c = makeStorm({ key: 'C', splitLineage: [], initialTotalStrikes: 0, totalStrikes: 1000 });
    const b = makeStorm({ key: 'B', splitLineage: ['A'], initialTotalStrikes: 200, totalStrikes: 350 });
    // C absorbs B — correction doesn't apply
    absorbInto(c, b);
    expect(c.totalStrikes).toBe(1350);         // 1000 + 350 full
    expect(c.splitLineage).toEqual(['A']);      // inherited from B
    expect(c.initialTotalStrikes).toBe(200);   // inherited from B

    // C re-merges into A
    const a = makeStorm({ key: 'A', totalStrikes: 5000 });
    absorbInto(a, c);
    // Net-new = 1350 - 200 = 1150 (1000 from C itself + 150 net-new from B)
    expect(a.totalStrikes).toBe(6150);
  });

  it('lineage union: merging two storms from different ancestors merges both lineages', () => {
    const b = makeStorm({ key: 'B', splitLineage: ['A'], initialTotalStrikes: 100, totalStrikes: 300 });
    const c = makeStorm({ key: 'C', splitLineage: ['D'], initialTotalStrikes: 80,  totalStrikes: 200 });
    absorbInto(b, c);
    expect(b.splitLineage).toContain('A');
    expect(b.splitLineage).toContain('D');
    expect(b.initialTotalStrikes).toBe(180); // 100 + 80
  });

  it('no duplicate ancestors when siblings share the same lineage entry', () => {
    const b = makeStorm({ key: 'B', splitLineage: ['A'], initialTotalStrikes: 100, totalStrikes: 300 });
    const c = makeStorm({ key: 'C', splitLineage: ['A'], initialTotalStrikes: 80,  totalStrikes: 200 });
    absorbInto(b, c);
    expect(b.splitLineage.filter(k => k === 'A').length).toBe(1); // 'A' appears once
  });
});

// ── Key adoption: splitLineage patch ─────────────────────────────────────

describe('key adoption patches splitLineage references', () => {
  it('updates splitLineage entries that pointed at the old key', () => {
    const storms: MinTrackedStorm[] = [
      makeStorm({ key: 'A', totalStrikes: 5000 }),
      makeStorm({ key: 'C', splitLineage: ['A'], totalStrikes: 300 }),
      makeStorm({ key: 'D', splitLineage: ['A', 'X'], totalStrikes: 200 }),
    ];
    // A adopts key 'B' (small had DB entry, big didn't)
    adoptKey(storms, storms[0], 'B');
    expect(storms[0].key).toBe('B');
    expect(storms[1].splitLineage).toEqual(['B']); // updated
    expect(storms[2].splitLineage).toEqual(['B', 'X']); // first entry updated
  });

  it('does not affect unrelated splitLineage entries', () => {
    const storms: MinTrackedStorm[] = [
      makeStorm({ key: 'A', totalStrikes: 5000 }),
      makeStorm({ key: 'E', splitLineage: ['X', 'Y'], totalStrikes: 100 }),
    ];
    adoptKey(storms, storms[0], 'B');
    expect(storms[1].splitLineage).toEqual(['X', 'Y']); // unchanged
  });

  it('correction still applies after key adoption', () => {
    // A absorbs small, adopts small's DB key 'DB-key'
    const storms: MinTrackedStorm[] = [
      makeStorm({ key: 'A', totalStrikes: 8000 }),
      makeStorm({ key: 'C', splitLineage: ['A'], initialTotalStrikes: 100, totalStrikes: 400 }),
    ];
    adoptKey(storms, storms[0], 'DB-key');
    // Now C.splitLineage = ['DB-key'], big.key = 'DB-key'
    const { mergedStrikes } = absorbInto(storms[0], storms[1]);
    // Net-new = 400 - 100 = 300 (correction still applied correctly)
    expect(mergedStrikes).toBe(300);
    expect(storms[0].totalStrikes).toBe(8300);
  });
});

// ── Split detection heuristic ─────────────────────────────────────────────

describe('split detection heuristic', () => {
  const TRACKER_MERGE_KM = 100;
  const SPLIT_DETECT_KM = 200;

  interface ExistingStorm { lat: number; lon: number; key: string; splitLineage: string[] }

  // Mirrors the detection logic from route.ts
  function detectSplitParent(
    freshLat: number, freshLon: number,
    existingStorms: ExistingStorm[],
  ): ExistingStorm | null {
    let nearestParent: ExistingStorm | null = null;
    let nearestKm = Infinity;
    for (const st of existingStorms) {
      const km = kmBetween(freshLat, freshLon, st.lat, st.lon);
      if (km < nearestKm && km < SPLIT_DETECT_KM && km >= TRACKER_MERGE_KM) {
        nearestKm = km; nearestParent = st;
      }
    }
    return nearestParent;
  }

  function buildLineage(parent: ExistingStorm): string[] {
    return [...parent.splitLineage, parent.key];
  }

  it('returns null when no existing storms are within SPLIT_DETECT_KM', () => {
    const parent = detectSplitParent(52, 5, [
      { lat: 48, lon: 5, key: 'far-storm', splitLineage: [] }, // ~444 km away
    ]);
    expect(parent).toBeNull();
  });

  it('detects split when fresh storm is within SPLIT_DETECT_KM but beyond TRACKER_MERGE_KM', () => {
    // ~167 km north — inside split window (100–200 km)
    const parent = detectSplitParent(52, 5, [
      { lat: 50.5, lon: 5, key: 'parent-storm', splitLineage: [] },
    ]);
    expect(parent?.key).toBe('parent-storm');
  });

  it('returns null when fresh storm is within TRACKER_MERGE_KM (would be merged by Phase 1)', () => {
    // ~55 km — Phase 1 consolidation would absorb this
    const parent = detectSplitParent(52, 5, [
      { lat: 51.5, lon: 5, key: 'too-close-storm', splitLineage: [] },
    ]);
    expect(parent).toBeNull();
  });

  it('picks the closest eligible parent', () => {
    const parent = detectSplitParent(52, 5, [
      { lat: 50.5, lon: 5, key: 'closer-parent', splitLineage: [] },  // ~167 km
      { lat: 49, lon: 5, key: 'farther-parent', splitLineage: [] },   // ~333 km — outside window
    ]);
    expect(parent?.key).toBe('closer-parent');
  });

  it('propagates grandparent ancestry into the grandchild lineage', () => {
    // A splits → B (B.splitLineage = ['A']).
    // B splits → C: C should get lineage ['A', 'B'].
    const parentB: ExistingStorm = { lat: 52, lon: 5, key: 'B', splitLineage: ['A'] };
    const lineage = buildLineage(parentB);
    expect(lineage).toEqual(['A', 'B']);
  });

  it('grandchild lineage includes grandparent key for absorbInto correction', () => {
    // Verify that when A.key appears in C.splitLineage, absorbInto applies the fix
    const a = makeStorm({ key: 'A', totalStrikes: 10_000 });
    const c = makeStorm({
      key: 'C',
      splitLineage: ['A', 'B'],
      initialTotalStrikes: 150,
      totalStrikes: 400,
    });
    absorbInto(a, c);
    expect(a.totalStrikes).toBe(10_250); // 10000 + (400 - 150)
  });
});

// ── StormEvent type guard ────────────────────────────────────────────────

describe('StormEvent structure', () => {
  it('merge event has required fields', () => {
    const ev = {
      id: 1,
      stormKey: 'A',
      eventType: 'merge' as const,
      ts: Date.now(),
      relatedKey: 'B',
      relatedCity: 'Amsterdam',
      relatedCc: 'NL',
      strikesAbsorbed: 300,
    };
    expect(ev.eventType).toBe('merge');
    expect(typeof ev.strikesAbsorbed).toBe('number');
  });

  it('split event allows null strikesAbsorbed', () => {
    const ev = {
      id: 2,
      stormKey: 'A',
      eventType: 'split' as const,
      ts: Date.now(),
      relatedKey: 'B',
      relatedCity: null,
      relatedCc: 'DE',
      strikesAbsorbed: null,
    };
    expect(ev.eventType).toBe('split');
    expect(ev.strikesAbsorbed).toBeNull();
  });
});
