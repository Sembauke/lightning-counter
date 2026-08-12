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
  initialStrikesByAncestor: Record<string, number>;
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
    countryCodes: ['NL'], initialStrikesByAncestor: {},
    lastSeen: 1000,
    ...overrides,
  };
}

// Pure absorb function mirroring route.ts logic (no DB calls).
// `reported` mirrors route.ts's reportedNew: only non-null when ancestry is
// tracked (Branch 1/2), because Branch 3 returns small.totalStrikes which is
// the full lifetime count, not the genuine contribution since last absorption.
function absorbInto(
  big: MinTrackedStorm,
  small: MinTrackedStorm,
): { mergedStrikes: number; reported: number | null } {
  if (small.peakCount > big.peakCount) { big.peakCount = small.peakCount; big.peakRate = small.peakRate; }
  if (small.startTime < big.startTime) {
    big.startTime = small.startTime;
    big.originLat = small.originLat; big.originLon = small.originLon; big.originCity = small.originCity;
  }
  big.traveledKm = Math.max(big.traveledKm, small.traveledKm);

  // Capture before any map mutations — matches route.ts hadAncestor check.
  const hadAncestorLink = big.key in small.initialStrikesByAncestor
    || small.key in big.initialStrikesByAncestor;

  const overlapInBig   = small.initialStrikesByAncestor[big.key];
  const overlapInSmall = big.initialStrikesByAncestor[small.key];

  let netNew: number;
  if (overlapInBig !== undefined) {
    // Normal re-merge: small is a descendant of big.
    netNew = Math.max(0, small.totalStrikes - overlapInBig);
    for (const [k, v] of Object.entries(small.initialStrikesByAncestor)) {
      if (k === big.key) continue;
      big.initialStrikesByAncestor[k] = (big.initialStrikesByAncestor[k] ?? 0) + v;
    }
  } else if (overlapInSmall !== undefined) {
    // Reverse re-merge: big is a descendant of small (child outgrew parent).
    netNew = Math.max(0, small.totalStrikes - overlapInSmall);
    delete big.initialStrikesByAncestor[small.key];
    for (const [k, v] of Object.entries(small.initialStrikesByAncestor)) {
      big.initialStrikesByAncestor[k] = v;
    }
  } else {
    // No direct ancestry (independent, sibling, or third-party).
    netNew = small.totalStrikes;
    for (const [k, v] of Object.entries(small.initialStrikesByAncestor)) {
      big.initialStrikesByAncestor[k] = (big.initialStrikesByAncestor[k] ?? 0) + v;
    }
  }

  big.totalStrikes += netNew;
  for (const c of small.countryCodes) if (!big.countryCodes.includes(c)) big.countryCodes.push(c);
  return { mergedStrikes: netNew, reported: hadAncestorLink ? netNew : null };
}

// Mirrors the key-adoption ancestor map patch from route.ts Phase 1 / Phase 2
function adoptKey(storms: MinTrackedStorm[], target: MinTrackedStorm, newKey: string): void {
  const oldKey = target.key;
  target.key = newKey;
  for (const st of storms) {
    if (oldKey in st.initialStrikesByAncestor) {
      st.initialStrikesByAncestor[newKey] = st.initialStrikesByAncestor[oldKey];
      delete st.initialStrikesByAncestor[oldKey];
    }
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
    const small = makeStorm({ key: 'B', totalStrikes: 2000, initialStrikesByAncestor: {} });
    absorbInto(big, small);
    expect(big.totalStrikes).toBe(7000);
  });

  it('adds only net-new strikes when absorbing a direct split child (avoids double-counting)', () => {
    // B split from A; 300 strikes were already in A's territory when B formed.
    const big = makeStorm({ key: 'A', totalStrikes: 5000 });
    const small = makeStorm({
      key: 'B',
      initialStrikesByAncestor: { 'A': 300 }, // overlap with A at birth
      totalStrikes: 500,                        // 200 net-new after the split
    });
    absorbInto(big, small);
    // overlapInBig = small.initialStrikesByAncestor['A'] = 300
    // netNew = max(0, 500 - 300) = 200
    expect(big.totalStrikes).toBe(5200);
  });

  it('corrects cascading splits: grandchild re-merges into grandparent', () => {
    // A splits → B. B splits → C. C.map has 'A' as a key → correction applies.
    const a = makeStorm({ key: 'A', totalStrikes: 10_000 });
    const c = makeStorm({
      key: 'C',
      initialStrikesByAncestor: { 'A': 200, 'B': 200 },
      totalStrikes: 350,
    });
    absorbInto(a, c);
    // overlapInBig = c.initialStrikesByAncestor['A'] = 200
    // netNew = max(0, 350 - 200) = 150
    expect(a.totalStrikes).toBe(10_150);
  });

  it('clamps net-new to zero when absorbed storm has no new strikes', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 5000 });
    const small = makeStorm({
      key: 'B',
      initialStrikesByAncestor: { 'A': 400 },
      totalStrikes: 400, // no new strikes since split
    });
    absorbInto(big, small);
    expect(big.totalStrikes).toBe(5000);
  });

  it('does NOT subtract initial strikes when lineage does not include big.key', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 5000 });
    const small = makeStorm({
      key: 'B',
      initialStrikesByAncestor: { 'C': 300 }, // split from C, not A
      totalStrikes: 500,
    });
    absorbInto(big, small);
    // No 'A' in small.map, no 'B' in big.map → full count
    expect(big.totalStrikes).toBe(5500);
  });

  it('returns the count actually merged for event recording', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 1000 });
    const small = makeStorm({ key: 'B', totalStrikes: 300, initialStrikesByAncestor: {} });
    const { mergedStrikes } = absorbInto(big, small);
    expect(mergedStrikes).toBe(300);
  });

  it('returns net-new count when split child is absorbed', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 1000 });
    const small = makeStorm({ key: 'B', totalStrikes: 500, initialStrikesByAncestor: { 'A': 200 } });
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

