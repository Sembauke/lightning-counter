import { describe, expect, it } from 'vitest';
import type { RankedNeighbor, StormLeaderboardPage } from '../app/lib/db';
import {
  compareLeaderboardRows, mergeLeaderboardWindow, nextLeaderboardPageAnchor, rankLeaderboardWindow, trimLeaderboardWindow,
  type LeaderboardEntry,
} from '../app/lib/stormLeaderboardWindow';

function row(stormKey: string, totalCount: number, rank = 1): RankedNeighbor {
  return { stormKey, totalCount, rank, code: 'FR', lat: 45, lon: 4, city: null, originCity: null, date: '2026-09-10' };
}

function standings(peers: RankedNeighbor[], current: RankedNeighbor): RankedNeighbor[] {
  return [...peers, current].sort(compareLeaderboardRows).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function page(all: RankedNeighbor[], currentKey: string, from: number, to: number): StormLeaderboardPage {
  const rows = all.filter(entry => entry.rank >= from && entry.rank <= to);
  return {
    stormKey: currentKey, currentRank: all.find(entry => entry.stormKey === currentKey)!.rank,
    rows, hasMoreAbove: (rows[0]?.rank ?? 1) > 1,
  };
}

const peers = Array.from({ length: 100 }, (_, index) => row(`peer-${String(index + 1).padStart(3, '0')}`, 1_000 - index * 10));

describe('buffered storm leaderboard', () => {
  it('prepends the next ten competitors without dropping the existing neighborhood or including the current storm twice', () => {
    const all = standings(peers, row('current', 755));
    const initial = page(all, 'current', 16, 36);
    const initialEntries = mergeLeaderboardWindow([], initial);
    const expanded = mergeLeaderboardWindow(initialEntries, page(all, 'current', 6, 15));

    expect(initial.currentRank).toBe(26);
    expect(initialEntries).toHaveLength(20);
    expect(expanded).toHaveLength(30);
    expect(expanded.some(entry => entry.row.stormKey === 'current')).toBe(false);
    expect(expanded.slice(10)).toEqual(initialEntries);
    expect(expanded.map(entry => entry.peerRank)).toEqual(Array.from({ length: 30 }, (_, index) => index + 6));
  });

  it('keeps exact global ranks while live strikes pass several competitors between server refreshes', () => {
    const all = standings(peers, row('current', 755));
    const original = all.find(entry => entry.stormKey === 'current')!;
    const entries = mergeLeaderboardWindow([], page(all, 'current', 6, 36));

    for (const totalCount of [756, 795, 835, 875, 900]) {
      const live = { ...original, totalCount };
      const result = rankLeaderboardWindow(entries, live);
      const expected = new Map(standings(peers, live).map(entry => [entry.stormKey, entry.rank]));
      expect(result.rankKnown).toBe(true);
      expect(result.rows.map(entry => [entry.stormKey, entry.rank])).toEqual(
        result.rows.map(entry => [entry.stormKey, expected.get(entry.stormKey)]),
      );
      expect(result.rows.find(entry => entry.stormKey === 'current')!.totalCount).toBe(totalCount);
    }
  });

  it('preserves buffered neighbors when a poll moves the server neighborhood upward', () => {
    const before = standings(peers, row('current', 755));
    const entries = mergeLeaderboardWindow([], page(before, 'current', 6, 36));
    const after = standings(peers, row('current', 875));
    const poll = page(after, 'current', 4, 24);
    const refreshed = mergeLeaderboardWindow(entries, poll);
    const result = rankLeaderboardWindow(refreshed, after.find(entry => entry.stormKey === 'current')!);

    expect(refreshed.map(entry => entry.peerRank)).toEqual(Array.from({ length: 32 }, (_, index) => index + 4));
    expect(refreshed.filter(entry => entry.peerRank >= 24)).toEqual(entries.filter(entry => entry.peerRank >= 24));
    expect(new Set(result.rows.map(entry => entry.stormKey)).size).toBe(result.rows.length);
    expect(result.rankKnown).toBe(true);
    expect(result.rows.find(entry => entry.stormKey === 'current')!.rank).toBe(14);
  });

  it('refreshes totals and removes replaced peers inside the fetched interval without resetting rows outside it', () => {
    const previous: LeaderboardEntry[] = [
      { row: row('ahead', 100, 1), peerRank: 1 },
      { row: row('removed', 90, 2), peerRank: 2 },
      { row: row('moved', 80, 3), peerRank: 3 },
      { row: row('behind', 10, 5), peerRank: 4 },
    ];
    const refreshed = mergeLeaderboardWindow(previous, {
      stormKey: 'current', currentRank: 4, hasMoreAbove: true,
      rows: [row('replacement', 92, 2), row('moved', 85, 3)],
    });

    expect(refreshed.map(entry => [entry.row.stormKey, entry.peerRank, entry.row.totalCount])).toEqual([
      ['ahead', 1, 100], ['replacement', 2, 92], ['moved', 3, 85], ['behind', 4, 10],
    ]);
    expect(refreshed[0]).toBe(previous[0]);
    expect(refreshed[3]).toBe(previous[3]);
  });

  it('deduplicates overlapping pages by identity even when an incoming storm moved from outside the refreshed interval', () => {
    const previous: LeaderboardEntry[] = [
      { row: row('rising', 10, 40), peerRank: 39 },
      { row: row('stable', 5, 41), peerRank: 40 },
    ];
    const incoming: StormLeaderboardPage = {
      stormKey: 'current', currentRank: 30, hasMoreAbove: true, rows: [row('rising', 300, 20)],
    };
    const first = mergeLeaderboardWindow(previous, incoming);
    expect(first.map(entry => [entry.row.stormKey, entry.peerRank])).toEqual([['rising', 20], ['stable', 40]]);
    expect(mergeLeaderboardWindow(first, incoming)).toEqual(first);
  });

  it('does not claim a precise rank when the live total outruns the earliest buffered competitor', () => {
    const all = standings(peers, row('current', 755));
    const entries = mergeLeaderboardWindow([], page(all, 'current', 16, 36));
    const live = { ...all.find(entry => entry.stormKey === 'current')!, totalCount: 935 };
    const result = rankLeaderboardWindow(entries, live);

    expect(result.rankKnown).toBe(false);
    expect(result.higherCount).toBe(0);

    const expanded = mergeLeaderboardWindow(entries, page(all, 'current', 6, 15));
    const recovered = rankLeaderboardWindow(expanded, live);
    expect(recovered.rankKnown).toBe(true);
    expect(recovered.rows.find(entry => entry.stormKey === 'current')!.rank).toBe(8);
  });

  it('does not invent a contiguous rank across a missing page', () => {
    const entries: LeaderboardEntry[] = [
      { row: row('above', 200, 10), peerRank: 10 },
      { row: row('below', 100, 31), peerRank: 30 },
    ];
    const result = rankLeaderboardWindow(entries, row('current', 150, 25));
    expect(result.rankKnown).toBe(false);
    expect(result.rows.filter(entry => entry.stormKey !== 'current').map(entry => entry.rank)).toEqual([10, 31]);
  });

  it('recognizes first place only when the actual first competitor is loaded', () => {
    const all = standings(peers, row('current', 755));
    const current = { ...all.find(entry => entry.stormKey === 'current')!, totalCount: 1_100 };
    const entries = mergeLeaderboardWindow([], page(all, 'current', 1, 10));
    const result = rankLeaderboardWindow(entries, current);
    expect(result.rankKnown).toBe(true);
    expect(result.rows[0]).toMatchObject({ stormKey: 'current', rank: 1 });
    expect(result.rows[1]).toMatchObject({ stormKey: 'peer-001', rank: 2 });
  });

  it('keeps equal-count storms in deterministic key order across page merges and local crossings', () => {
    const all = standings([row('a', 100), row('z', 100), row('tail', 50)], row('m', 99));
    const entries = mergeLeaderboardWindow([], page(all, 'm', 1, 4));
    const result = rankLeaderboardWindow(entries, { ...all.find(entry => entry.stormKey === 'm')!, totalCount: 100 });
    expect(result.rankKnown).toBe(true);
    expect(result.rows.map(entry => [entry.stormKey, entry.rank])).toEqual([['a', 1], ['m', 2], ['z', 3], ['tail', 4]]);
    expect(rankLeaderboardWindow([...entries].reverse(), { ...row('m', 100), rank: 3 }).rows).toEqual(result.rows);
  });

  it('retains the existing buffer when the cursor reaches an empty page at the top', () => {
    const all = standings(peers, row('current', 755));
    const entries = mergeLeaderboardWindow([], page(all, 'current', 1, 36));
    expect(mergeLeaderboardWindow(entries, {
      stormKey: 'current', currentRank: 26, hasMoreAbove: false, rows: [],
    })).toEqual(entries);
  });

  it('bounds the normal buffer to sixty ahead and twenty behind while retaining protected visible or focused rows', () => {
    const all = standings(peers, row('current', 355));
    const current = all.find(entry => entry.stormKey === 'current')!;
    const entries = mergeLeaderboardWindow([], page(all, 'current', 1, 101));
    const protectedKeys = new Set(['peer-001', 'peer-100']);
    const trimmed = trimLeaderboardWindow(entries, current, protectedKeys);

    expect(trimmed).toHaveLength(82);
    expect(trimmed.filter(entry => !protectedKeys.has(entry.row.stormKey)).map(entry => entry.peerRank)).toEqual(
      Array.from({ length: 80 }, (_, index) => index + 6),
    );
    expect(trimmed.filter(entry => protectedKeys.has(entry.row.stormKey)).map(entry => entry.row.stormKey)).toEqual(['peer-001', 'peer-100']);
    expect(entries).toHaveLength(100);
    expect(trimLeaderboardWindow(trimmed, current)).toHaveLength(80);
  });

  it('keeps the shorter available buffer at first and last place without deleting the current storm from the ranked result', () => {
    for (const totalCount of [1_100, 1]) {
      const all = standings(peers, row('current', totalCount));
      const current = all.find(entry => entry.stormKey === 'current')!;
      const entries = mergeLeaderboardWindow([], page(all, 'current', 1, 101));
      const trimmed = trimLeaderboardWindow(entries, current);
      const ranked = rankLeaderboardWindow(trimmed, current);
      expect(trimmed).toHaveLength(totalCount === 1_100 ? 20 : 60);
      expect(ranked.rankKnown).toBe(true);
      expect(ranked.rows.find(entry => entry.stormKey === 'current')!.rank).toBe(current.rank);
    }
  });

  it('loads above the contiguous band beside the current storm even when a protected first-place row is retained', () => {
    const all = standings(peers, row('current', 755));
    const current = all.find(entry => entry.stormKey === 'current')!;
    const entries = mergeLeaderboardWindow([], page(all, 'current', 16, 36));
    const retained = mergeLeaderboardWindow(entries, page(all, 'current', 1, 1));
    expect(nextLeaderboardPageAnchor(retained, current)?.row.stormKey).toBe('peer-016');
    expect(nextLeaderboardPageAnchor([...retained].reverse(), current)?.row.stormKey).toBe('peer-016');
  });

  it('loads into a missing interval from the lower band when a rising storm lies between disconnected pages', () => {
    const all = standings(peers, row('current', 755));
    const current = { ...all.find(entry => entry.stormKey === 'current')!, totalCount: 850 };
    const lower = mergeLeaderboardWindow([], page(all, 'current', 20, 36));
    const entries = mergeLeaderboardWindow(lower, page(all, 'current', 1, 10));
    expect(rankLeaderboardWindow(entries, current).rankKnown).toBe(false);
    expect(nextLeaderboardPageAnchor(entries, current)?.row.stormKey).toBe('peer-020');

    const joined = mergeLeaderboardWindow(entries, page(all, 'current', 10, 19));
    expect(rankLeaderboardWindow(joined, current).rankKnown).toBe(true);
    expect(nextLeaderboardPageAnchor(joined, current)?.row.stormKey).toBe('peer-001');
  });

  it('chooses the adjacent band at either end and handles an empty buffer', () => {
    const all = standings(peers, row('current', 755));
    const entries = mergeLeaderboardWindow([], page(all, 'current', 16, 36));
    expect(nextLeaderboardPageAnchor(entries, row('current', 1_100))?.row.stormKey).toBe('peer-016');
    expect(nextLeaderboardPageAnchor(entries, row('current', 1))?.row.stormKey).toBe('peer-016');
    expect(nextLeaderboardPageAnchor([], row('current', 500))).toBeUndefined();
  });

  it('keeps cached rows in place but refreshes stale ordinals in whole pages after higher-ranked storms disappear', () => {
    const before = standings(peers, row('current', 355));
    const entries = mergeLeaderboardWindow([], page(before, 'current', 46, 76));
    const after = standings(peers.slice(10), row('current', 355));
    const current = after.find(entry => entry.stormKey === 'current')!;
    const refreshed = mergeLeaderboardWindow(entries, page(after, 'current', 46, 66));
    const beforeOrder = rankLeaderboardWindow(entries, before.find(entry => entry.stormKey === 'current')!).rows;
    const afterOrder = rankLeaderboardWindow(refreshed, current).rows;

    expect(afterOrder.map(entry => entry.stormKey)).toEqual(beforeOrder.map(entry => entry.stormKey));
    expect(refreshed.filter(entry => entry.rankValid === false).map(entry => entry.row.stormKey)).toEqual(
      Array.from({ length: 10 }, (_, index) => `peer-${String(index + 46).padStart(3, '0')}`),
    );
    expect(rankLeaderboardWindow(refreshed, current).rankKnown).toBe(true);
    expect(afterOrder.find(entry => entry.stormKey === 'current')!.rank).toBe(56);
    expect(afterOrder.filter(entry => !entry.rankKnown).map(entry => entry.stormKey)).toEqual(
      Array.from({ length: 10 }, (_, index) => `peer-${String(index + 46).padStart(3, '0')}`),
    );
    const anchor = nextLeaderboardPageAnchor(refreshed, current)!;
    expect(anchor.row.stormKey).toBe('peer-056');
    expect(anchor.peerRank).toBe(46);

    const next = mergeLeaderboardWindow(refreshed, {
      ...page(after, 'current', 36, 45), anchor: after.find(entry => entry.stormKey === anchor.row.stormKey),
    });
    expect(next.every(entry => entry.rankValid)).toBe(true);
    expect(rankLeaderboardWindow(next, current).rows.every(entry => entry.rankKnown)).toBe(true);
    expect(next.map(entry => entry.peerRank)).toEqual(Array.from({ length: 30 }, (_, index) => index + 36));
    expect(nextLeaderboardPageAnchor(next, current)?.row.stormKey).toBe('peer-046');
    expect(nextLeaderboardPageAnchor(next, current)?.row.stormKey).not.toBe(anchor.row.stormKey);
    expect(rankLeaderboardWindow(next, current).rows.map(entry => entry.stormKey)).toEqual(afterOrder.map(entry => entry.stormKey));
  });

  it('does not trust stale cached ranks when live strikes outrun the freshly polled band', () => {
    const before = standings(peers, row('current', 355));
    const entries = mergeLeaderboardWindow([], page(before, 'current', 46, 76));
    const after = standings(peers.slice(10), row('current', 355));
    const refreshed = mergeLeaderboardWindow(entries, page(after, 'current', 46, 66));
    const live = { ...after.find(entry => entry.stormKey === 'current')!, totalCount: 455 };
    expect(rankLeaderboardWindow(refreshed, live).rankKnown).toBe(false);
    expect(rankLeaderboardWindow(refreshed, live).higherCount).toBe(0);
    expect(nextLeaderboardPageAnchor(refreshed, live)?.row.stormKey).toBe('peer-056');

    const restored = mergeLeaderboardWindow(refreshed, {
      ...page(after, 'current', 36, 45), anchor: after.find(entry => entry.stormKey === 'peer-056'),
    });
    const result = rankLeaderboardWindow(restored, live);
    expect(result.rankKnown).toBe(true);
    expect(result.rows.find(entry => entry.stormKey === 'current')!.rank).toBe(46);
  });

  it('uses updated cursor metadata to join the fetched page rather than requesting the same stale boundary repeatedly', () => {
    const original: LeaderboardEntry[] = [
      { row: row('anchor', 500, 30), peerRank: 30 },
      { row: row('below', 100, 32), peerRank: 31 },
    ];
    const updated = mergeLeaderboardWindow(original, {
      stormKey: 'current', currentRank: 21, hasMoreAbove: true,
      rows: [row('fresh-before', 600, 19)], anchor: row('anchor', 500, 20),
    });
    expect(updated.find(entry => entry.row.stormKey === 'anchor')).toMatchObject({ peerRank: 20, rankValid: true });
    expect(updated.find(entry => entry.row.stormKey === 'below')?.rankValid).toBe(false);
    expect(nextLeaderboardPageAnchor(updated, row('current', 300, 21))?.row.stormKey).toBe('fresh-before');
  });

  it('does not re-invalidate newer metadata when old invalid rows are fetched at their new ranks', () => {
    const previous: LeaderboardEntry[] = [
      { row: row('old', 600, 30), peerRank: 30, rankValid: false },
      { row: row('fresh', 500, 21), peerRank: 21, rankValid: true },
    ];
    const refreshed = mergeLeaderboardWindow(previous, {
      stormKey: 'current', currentRank: 22, hasMoreAbove: true, rows: [row('old', 600, 20)],
    });
    expect(refreshed.map(entry => [entry.row.stormKey, entry.peerRank, entry.rankValid])).toEqual([
      ['old', 20, true], ['fresh', 21, true],
    ]);
    expect(nextLeaderboardPageAnchor(refreshed, row('current', 400, 22))?.row.stormKey).toBe('old');
  });

  it('does not claim a known rank from an entirely invalid cache', () => {
    const entries: LeaderboardEntry[] = [{ row: row('old-first', 1_000), peerRank: 1, rankValid: false }];
    expect(rankLeaderboardWindow(entries, row('current', 2_000)).rankKnown).toBe(false);
    expect(rankLeaderboardWindow(entries, row('current', 2_000)).rows.every(entry => !entry.rankKnown)).toBe(true);
    expect(nextLeaderboardPageAnchor(entries, row('current', 2_000))).toBeUndefined();
  });
});
