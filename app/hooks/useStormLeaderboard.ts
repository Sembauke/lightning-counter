'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RankedNeighbor, StormLeaderboardPage } from '../lib/db';
import { compareLeaderboardRows, mergeLeaderboardWindow, nextLeaderboardPageAnchor, rankLeaderboardWindow, trimLeaderboardWindow } from '../lib/stormLeaderboardWindow';

export type LoadLeaderboardPage = (before: string | undefined, signal: AbortSignal) => Promise<StormLeaderboardPage & { reset?: boolean }>;

export function useStormLeaderboard(
  rows: RankedNeighbor[], stormKey: string | null, totalCount: number | undefined,
  loadPage: LoadLeaderboardPage, protectedKeys: React.RefObject<Set<string>>,
) {
  const current = rows.find(row => row.stormKey === stormKey);
  const snapshot = useMemo(() => ({
    stormKey: stormKey ?? '', currentRank: current?.rank ?? 1, rows, hasMoreAbove: (rows[0]?.rank ?? 1) > 1,
  }), [rows, stormKey, current?.rank]);
  const [entries, setEntries] = useState(() => mergeLeaderboardWindow([], snapshot));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const version = useRef(0);
  const request = useRef<AbortController | null>(null);
  const liveCurrent = useMemo(() => current ? {
    ...current, totalCount: totalCount ?? current.totalCount,
  } : null, [current, totalCount]);
  const latestCurrent = useRef(liveCurrent);
  useLayoutEffect(() => { latestCurrent.current = liveCurrent; }, [liveCurrent]);

  useEffect(() => {
    version.current++;
    request.current?.abort();
    request.current = null;
    setLoading(false);
    setError(false);
    setEntries(previous => {
      const merged = mergeLeaderboardWindow(previous, snapshot);
      const own = latestCurrent.current;
      return own ? trimLeaderboardWindow(merged, own, protectedKeys.current) : merged;
    });
  }, [snapshot, protectedKeys]);

  useEffect(() => () => {
    version.current++;
    request.current?.abort();
  }, []);

  const ranked = useMemo(() => liveCurrent
    ? rankLeaderboardWindow(entries, liveCurrent)
    : { rows: rows.map(row => ({ ...row, rankKnown: true })), rankKnown: true, higherCount: 0 }, [entries, liveCurrent, rows]);
  const first = liveCurrent ? nextLeaderboardPageAnchor(entries, liveCurrent) : undefined;
  const ahead = liveCurrent && first ? entries.filter(entry => entry.rankValid !== false && entry.peerRank >= first.peerRank
    && compareLeaderboardRows(entry.row, liveCurrent) < 0).length : 0;
  const canLoad = !!liveCurrent && (first ? first.peerRank > 1 && (ahead < 60 || !ranked.rankKnown) : !ranked.rankKnown);

  const loadMore = useCallback(async () => {
    if (!canLoad || request.current || !liveCurrent) return;
    const controller = new AbortController();
    request.current = controller;
    const generation = version.current;
    const before = first?.row.stormKey;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 8_000);
    setLoading(true);
    setError(false);
    try {
      let page = await loadPage(before, controller.signal);
      if (!before) page = { ...page, reset: true };
      if (!controller.signal.aborted && !page.rows.length && page.anchor) {
        page = { ...await loadPage(undefined, controller.signal), reset: true };
      }
      if (controller.signal.aborted || generation !== version.current) return;
      // A merged/deleted anchor can make a page empty. The loader returns a
      // fresh neighborhood on 404, which is safe to merge by identity as well.
      if (page.stormKey !== stormKey || !Number.isInteger(page.currentRank) || page.currentRank < 1
        || !Array.isArray(page.rows) || page.rows.some(row => !row.stormKey || !Number.isInteger(row.rank)
          || row.rank < 1 || !Number.isFinite(row.totalCount))) throw new Error('Invalid leaderboard page');
      if (!page.rows.length && (first?.peerRank ?? 2) > 1) throw new Error('Empty leaderboard page');
      setEntries(previous => {
        if (controller.signal.aborted || generation !== version.current) return previous;
        const base = page.reset ? [] : previous.filter(entry => !page.anchor
          || page.anchor.stormKey === before || entry.row.stormKey !== before);
        return trimLeaderboardWindow(
          mergeLeaderboardWindow(base, page), latestCurrent.current ?? liveCurrent, protectedKeys.current,
        );
      });
    } catch {
      if ((!controller.signal.aborted || timedOut) && generation === version.current) setError(true);
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [canLoad, first, liveCurrent, loadPage, protectedKeys, stormKey]);

  useEffect(() => {
    // Leave room for the visible rows, request latency, and a fast burst. Each
    // request still fetches only ten; the retained buffer is bounded separately.
    if ((ahead < 30 || !ranked.rankKnown) && canLoad && !loading && !error) void loadMore();
  }, [ahead, ranked.rankKnown, canLoad, loading, error, loadMore]);

  const latestLoad = useRef(loadMore);
  useEffect(() => { latestLoad.current = loadMore; }, [loadMore]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => { void latestLoad.current(); }, 5_000);
    return () => window.clearTimeout(timer);
  }, [error]);

  return {
    ...ranked, loading, error, moreAbove: !!first && first.peerRank > 1,
    loadMore: () => { if (!error) void loadMore(); },
    retry: () => { setError(false); void loadMore(); },
  };
}
