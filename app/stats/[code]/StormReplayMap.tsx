'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import 'leaflet/dist/leaflet.css';
import type { Map as LeafletMap } from 'leaflet';
import type { StormStrike } from '../../lib/db';
import { TILE_SAT, TILE_LABELS_URL, TILE_DIM_FILTER } from '../../lib/tiles';
import { ageColor } from '../../lib/ageGradient';
import { fmtClock } from '../../lib/format';

// Playback lasts ~2 s per storm-minute, clamped so short storms stay watchable
// and multi-hour storms don't drag
const REPLAY_MS_MIN = 10_000;
const REPLAY_MS_MAX = 40_000;
const REPLAY_MS_PER_STORM_MIN = 2_000;
// In the static view, strikes from the storm's last 20 s are drawn bright with
// a red border, matching the fresh-strike treatment on the live map. During
// playback freshness follows real time instead (see play()).
const FRESH_MS = 20_000;
const RING_MS = 600;
// Rings are an accent, not a light show — keep only a few alive at once
const MAX_RINGS = 12;
const TARGET_RING_COUNT = 60;
// Dot colors age against a fixed 4-hour scale (matching how slowly colors
// shift on the live map) instead of cycling the full spectrum per replay
const GRADIENT_REF_MS = 4 * 60 * 60 * 1000;

interface Projected { x: number; y: number; time: number }
interface Ring { x: number; y: number; start: number }

export default function StormReplayMap({ strikes }: { strikes: StormStrike[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const projectedRef = useRef<Projected[]>([]);
  const ringsRef = useRef<Ring[]>([]);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const t = useTranslations('stats');

  const { minTime, maxTime } = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const [, , time] of strikes) {
      if (time < min) min = time;
      if (time > max) max = time;
    }
    return { minTime: min, maxTime: max };
  }, [strikes]);

  // The storm's 5-minute window in the viewer's local time
  const timeRange = `${fmtClock(minTime)} – ${fmtClock(maxTime)}`;

  // Draw every strike at or before `cutoff` (storm time) plus active ring pulses
  const draw = (cutoff: number, now: number, freshMs = FRESH_MS) => {
    const cnv = canvasRef.current;
    if (!cnv) return;
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cnv.width / dpr, cnv.height / dpr);

    // Same age gradient as the live map: dots drift subtly toward orange as
    // the replay leaves them behind, on a 4-hour reference scale
    for (const pt of projectedRef.current) {
      if (pt.time > cutoff) continue;
      const age = cutoff - pt.time;
      ctx.beginPath();
      if (age < freshMs) {
        const f = age / freshMs;
        ctx.arc(pt.x, pt.y, 3.5 - 1.5 * f, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,${Math.round(230 - 60 * f)},${Math.round(64 - 30 * f)},${(1 - 0.2 * f).toFixed(3)})`;
        ctx.fill();
        if (f < 0.35) {
          ctx.strokeStyle = 'rgba(255,34,34,0.9)';
          ctx.lineWidth = 1.8;
          ctx.stroke();
        }
      } else {
        const [r, g, b, a] = ageColor(Math.max(0, 1 - age / GRADIENT_REF_MS));
        ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.fill();
      }
    }

    const rings = ringsRef.current;
    let i = rings.length;
    while (i--) {
      const p = (now - rings[i].start) / RING_MS;
      if (p >= 1) { rings.splice(i, 1); continue; }
      if (p <= 0) continue;
      ctx.beginPath();
      ctx.arc(rings[i].x, rings[i].y, Math.max(1, Math.sqrt(p) * 18), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,220,60,${(Math.pow(1 - p, 1.5) * 0.95).toFixed(3)})`;
      ctx.lineWidth = 2.5 * (1 - p) + 0.5;
      ctx.stroke();
    }
  };

  useEffect(() => {
    let disposed = false;
    import('leaflet').then(({ default: L }) => {
      if (disposed || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, {
        zoomControl: false, attributionControl: false,
        dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
        boxZoom: false, keyboard: false, touchZoom: false,
      });
      L.tileLayer(TILE_SAT.url, TILE_SAT.options).addTo(map);
      L.tileLayer(TILE_LABELS_URL, { maxZoom: 19, opacity: 0.75 }).addTo(map);
      (map.getPanes().tilePane as HTMLElement).style.filter = TILE_DIM_FILTER;

      // Fit the dense core of the storm (10th–90th percentile) — chained storm
      // complexes and outlier strikes would otherwise zoom the view way out.
      // Strikes outside the core still draw, just off-center.
      const lats = strikes.map(s => s[0]).sort((a, b) => a - b);
      const lons = strikes.map(s => s[1]).sort((a, b) => a - b);
      const lo = Math.floor(strikes.length * 0.1);
      const hi = Math.ceil(strikes.length * 0.9) - 1;
      const bounds = L.latLngBounds([lats[lo], lons[lo]], [lats[hi], lons[hi]]);
      map.fitBounds(bounds, { animate: false });
      mapRef.current = map;

      // The view is static, so strikes can be projected to pixels once
      const size = map.getSize();
      const cnv = canvasRef.current;
      if (cnv) {
        const dpr = window.devicePixelRatio || 1;
        cnv.width = size.x * dpr;
        cnv.height = size.y * dpr;
        cnv.style.width = `${size.x}px`;
        cnv.style.height = `${size.y}px`;
      }
      projectedRef.current = strikes
        .map(([lat, lon, time]) => {
          const p = map.latLngToContainerPoint([lat, lon]);
          return { x: p.x, y: p.y, time };
        })
        .sort((a, b) => a.time - b.time);
      draw(maxTime, performance.now());
    });

    return () => {
      disposed = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      mapRef.current?.remove();
      mapRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strikes]);

  const play = () => {
    const proj = projectedRef.current;
    if (playing || proj.length === 0) return;
    setPlaying(true);
    ringsRef.current = [];
    let nextIdx = 0;
    const start = performance.now();
    const spanMs = Math.max(1, maxTime - minTime);
    const replayMs = Math.min(REPLAY_MS_MAX, Math.max(REPLAY_MS_MIN, (spanMs / 60_000) * REPLAY_MS_PER_STORM_MIN));
    // Sample rings evenly across the storm instead of ringing every strike
    const ringEvery = Math.max(1, Math.round(proj.length / TARGET_RING_COUNT));
    // During playback a strike counts as "fresh" for ~1.2 real seconds
    const freshMs = (spanMs / replayMs) * 1200;

    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / replayMs);
      const cutoff = minTime + p * (maxTime - minTime);

      while (nextIdx < proj.length && proj[nextIdx].time <= cutoff) {
        if (nextIdx % ringEvery === 0 && ringsRef.current.length < MAX_RINGS) {
          ringsRef.current.push({ x: proj[nextIdx].x, y: proj[nextIdx].y, start: now + Math.random() * 150 });
        }
        nextIdx++;
      }

      draw(cutoff, now, freshMs);
      if (timeRef.current) timeRef.current.textContent = fmtClock(cutoff, true);

      if (p < 1 || ringsRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        draw(maxTime, performance.now());
        if (timeRef.current) timeRef.current.textContent = timeRange;
        setPlaying(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  return (
    <div className="bsc-map">
      <div ref={containerRef} className="bsc-map-leaflet" />
      <canvas ref={canvasRef} className="bsc-map-canvas" />
      <span ref={timeRef} className="bsc-map-time">{timeRange}</span>
      <button className="bsc-replay-btn" onClick={play} disabled={playing}>
        ▶ {t('replay')}
      </button>
    </div>
  );
}
