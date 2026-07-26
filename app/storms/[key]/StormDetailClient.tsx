'use client';

import dynamic from 'next/dynamic';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCountryName } from '../../hooks/useCountryName';
import { fmtRate, fmtClock, fmtDuration } from '../../lib/format';
import CountryFlag from '../../components/CountryFlag';
import type { BiggestStorm, GlobalStormRecord, StormStrike } from '../../lib/db';

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
  const maxCount = Math.max(...timeline.map(t => t.count), 1);
  const W = 800, H = 100, PX = 4, PY = 6;
  const barW = (W - PX * 2) / Math.max(timeline.length, 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="timeline-chart" aria-label="Strike intensity chart">
      {timeline.map((t, i) => {
        const h = (t.count / maxCount) * (H - PY * 2);
        const isPeak = t.minute === peakMinute;
        const alpha = (0.25 + 0.75 * (t.count / maxCount)).toFixed(2);
        const fill = isPeak ? '#ff6b35' : `rgba(90,170,255,${alpha})`;
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
  return (
    <div className="storm-compare-row">
      <span className="storm-compare-label">{label}</span>
      <div className="storm-compare-track">
        <div className="storm-compare-bar"
          style={{ width: `${pct.toFixed(1)}%`, background: isRecord ? '#ff6b35' : '#3a6fa8' }} />
      </div>
      <span className="storm-compare-pct">{Math.round(pct)}%</span>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function rankStyle(rank: number): React.CSSProperties {
  const t = Math.pow(Math.max(0, 1 - (rank - 1) / 99), 0.5);
  const hue = Math.round(50 - t * 20);
  const sat = Math.round(30 + t * 70);
  const light = Math.round(40 + t * 35);
  return {
    color: `hsl(${hue}, ${sat}%, ${light}%)`,
    background: `hsla(${hue}, ${sat}%, ${light}%, ${0.1 + t * 0.35})`,
    borderColor: `hsla(${hue}, ${sat}%, ${light}%, ${0.25 + t * 0.65})`,
    fontWeight: t > 0.7 ? 700 : undefined,
  };
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
  storm, records, rank,
}: {
  storm: BiggestStorm;
  records: GlobalStormRecord[];
  rank: number;
}) {
  const router = useRouter();
  const ts = useTranslations('storms');
  const countryName = useCountryName();

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
  const latestTsRef = useRef(
    storm.strikes?.length ? Math.max(...storm.strikes.map(s => s[2])) : 0,
  );

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

  // KPI poll: update stats (rate, count, location, endTime) every 15s
  // Also fills the gap between SSR snapshot and EventSource connect on first run
  useEffect(() => {
    if (!isLive || !storm.stormKey) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/storms/${encodeURIComponent(storm.stormKey!)}/strikes`);
        if (!res.ok || cancelled) return;
        const data = await res.json() as PollResponse;
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
        setAppendedSinceFlush(0); // DB total now includes these strikes
        // Backfill any strikes between SSR and EventSource connect
        const fresh = data.strikes.filter(s => s[2] > latestTsRef.current);
        if (fresh.length > 0) {
          latestTsRef.current = Math.max(...fresh.map(s => s[2]));
          setAppendedStrikes(prev => [...prev, ...fresh]);
        }
      } catch { /* network blip — skip */ }
    };

    const id = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, storm.stormKey]);

  const name = liveStats.originCity && liveStats.city && liveStats.originCity !== liveStats.city
    ? ts('stormFromTo', { from: liveStats.originCity, to: liveStats.city })
    : liveStats.city
      ? ts('stormNear', { city: liveStats.city })
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
  const biggestRec = records.find(r => r.category === 'biggest');
  const mostRec    = records.find(r => r.category === 'most');
  const longestRec = records.find(r => r.category === 'longest');
  const farthestRec = records.find(r => r.category === 'farthest');

  // Real-time total: DB flush value + strikes received via SSE since last flush
  const stormTotal = (liveStats.totalCount ?? liveStats.count) + appendedSinceFlush;
  const biggestRatio = biggestRec ? liveStats.count / biggestRec.count : null;
  const mostRatio    = mostRec ? stormTotal / (mostRec.totalCount ?? mostRec.count) : null;
  const longestRatio =
    longestRec && duration != null && longestRec.startTime != null && longestRec.endTime != null
      ? duration / (longestRec.endTime - longestRec.startTime)
      : null;
  const farthestRatio =
    farthestRec?.traveledKm && liveStats.traveledKm
      ? liveStats.traveledKm / farthestRec.traveledKm
      : null;

  const hasCompare = biggestRatio != null || mostRatio != null || longestRatio != null || farthestRatio != null;

  return (
    <div className="archive-page">
      <div className="archive-toolbar">
        <button
          className="storm-detail-back"
          onClick={() => window.history.length > 1 ? router.back() : router.push('/storms')}
        >← Back</button>
      </div>

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
          <div className="storm-detail-date-line">{storm.date}</div>
          <div className="storm-record-badges">
            {isLive && <span className="storm-record-badge storm-live-tag">LIVE</span>}
            <span className="storm-record-badge storm-record-badge--rank" style={rankStyle(rank)}>
              {ordinal(rank)} biggest storm
            </span>
            {heldRecords.map(r => (
              <span key={r.category} className={`storm-record-badge storm-record-badge--${r.category}`}>
                {r.category === 'biggest' ? 'Global Record — Biggest'
                  : r.category === 'most'    ? 'Global Record — Most Strikes'
                  : r.category === 'longest' ? 'Global Record — Longest'
                  : 'Global Record — Farthest'}
              </span>
            ))}
          </div>
        </div>

        {/* ── KPI grid ── */}
        <div className="storm-kpi-grid">
          <div className="storm-kpi">
            {/* key changes on each SSE strike → remounts span → CSS pulse animation fires */}
            <span key={stormTotal} className="storm-kpi-value storm-kpi-value--live">
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
          {stats && (
            <>
              <div className="storm-kpi">
                <span className="storm-kpi-value">
                  {Math.round(stats.bboxWidthKm)}<span className="storm-kpi-unit">km</span>
                </span>
                <span className="storm-kpi-label">Area width</span>
              </div>
              <div className="storm-kpi">
                <span className="storm-kpi-value">
                  {Math.round(stats.bboxHeightKm)}<span className="storm-kpi-unit">km</span>
                </span>
                <span className="storm-kpi-label">Area height</span>
              </div>
            </>
          )}
        </div>

        {/* ── Strike timeline chart ── */}
        {stats && stats.timeline.length > 1 && (
          <div className="storm-section">
            <div className="storm-section-title">Strike intensity over time</div>
            <div className="storm-timeline-meta">
              {storm.startTime != null && <span>{fmtClock(storm.startTime)}</span>}
              <span className="storm-timeline-peak-label">
                Peak {fmtClock(stats.peakTs)} — {stats.peakCount} strikes/min
              </span>
              {storm.endTime != null && <span>{fmtClock(storm.endTime)}</span>}
            </div>
            <TimelineChart timeline={stats.timeline} peakMinute={stats.peakMinute} />
          </div>
        )}

        {/* ── Two-column panels ── */}
        <div className="storm-two-col">

          <div className="storm-section">
            <div className="storm-section-title">Key moments</div>
            <div className="storm-info-table">
              {liveStats.startTime != null && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Born</span>
                  <span className="storm-info-value">{fmtClock(liveStats.startTime)}</span>
                </div>
              )}
              {liveStats.originCity && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Origin</span>
                  <span className="storm-info-value">{liveStats.originCity}</span>
                </div>
              )}
              {stats && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Peak</span>
                  <span className="storm-info-value storm-info-value--peak">
                    {fmtClock(stats.peakTs)} · {stats.peakCount} strikes/min
                  </span>
                </div>
              )}
              {liveStats.endTime != null && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Ended</span>
                  <span className="storm-info-value">{fmtClock(liveStats.endTime)}</span>
                </div>
              )}
              {liveStats.city && (
                <div className="storm-info-row">
                  <span className="storm-info-label">{isLive ? 'Current location' : 'Final location'}</span>
                  <span className="storm-info-value">{liveStats.city}</span>
                </div>
              )}
              {duration != null && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Duration</span>
                  <span className="storm-info-value">{fmtDuration(duration)}</span>
                </div>
              )}
            </div>
          </div>

          {stats && (
            <div className="storm-section">
              <div className="storm-section-title">Geography</div>
              <div className="storm-info-table">
                <div className="storm-info-row">
                  <span className="storm-info-label">Bounding box</span>
                  <span className="storm-info-value">
                    {Math.round(stats.bboxWidthKm)} × {Math.round(stats.bboxHeightKm)} km
                  </span>
                </div>
                <div className="storm-info-row">
                  <span className="storm-info-label">Covered area</span>
                  <span className="storm-info-value">
                    {Math.round(stats.bboxWidthKm * stats.bboxHeightKm).toLocaleString()} km²
                  </span>
                </div>
                {storm.traveledKm != null && storm.traveledKm >= 1 && (
                  <div className="storm-info-row">
                    <span className="storm-info-label">Path length</span>
                    <span className="storm-info-value">{Math.round(storm.traveledKm)} km</span>
                  </div>
                )}
                <div className="storm-info-row">
                  <span className="storm-info-label">Lat range</span>
                  <span className="storm-info-value">
                    {stats.minLat.toFixed(2)}° – {stats.maxLat.toFixed(2)}°
                  </span>
                </div>
                <div className="storm-info-row">
                  <span className="storm-info-label">Lon range</span>
                  <span className="storm-info-value">
                    {stats.minLon.toFixed(2)}° – {stats.maxLon.toFixed(2)}°
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Countries panel ── */}
        {storm.countryPath && storm.countryPath.length > 0 && (
          <div className="storm-section">
            <div className="storm-section-title">
              {storm.countryPath.length > 1 ? 'Countries crossed' : 'Country'}
            </div>
            <div className="storm-countries-list">
              {storm.countryPath.map((cc, i) => (
                <span key={cc} className="storm-country-chip">
                  {i > 0 && <span className="storm-country-arrow">→</span>}
                  <CountryFlag code={cc} name={countryName(cc)} />
                  <span>{countryName(cc)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ── Record comparison ── */}
        {hasCompare && (
          <div className="storm-section">
            <div className="storm-section-title">Compared to global records</div>
            <div className="storm-compare-list">
              {biggestRatio != null && (
                <CompareBar
                  label="Biggest (peak window)"
                  ratio={biggestRatio}
                  isRecord={heldRecords.some(r => r.category === 'biggest')}
                />
              )}
              {mostRatio != null && (
                <CompareBar
                  label="Most strikes (total)"
                  ratio={mostRatio}
                  isRecord={heldRecords.some(r => r.category === 'most')}
                />
              )}
              {longestRatio != null && (
                <CompareBar
                  label="Longest (duration)"
                  ratio={longestRatio}
                  isRecord={heldRecords.some(r => r.category === 'longest')}
                />
              )}
              {farthestRatio != null && (
                <CompareBar
                  label="Farthest (distance)"
                  ratio={farthestRatio}
                  isRecord={heldRecords.some(r => r.category === 'farthest')}
                />
              )}
            </div>
          </div>
        )}

        {/* ── Replay map ── */}
        <div className="storm-section">
          <div className="storm-section-title">Strike replay</div>
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