// ── Reverse re-merge: child absorbs parent ────────────────────────────────

describe('absorbInto — child absorbs parent (reverse case)', () => {
  it('adds only parent strikes outside the child\'s initial territory', () => {
    // A (pre-split total=500) splits → B (B.map={'A':200}). A gains 100 new, B gains 80.
    // B grows larger and absorbs A.
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 280 });
    const a = makeStorm({ key: 'A', totalStrikes: 600 }); // 500 pre-split + 100 new
    absorbInto(b, a); // big=b, small=a
    // overlapInSmall = b.initialStrikesByAncestor['A'] = 200
    // netNew = max(0, 600 - 200) = 400
    expect(b.totalStrikes).toBe(680);
  });

  it('grandchild absorbs grandparent using grandchild\'s overlap with grandparent as baseline', () => {
    // A → B → C. C.map = {'A':100, 'B':100}. C grows huge and absorbs A.
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 100, 'B': 100 }, totalStrikes: 300 });
    const a = makeStorm({ key: 'A', totalStrikes: 800 });
    absorbInto(c, a);
    // overlapInSmall = c.initialStrikesByAncestor['A'] = 100
    // netNew = max(0, 800 - 100) = 700
    expect(c.totalStrikes).toBe(1000); // 300 + 700
  });

  it('combined ancestor overlap (after sibling absorption) used when child absorbs grandparent', () => {
    // A → B (B.map={'A':200}) and A → C (C.map={'A':150}). B absorbs C → B.map['A']=350, B.total=480.
    // A has 600 total. B absorbs A.
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 350 }, totalStrikes: 480 });
    const a = makeStorm({ key: 'A', totalStrikes: 600 });
    absorbInto(b, a);
    // overlapInSmall = b.initialStrikesByAncestor['A'] = 350
    // netNew = max(0, 600 - 350) = 250
    expect(b.totalStrikes).toBe(730); // 480 + 250
  });

  it('clamps to zero when parent has fewer strikes than the child\'s overlap baseline', () => {
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 500 }, totalStrikes: 800 });
    const a = makeStorm({ key: 'A', totalStrikes: 300 });
    absorbInto(b, a);
    expect(b.totalStrikes).toBe(800); // netNew = max(0, 300-500) = 0
  });

  it('returns the net-new count', () => {
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 280 });
    const a = makeStorm({ key: 'A', totalStrikes: 600 });
    const { mergedStrikes } = absorbInto(b, a);
    expect(mergedStrikes).toBe(400);
  });

  it('OVERWRITEs ancestor overlaps from small\'s map (not adds) in reverse re-merge', () => {
    // B.map={'A':200, 'X':50}. A.map={'X':100}. B absorbs A (reverse).
    // 'X' in A's map should OVERWRITE 'X' in B's map (100 beats 50), not add (150).
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200, 'X': 50 }, totalStrikes: 300 });
    const a = makeStorm({ key: 'A', initialStrikesByAncestor: { 'X': 100 }, totalStrikes: 500 });
    absorbInto(b, a);
    expect('A' in b.initialStrikesByAncestor).toBe(false); // 'A' consumed and removed
    expect(b.initialStrikesByAncestor['X']).toBe(100);      // overwrite, not 50+100=150
  });
});

