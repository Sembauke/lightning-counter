'use client';

import dynamic from 'next/dynamic';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../../lib/format';
import CountryFlag from '../../components/CountryFlag';
import type { BiggestStorm, GlobalStormRecord, StormStrike } from '../../lib/db';
import { useStormMerge } from '../../context/StormMergeContext';
import StormEventsWidget from '../../components/StormEventsWidget';

const StormReplayMap = dynamic(() => import('../../components/StormReplayMap'), { ssr: false });

const R = 6371;
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface MinuteBucket { count: number; ts: number; }
interface StrikeStats {
  timeline: { minute: number; count: number; ts: number }[];
  peakMinute: number; peakTs: number; peakCount: number;
  bboxWidthKm: number; bboxHeightKm: number;
  minLat: number; maxLat: number; minLon: number; maxLon: number;
}

function computeStats(strikes: StormStrike[]): StrikeStats {
  const sorted = [...strikes].sort((a, b) => a[2] - b[2]);
  const firstMs = sorted[0][2];

  const buckets = new Map<number, MinuteBucket>();
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon, ts] of sorted) {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    const min = Math.floor((ts - firstMs) / 60_000);
    const b = buckets.get(min) ?? { count: 0, ts };
    b.count++;
    buckets.set(min, b);
  }

  const maxMin = Math.max(...buckets.keys());
  const timeline: { minute: number; count: number; ts: number }[] = [];
  for (let m = 0; m <= maxMin; m++) {
    const b = buckets.get(m);
    timeline.push({ minute: m, count: b?.count ?? 0, ts: b?.ts ?? firstMs + m * 60_000 });
  }

  let peakMinute = 0, peakCount = 0, peakTs = firstMs;
  for (const t of timeline) {
    if (t.count > peakCount) { peakCount = t.count; peakMinute = t.minute; peakTs = t.ts; }
  }

  const midLat = (minLat + maxLat) / 2;
  const bboxWidthKm = haversineKm(midLat, minLon, midLat, maxLon);
  const bboxHeightKm = haversineKm(minLat, minLon, maxLat, minLon);

  return { timeline, peakMinute, peakTs, peakCount, bboxWidthKm, bboxHeightKm, minLat, maxLat, minLon, maxLon };
}

