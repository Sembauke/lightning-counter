'use client';

import { useBlitzortung } from '../hooks/useBlitzortung';
import { useMemo, useEffect, useState } from 'react';
import { useAnimatedCounter } from '../hooks/useAnimatedCounter';

const dn = typeof Intl !== 'undefined' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function countryName(code: string): string {
  try { return dn?.of(code) ?? code; } catch { return code; }
}
function toFlag(code: string): string {
  if (code.length !== 2) return '🌐';
  return [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}
function fmt(n: number) { return n.toLocaleString('en-US'); }

function RateArc({ rate, peak }: { rate: number; peak: number }) {
  const MAX = 300;
  const pct = Math.min(rate / MAX, 1) * 100;
  return (
    <div className="rate-arc-wrap">
      <svg viewBox="0 0 140 80" className="rate-arc-svg">
        <defs>
          <filter id="arcglow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        {/* Track */}
        <path
          d="M 10 78 A 60 60 0 0 1 130 78"
          fill="none"
          stroke="rgba(255,220,0,0.08)"
          strokeWidth="8"
          strokeLinecap="round"
          pathLength="100"
        />
        {/* Fill */}
        <path
          d="M 10 78 A 60 60 0 0 1 130 78"
          fill="none"
          stroke="#ffe040"
          strokeWidth="8"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray={`${pct} 100`}
          filter="url(#arcglow)"
          style={{ transition: 'stroke-dasharray 0.7s ease' }}
        />
        {/* Tick marks */}
        {[0, 25, 50, 75, 100].map(t => {
          const angle = -180 + t * 1.8; // 180° sweep mapped to 0–100
          const rad = (angle * Math.PI) / 180;
          const r = 60, cx = 70, cy = 78;
          const x1 = cx + (r - 5) * Math.cos(rad);
          const y1 = cy + (r - 5) * Math.sin(rad);
          const x2 = cx + (r + 0) * Math.cos(rad);
          const y2 = cy + (r + 0) * Math.sin(rad);
          return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(255,220,0,0.2)" strokeWidth="1.5" />;
        })}
      </svg>
      <div className="rate-center">
        <span className="rate-num">{rate}</span>
        <span className="rate-unit-label">/MIN</span>
        {peak > 0 && <span className="rate-peak">PEAK {peak}</span>}
      </div>
    </div>
  );
}

export default function StatsPage() {
  const { strikes, totalCount, countryCounts, connected } = useBlitzortung();
  const [peakRate, setPeakRate] = useState(0);
  const animatedTotal = useAnimatedCounter(totalCount, 800);

  const rate = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    return strikes.filter(s => s.time > cutoff).length;
  }, [strikes]);

  useEffect(() => {
    if (rate > peakRate) setPeakRate(rate);
  }, [rate, peakRate]);

  // 60 bars × 30s buckets = last 30 min
  const timeline = useMemo(() => {
    const now = Date.now();
    const buckets = new Array(60).fill(0);
    for (const s of strikes) {
      const idx = Math.floor((now - s.time) / 30_000);
      if (idx >= 0 && idx < 60) buckets[59 - idx]++;
    }
    return buckets;
  }, [strikes]);
  const maxBar = Math.max(...timeline, 1);

  // Countries ranked by strikes in the last 30 min (from the strikes buffer)
  const hotNow = useMemo(() => {
    const tally: Record<string, number> = {};
    for (const s of strikes) {
      if (s.cc) tally[s.cc] = (tally[s.cc] ?? 0) + 1;
    }
    return Object.entries(tally)
      .map(([code, count]) => ({ code, count, name: countryName(code), flag: toFlag(code) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [strikes]);
  const hotCount = hotNow[0]?.count ?? 1;
  const countriesHit = Object.keys(countryCounts).length;

  // Hemisphere & quadrant
  const geo = useMemo(() => {
    let N = 0, S = 0, E = 0, W = 0, NW = 0, NE = 0, SW = 0, SE = 0;
    for (const s of strikes) {
      const isN = s.lat >= 0, isE = s.lon >= 0;
      isN ? N++ : S++;
      isE ? E++ : W++;
      if (isN && !isE) NW++;
      else if (isN && isE) NE++;
      else if (!isN && !isE) SW++;
      else SE++;
    }
    const t = strikes.length || 1;
    return { N, S, E, W, NW, NE, SW, SE, t };
  }, [strikes]);

  const nsTotal = geo.N + geo.S || 1;
  const ewTotal = geo.E + geo.W || 1;

  return (
    <div className="statspage">
      {/* Header */}
      <div className="statspage-header">
        <span className={`stats-status ${connected ? 'live' : 'connecting'}`}>
          {connected ? '● LIVE' : '○ CONNECTING…'}
        </span>
        <span className="statspage-title">MISSION CONTROL</span>
      </div>

      {/* Hero: rate arc + activity chart */}
      <div className="statspage-hero">
        <div className="hero-rate">
          <div className="section-label">STRIKE RATE</div>
          <RateArc rate={rate} peak={peakRate} />
        </div>

        <div className="hero-chart">
          <div className="section-label">LIVE ACTIVITY — LAST 30 MIN (30-SEC BUCKETS)</div>
          <div className="activity-chart">
            {timeline.map((count, i) => (
              <div key={i} className="abar-outer">
                <div
                  className="abar-inner"
                  style={{ height: `${count > 0 ? Math.max((count / maxBar) * 100, 4) : 0}%` }}
                />
              </div>
            ))}
            <div className="chart-scanline" />
          </div>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="stat-tiles-row">
        <div className="stat-tile">
          <span className="tile-label">ALL-TIME TOTAL</span>
          <span className="tile-value tile-yellow">{fmt(animatedTotal)}</span>
        </div>
        <div className="stat-tile">
          <span className="tile-label">LAST 30 MIN</span>
          <span className="tile-value">{fmt(strikes.length)}</span>
        </div>
        <div className="stat-tile">
          <span className="tile-label">COUNTRIES HIT</span>
          <span className="tile-value">{countriesHit}</span>
        </div>
        <div className="stat-tile">
          <span className="tile-label">SESSION PEAK</span>
          <span className="tile-value tile-orange">{peakRate}<span className="tile-unit">/min</span></span>
        </div>
      </div>

      {/* Bottom: countries + geo */}
      <div className="statspage-bottom">
        {/* Hot right now */}
        <div className="crace-panel">
          <div className="section-label">HOT RIGHT NOW — LAST 30 MIN</div>
          {hotNow.length === 0
            ? <div className="sp-waiting">Waiting for strike data…</div>
            : hotNow.map(({ code, count, name, flag }, i) => (
              <div key={code} className="crace-row">
                <span className="crace-rank">#{i + 1}</span>
                <span className="crace-flag">{flag}</span>
                <span className="crace-name">{name}</span>
                <div className="crace-bar-wrap">
                  <div className="crace-bar" style={{ width: `${(count / hotCount) * 100}%` }} />
                </div>
                <span className="crace-count">{fmt(count)}</span>
              </div>
            ))
          }
        </div>

        {/* Geo split */}
        <div className="geo-panel">
          <div className="section-label">GEOGRAPHIC SPLIT — LAST 30 MIN</div>

          <div className="hemi-rows">
            {([
              { label: 'NORTH', v: geo.N, total: nsTotal, cls: 'hemi-N' },
              { label: 'SOUTH', v: geo.S, total: nsTotal, cls: 'hemi-S' },
            ] as const).map(r => (
              <div key={r.label} className="hemi-row">
                <span className="hemi-label">{r.label}</span>
                <div className="hemi-bar-wrap">
                  <div className={`hemi-bar ${r.cls}`} style={{ width: `${(r.v / r.total) * 100}%` }} />
                </div>
                <span className="hemi-pct">{Math.round((r.v / r.total) * 100)}%</span>
              </div>
            ))}
            <div className="hemi-divider" />
            {([
              { label: 'EAST', v: geo.E, total: ewTotal, cls: 'hemi-E' },
              { label: 'WEST', v: geo.W, total: ewTotal, cls: 'hemi-W' },
            ] as const).map(r => (
              <div key={r.label} className="hemi-row">
                <span className="hemi-label">{r.label}</span>
                <div className="hemi-bar-wrap">
                  <div className={`hemi-bar ${r.cls}`} style={{ width: `${(r.v / r.total) * 100}%` }} />
                </div>
                <span className="hemi-pct">{Math.round((r.v / r.total) * 100)}%</span>
              </div>
            ))}
          </div>

          {/* Quadrant grid */}
          <div className="quad-grid">
            {([
              { label: 'NW', v: geo.NW },
              { label: 'NE', v: geo.NE },
              { label: 'SW', v: geo.SW },
              { label: 'SE', v: geo.SE },
            ] as const).map(q => (
              <div key={q.label} className="quad-cell" style={{ opacity: 0.15 + (q.v / geo.t) * 2.5 }}>
                <span className="quad-label">{q.label}</span>
                <span className="quad-pct">{Math.round((q.v / geo.t) * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
