/**
 * Reproduces and fixes a "replay ends abruptly" bug: the storm detail page's
 * replay map derives its min/max time purely from the persisted `strikes`
 * blob, so if that blob's last stored point isn't actually the storm's true
 * final strike, the replay visibly stops short of the storm's real end.
 *
 * accumulateStrikes (app/api/strikes/route.ts) sub-samples appends once a
 * storm's allStrikes array exceeds ALL_STRIKES_MAX: only every `keepEvery`-th
 * new strike gets pushed, and keepEvery doubles every time the cap is
 * exceeded again. For a long-lived storm keepEvery can grow large (tens),
 * and a later, quieter pass can easily produce fewer new strikes than
 * keepEvery — in which case NONE of that pass's strikes land on the
 * `appendSeq % keepEvery === 0` boundary except possibly an early one,
 * leaving the stored tail stuck well behind the storm's true last-seen
 * moment even though totalStrikes (the numeric counter, unaffected by this
 * sub-sampling) keeps advancing correctly.
 *
 * The fix guarantees the pass's true newest strike is always represented in
 * the persisted blob, pushed after thinning so the halving filter can't be
 * the thing that drops it — bounding the replay's lag behind the storm's
 * real end to a single ~30s tracker pass instead of however large keepEvery
 * has grown.
 */
import { describe, it, expect } from 'vitest';

type StormStrike = [number, number, number];
interface Member { lat: number; lon: number; time: number }
interface MinStorm {
  allStrikes: StormStrike[];
  lastStrikeTime: number;
  totalStrikes: number;
  keepEvery: number;
  appendSeq: number;
}

function freshStorm(): MinStorm {
  return { allStrikes: [], lastStrikeTime: 0, totalStrikes: 0, keepEvery: 1, appendSeq: 0 };
}

function roundPt(m: Member): StormStrike {
  return [Math.round(m.lat * 1000) / 1000, Math.round(m.lon * 1000) / 1000, m.time];
}

/** Mirrors accumulateStrikes before the tail-guarantee fix. */
function accumulateOld(st: MinStorm, members: Member[], cap: number): void {
  let newest = st.lastStrikeTime;
  for (const m of members) {
    if (m.time <= st.lastStrikeTime) continue;
    st.totalStrikes++;
    if (st.appendSeq++ % st.keepEvery === 0) st.allStrikes.push(roundPt(m));
    if (m.time > newest) newest = m.time;
  }
  st.lastStrikeTime = newest;
  if (st.allStrikes.length > cap) {
    st.keepEvery *= 2;
    st.allStrikes = st.allStrikes.filter((_, i) => i % 2 === 0);
  }
}

/** Mirrors the fixed accumulateStrikes. */
function accumulateFixed(st: MinStorm, members: Member[], cap: number): void {
  let newest = st.lastStrikeTime;
  let newestMember: Member | null = null;
  for (const m of members) {
    if (m.time <= st.lastStrikeTime) continue;
    st.totalStrikes++;
    if (st.appendSeq++ % st.keepEvery === 0) st.allStrikes.push(roundPt(m));
    if (m.time > newest) { newest = m.time; newestMember = m; }
  }
  st.lastStrikeTime = newest;
  if (st.allStrikes.length > cap) {
    st.keepEvery *= 2;
    st.allStrikes = st.allStrikes.filter((_, i) => i % 2 === 0);
  }
  if (newestMember) {
    const p = roundPt(newestMember);
    const last = st.allStrikes[st.allStrikes.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1] || last[2] !== p[2]) st.allStrikes.push(p);
  }
}

describe('replay tail continuity', () => {
  const CAP = 500;

  it('reproduces the bug: with keepEvery grown large, a quiet pass leaves the stored tail behind the true last strike', () => {
    const st = freshStorm();
    st.keepEvery = 16; // simulates a long-lived storm where earlier thinning has already grown this
    const members = Array.from({ length: 10 }, (_, i) => ({ lat: 40, lon: 10, time: 1000 + i })); // fewer than keepEvery
    accumulateOld(st, members, CAP);
    const trueLastTime = members[members.length - 1].time;

    expect(st.totalStrikes).toBe(10); // the numeric counter is unaffected — it's correct
    expect(st.allStrikes.length).toBe(1); // only appendSeq=0 landed on the 0 % 16 boundary
    expect(st.allStrikes[0][2]).toBeLessThan(trueLastTime); // stored tail stuck near the pass's start
  });

  it('fixed: the stored tail always equals the true last strike, even with the same quiet, heavily-thinned pass', () => {
    const st = freshStorm();
    st.keepEvery = 16;
    const members = Array.from({ length: 10 }, (_, i) => ({ lat: 40, lon: 10, time: 1000 + i }));
    accumulateFixed(st, members, CAP);
    const trueLastTime = members[members.length - 1].time;

    expect(st.totalStrikes).toBe(10);
    const tail = st.allStrikes[st.allStrikes.length - 1];
    expect(tail[2]).toBe(trueLastTime);
  });

  it('fixed: tail correctness holds after every pass across a long, heavily-thinned storm life', () => {
    const st = freshStorm();
    let trueLastTime = 0;
    for (let pass = 0; pass < 80; pass++) {
      // Later passes taper off (storm dying down) — fewer strikes per pass,
      // exactly the scenario that starves the keepEvery modulo of a hit.
      const count = pass < 40 ? 50 : 3;
      const members = Array.from({ length: count }, (_, i) => ({ lat: 40, lon: 10, time: pass * 10_000 + i }));
      accumulateFixed(st, members, CAP);
      trueLastTime = members[members.length - 1].time;
      expect(st.allStrikes[st.allStrikes.length - 1][2]).toBe(trueLastTime);
    }
    expect(st.keepEvery).toBeGreaterThan(1); // confirm heavy thinning actually happened in this run
  });

  it('fixed: no literal duplicate pushed when normal sub-sampling already kept the true latest strike', () => {
    const st = freshStorm(); // keepEvery=1 — nothing gets skipped
    accumulateFixed(st, [{ lat: 1, lon: 1, time: 100 }, { lat: 2, lon: 2, time: 200 }], CAP);
    expect(st.allStrikes).toEqual([[1, 1, 100], [2, 2, 200]]);
  });

  it('fixed: guarantees the true max-time member even when it does not arrive last in the members array', () => {
    // cluster.members order comes from grid-cell Map iteration, not time order.
    const st = freshStorm();
    st.keepEvery = 5;
    accumulateFixed(st, [
      { lat: 1, lon: 1, time: 300 },
      { lat: 2, lon: 2, time: 100 },
      { lat: 3, lon: 3, time: 500 }, // true max, arrives in the middle
      { lat: 4, lon: 4, time: 200 },
    ], CAP);
    expect(st.allStrikes[st.allStrikes.length - 1][2]).toBe(500);
  });
});