function TimelineChart({ timeline, peakMinute }: { timeline: StrikeStats['timeline']; peakMinute: number }) {
  const window = timeline.slice(-60);
  const maxCount = Math.max(...window.map(t => t.count), 1);
  const W = 800, H = 100, PX = 4, PY = 6;
  const barW = (W - PX * 2) / Math.max(window.length, 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="timeline-chart" aria-label="Strike intensity chart">
      {window.map((t, i) => {
        const h = (t.count / maxCount) * (H - PY * 2);
        const isPeak = t.minute === peakMinute;
        const alpha = (0.25 + 0.75 * (t.count / maxCount)).toFixed(2);
        const fill = isPeak ? '#ffe566' : `rgba(255,210,50,${alpha})`;
        return (
          <rect key={i}
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



function CompareBar({ label, ratio, isRecord }: { label: string; ratio: number; isRecord: boolean }) {
  const pct = Math.min(100, ratio * 100);
  const [mounted, setMounted] = useState(false);
  const [animDone, setAnimDone] = useState(false);
  useEffect(() => {
    setMounted(true);
    const t = setTimeout(() => setAnimDone(true), 700);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="storm-rank-bar">
      <div className="storm-rank-bar-head">
        <span className="storm-rank-bar-label" style={{ color: isRecord ? '#ff6b35' : '#ffe566' }}>{label}</span>
        <span className="storm-rank-bar-next">{Math.round(pct)}%</span>
      </div>
      <div className="storm-rank-bar-track">
        <div className="storm-rank-bar-fill"
          style={{ width: mounted ? `${pct.toFixed(1)}%` : '0%', background: isRecord ? '#ff6b35' : '#ffe566', transition: animDone ? 'none' : undefined }} />
      </div>
    </div>
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
  rank: number;
  nextRankThreshold: number | null;
  prevRankThreshold: number | null;
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
  storm, records, rank, nextRankThreshold, prevRankThreshold,
}: {
  storm: BiggestStorm;
  records: GlobalStormRecord[];
  rank: number;
  nextRankThreshold: number | null;
  prevRankThreshold: number | null;
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

  // Live rank + threshold — start from server-rendered values, updated by each KPI poll
  const [displayRank, setDisplayRank] = useState(rank);
  const [displayNextThreshold, setDisplayNextThreshold] = useState(nextRankThreshold);
  const [displayPrevThreshold, setDisplayPrevThreshold] = useState(prevRankThreshold);
  // Refs so the crossing-detection effect can call poll() and read stormTotal without stale closures
  const pollNowRef = useRef<(() => Promise<void>) | null>(null);
  const stormTotalRef = useRef(0);

  // SSE: real-time per-strike updates for live storms (millisecond latency)
  useEffect(() => {
    if (!isLive || !storm.stormKey) return;
    const es = new EventSource(`/api/storms/${encodeURIComponent(storm.stormKey)}/stream`);
    es.onmessage = (e) => {
      try {
        const strike = JSON.parse(e.data) as StormStrike;
        if (strike[2] > latestTsRef.current) {
          latestTsRef.current = strike[2];
          setAppendedStrikes(prev => [...prev, strike]);
          setAppendedSinceFlush(prev => prev + 1);
        }
      } catch {}
    };
    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, storm.stormKey]);

  // KPI poll: update stats + rank every 15s; also backfills strikes missed between SSR and SSE
  useEffect(() => {
    if (!isLive || !storm.stormKey) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const liveTotal = stormTotalRef.current;
        const url = `/api/storms/${encodeURIComponent(storm.stormKey!)}/strikes?liveTotal=${liveTotal}`;
        const res = await fetch(url);
        if (!res.ok || cancelled) return;
        const data = await res.json() as PollResponse;
        // Preserve SSE strikes not yet flushed to DB. The poll was sent with
        // liveTotal so thresholds are based on that value — resetting to 0
        // drops stormTotal below displayPrevThreshold and makes rankFillPct negative.
        const dbTotal = data.totalCount ?? data.count;
        setAppendedSinceFlush(Math.max(0, liveTotal - dbTotal));
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
        // Take the better (lower-number) rank — never regress an optimistic advance
        if (data.rank) setDisplayRank(prev => Math.min(prev, data.rank));
        if ('nextRankThreshold' in data) setDisplayNextThreshold(data.nextRankThreshold);
        // displayPrevThreshold is intentionally NOT updated from polls — only set
        // on page load (SSR prop) and threshold crossings. Updating it here would
        // advance the slot floor each time a new storm appears below stormTotal,
        // causing the bar to shrink/reset between crossings.
        // Backfill any strikes between SSR and EventSource connect
        const fresh = data.strikes.filter(s => s[2] > latestTsRef.current);
        if (fresh.length > 0) {
          for (const s of fresh) if (s[2] > latestTsRef.current) latestTsRef.current = s[2];
          setAppendedStrikes(prev => [...prev, ...fresh]);
        }
      } catch { /* network blip — skip */ }
    };

    pollNowRef.current = poll;
    const id = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    return () => { cancelled = true; clearInterval(id); pollNowRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, storm.stormKey]);

  // Real-time total: DB flush value + strikes received via SSE since last flush
  // (defined here so the crossing effect below can reference it)
  const stormTotal = (liveStats.totalCount ?? liveStats.count) + appendedSinceFlush;

  // Keep stormTotalRef in sync so the poll always sends the current live total
  stormTotalRef.current = stormTotal;

  // When stormTotal crosses displayNextThreshold:
  // 1. Optimistically advance the rank immediately (never shows "stuck")
  // 2. Clear old threshold so the tag hides while re-polling
  // 3. Poll with the live total so the server returns the correct next threshold
  const prevTotalRef = useRef(0);
  useEffect(() => {
    // Always keep ref fresh — if we skip updating while nextThreshold is null,
    // the stale value causes a spurious re-crossing the moment the poll returns.
    const prev = prevTotalRef.current;
    prevTotalRef.current = stormTotal;
    if (displayNextThreshold == null) return;
    if (prev < displayNextThreshold && stormTotal >= displayNextThreshold) {
      setDisplayRank(r => r - 1);
      setDisplayPrevThreshold(displayNextThreshold);
      setDisplayNextThreshold(null);
      pollNowRef.current?.();
    }
  }, [stormTotal, displayNextThreshold]);

  const isOceanStorm = storm.code === 'XO';
  const effectiveCity = liveStats.city ?? (isOceanStorm ? 'Open Ocean' : null);
  const effectiveOrigin = liveStats.originCity ?? (isOceanStorm ? 'Open Ocean' : null);
  const name = effectiveOrigin && effectiveCity && effectiveOrigin !== effectiveCity
    ? ts('stormFromTo', { from: effectiveOrigin, to: effectiveCity })
    : effectiveCity
      ? ts('stormNear', { city: effectiveCity })
      : `${storm.lat.toFixed(2)}, ${storm.lon.toFixed(2)}`;

  const duration = liveStats.startTime != null && liveStats.endTime != null
    ? liveStats.endTime - liveStats.startTime : null;

  // Merge server strikes with live-appended ones for the timeline chart and geo stats
  const allStrikesForStats = useMemo(() => {
    const base = storm.strikes ?? [];
    return appendedStrikes.length ? [...base, ...appendedStrikes] : base;
  }, [storm.strikes, appendedStrikes]);

  const stats = useMemo(
    () => (allStrikesForStats.length >= 2 ? computeStats(allStrikesForStats) : null),
    [allStrikesForStats],
  );

  const heldRecords = records.filter(r => r.stormKey && r.stormKey === storm.stormKey);
  const biggestRec  = records.find(r => r.category === 'biggest');
  const longestRec  = records.find(r => r.category === 'longest');
  const farthestRec = records.find(r => r.category === 'farthest');

  const biggestRatio = biggestRec ? stormTotal / (biggestRec.totalCount ?? biggestRec.count) : null;
  const longestRatio =
    longestRec && duration != null && longestRec.startTime != null && longestRec.endTime != null
      ? duration / (longestRec.endTime - longestRec.startTime) : null;
  const farthestRatio =
    farthestRec?.traveledKm && liveStats.traveledKm
      ? liveStats.traveledKm / farthestRec.traveledKm : null;
  const hasCompare = biggestRatio != null || longestRatio != null || farthestRatio != null;

  // Strikes needed to surpass the storm ranked just above; updates live per SSE strike
  const strikesToNextRank = displayRank > 1 && displayNextThreshold != null
    ? displayNextThreshold - stormTotal + 1
    : null;

  // Progress between the rank just passed (0%) and the rank being targeted (100%).
  // When nextThreshold is null (crossing in flight, or rank #1) hold at 100%
  // so the bar never disappears and triggers the re-crossing cascade.
  const rankFillPct = displayNextThreshold != null
    ? Math.max(0, Math.min(100, ((stormTotal - (displayPrevThreshold ?? 0)) / (displayNextThreshold - (displayPrevThreshold ?? 0))) * 100))
    : 100;

  const [rankMounted, setRankMounted] = useState(false);
  const [rankAnimDone, setRankAnimDone] = useState(false);
  useEffect(() => {
    setRankMounted(true);
    const t = setTimeout(() => setRankAnimDone(true), 700);
    return () => clearTimeout(t);
  }, []);

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
        {stats && stats.timeline.length > 1 && (() => {
          const window = stats.timeline.slice(-60);
          const windowStart = window[0]?.ts;
          const windowEnd = window[window.length - 1]?.ts;
          return (
            <div className="storm-section">
              <div className="storm-timeline-meta">
                {windowStart != null && <span>{fmtClock(windowStart)}</span>}
                {windowEnd != null && <span>{fmtClock(windowEnd)}</span>}
              </div>
              <TimelineChart timeline={stats.timeline} peakMinute={stats.peakMinute} />
            </div>
          );
        })()}

        {/* ── Record comparison ── */}
        {(rankFillPct != null || hasCompare) && (
          <div className="storm-compare-list">
            {rankFillPct != null && (
              <div className="storm-rank-bar">
                <div className="storm-rank-bar-head">
                  <span className="storm-rank-bar-label" style={{ color: '#ffe566' }}>
                    #{displayRank} globally
                  </span>
                  {strikesToNextRank != null && strikesToNextRank > 0 && (
                    <span className="storm-rank-bar-next">
                      ↑ #{displayRank - 1} in {strikesToNextRank.toLocaleString()} strikes
                    </span>
                  )}
                </div>
                <div className="storm-rank-bar-track">
                  <div className="storm-rank-bar-fill" style={{
                    width: rankMounted ? `${rankFillPct.toFixed(1)}%` : '0%',
                    background: '#ffe566',
                    transition: rankAnimDone ? 'none' : undefined,
                  }} />
                </div>
              </div>
            )}
            {biggestRatio != null && (
              <CompareBar label="Biggest" ratio={biggestRatio}
                isRecord={heldRecords.some(r => r.category === 'biggest')} />
            )}
            {longestRatio != null && (
              <CompareBar label="Longest" ratio={longestRatio}
                isRecord={heldRecords.some(r => r.category === 'longest')} />
            )}
            {farthestRatio != null && (
              <CompareBar label="Farthest" ratio={farthestRatio}
                isRecord={heldRecords.some(r => r.category === 'farthest')} />
            )}
          </div>
        )}

        {/* ── Storm events log ── */}
        {storm.stormKey && (
          <StormEventsWidget stormKey={storm.stormKey} isLive={isLive} stormTotal={stormTotal} />
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
