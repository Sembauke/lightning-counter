'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import React, { useMemo } from 'react';
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

export default function StormDetailClient({
  storm, records, rank,
}: {
  storm: BiggestStorm;
  records: GlobalStormRecord[];
  rank: number;
}) {
  const ts = useTranslations('storms');
  const countryName = useCountryName();

  const name = storm.originCity && storm.city && storm.originCity !== storm.city
    ? ts('stormFromTo', { from: storm.originCity, to: storm.city })
    : storm.city
      ? ts('stormNear', { city: storm.city })
      : `${storm.lat.toFixed(2)}, ${storm.lon.toFixed(2)}`;

  const duration = storm.startTime != null && storm.endTime != null
    ? storm.endTime - storm.startTime : null;

  const stats = useMemo(
    () => (storm.strikes && storm.strikes.length >= 2 ? computeStats(storm.strikes) : null),
    [storm.strikes],
  );

  const heldRecords = records.filter(r => r.stormKey && r.stormKey === storm.stormKey);
  const biggestRec = records.find(r => r.category === 'biggest');
  const longestRec = records.find(r => r.category === 'longest');
  const farthestRec = records.find(r => r.category === 'farthest');

  const biggestRatio = biggestRec ? storm.count / biggestRec.count : null;
  const longestRatio =
    longestRec && duration != null && longestRec.startTime != null && longestRec.endTime != null
      ? duration / (longestRec.endTime - longestRec.startTime)
      : null;
  const farthestRatio =
    farthestRec?.traveledKm && storm.traveledKm
      ? storm.traveledKm / farthestRec.traveledKm
      : null;

  const hasCompare = biggestRatio != null || longestRatio != null || farthestRatio != null;

  return (
    <div className="archive-page">
      <div className="archive-toolbar">
        <Link href="/records" className="storm-detail-back">← Records</Link>
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
            <span className="storm-record-badge storm-record-badge--rank" style={rankStyle(rank)}>
              {ordinal(rank)} biggest storm
            </span>
            {heldRecords.map(r => (
              <span key={r.category} className={`storm-record-badge storm-record-badge--${r.category}`}>
                {r.category === 'biggest'
                  ? 'Global Record — Biggest'
                  : r.category === 'longest'
                    ? 'Global Record — Longest'
                    : 'Global Record — Farthest'}
              </span>
            ))}
          </div>
        </div>

        {/* ── KPI grid ── */}
        <div className="storm-kpi-grid">
          <div className="storm-kpi">
            <span className="storm-kpi-value">{(storm.totalCount ?? storm.count).toLocaleString()}</span>
            <span className="storm-kpi-label">Total strikes</span>
          </div>
          <div className="storm-kpi">
            <span className="storm-kpi-value">
              {fmtRate(storm.rate)}<span className="storm-kpi-unit">/min</span>
            </span>
            <span className="storm-kpi-label">Peak rate</span>
          </div>
          {duration != null && (
            <div className="storm-kpi">
              <span className="storm-kpi-value">{fmtDuration(duration)}</span>
              <span className="storm-kpi-label">Duration</span>
            </div>
          )}
          {storm.traveledKm != null && storm.traveledKm >= 1 && (
            <div className="storm-kpi">
              <span className="storm-kpi-value">
                {Math.round(storm.traveledKm)}<span className="storm-kpi-unit">km</span>
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
              {storm.startTime != null && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Born</span>
                  <span className="storm-info-value">{fmtClock(storm.startTime)}</span>
                </div>
              )}
              {storm.originCity && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Origin</span>
                  <span className="storm-info-value">{storm.originCity}</span>
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
              {storm.endTime != null && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Ended</span>
                  <span className="storm-info-value">{fmtClock(storm.endTime)}</span>
                </div>
              )}
              {storm.city && (
                <div className="storm-info-row">
                  <span className="storm-info-label">Final location</span>
                  <span className="storm-info-value">{storm.city}</span>
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
                <StormReplayMap strikes={storm.strikes} />
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