// ── Reverse re-merge: ancestor map updated correctly ──────────────────────

describe('absorbInto — reverse re-merge updates ancestor map for grandparent pass', () => {
  it('grandparent absorbs (child+parent) without double-count after child absorbed parent', () => {
    // B.map={'A':200}, B.total=350. C.map={'A':100, 'B':100}, C.total=150.
    // C absorbs B (reverse: overlapInSmall = C.map['B'] = 100):
    //   netNew=250. C.total=400. Delete 'B'. Overwrite from B.map: C.map['A']=200.
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 350 });
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 100, 'B': 100 }, totalStrikes: 150 });
    absorbInto(c, b);
    // 'B' consumed, 'A' updated to B's value (200)
    expect(c.initialStrikesByAncestor).toEqual({ 'A': 200 });

    // A (580 total) absorbs the combined C+B
    const a = makeStorm({ key: 'A', totalStrikes: 580 });
    absorbInto(a, c);
    // overlapInBig = c.initialStrikesByAncestor['A'] = 200
    // netNew = (150+250) - 200 = 200
    expect(a.totalStrikes).toBe(780);
  });

  it('ancestor overlap is overwritten (not added) when child absorbs its parent', () => {
    // B and D both split from A. C splits from B.
    // D.map={'A':80}. C.map={'A':100, 'B':100}.
    // C absorbs D (sibling, no ancestry → ADD: C.map['A'] = 180).
    // C absorbs B (reverse: overlapInSmall = C.map['B'] = 100 → overwrite from B.map: C.map['A']=200).
    const d = makeStorm({ key: 'D', initialStrikesByAncestor: { 'A': 80 }, totalStrikes: 120 });
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 100, 'B': 100 }, totalStrikes: 150 });
    absorbInto(c, d); // sibling → ADD: C.map['A'] = 180
    expect(c.initialStrikesByAncestor['A']).toBe(180);

    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 350 });
    absorbInto(c, b); // reverse: C absorbs parent B → overwrite C.map['A'] = 200
    expect(c.initialStrikesByAncestor['A']).toBe(200); // overwrite, not max(180, 200)
    expect('B' in c.initialStrikesByAncestor).toBe(false); // 'B' removed
  });
});

// ── Ancestor map propagation after reverse re-merge ───────────────────────

describe('absorbInto — reverse re-merge propagates ancestor map and removes consumed key', () => {
  it('inherited ancestor map allows great-grandparent correction later', () => {
    // Original → A (A.map={'Original':50}). A → B → C (C.map={'A':100, 'B':100}).
    // C absorbs A (reverse: C.map['A']=100 → delete 'A', overwrite from A.map: C.map['Original']=50).
    const a = makeStorm({ key: 'A', initialStrikesByAncestor: { 'Original': 50 }, totalStrikes: 600 });
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 100, 'B': 100 }, totalStrikes: 150 });
    absorbInto(c, a);
    // 'Original' inherited from A's map
    expect('Original' in c.initialStrikesByAncestor).toBe(true);
    // Consumed key 'A' removed
    expect('A' in c.initialStrikesByAncestor).toBe(false);
    // 'B' still present (not in A's map, not overwritten)
    expect('B' in c.initialStrikesByAncestor).toBe(true);

    // Original (800 total) absorbs C — correction must apply
    const original = makeStorm({ key: 'Original', totalStrikes: 800 });
    absorbInto(original, c); // overlapInBig = c.initialStrikesByAncestor['Original'] = 50
    // C.total after absorbing A: 150 + (600-100) = 650. netNew = 650-50 = 600.
    expect(original.totalStrikes).toBe(1400); // 800 + 600
  });

  it('consumed ancestor key is removed from the map after reverse re-merge', () => {
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 350 });
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 100, 'B': 100 }, totalStrikes: 150 });
    absorbInto(c, b); // C absorbs B
    expect('B' in c.initialStrikesByAncestor).toBe(false); // 'B' consumed and removed
    expect('A' in c.initialStrikesByAncestor).toBe(true);  // A (B's ancestor) inherited
  });

  it('map key appears exactly once even when both storm have the same ancestor', () => {
    // A → B (B.map={'A':200}). B → C (C.map={'A':100, 'B':100}).
    // C absorbs B: 'A' from B.map overwrites C.map['A']. Still just one entry.
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 350 });
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 100, 'B': 100 }, totalStrikes: 150 });
    absorbInto(c, b);
    expect(Object.keys(c.initialStrikesByAncestor).filter(k => k === 'A').length).toBe(1);
  });
});

