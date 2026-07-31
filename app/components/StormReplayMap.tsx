'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import 'leaflet/dist/leaflet.css';
import type { Map as LeafletMap } from 'leaflet';
import type { StormStrike } from '../lib/db';
import { TILE_SAT, TILE_LABELS_URL, TILE_DIM_FILTER } from '../lib/tiles';
import { ageColor } from '../lib/ageGradient';
import { fmtClock } from '../lib/format';

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
// In replay mode keep concurrent rings modest; live mode uncaps so every
// real-time strike gets its own ring (they expire fast enough not to pile up)
const MAX_RINGS_REPLAY = 12;
const TARGET_RING_COUNT = 60;
// Dot colors age against a fixed 4-hour scale (matching how slowly colors
// shift on the live map) instead of cycling the full spectrum per replay
const GRADIENT_REF_MS = 4 * 60 * 60 * 1000;

interface Projected { x: number; y: number; time: number }
interface Ring { x: number; y: number; start: number }

export default function StormReplayMap({
  strikes,
  appendedStrikes,
  isLive = false,
}: {
  strikes: StormStrike[];
  appendedStrikes?: StormStrike[];
  isLive?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const timeTextRef = useRef<HTMLSpanElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const projectedRef = useRef<Projected[]>([]);
  const ringsRef = useRef<Ring[]>([]);
  const rafRef = useRef<number | null>(null);
  const liveRafRef = useRef<number | null>(null);
  const appendedLengthRef = useRef(0);
  const maxTimeRef = useRef(-Infinity);
  const [playing, setPlaying] = useState(false);
  const t = useTranslations('stats');

  const { minTime, maxTime } = useMemo(() => {
    let min = Infinity, max = -Infinity;
    for (const [, , time] of strikes) {
      if (time < min) min = time;
      if (time > max) max = time;
    }
    maxTimeRef.current = max;
    return { minTime: min, maxTime: max };
  }, [strikes]);

  // Stretch the age gradient to cover the full storm lifespan so that beginning
  // strikes are visible even when the storm lasted longer than GRADIENT_REF_MS.
  // The floor ensures ageColor(t) is never called with t<0.12 (near-invisible).
  const gradientRef = Math.max(GRADIENT_REF_MS, maxTime - minTime);

  // The storm's 5-minute window in the viewer's local time
  const timeRange = `${fmtClock(minTime)} – ${fmtClock(maxTime)}`;

  // Draw every strike at or before `cutoff` (storm time) plus active ring pulses.
  // windowStart: when set (replay mode) strikes older than this are skipped so the
  // display shows a sliding 4-hour window instead of the full accumulated history.
  const draw = (cutoff: number, now: number, freshMs = FRESH_MS, windowStart?: number) => {
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
      if (windowStart !== undefined && pt.time < windowStart) continue;
      const age = cutoff - pt.time;
      // During replay use the fixed 4-hour scale so the full colour range is
      // visible within the sliding window rather than compressed to a thin band.
      const ageRef = windowStart !== undefined ? GRADIENT_REF_MS : gradientRef;
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
        const [r, g, b, a] = ageColor(Math.max(0.12, 1 - age / ageRef));
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
      ctx.arc(rings[i].x, rings[i].y, Math.max(1, Math.sqrt(p) * 40), 0, Math.PI * 2);
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
        dragging: !isLive, scrollWheelZoom: !isLive, doubleClickZoom: false,
        boxZoom: false, keyboard: false, touchZoom: !isLive,
        minZoom: 4, maxZoom: 12,
      });
      L.tileLayer(TILE_SAT.url, TILE_SAT.options).addTo(map);
      L.tileLayer(TILE_LABELS_URL, { maxZoom: 19, opacity: 0.75 }).addTo(map);
      (map.getPanes().tilePane as HTMLElement).style.filter = TILE_DIM_FILTER;

      // Fit the full extent of all strikes — the zoom cap prevents over-zooming
      // on compact storms, so we no longer need percentile trimming (which was
      // cutting off the trailing end of traveling storms).
      const lats = strikes.map(s => s[0]);
      const lons = strikes.map(s => s[1]);
      const bounds = L.latLngBounds(
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      );
      // 20% padding keeps strikes away from the frame edge; zoom cap stops
      // single-cell storms from zooming in to street level.
      map.fitBounds(bounds.pad(0.2), { animate: false, maxZoom: 8 });
      mapRef.current = map;

      const resizeCanvas = () => {
        const size = map.getSize();
        const cnv = canvasRef.current;
        if (!cnv) return;
        const dpr = window.devicePixelRatio || 1;
        cnv.width = size.x * dpr;
        cnv.height = size.y * dpr;
        cnv.style.width = `${size.x}px`;
        cnv.style.height = `${size.y}px`;
      };

      const reprojectStrikes = () => {
        projectedRef.current = strikes
          .map(([lat, lon, time]) => {
            const p = map.latLngToContainerPoint([lat, lon]);
            return { x: p.x, y: p.y, time };
          })
          .sort((a, b) => a.time - b.time);
      };

      resizeCanvas();
      reprojectStrikes();

      // Zoom: resize canvas + re-project + redraw
      map.on('zoomstart', () => {
        const cnv = canvasRef.current;
        if (!cnv) return;
        const ctx = cnv.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, cnv.width, cnv.height);
      });
      map.on('zoomend', () => { resizeCanvas(); reprojectStrikes(); draw(maxTime, performance.now()); });

      // Drag: only re-project (canvas size doesn't change); if replay is running
      // the next animation frame picks up the new positions automatically.
      map.on('move', () => { reprojectStrikes(); draw(maxTime, performance.now()); });

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

  // Project and flash-draw newly-arrived live strikes without reinitializing the map
  useEffect(() => {
    if (!appendedStrikes?.length) return;
    const newBatch = appendedStrikes.slice(appendedLengthRef.current);
    if (!newBatch.length) return;
    appendedLengthRef.current = appendedStrikes.length;

    const map = mapRef.current;
    if (!map) return;

    const now = performance.now();
    for (const [lat, lon, time] of newBatch) {
      const p = map.latLngToContainerPoint([lat, lon]);
      projectedRef.current.push({ x: p.x, y: p.y, time });
      // Live mode: every real-time strike gets a ring (they expire in 600 ms so
      // they don't accumulate); replay caps via MAX_RINGS_REPLAY.
      ringsRef.current.push({ x: p.x, y: p.y, start: now });
      if (time > maxTimeRef.current) maxTimeRef.current = time;
    }
    projectedRef.current.sort((a, b) => a.time - b.time);
    draw(maxTimeRef.current, now);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendedStrikes]);

  // Live mode: continuous RAF that ages strikes by real elapsed time and keeps rings animated
  useEffect(() => {
    if (!isLive) return;
    const tick = () => {
      if (mapRef.current) {
        draw(Date.now(), performance.now());
        if (timeTextRef.current && maxTimeRef.current > -Infinity) {
          timeTextRef.current.textContent = fmtClock(maxTimeRef.current, true);
        }
      }
      liveRafRef.current = requestAnimationFrame(tick);
    };
    liveRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (liveRafRef.current !== null) {
        cancelAnimationFrame(liveRafRef.current);
        liveRafRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive]);

  const play = () => {
    const proj = projectedRef.current;
    if (playing || proj.length === 0) return;
    setPlaying(true);
    ringsRef.current = [];

    // Skip isolated early strikes: find the first index where the gap to the
    // NEXT strike is less than 2 hours — the storm is "continuous" from there.
    // This prevents a single outlier strike 11 hours before the main activity
    // from padding the replay with ~17 s of empty screen.
    let replayStartIdx = 0;
    const GAP_MS = 2 * 60 * 60 * 1000;
    for (let i = 0; i < proj.length - 1; i++) {
      if (proj[i + 1].time - proj[i].time < GAP_MS) { replayStartIdx = i; break; }
    }
    const replayMinTime = proj[replayStartIdx].time;

    let nextIdx = replayStartIdx;
    const start = performance.now();
    const spanMs = Math.max(1, maxTime - replayMinTime);
    const replayMs = Math.min(REPLAY_MS_MAX, Math.max(REPLAY_MS_MIN, (spanMs / 60_000) * REPLAY_MS_PER_STORM_MIN));
    // Sample rings evenly across the storm instead of ringing every strike
    const ringEvery = Math.max(1, Math.round(proj.length / TARGET_RING_COUNT));
    // During playback a strike counts as "fresh" for ~1.2 real seconds
    const freshMs = (spanMs / replayMs) * 1200;

    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / replayMs);
      const cutoff = replayMinTime + p * (maxTime - replayMinTime);

      while (nextIdx < proj.length && proj[nextIdx].time <= cutoff) {
        if (nextIdx % ringEvery === 0 && ringsRef.current.length < MAX_RINGS_REPLAY) {
          ringsRef.current.push({ x: proj[nextIdx].x, y: proj[nextIdx].y, start: now + Math.random() * 150 });
        }
        nextIdx++;
      }

      draw(cutoff, now, freshMs, cutoff - GRADIENT_REF_MS);
      if (timeTextRef.current) timeTextRef.current.textContent = fmtClock(cutoff, true);

      if (p < 1 || ringsRef.current.length > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
        draw(maxTime, performance.now());
        if (timeTextRef.current) timeTextRef.current.textContent = timeRange;
        setPlaying(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  return (
    <div className="bsc-map">
      <div ref={containerRef} className="bsc-map-leaflet" />
      <canvas ref={canvasRef} className="bsc-map-canvas" />
      <span ref={timeRef} className="bsc-map-time">
        {isLive && <span className="bsc-live-dot bsc-live-dot--inline" />}
        <span ref={timeTextRef}>{timeRange}</span>
      </span>
      {isLive
        ? <span className="bsc-live-badge">● LIVE</span>
        : <button className="bsc-replay-btn" onClick={play} disabled={playing}>▶ {t('replay')}</button>
      }
    </div>
  );
}
