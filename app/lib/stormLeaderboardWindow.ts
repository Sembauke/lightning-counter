import type { RankedNeighbor, StormLeaderboardPage } from './db';

export interface LeaderboardEntry {
  row: RankedNeighbor;
  /** Ordinal among competitors, excluding the storm receiving live strikes. */
  peerRank: number;
  /** Cached rows can stay visible while their older ordinal is refreshed. */
  rankValid?: boolean;
}

export function compareLeaderboardRows(a: RankedNeighbor, b: RankedNeighbor): number {
  return b.totalCount - a.totalCount || (a.stormKey < b.stormKey ? -1 : a.stormKey > b.stormKey ? 1 : 0);
}

export function mergeLeaderboardWindow(
  previous: LeaderboardEntry[], page: StormLeaderboardPage,
): LeaderboardEntry[] {
  const pageRows = page.anchor ? [...page.rows, page.anchor] : page.rows;
  const incoming: LeaderboardEntry[] = pageRows.filter(row => row.stormKey !== page.stormKey).map(row => ({
    row,
    peerRank: row.rank - (row.rank > page.currentRank ? 1 : 0),
    rankValid: true,
  }));
  const previousByKey = new Map(previous.map(entry => [entry.row.stormKey, entry]));
  const ranksShifted = incoming.some(entry => {
    const before = previousByKey.get(entry.row.stormKey);
    return before && before.rankValid !== false && before.peerRank !== entry.peerRank;
  });
  const low = Math.min(...incoming.map(entry => entry.peerRank));
  const high = Math.max(...incoming.map(entry => entry.peerRank));
  // A changed trusted ordinal means the cached snapshot no longer shares the
  // same rank coordinates (for example, other storms merged). Keep its rows
  // visible, but refresh their ordinals before using them to rank or page.
  // Refreshing an already-invalid entry must not invalidate newer pages again.
  const retained = ranksShifted ? previous.map(entry => ({ ...entry, rankValid: false })) : previous;
  // Replace a refreshed interval only in the same trusted coordinates. An old
  // invalid ordinal cannot prove that a row belongs to the returned interval.
  const byKey = new Map(retained.filter(entry => entry.rankValid === false || entry.peerRank < low || entry.peerRank > high)
    .map(entry => [entry.row.stormKey, entry]));
  for (const entry of incoming) byKey.set(entry.row.stormKey, entry);
  return [...byKey.values()].sort((a, b) => a.peerRank - b.peerRank);
}

export function rankLeaderboardWindow(entries: LeaderboardEntry[], current: RankedNeighbor) {
  const peers = [...entries].sort((a, b) => compareLeaderboardRows(a.row, b.row));
  const trusted = peers.filter(entry => entry.rankValid !== false);
  const higher = trusted.filter(entry => compareLeaderboardRows(entry.row, current) < 0);
  const lower = trusted.filter(entry => compareLeaderboardRows(entry.row, current) > 0);
  const above = higher.at(-1);
  const below = lower[0];
  const rankKnown = above && below ? below.peerRank === above.peerRank + 1
    : !above && below ? below.peerRank === 1
      : above ? current.rank === above.peerRank + 1 : peers.length === 0;
  const rank = above ? above.peerRank + 1 : below?.peerRank ?? current.rank;
  const rows: Array<RankedNeighbor & { rankKnown: boolean }> = peers.map(({ row, peerRank, rankValid }) => ({
    ...row, rank: peerRank + (compareLeaderboardRows(row, current) > 0 ? 1 : 0), rankKnown: rankValid !== false,
  }));
  rows.push({ ...current, rank, rankKnown });
  rows.sort(compareLeaderboardRows);
  return { rows, rankKnown, higherCount: higher.length };
}

/**
 * Load above the contiguous band nearest the live storm. A row kept because it
 * is focused or visible may belong to a distant page; paging above that row
 * would leave the intervening competitors permanently missing.
 */
export function nextLeaderboardPageAnchor(
  entries: LeaderboardEntry[], current: RankedNeighbor,
): LeaderboardEntry | undefined {
  const ordered = entries.filter(entry => entry.rankValid !== false).sort((a, b) => compareLeaderboardRows(a.row, b.row));
  // When the current rank lies in a gap, extend the lower band upward into that
  // gap. If every loaded row is above the storm, start at the nearest higher row.
  let index = ordered.findIndex(entry => compareLeaderboardRows(entry.row, current) > 0);
  if (index === -1) index = ordered.length - 1;
  if (index < 0) return undefined;
  while (index > 0 && ordered[index - 1].peerRank === ordered[index].peerRank - 1) index--;
  return ordered[index];
}

/** Keep the useful area around the storm, plus rows currently being read. */
export function trimLeaderboardWindow(
  entries: LeaderboardEntry[], current: RankedNeighbor, protectedKeys: Set<string> = new Set(),
): LeaderboardEntry[] {
  const ranked = rankLeaderboardWindow(entries, current);
  const index = ranked.rows.findIndex(row => row.stormKey === current.stormKey);
  const keep = new Set(ranked.rows.slice(Math.max(0, index - 60), index + 21).map(row => row.stormKey));
  return entries.filter(entry => keep.has(entry.row.stormKey) || protectedKeys.has(entry.row.stormKey));
}