// ── Non-adoption merges patch ancestor map of surviving storms ────────────

describe('non-adoption merge patches ancestor map references to absorbed key', () => {
  it('E can correctly re-merge into C after B (E\'s ancestor entry) was absorbed into C', () => {
    // E.map={'A':80, 'B':80}. B absorbed (non-adoption) into C.
    // The patch renames 'B' → 'C' in E's map.
    const e = makeStorm({ key: 'E', initialStrikesByAncestor: { 'A': 80, 'B': 80 }, totalStrikes: 200 });
    const storms = [e];

    // Simulate the non-adoption patch: B was absorbed into C
    for (const st of storms) {
      if ('B' in st.initialStrikesByAncestor) {
        st.initialStrikesByAncestor['C'] = st.initialStrikesByAncestor['B'];
        delete st.initialStrikesByAncestor['B'];
      }
    }
    expect('C' in e.initialStrikesByAncestor).toBe(true);
    expect('B' in e.initialStrikesByAncestor).toBe(false);

    // E now re-merges into C — correction should apply
    const c = makeStorm({ key: 'C', totalStrikes: 3000 });
    absorbInto(c, e); // overlapInBig = e.initialStrikesByAncestor['C'] = 80
    // netNew = 200 - 80 = 120
    expect(c.totalStrikes).toBe(3120);
  });

  it('without the patch, the same re-merge double-counts', () => {
    // Same scenario but WITHOUT patching — shows what the bug looks like.
    const e = makeStorm({ key: 'E', initialStrikesByAncestor: { 'A': 80, 'B': 80 }, totalStrikes: 200 });
    const c = makeStorm({ key: 'C', totalStrikes: 3000 });
    // No patch: 'C' not in e's map, no ancestry → full count
    absorbInto(c, e);
    expect(c.totalStrikes).toBe(3200); // double-counts the 80 overlap
  });
});

// ── Ancestor map propagation through intermediate merges ──────────────────

describe('absorbInto — ancestor map propagation', () => {
  it('sibling merge: B absorbs C (both from A) → combined overlap used when re-merging into A', () => {
    // B.map={'A':200}, C.map={'A':150}.
    // B absorbs C (no ancestry → ADD: B.map['A']=350). B.total=480.
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 280 });
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 150 }, totalStrikes: 200 });
    absorbInto(b, c);
    expect(b.totalStrikes).toBe(480);
    expect(b.initialStrikesByAncestor['A']).toBe(350); // 200 + 150

    // B (now carrying C) re-merges into A
    const a = makeStorm({ key: 'A', totalStrikes: 5000 });
    absorbInto(a, b);
    // overlapInBig = b.initialStrikesByAncestor['A'] = 350
    // netNew = 480 - 350 = 130 (= 80 new from B + 50 new from C)
    expect(a.totalStrikes).toBe(5130);
  });

  it('third-party absorption: C absorbs B (B from A) → C inherits ancestor map and corrects on re-merge into A', () => {
    // B.map={'A':200}. C.map={}.
    // C absorbs B (no ancestry → ADD: C.map['A']=200). C.total=1350.
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: {}, totalStrikes: 1000 });
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 350 });
    absorbInto(c, b);
    expect(c.totalStrikes).toBe(1350);
    expect(c.initialStrikesByAncestor['A']).toBe(200); // inherited from B

    // C re-merges into A
    const a = makeStorm({ key: 'A', totalStrikes: 5000 });
    absorbInto(a, c);
    // overlapInBig = c.initialStrikesByAncestor['A'] = 200
    // netNew = 1350 - 200 = 1150
    expect(a.totalStrikes).toBe(6150);
  });

  it('merging two storms from different ancestors accumulates both entries into the map', () => {
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 100 }, totalStrikes: 300 });
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'D': 80  }, totalStrikes: 200 });
    absorbInto(b, c);
    // ADD each of c's entries into b's map
    expect(b.initialStrikesByAncestor['A']).toBe(100);
    expect(b.initialStrikesByAncestor['D']).toBe(80);
  });

  it('shared ancestor key ADDs when merging siblings (no duplicate map entries)', () => {
    const b = makeStorm({ key: 'B', initialStrikesByAncestor: { 'A': 100 }, totalStrikes: 300 });
    const c = makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 80  }, totalStrikes: 200 });
    absorbInto(b, c);
    // ADD: B.map['A'] = 100+80=180. Map is a plain object — only one 'A' key.
    expect(Object.keys(b.initialStrikesByAncestor).filter(k => k === 'A').length).toBe(1);
    expect(b.initialStrikesByAncestor['A']).toBe(180);
  });
});

