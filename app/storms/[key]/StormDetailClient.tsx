'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../../lib/format';
import CountryFlag from '../../components/CountryFlag';
import type { BiggestStorm, GlobalStormRecord, StormStrike, RankedNeighbor } from '../../lib/db';
import { useStormMerge } from '../../context/StormMergeContext';
import { latestReplayTime, replayStrikeKey, shouldPollStormReplay } from '../../lib/stormReplayState';
import { buildStormTimeline, type StormMinuteBucket } from '../../lib/stormTimeline';

const StormReplayMap = dynamic(() => import('../../components/StormReplayMap'), { ssr: false });

function rankBadgeClass(rank: number): string {
  if (rank === 1) return ' storm-leaderboard-row--gold';
  if (rank === 2) return ' storm-leaderboard-row--silver';
  if (rank === 3) return ' storm-leaderboard-row--bronze';
  if (rank <= 10) return ' storm-leaderboard-row--top10';
  return '';
}

function stormLabel(
  ts: (key: string, values?: Record<string, string>) => string,
  city: string | null, originCity: string | null, code: string, lat: number, lon: number,
): string {
  const isOcean = code === 'XO';
  const effCity = city ?? (isOcean ? 'Open Ocean' : null);
  const effOrigin = originCity ?? (isOcean ? 'Open Ocean' : null);
  return effOrigin && effCity && effOrigin !== effCity
    ? ts('stormFromTo', { from: effOrigin, to: effCity })
    : effCity
      ? ts('stormNear', { city: effCity })
      : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

function TimelineChart({ timeline }: { timeline: StormMinuteBucket[] }) {
  const maxCount = Math.max(...timeline.map(t => t.count), 1);
  const peakTs = timeline.find(t => t.count === maxCount)?.ts;
  const W = 800, H = 100, PX = 4, PY = 6;
  const barW = (W - PX * 2) / Math.max(timeline.length, 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="timeline-chart" aria-label="Strike intensity chart">
      {timeline.map((t, i) => {
        const h = (t.count / maxCount) * (H - PY * 2);
        const isPeak = t.ts === peakTs;
        const alpha = (0.25 + 0.75 * (t.count / maxCount)).toFixed(2);
        const fill = isPeak ? '#ffe566' : `rgba(255,210,50,${alpha})`;
        return (
          <rect key={t.ts}
            x={PX + i * barW}
            y={H - PY - h}
            width={Math.max(0.5, barW - 0.8)}
            height={h}
            fill={fill}
          />
        );
      })}
    </svg>
  );
}




const POLL_INTERVAL_MS = 15_000;

interface PollResponse {
  strikes: StormStrike[];
  endTime: number | null;
  totalCount: number | null;
  count: number;
  rate: number;
  startTime: number | null;
  traveledKm: number | null;
  city: string | null;
  originCity: string | null;
  nearbyRanked: RankedNeighbor[];
}

interface LiveStats {
  endTime: number | null;
  totalCount: number | null;
  count: number;
  rate: number;
  startTime: number | null;
  traveledKm: number | null;
  city: string | null;
  originCity: string | null;
}

export default function StormDetailClient({
  storm, records, nearbyRanked,
}: {
  storm: BiggestStorm;
  records: GlobalStormRecord[];
  nearbyRanked: RankedNeighbor[];
}) {
  const ts = useTranslations('storms');
  const countryName = useCountryName();
  const { mergeMap } = useStormMerge();
  const mergeStatus = storm.stormKey ? mergeMap.get(storm.stormKey) : undefined;

  const [liveStats, setLiveStats] = useState<LiveStats>({
    endTime: storm.endTime,
    totalCount: storm.totalCount,
    count: storm.count,
    rate: storm.rate,
    startTime: storm.startTime,
    traveledKm: storm.traveledKm,
    city: storm.city,
    originCity: storm.originCity,
  });
  // endTime is always a timestamp (last tracker flush); treat storm as live
  // if it was active within the last 10 minutes — same logic as the storms list.
  const isLive = liveStats.endTime != null && Date.now() - liveStats.endTime < 10 * 60_000;

  // Tick every minute so the live duration KPI re-renders without waiting for a poll
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [isLive]);

  const [appendedStrikes, setAppendedStrikes] = useState<StormStrike[]>([]);
  // Counts SSE strikes since last DB flush so the counter ticks in real-time
  const [appendedSinceFlush, setAppendedSinceFlush] = useState(0);
  const latestTsRef = useRef((() => {
    let max = 0;
    if (storm.strikes) for (const s of storm.strikes) if (s[2] > max) max = s[2];
    return max;
  })());
  const seenReplayStrikesRef = useRef(new Set((storm.strikes ?? []).map(replayStrikeKey)));
  const shouldPoll = shouldPollStormReplay(liveStats.endTime, latestTsRef.current);

  const appendUnseenStrikes = (batch: StormStrike[]) => {
    const fresh = batch.filter(strike => {
      const key = replayStrikeKey(strike);
      if (seenReplayStrikesRef.current.has(key)) return false;
      seenReplayStrikesRef.current.add(key);
      return true;
    });
    if (fresh.length) {
      latestTsRef.current = Math.max(latestTsRef.current, latestReplayTime(fresh));
      setAppendedStrikes(prev => [...prev, ...fresh]);
    }
    return fresh.length;
  };

  const [displayNearbyRanked, setDisplayNearbyRanked] = useState(nearbyRanked);
  const [leaderboardFlashKeys, setLeaderboardFlashKeys] = useState<Set<string>>(new Set());
  // Rank numbers actually shown — held back until a reorder's slide animation
  // finishes, so the number changes after the row visually arrives, not before
  const [displayedRanks, setDisplayedRanks] = useState<Map<string, number>>(
    () => new Map(nearbyRanked.map(n => [n.stormKey, n.rank])),
  );

  // Refs for the leaderboard's FLIP reorder animation (set up below, once stormTotal exists)
  const leaderboardRowRefs = useRef(new Map<string, HTMLElement>());
  const leaderboardRowTops = useRef(new Map<string, number>());
  // So the poll can read the current live total without a stale closure
  const stormTotalRef = useRef(0);

  // SSE: real-time per-strike updates for live storms (millisecond latency)
  useEffect(() => {
    if (!isLive || !storm.stormKey) return;
    const es = new EventSource(`/api/storms/${encodeURIComponent(storm.stormKey)}/stream`);

    // Named 'history' event: last 10 min of persisted strikes for this storm.
    // Seed appendedStrikes without counting as new (they're already in the DB).
    es.addEventListener('history', (e: Event) => {
      try {
        const batch = JSON.parse((e as MessageEvent).data) as StormStrike[];
        appendUnseenStrikes(batch);
      } catch {}
    });

    es.onmessage = (e) => {
      try {
        const strike = JSON.parse(e.data) as StormStrike;
        const added = appendUnseenStrikes([strike]);
        if (added) setAppendedSinceFlush(prev => prev + added);
      } catch {}
    };
    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, storm.stormKey]);

  // Keep replay polling through the weakening tail even after the official
  // storm is no longer live. Only SSE for active storms affects the live total.
  useEffect(() => {
    if (!shouldPoll || !storm.stormKey) return;
    let cancelled = false;
    let polling = false;

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const liveTotal = stormTotalRef.current;
        const url = `/api/storms/${encodeURIComponent(storm.stormKey!)}/strikes`;
        const res = await fetch(url);
        if (!res.ok || cancelled) return;
        const data = await res.json() as PollResponse;
        if (cancelled) return;
        // Preserve SSE strikes not yet flushed to DB
        const dbTotal = data.totalCount ?? data.count;
        const stillLive = data.endTime != null && Date.now() - data.endTime < 10 * 60_000;
        setAppendedSinceFlush(stillLive ? Math.max(0, liveTotal - dbTotal) : 0);
        setLiveStats({
          endTime: data.endTime,
          totalCount: data.totalCount,
          count: data.count,
          rate: data.rate,
          startTime: data.startTime,
          traveledKm: data.traveledKm,
          city: data.city,
          originCity: data.originCity,
        });
        if (data.nearbyRanked) {
          setDisplayNearbyRanked(prev => {
            // Flash neighbors whose total changed since the last poll (not the current
            // storm's own row, which already re-renders live off every SSE strike)
            const changed = new Set<string>();
            const prevMap = new Map(prev.map(p => [p.stormKey, p.totalCount]));
            for (const row of data.nearbyRanked) {
              const prevTotal = prevMap.get(row.stormKey);
              if (prevTotal != null && prevTotal !== row.totalCount && row.stormKey !== storm.stormKey) {
                changed.add(row.stormKey);
              }
            }
            if (changed.size > 0) {
              setLeaderboardFlashKeys(changed);
              setTimeout(() => setLeaderboardFlashKeys(new Set()), 1000);
            }
            return data.nearbyRanked;
          });
        }
        // Backfill any strikes between SSR and EventSource connect
        appendUnseenStrikes(data.strikes);
      } catch { /* network blip — skip */ } finally { polling = false; }
    };

    const id = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPoll, storm.stormKey]);

  // Real-time total: DB flush value + strikes received via SSE since last flush
  const stormTotal = (liveStats.totalCount ?? liveStats.count) + appendedSinceFlush;

  // Keep stormTotalRef in sync so the poll always sends the current live total
  stormTotalRef.current = stormTotal;

  // Reorder the leaderboard locally using the live stormTotal so this storm's position
  // updates instantly on every strike, instead of waiting up to a poll cycle for the
  // DB's tracker-flushed total_count to catch up. Neighbors keep their last-polled totals.
  const localRanked = useMemo(() => {
    if (!storm.stormKey) return displayNearbyRanked;
    const withLiveTotal = displayNearbyRanked.map(n =>
      n.stormKey === storm.stormKey ? { ...n, totalCount: stormTotal } : n);
    withLiveTotal.sort((a, b) => b.totalCount - a.totalCount);
    const baseRank = displayNearbyRanked[0]?.rank ?? 1;
    return withLiveTotal.map((n, i) => ({ ...n, rank: baseRank + i }));
  }, [displayNearbyRanked, stormTotal, storm.stormKey]);
  const leaderboardOrderKey = localRanked.map(n => n.stormKey).join('|');

  // FLIP-animate leaderboard rows sliding to their new position when the rank
  // order changes, instead of silently popping into place. The displayed rank
  // NUMBER is held back until the slide finishes (see setDisplayedRanks below)
  // so a row's label changes after it visually arrives, not before.
  useLayoutEffect(() => {
    const prevTops = leaderboardRowTops.current;
    const nextTops = new Map<string, number>();
    leaderboardRowRefs.current.forEach((el, key) => nextTops.set(key, el.getBoundingClientRect().top));
    let anyMoved = false;
    leaderboardRowRefs.current.forEach((el, key) => {
      const prevTop = prevTops.get(key);
      const nextTop = nextTops.get(key);
      if (prevTop == null || nextTop == null || prevTop === nextTop) return;
      anyMoved = true;
      const delta = prevTop - nextTop;
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.4s ease';
        el.style.transform = '';
      });
    });
    leaderboardRowTops.current = nextTops;

    const newRanks = new Map(localRanked.map(n => [n.stormKey, n.rank]));
    if (!anyMoved) {
      // first mount, or numbers changed with no visible position shift — show right away
      setDisplayedRanks(newRanks);
      return;
    }
    const t = setTimeout(() => setDisplayedRanks(newRanks), 420);
    return () => clearTimeout(t);
  }, [leaderboardOrderKey]);

  const name = stormLabel(ts, liveStats.city, liveStats.originCity, storm.code, storm.lat, storm.lon);

  const duration = liveStats.startTime != null && liveStats.endTime != null
    ? liveStats.endTime - liveStats.startTime : null;

  // Merge server strikes with live-appended ones for the timeline chart.
  const allStrikesForStats = useMemo(() => {
    const base = storm.strikes ?? [];
    return appendedStrikes.length ? [...base, ...appendedStrikes] : base;
  }, [storm.strikes, appendedStrikes]);

  const timeline = useMemo(
    () => buildStormTimeline(allStrikesForStats, liveStats.endTime),
    [allStrikesForStats, liveStats.endTime],
  );

  const heldRecords = records.filter(r => r.stormKey && r.stormKey === storm.stormKey);

  return (
    <div className="archive-page">
      <div className="storm-detail-body">

        {/* ── Header ── */}
        <div className="storm-detail-header">
          <span className="storm-detail-country">
            {storm.countryPath && storm.countryPath.length > 1
              ? storm.countryPath.map((cc, i) => (
                  <span key={cc} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                    {i > 0 && <span className="storm-log-arrow">→</span>}
                    <CountryFlag code={cc} name={countryName(cc)} />
                    {countryName(cc)}
                  </span>
                ))
              : (
                <>
                  <CountryFlag code={storm.code} name={countryName(storm.code)} />
                  {countryName(storm.code)}
                </>
              )}
          </span>
          <h1 className="storm-detail-name">{name}</h1>
          <div className="storm-record-badges">
            {heldRecords.map(r => (
              <span key={r.category} className={`storm-record-badge storm-record-badge--${r.category}`}>
                {r.category === 'biggest' ? 'Global Record — Biggest'
                  : r.category === 'longest' ? 'Global Record — Longest'
                  : 'Global Record — Farthest'}
              </span>
            ))}
            {mergeStatus?.type === 'merging' && (() => {
              const rem = Math.max(0, Math.round((mergeStatus.mergeAtMs - Date.now()) / 60_000));
              return (
                <span className="storm-record-badge storm-merge-status-badge storm-merge-status-badge--merging">
                  ⚡ merging{rem > 0 ? ` ~${rem}m` : ''}
                </span>
              );
            })()}
            {mergeStatus?.type === 'splitting' && (
              <span className="storm-record-badge storm-merge-status-badge storm-merge-status-badge--splitting">
                ⚡ splitting{mergeStatus.estimatedMinutes != null ? ` ~${mergeStatus.estimatedMinutes}m` : ''}
              </span>
            )}
          </div>
        </div>

        {/* ── KPI grid ── */}
        <div className="storm-kpi-grid">
          <div className="storm-kpi">
            <span className="storm-kpi-value">
              {stormTotal.toLocaleString()}
            </span>
            <span className="storm-kpi-label">Total strikes</span>
          </div>
          <div className="storm-kpi">
            <span className="storm-kpi-value">
              {fmtRate(liveStats.rate)}<span className="storm-kpi-unit">/min</span>
            </span>
            <span className="storm-kpi-label">Peak rate</span>
          </div>
          {(duration != null || isLive) && (
            <div className="storm-kpi">
              <span className="storm-kpi-value">
                {duration != null
                  ? fmtDuration(duration)
                  : liveStats.startTime != null
                    ? fmtDuration(now - liveStats.startTime)
                    : '—'}
              </span>
              <span className="storm-kpi-label">Duration</span>
            </div>
          )}
          {liveStats.traveledKm != null && liveStats.traveledKm >= 1 && (
            <div className="storm-kpi">
              <span className="storm-kpi-value">
                {Math.round(liveStats.traveledKm)}<span className="storm-kpi-unit">km</span>
              </span>
              <span className="storm-kpi-label">Distance traveled</span>
            </div>
          )}
        </div>

        {/* ── Strike timeline chart — last 60 minutes ── */}
        {timeline.length > 1 && (() => {
          const windowStart = timeline[0]?.ts;
          const windowEnd = timeline[timeline.length - 1]?.ts;
          return (
            <div className="storm-section">
              <div className="storm-timeline-meta">
                {windowStart != null && <span>{fmtClock(windowStart)}</span>}
                {windowEnd != null && <span>{fmtClock(windowEnd)}</span>}
              </div>
              <TimelineChart timeline={timeline} />
            </div>
          );
        })()}

        {/* ── Rank leaderboard — closest storms above/below globally ── */}
        {localRanked.length > 1 && (
          <div className="storm-section">
            <div className="storm-section-title">All-time leaderboard ranking</div>
            <div className="storm-leaderboard">
              {localRanked.map(n => {
                const isCurrent = !!storm.stormKey && n.stormKey === storm.stormKey;
                // The rank NUMBER shown lags behind n.rank until the slide animation
                // finishes (see the FLIP effect above) — total/position update live,
                // the label catches up once the row has visually arrived.
                const rowRank = displayedRanks.get(n.stormKey) ?? n.rank;
                const rowTotal = n.totalCount;
                const rowCode = isCurrent ? storm.code : n.code;
                const rowLabel = isCurrent ? name : stormLabel(ts, n.city, n.originCity, n.code, n.lat, n.lon);
                const rowClass = `storm-leaderboard-row${isCurrent ? ' storm-leaderboard-row--current' : rankBadgeClass(rowRank)}${leaderboardFlashKeys.has(n.stormKey) ? ' flash' : ''}`;
                const row = (
                  <>
                    <span className="storm-leaderboard-rank">#{rowRank}</span>
                    <span className="storm-leaderboard-name">
                      <CountryFlag code={rowCode} name={countryName(rowCode)} />
                      <span className="storm-leaderboard-name-text">{rowLabel}</span>
                    </span>
                    <span className="storm-leaderboard-count">{rowTotal.toLocaleString()}</span>
                  </>
                );
                const setRowRef = (el: HTMLElement | null) => {
                  if (el) leaderboardRowRefs.current.set(n.stormKey, el);
                  else leaderboardRowRefs.current.delete(n.stormKey);
                };
                return isCurrent ? (
                  <div key={n.stormKey} ref={setRowRef} className={rowClass}>{row}</div>
                ) : (
                  <Link key={n.stormKey} ref={setRowRef} href={`/storms/${encodeURIComponent(n.stormKey)}`} className={rowClass}>
                    {row}
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Replay map / Live map ── */}
        <div className="storm-section storm-section--map">
          <div className="storm-section-title">{isLive ? 'Live map' : 'Strike replay'}</div>
          {storm.strikes && storm.strikes.length > 0
            ? (
              <div className="storm-detail-map">
                <StormReplayMap
                  strikes={storm.strikes}
                  appendedStrikes={appendedStrikes.length ? appendedStrikes : undefined}
                  isLive={isLive}
                />
              </div>
            )
            : (
              <div className="storm-detail-no-replay">
                Replay not available — strike data is kept for 7 days.
              </div>
            )}
        </div>

      </div>
    </div>
  );
}
