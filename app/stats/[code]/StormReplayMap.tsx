'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import 'leaflet/dist/leaflet.css';
import type { Map as LeafletMap } from 'leaflet';
import type { StormStrike } from '../../lib/db';
import { TILE_SAT, TILE_LABELS_URL, TILE_DIM_FILTER } from '../../lib/tiles';

const REPLAY_MS = 10_000;
// Strikes younger than this (in storm time) are drawn bright with a red border,
// matching the fresh-strike treatment on the live map
const FRESH_MS = 20_000;
const RING_MS = 600;
const MAX_RINGS = 80;

interface Projected { x: number; y: number; time: number }
interface Ring { x: number; y: number; start: number }

function fmtClock(t: number, seconds = false) {
  return new Date(t).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  });
}

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
  const draw = (cutoff: number, now: number) => {
    const cnv = canvasRef.current;
    if (!cnv) return;
    const ctx = cnv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cnv.width / dpr, cnv.height / dpr);

    for (const pt of projectedRef.current) {
      if (pt.time > cutoff) continue;
      const fresh = cutoff - pt.time < FRESH_MS;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, fresh ? 3.5 : 2, 0, Math.PI * 2);
      ctx.fillStyle = fresh ? '#ffe040' : 'rgba(255,140,50,0.55)';
      ctx.fill();
      if (fresh) {
        ctx.strokeStyle = 'rgba(255,34,34,0.9)';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    }

    const rings = ringsRef.current;
    let i = rings.length;
    while (i--) {
      const p = (now - rings[i].start) / RING_MS;
      if (p >= 1) { rings.splice(i, 1); continue; }
      if (p <= 0) continue;
      ctx.beginPath();
      ctx.arc(rings[i].x, rings[i].y, Math.max(1, Math.sqrt(p) * 30), 0, Math.PI * 2);
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

      const bounds = L.latLngBounds(strikes.map(([lat, lon]) => [lat, lon] as [number, number]));
      map.fitBounds(bounds.pad(0.2), { animate: false });
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

    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / REPLAY_MS);
      const cutoff = minTime + p * (maxTime - minTime);

      // Ring pulse for strikes appearing this frame, capped to keep dense storms readable
      while (nextIdx < proj.length && proj[nextIdx].time <= cutoff) {
        if (ringsRef.current.length < MAX_RINGS) {
          ringsRef.current.push({ x: proj[nextIdx].x, y: proj[nextIdx].y, start: now + Math.random() * 150 });
        }
        nextIdx++;
      }

      draw(cutoff, now);
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