// ── Key adoption: ancestor map patch ─────────────────────────────────────

describe('key adoption patches ancestor map references', () => {
  it('updates ancestor map entries that pointed at the old key', () => {
    const storms: MinTrackedStorm[] = [
      makeStorm({ key: 'A', totalStrikes: 5000 }),
      makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 200 }, totalStrikes: 300 }),
      makeStorm({ key: 'D', initialStrikesByAncestor: { 'A': 150, 'X': 80 }, totalStrikes: 200 }),
    ];
    adoptKey(storms, storms[0], 'B');
    expect(storms[0].key).toBe('B');
    // 'A' → 'B' in C's map, value preserved
    expect('B' in storms[1].initialStrikesByAncestor).toBe(true);
    expect('A' in storms[1].initialStrikesByAncestor).toBe(false);
    expect(storms[1].initialStrikesByAncestor['B']).toBe(200);
    // 'A' → 'B' in D's map; unrelated 'X' entry preserved
    expect('B' in storms[2].initialStrikesByAncestor).toBe(true);
    expect('A' in storms[2].initialStrikesByAncestor).toBe(false);
    expect(storms[2].initialStrikesByAncestor['X']).toBe(80);
  });

  it('does not affect unrelated ancestor map entries', () => {
    const storms: MinTrackedStorm[] = [
      makeStorm({ key: 'A', totalStrikes: 5000 }),
      makeStorm({ key: 'E', initialStrikesByAncestor: { 'X': 100, 'Y': 50 }, totalStrikes: 100 }),
    ];
    adoptKey(storms, storms[0], 'B');
    expect(storms[1].initialStrikesByAncestor).toEqual({ 'X': 100, 'Y': 50 }); // unchanged
  });

  it('correction still applies after key adoption', () => {
    // A absorbs small, adopts small's DB key 'DB-key'
    const storms: MinTrackedStorm[] = [
      makeStorm({ key: 'A', totalStrikes: 8000 }),
      makeStorm({ key: 'C', initialStrikesByAncestor: { 'A': 100 }, totalStrikes: 400 }),
    ];
    adoptKey(storms, storms[0], 'DB-key');
    // C.map = { 'DB-key': 100 }, big.key = 'DB-key'
    const { mergedStrikes } = absorbInto(storms[0], storms[1]);
    // overlapInBig = c.initialStrikesByAncestor['DB-key'] = 100
    // netNew = 400 - 100 = 300
    expect(mergedStrikes).toBe(300);
    expect(storms[0].totalStrikes).toBe(8300);
  });
});

// ── Split detection heuristic ─────────────────────────────────────────────

describe('split detection heuristic', () => {
  const TRACKER_MERGE_KM = 100;
  const SPLIT_DETECT_KM = 200;

  interface ExistingStorm { lat: number; lon: number; key: string; initialStrikesByAncestor: Record<string, number> }

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

  // Mirrors split detection ancestor map population from route.ts
  function buildAncestorMap(parent: ExistingStorm, freshTotal: number): Record<string, number> {
    const map: Record<string, number> = {};
    map[parent.key] = freshTotal; // direct parent overlap = fresh storm's entire total
    for (const [k, v] of Object.entries(parent.initialStrikesByAncestor)) {
      map[k] = Math.min(freshTotal, v); // grandparent overlaps capped at fresh total
    }
    return map;
  }

  it('returns null when no existing storms are within SPLIT_DETECT_KM', () => {
    const parent = detectSplitParent(52, 5, [
      { lat: 48, lon: 5, key: 'far-storm', initialStrikesByAncestor: {} }, // ~444 km away
    ]);
    expect(parent).toBeNull();
  });

  it('detects split when fresh storm is within SPLIT_DETECT_KM but beyond TRACKER_MERGE_KM', () => {
    // ~167 km north — inside split window (100–200 km)
    const parent = detectSplitParent(52, 5, [
      { lat: 50.5, lon: 5, key: 'parent-storm', initialStrikesByAncestor: {} },
    ]);
    expect(parent?.key).toBe('parent-storm');
  });

  it('returns null when fresh storm is within TRACKER_MERGE_KM (would be merged by Phase 1)', () => {
    // ~55 km — Phase 1 consolidation would absorb this
    const parent = detectSplitParent(52, 5, [
      { lat: 51.5, lon: 5, key: 'too-close-storm', initialStrikesByAncestor: {} },
    ]);
    expect(parent).toBeNull();
  });

  it('picks the closest eligible parent', () => {
    const parent = detectSplitParent(52, 5, [
      { lat: 50.5, lon: 5, key: 'closer-parent', initialStrikesByAncestor: {} },  // ~167 km
      { lat: 49, lon: 5, key: 'farther-parent', initialStrikesByAncestor: {} },   // ~333 km — outside window
    ]);
    expect(parent?.key).toBe('closer-parent');
  });

  it('records direct parent overlap and inherits grandparent overlaps with cap', () => {
    // A (parent) has map={'Original':300}. Fresh storm (total=150) splits from A.
    // Fresh.map = { 'A': 150, 'Original': min(150, 300) = 150 }.
    const parentA: ExistingStorm = {
      lat: 52, lon: 5, key: 'A',
      initialStrikesByAncestor: { 'Original': 300 },
    };
    const freshTotal = 150;
    const map = buildAncestorMap(parentA, freshTotal);
    expect(map['A']).toBe(freshTotal);    // direct parent overlap = freshTotal
    expect(map['Original']).toBe(150);    // capped at freshTotal (not 300)
  });

  it('grandchild ancestor map includes grandparent key — absorbInto applies correction', () => {
    // When 'Original' appears in C's map, absorbInto must correct on re-merge.
    const original = makeStorm({ key: 'Original', totalStrikes: 10_000 });
    const c = makeStorm({
      key: 'C',
      initialStrikesByAncestor: { 'Original': 150, 'B': 400 },
      totalStrikes: 400,
    });
    absorbInto(original, c);
    // overlapInBig = c.initialStrikesByAncestor['Original'] = 150
    // netNew = 400 - 150 = 250
    expect(original.totalStrikes).toBe(10_250);
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

// ── accumulateStrikes — no thinning ─────────────────────────────────────
// Mirrors the (now-unconditional) append loop in route.ts's accumulateStrikes:
// every strike is kept, with no cap that halves/decimates allStrikes once it
// grows large. Guards against that cap being silently reintroduced.

function accumulateStrikes(
  storm: Pick<MinTrackedStorm, 'allStrikes' | 'totalStrikes' | 'lastSeen'> & { lastStrikeTime: number },
  members: Array<{ lat: number; lon: number; time: number }>,
): void {
  let newest = storm.lastStrikeTime;
  for (const m of members) {
    if (m.time < storm.lastStrikeTime) continue;
    storm.totalStrikes++;
    storm.allStrikes.push([m.lat, m.lon, m.time]);
    if (m.time > newest) newest = m.time;
  }
  storm.lastStrikeTime = newest;
}

describe('accumulateStrikes — no thinning', () => {
  it('keeps every strike across many passes, well past the old 24k cap', () => {
    const storm = { allStrikes: [] as [number, number, number][], totalStrikes: 0, lastSeen: 0, lastStrikeTime: -1 };
    const passes = 50;
    const perPass = 1000; // 50,000 strikes total — over 2x the old ALL_STRIKES_MAX
    let time = 0;
    for (let pass = 0; pass < passes; pass++) {
      const members = Array.from({ length: perPass }, () => ({ lat: 52, lon: 5, time: time++ }));
      accumulateStrikes(storm, members);
    }
    expect(storm.totalStrikes).toBe(passes * perPass);
    expect(storm.allStrikes.length).toBe(passes * perPass);
  });

  it('skips strikes older than the last-seen time from a previous overlapping pass', () => {
    const storm = { allStrikes: [] as [number, number, number][], totalStrikes: 0, lastSeen: 0, lastStrikeTime: -1 };
    accumulateStrikes(storm, [{ lat: 1, lon: 1, time: 10 }, { lat: 1, lon: 1, time: 20 }]);
    // Overlapping pass: time 15 is older than lastStrikeTime (20) and is skipped,
    // only time 25 is net-new
    accumulateStrikes(storm, [{ lat: 1, lon: 1, time: 15 }, { lat: 1, lon: 1, time: 25 }]);
    expect(storm.totalStrikes).toBe(3);
    expect(storm.allStrikes.length).toBe(3);
  });
});

describe('reportedAbsorbed — event log count accuracy', () => {
  it('Branch 3 (no ancestry) → reported is null, not small.totalStrikes', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 10_000 });
    const small = makeStorm({ key: 'B', totalStrikes: 54_000 }); // fresh independent cluster
    const { mergedStrikes, reported } = absorbInto(big, small);
    expect(mergedStrikes).toBe(54_000); // netNew is full count
    expect(reported).toBeNull();        // must not appear in event log
  });

  it('Branch 1 (split child re-merges) → reported equals delta, not small.totalStrikes', () => {
    // B split from A with 1000 strikes at the time; B grew to 3500
    const big = makeStorm({ key: 'A', totalStrikes: 20_000 });
    const small = makeStorm({ key: 'B', totalStrikes: 3_500 });
    small.initialStrikesByAncestor['A'] = 1_000; // overlap recorded at split time
    const { mergedStrikes, reported } = absorbInto(big, small);
    expect(mergedStrikes).toBe(2_500);  // 3500 - 1000
    expect(reported).toBe(2_500);       // delta is reliable — show it
  });

  it('Branch 2 (reverse re-merge) → reported equals delta, not small.totalStrikes', () => {
    // A was once a child of B (B absorbed A first), now B re-merges into A
    const big = makeStorm({ key: 'A', totalStrikes: 15_000 });
    const small = makeStorm({ key: 'B', totalStrikes: 5_000 });
    big.initialStrikesByAncestor['B'] = 2_000; // big is a descendant of small
    const { mergedStrikes, reported } = absorbInto(big, small);
    expect(mergedStrikes).toBe(3_000);  // 5000 - 2000
    expect(reported).toBe(3_000);
  });

  it('repeated Branch 3 (Batesville pattern) → reported is null every time', () => {
    // Fresh cluster re-emerges with a large accumulated total but no ancestor link.
    // Each absorption has no ancestry tracked — reported must stay null.
    const host = makeStorm({ key: 'HOST', totalStrikes: 5_000 });
    for (let i = 0; i < 3; i++) {
      const fresh = makeStorm({ key: `FRESH-${i}`, totalStrikes: 50_000 + i * 1_000 });
      const { reported } = absorbInto(host, fresh);
      expect(reported).toBeNull();
    }
  });

  it('same numbers but different ancestry → different reported values', () => {
    // Both clusters have 10 000 strikes and will be absorbed into a 50 000-strike host.
    // The one with an ancestor link should produce a delta; the one without should be null.

    const hostWithLink = makeStorm({ key: 'HOST1', totalStrikes: 50_000 });
    const childWithLink = makeStorm({ key: 'CHILD1', totalStrikes: 10_000 });
    childWithLink.initialStrikesByAncestor['HOST1'] = 7_000; // was tracked from a split
    const { reported: reportedWithLink } = absorbInto(hostWithLink, childWithLink);
    expect(reportedWithLink).toBe(3_000); // 10000 - 7000

    const hostNoLink = makeStorm({ key: 'HOST2', totalStrikes: 50_000 });
    const childNoLink = makeStorm({ key: 'CHILD2', totalStrikes: 10_000 });
    // no initialStrikesByAncestor entry → Branch 3
    const { reported: reportedNoLink } = absorbInto(hostNoLink, childNoLink);
    expect(reportedNoLink).toBeNull();
  });

  it('Branch 1 delta never exceeds small.totalStrikes', () => {
    const big = makeStorm({ key: 'A', totalStrikes: 100_000 });
    const small = makeStorm({ key: 'B', totalStrikes: 5_000 });
    small.initialStrikesByAncestor['A'] = 0; // overlap is 0 (split with no strikes yet)
    const { mergedStrikes, reported } = absorbInto(big, small);
    expect(mergedStrikes).toBe(5_000);
    expect(reported).toBe(5_000);
    expect(reported!).toBeLessThanOrEqual(small.totalStrikes);
  });
});
