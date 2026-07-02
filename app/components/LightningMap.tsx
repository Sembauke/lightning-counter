'use client';

import { useEffect, useRef, useState } from 'react';
import 'leaflet/dist/leaflet.css';
import type { Strike } from '../hooks/useBlitzortung';
import { useHeatmap, type HeatmapWindow } from '../context/HeatmapContext';
import { useReplay } from '../context/ReplayContext';
import { useWind } from '../context/WindContext';

interface FlashRing {
  nx: number;
  ny: number;
  startTime: number;
  zoomed: boolean;
}

interface HeatPoint {
  lat: number;
  lon: number;
  time: number;
  nx: number; // normalized web-mercator x/y in [0,1], precomputed once so redraws
  ny: number; // are two multiply-adds per point instead of a Leaflet projection call
}

const MAX_MERC_LAT = 85.05112878;

function mercNX(lon: number): number {
  return (lon + 180) / 360;
}

function mercNY(lat: number): number {
  const clamped = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
  const s = Math.sin(clamped * Math.PI / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

interface WindParticle {
  x: number;
  y: number;
  trail: [number, number][];
  age: number;
  maxAge: number;
}

interface WindGridData {
  points: { u: number; v: number }[];
  cols: number;
  rows: number;
  south: number;
  north: number;
  west: number;
  east: number;
}

function interpWind(lat: number, lng: number, grid: WindGridData): { u: number; v: number } {
  const { points, cols, rows, south, north, west, east } = grid;
  const tx = (lng - west) / (east - west) * (cols - 1);
  const ty = (north - lat) / (north - south) * (rows - 1);
  const x0 = Math.max(0, Math.min(cols - 2, Math.floor(tx)));
  const x1 = x0 + 1;
  const y0 = Math.max(0, Math.min(rows - 2, Math.floor(ty)));
  const y1 = y0 + 1;
  const fx = Math.max(0, Math.min(1, tx - x0));
  const fy = Math.max(0, Math.min(1, ty - y0));
  const g = (r: number, c: number) => points[r * cols + c] ?? { u: 0, v: 0 };
  return {
    u: (1-fx)*(1-fy)*g(y0,x0).u + fx*(1-fy)*g(y0,x1).u + (1-fx)*fy*g(y1,x0).u + fx*fy*g(y1,x1).u,
    v: (1-fx)*(1-fy)*g(y0,x0).v + fx*(1-fy)*g(y0,x1).v + (1-fx)*fy*g(y1,x0).v + fx*fy*g(y1,x1).v,
  };
}

interface CellData {
  id: string;
  col: number;
  row: number;
  count: number;
  strikes: HeatPoint[];
  binZoom: number;
  displayPx: number;
  bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

interface MapState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  map: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tileLayer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labelsLayer: any;
  processed: Set<string>;
  heatmapTimer: ReturnType<typeof setInterval> | null;
  rings: FlashRing[];
  liveDots: Array<{ nx: number; ny: number; addedAt: number }>;
  rafId: number | null;
  ready: boolean;
  heatCanvas: HTMLCanvasElement | null;
  heatCtx: CanvasRenderingContext2D | null;
  windCanvas: HTMLCanvasElement | null;
  windCtx: CanvasRenderingContext2D | null;
  windParticles: WindParticle[];
  windScreenGrid: { dxdy: Float32Array; cols: number; rows: number; cell: number } | null;
  windWasActive: boolean;
  buildScreenGrid: (() => void) | null;
  dpr: number;
  drawHeatmap: (() => void) | null;
}

// Three stepped grid tiers, each with a fixed binZoom for geographic stability.
// Visual cell size grows as you zoom in within a tier (natural heatmap behaviour).
// z≤6: binZoom=6, 192px → ~192px at z6, ~12px at z2 (same geographic cells, just smaller on screen)
// z7–z9: binZoom=7, 96px → ~96px at z7, ~384px at z9
// z10–z12: binZoom=10, 64px → ~64px at z10, ~256px at z12
function getHeatmapLevel(zoom: number): { displayPx: number; binZoom: number } {
  const z = Math.floor(zoom);
  if (z >= 10) return { displayPx: 64,  binZoom: 10 };
  if (z >= 9)  return { displayPx: 48,  binZoom: 9  };
  if (z >= 7)  return { displayPx: 96,  binZoom: 7  };
  if (z >= 6)  return { displayPx: 96,  binZoom: 6  };
  return             { displayPx: 192, binZoom: 6   };
}

// Logarithmic color scale: blue (sparse) → cyan → green → yellow → orange → red (dense)
const CELL_KEY_MULT = 1 << 15;
const FLASH_DURATION_MS = 700;

function getHeatColor(count: number, maxCount: number): string {
  if (!count || !maxCount) return 'rgba(0,0,0,0)';
  const t = Math.min(Math.log1p(count) / Math.log1p(Math.max(maxCount, 1)), 1);
  // Color stops: [position, r, g, b, alpha]
  type Stop = [number, number, number, number, number];
  const stops: Stop[] = [
    [0,    0,  40, 220, 0.35],
    [0.20, 0, 180, 255, 0.52],
    [0.45, 60, 230, 100, 0.62],
    [0.65, 255, 220,   0, 0.72],
    [0.82, 255,  80,   0, 0.82],
    [1.0,  255,  20,  20, 0.90],
  ];
  let i = 0;
  while (i < stops.length - 2 && stops[i + 1][0] <= t) i++;
  const s0 = stops[i], s1 = stops[i + 1];
  const f = s1[0] > s0[0] ? (t - s0[0]) / (s1[0] - s0[0]) : 0;
  const r = Math.round(s0[1] + f * (s1[1] - s0[1]));
  const g = Math.round(s0[2] + f * (s1[2] - s0[2]));
  const b = Math.round(s0[3] + f * (s1[3] - s0[3]));
  const a = (s0[4] + f * (s1[4] - s0[4])).toFixed(2);
  return `rgba(${r},${g},${b},${a})`;
}

const TILE_DARK = {
  url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  options: { subdomains: 'abcd', maxZoom: 19 },
};
const TILE_SAT = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  options: { maxZoom: 19 },
};
const TILE_LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

const WINDOW_MS: Record<HeatmapWindow, number> = {
  '30m':  30 * 60 * 1000,
  '1h':    1 * 60 * 60 * 1000,
  '3h':    3 * 60 * 60 * 1000,
  '1d':   24 * 60 * 60 * 1000,
};

const WINDOW_LABELS: Record<HeatmapWindow, string> = {
  '30m': '30 min',
  '1h':  '1 hr',
  '3h':  '3 hrs',
  '1d':  '1 day',
};

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function playTick(ctx: AudioContext) {
  const duration = 0.018;
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 10);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = 0.5;
  src.connect(gain);
  gain.connect(ctx.destination);
  src.start();
}

export default function LightningMap({ strikes, satellite, sound, historyLoaded }: { strikes: Strike[]; satellite: boolean; sound: boolean; historyLoaded: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const satelliteRef = useRef(satellite);
  satelliteRef.current = satellite;
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const lastTickRef = useRef(0);

  const { enabled: heatmapEnabled, timeWindow, setTimeWindow } = useHeatmap();
  const { extend24h } = useReplay();
  const { enabled: windEnabled } = useWind();
  const extend24hRef = useRef(extend24h);
  extend24hRef.current = extend24h;
  const heatmapEnabledRef = useRef(heatmapEnabled);
  heatmapEnabledRef.current = heatmapEnabled;
  const timeWindowRef = useRef(timeWindow);
  timeWindowRef.current = timeWindow;
  const windEnabledRef = useRef(windEnabled);
  windEnabledRef.current = windEnabled;
  const windGridRef = useRef<WindGridData | null>(null);
  const windFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Long-lived buffer for heatmap — accumulates all strikes (max 7d, capped at 100k)
  const heatmapBufferRef = useRef<HeatPoint[]>([]);
  // Historical strikes fetched from DB for the current viewport
  const dbBufferRef = useRef<HeatPoint[]>([]);
  const viewportFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchViewportRef = useRef<(() => void) | null>(null);
  const lastDragEndRef = useRef(0);
  const isSelectingRef = useRef(false);
  const selectStartRef = useRef<{ x: number; y: number } | null>(null);
  const selectRectRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [binLocked, setBinLocked] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('gridBinLocked') === 'true'
  );
  const binLockedRef = useRef(
    typeof window !== 'undefined' && localStorage.getItem('gridBinLocked') === 'true'
  );
  const _savedLevel = typeof window !== 'undefined'
    ? (() => { try { return JSON.parse(localStorage.getItem('gridLockedLevel') || 'null'); } catch { return null; } })()
    : null;
  const lockedLevelRef = useRef<{ displayPx: number; binZoom: number } | null>(_savedLevel);
  const [gridOpacity, setGridOpacity] = useState(() => {
    if (typeof window === 'undefined') return 1;
    return parseFloat(localStorage.getItem('gridOpacity') || '1');
  });
  const gridOpacityRef = useRef(gridOpacity);
  gridOpacityRef.current = gridOpacity;
  const cellFlashMapRef = useRef<Map<number, number>>(new Map());
  const flashRafRef = useRef<number | null>(null);

  const startFlashLoop = () => {
    if (flashRafRef.current !== null) return;
    let lastDraw = 0;
    const tick = (now: number) => {
      if (now - lastDraw >= 50) {
        lastDraw = now;
        stateRef.current.drawHeatmap?.();
      }
      if (cellFlashMapRef.current.size > 0) {
        flashRafRef.current = requestAnimationFrame(tick);
      } else {
        flashRafRef.current = null;
      }
    };
    flashRafRef.current = requestAnimationFrame(tick);
  };

  const [selectedCell, setSelectedCell] = useState<CellData | null>(null);
  const selectedCellRef = useRef<{ col: number; row: number; binZoom: number; displayPx: number; bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number } } | null>(null);
  const [apiData, setApiData] = useState<{
    strikes: Array<{ id: number; strike_time: number; lat: number; lon: number }>;
    total: number; page: number; pages: number;
  } | null>(null);
  const [apiLoading, setApiLoading] = useState(false);


  const fetchViewport = () => {
    const s = stateRef.current;
    if (!s.map) return;
    const b = s.map.getBounds();
    const latPad = (b.getNorth() - b.getSouth()) * 0.5;
    const lonPad = (b.getEast() - b.getWest()) * 0.5;
    const minLat = Math.max(-90,  b.getSouth() - latPad);
    const maxLat = Math.min(90,   b.getNorth() + latPad);
    const minLon = Math.max(-180, b.getWest()  - lonPad);
    const maxLon = Math.min(180,  b.getEast()  + lonPad);
    const windowMs = heatmapEnabledRef.current
      ? WINDOW_MS[timeWindowRef.current]
      : extend24hRef.current
        ? 24 * 60 * 60 * 1000
        : 60 * 60 * 1000;
    const since = Date.now() - windowMs;
    const q = `minLat=${minLat}&maxLat=${maxLat}&minLon=${minLon}&maxLon=${maxLon}&since=${since}`;
    fetch(`/api/grid/viewport?${q}`)
      .then(r => r.json())
      .then(data => {
        dbBufferRef.current = (data.strikes as Array<{ lat: number; lon: number; strike_time: number }>)
          .map(s => ({ lat: s.lat, lon: s.lon, time: s.strike_time, nx: mercNX(s.lon), ny: mercNY(s.lat) }));
        stateRef.current.drawHeatmap?.();
      })
      .catch(() => {});
  };
  fetchViewportRef.current = fetchViewport;

  const scheduleFetchViewport = () => {
    if (viewportFetchTimerRef.current) clearTimeout(viewportFetchTimerRef.current);
    viewportFetchTimerRef.current = setTimeout(() => fetchViewportRef.current?.(), 400);
  };

  const fetchCellData = (bounds: { minLat: number; maxLat: number; minLon: number; maxLon: number }, page = 1) => {
    setApiLoading(true);
    const q = `minLat=${bounds.minLat}&maxLat=${bounds.maxLat}&minLon=${bounds.minLon}&maxLon=${bounds.maxLon}&page=${page}`;
    fetch(`/api/grid/area?${q}`)
      .then(r => r.json())
      .then(data => { setApiData(data); setApiLoading(false); })
      .catch(() => setApiLoading(false));
  };

  const stateRef = useRef<MapState>({
    map: null, tileLayer: null, labelsLayer: null,
    processed: new Set(),
    heatmapTimer: null,
    rings: [], liveDots: [], rafId: null, ready: false,
    heatCanvas: null, heatCtx: null, windCanvas: null, windCtx: null,
    windParticles: [], windScreenGrid: null, windWasActive: false, buildScreenGrid: null,
    dpr: 1, drawHeatmap: null,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const s = stateRef.current;

    import('leaflet').then(({ default: L }) => {
      if (s.map || !container) return;

      const savedView = (() => {
        try { const v = localStorage.getItem('mapView'); return v ? JSON.parse(v) : null; } catch { return null; }
      })();

      const worldBounds = L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180));
      const map = L.map(container, {
        center: savedView ? [savedView.lat, savedView.lng] : [20, 0],
        zoom: savedView ? savedView.zoom : 2,
        minZoom: 2, maxZoom: 12,
        zoomControl: true, attributionControl: false,
        maxBounds: worldBounds, maxBoundsViscosity: 1.0,
      });
      map.zoomControl.setPosition('bottomright');

      const scheduleWindFetch = () => {
        if (windFetchTimerRef.current) clearTimeout(windFetchTimerRef.current);
        windFetchTimerRef.current = setTimeout(() => {
          if (!windEnabledRef.current) return;
          const b = map.getBounds();
          const south = Math.max(-85, b.getSouth());
          const north = Math.min(85, b.getNorth());
          const west = b.getWest();
          const east = b.getEast();
          const COLS = 10, ROWS = 6;
          const lats: string[] = [], lons: string[] = [];
          for (let r = 0; r < ROWS; r++) {
            const lat = south + (north - south) * r / (ROWS - 1);
            for (let c = 0; c < COLS; c++) {
              lats.push(lat.toFixed(3));
              lons.push((west + (east - west) * c / (COLS - 1)).toFixed(3));
            }
          }
          fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC`
          )
            .then(r => r.json())
            .then(data => {
              const arr = Array.isArray(data) ? data : [data];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const points = arr.map((item: any) => {
                const speed = item?.current?.wind_speed_10m ?? 0;
                const dir = item?.current?.wind_direction_10m ?? 0;
                const rad = (dir * Math.PI) / 180;
                return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
              });
              windGridRef.current = { points, cols: COLS, rows: ROWS, south, north, west, east };
              buildScreenGrid();
            })
            .catch(() => {});
        }, 600);
      };

      map.on('moveend zoomend', () => {
        const c = map.getCenter();
        const z = map.getZoom();
        localStorage.setItem('mapView', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: z }));
        setZoom(z);
        s.drawHeatmap?.();
        scheduleFetchViewport();
        scheduleWindFetch();
        if (windGridRef.current) buildScreenGrid(); // reproject on pan/zoom
      });

      map.on('dragend', () => { lastDragEndRef.current = Date.now(); });

      setZoom(map.getZoom());

      const initTile = satelliteRef.current ? TILE_SAT : TILE_DARK;
      s.tileLayer = L.tileLayer(initTile.url, initTile.options).addTo(map);

      if (satelliteRef.current) {
        (map.getPanes().tilePane as HTMLElement).style.filter = 'brightness(0.55)';
      }

      map.createPane('labelsPane');
      (map.getPane('labelsPane') as HTMLElement).style.zIndex = '250';
      (map.getPane('labelsPane') as HTMLElement).style.pointerEvents = 'none';
      s.labelsLayer = L.tileLayer(TILE_LABELS_URL, { pane: 'labelsPane', maxZoom: 19, opacity: 0.4 });
      if (satelliteRef.current) s.labelsLayer.addTo(map);

      s.map = map;

      const dpr = window.devicePixelRatio || 1;
      s.dpr = dpr;

      // ── Heatmap canvas — sits between the Leaflet map pane (z=400) and the ring overlay (z=450) ──
      const heatCanvas = document.createElement('canvas');
      heatCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:401;';
      container.appendChild(heatCanvas);
      s.heatCanvas = heatCanvas;
      s.heatCtx = heatCanvas.getContext('2d')!;

      // ── Wind particle canvas (z-index 402, above dot layer) ──
      const windCanvas = document.createElement('canvas');
      windCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:402;';
      container.appendChild(windCanvas);
      s.windCanvas = windCanvas;
      s.windCtx = windCanvas.getContext('2d')!;

      // ── Strike ring overlay canvas (z-index 450) ──
      const overlay = document.createElement('canvas');
      overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:450;';
      container.appendChild(overlay);

      const WIND_N = 150;
      const WIND_TRAIL = 5;
      const WIND_SCALE = 0.4;
      const WIND_CELL = 50; // CSS px — screen grid cell size

      // Precompute a screen-space wind grid so the RAF loop never calls containerPointToLatLng
      const buildScreenGrid = () => {
        const geo = windGridRef.current;
        if (!geo) { s.windScreenGrid = null; return; }
        const css_w = container.offsetWidth;
        const css_h = container.offsetHeight;
        const cols = Math.ceil(css_w / WIND_CELL) + 2;
        const rows = Math.ceil(css_h / WIND_CELL) + 2;
        const dxdy = new Float32Array(cols * rows * 2);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const latlng = map.containerPointToLatLng([c * WIND_CELL, r * WIND_CELL]);
            const { u, v } = interpWind(latlng.lat, latlng.lng, geo);
            dxdy[(r * cols + c) * 2    ] = u * WIND_SCALE;
            dxdy[(r * cols + c) * 2 + 1] = -v * WIND_SCALE;
          }
        }
        s.windScreenGrid = { dxdy, cols, rows, cell: WIND_CELL };
      };
      s.buildScreenGrid = buildScreenGrid;

      const sizeCanvases = () => {
        const w = container.offsetWidth * dpr;
        const h = container.offsetHeight * dpr;
        overlay.width = w;   overlay.height = h;
        heatCanvas.width = w; heatCanvas.height = h;
        windCanvas.width = w; windCanvas.height = h;
      };
      sizeCanvases();
      const ro = new ResizeObserver(sizeCanvases);
      ro.observe(container);

      // ── Heatmap draw function ──
      // Five stepped zoom groups, each with a fixed display cell size and a fixed
      // geographic bin zoom. Within a group, zooming doesn't add geographic detail —
      // adjacent display cells share the same bin value (blocky but stable).
      s.drawHeatmap = () => {
        const hCtx = s.heatCtx;
        const hCnv = s.heatCanvas;
        if (!hCtx || !hCnv || !s.map) return;

        hCtx.clearRect(0, 0, hCnv.width, hCnv.height);

        hCtx.save();
        hCtx.scale(dpr, dpr);

        // Dot view — always on when heatmap is inactive. Window: 24h or 1h.
        if (!heatmapEnabledRef.current) {
          const windowMs = extend24hRef.current ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
          const nowMs = Date.now();
          const cutoff24h = nowMs - windowMs;
          const dotR = Math.max(2, 3 / dpr);
          // Normalize against the fixed window so colors are viewport-independent:
          // t=0 → oldest possible (cutoff), t=1 → now

          // Multi-stop gradient: dark purple → violet → red → orange → yellow
          type Stop = [number, number, number, number, number]; // pos, r, g, b, a
          const stops: Stop[] = [
            [0,    30,   0,   80, 0.20],
            [0.30, 120,  0,  160, 0.42],
            [0.55, 210,  10,  10, 0.65],
            [0.78, 255, 120,   0, 0.80],
            [1,    255, 230,   0, 0.92],
          ];
          const lerpStop = (t: number): [number, number, number, number] => {
            let i = 0;
            while (i < stops.length - 2 && stops[i + 1][0] <= t) i++;
            const s0 = stops[i], s1 = stops[i + 1];
            const f = s1[0] > s0[0] ? (t - s0[0]) / (s1[0] - s0[0]) : 0;
            return [
              Math.round(s0[1] + f * (s1[1] - s0[1])),
              Math.round(s0[2] + f * (s1[2] - s0[2])),
              Math.round(s0[3] + f * (s1[3] - s0[3])),
              +(s0[4] + f * (s1[4] - s0[4])).toFixed(2),
            ];
          };

          // Batch dots by color bucket — one fill() per bucket instead of per dot.
          // 20 buckets → ≤20 GPU state changes regardless of dot count.
          const N_BUCKETS = 20;
          const buckets: number[][] = Array.from({ length: N_BUCKETS }, () => []);

          // Screen transform from precomputed mercator coords: containerPoint = n * scale + offset.
          // One Leaflet call per redraw instead of one per point.
          const scale = 256 * Math.pow(2, s.map.getZoom());
          const org = s.map.latLngToContainerPoint([0, 0]);
          const ox = org.x - scale * 0.5;
          const oy = org.y - scale * 0.5;
          const cssW = hCnv.width / dpr;
          const cssH = hCnv.height / dpr;

          const binDot = (pt: HeatPoint) => {
            if (pt.time < cutoff24h) return;
            const x = pt.nx * scale + ox;
            if (x < -4 || x > cssW + 4) return;
            const y = pt.ny * scale + oy;
            if (y < -4 || y > cssH + 4) return;
            const t = Math.min(1, (pt.time - cutoff24h) / windowMs);
            const bi = Math.min(N_BUCKETS - 1, Math.floor(t * N_BUCKETS));
            buckets[bi].push(x, y);
          };
          for (let i = dbBufferRef.current.length - 1; i >= 0; i--) binDot(dbBufferRef.current[i]);
          for (const pt of heatmapBufferRef.current) binDot(pt);

          // Draw oldest buckets first so newer (brighter) paint on top
          for (let b = 0; b < N_BUCKETS; b++) {
            const flat = buckets[b];
            if (flat.length === 0) continue;
            const [r, g, bc, a] = lerpStop((b + 0.5) / N_BUCKETS);
            hCtx.fillStyle = `rgba(${r},${g},${bc},${a})`;
            hCtx.beginPath();
            for (let i = 0; i < flat.length; i += 2) {
              hCtx.moveTo(flat[i] + dotR, flat[i + 1]);
              hCtx.arc(flat[i], flat[i + 1], dotR, 0, Math.PI * 2);
            }
            hCtx.fill();
          }

          hCtx.restore();
          return;
        }

        const zoom = s.map.getZoom();
        const { displayPx, binZoom } = (binLockedRef.current && lockedLevelRef.current)
          ? lockedLevelRef.current
          : getHeatmapLevel(zoom);
        const KEY_MULT = CELL_KEY_MULT;

        const cutoff = Date.now() - WINDOW_MS[timeWindowRef.current];

        // Viewport bounds in binZoom tile-pixel space — computed once, reused for binning + drawing
        const bounds = s.map.getBounds();
        const swP = s.map.project(bounds.getSouthWest(), binZoom);
        const neP = s.map.project(bounds.getNorthEast(), binZoom);
        const colMin = Math.floor(Math.min(swP.x, neP.x) / displayPx) - 1;
        const colMax = Math.ceil( Math.max(swP.x, neP.x) / displayPx) + 1;
        const rowMin = Math.floor(Math.min(swP.y, neP.y) / displayPx) - 1;
        const rowMax = Math.ceil( Math.max(swP.y, neP.y) / displayPx) + 1;

        // Bin only visible strikes — skip anything outside the current viewport
        // Bin visible strikes from live buffer + historical DB buffer
        const grid = new Map<number, number>();
        let maxCount = 0;
        const binScale = 256 * Math.pow(2, binZoom); // world pixels at binZoom, from precomputed mercator
        const binPoint = (pt: HeatPoint) => {
          if (pt.time < cutoff) return;
          const col = Math.floor(pt.nx * binScale / displayPx);
          const row = Math.floor(pt.ny * binScale / displayPx);
          if (col < colMin || col > colMax || row < rowMin || row > rowMax) return;
          const key = row * KEY_MULT + col;
          const n = (grid.get(key) ?? 0) + 1;
          grid.set(key, n);
          if (n > maxCount) maxCount = n;
        };
        for (const pt of heatmapBufferRef.current) binPoint(pt);
        for (const pt of dbBufferRef.current) binPoint(pt);

        hCtx.save();
        hCtx.globalAlpha = gridOpacityRef.current;

        // 1) Fill bins that have strikes — projected to current screen size
        for (const [key, count] of grid) {
          const row = Math.floor(key / KEY_MULT);
          const col = key % KEY_MULT;
          if (col < colMin || col > colMax || row < rowMin || row > rowMax) continue;

          const sw = s.map.latLngToContainerPoint(
            s.map.unproject({ x:  col      * displayPx, y: (row + 1) * displayPx }, binZoom)
          );
          const ne = s.map.latLngToContainerPoint(
            s.map.unproject({ x: (col + 1) * displayPx, y:  row      * displayPx }, binZoom)
          );
          const x = Math.min(sw.x, ne.x);
          const y = Math.min(sw.y, ne.y);
          const w = Math.abs(ne.x - sw.x);
          const h = Math.abs(sw.y - ne.y);
          if (w < 0.5 || h < 0.5) continue;
          hCtx.fillStyle = getHeatColor(count, maxCount);
          hCtx.fillRect(x, y, w, h);
        }

        // 1b) Flash overlay — cells that received a new strike recently
        const flashNow = Date.now();
        for (const [fKey, startTime] of cellFlashMapRef.current) {
          const elapsed = flashNow - startTime;
          if (elapsed >= FLASH_DURATION_MS) { cellFlashMapRef.current.delete(fKey); continue; }
          const t = elapsed / FLASH_DURATION_MS;
          const fRow = Math.floor(fKey / KEY_MULT);
          const fCol = fKey % KEY_MULT;
          const fsw = s.map.latLngToContainerPoint(
            s.map.unproject({ x: fCol * displayPx, y: (fRow + 1) * displayPx }, binZoom)
          );
          const fne = s.map.latLngToContainerPoint(
            s.map.unproject({ x: (fCol + 1) * displayPx, y: fRow * displayPx }, binZoom)
          );
          const fx = Math.min(fsw.x, fne.x);
          const fy = Math.min(fsw.y, fne.y);
          const fw = Math.abs(fne.x - fsw.x);
          const fh = Math.abs(fsw.y - fne.y);
          hCtx.fillStyle = `rgba(255,230,80,${((1 - t) * 0.75).toFixed(3)})`;
          hCtx.fillRect(fx, fy, fw, fh);
        }

        // 2) Labels: strike count centered on cells that have strikes
        hCtx.textBaseline = 'middle';
        hCtx.textAlign = 'center';
        for (const [key, count] of grid) {
          const row = Math.floor(key / KEY_MULT);
          const col = key % KEY_MULT;
          if (col < colMin || col > colMax || row < rowMin || row > rowMax) continue;
          const sw = s.map.latLngToContainerPoint(
            s.map.unproject({ x:  col      * displayPx, y: (row + 1) * displayPx }, binZoom)
          );
          const ne = s.map.latLngToContainerPoint(
            s.map.unproject({ x: (col + 1) * displayPx, y:  row      * displayPx }, binZoom)
          );
          const cx = Math.min(sw.x, ne.x);
          const cy = Math.min(sw.y, ne.y);
          const cw = Math.abs(ne.x - sw.x);
          const ch = Math.abs(sw.y - ne.y);
          if (cw < 24 || ch < 24) continue;
          const fontSize = Math.round(Math.max(9, Math.min(cw * 0.22, 13)));
          hCtx.font = `${fontSize}px monospace`;
          hCtx.fillStyle = 'rgba(255,255,255,0.95)';
          hCtx.fillText(String(count), cx + cw * 0.5, cy + ch * 0.5);
        }

        hCtx.restore();

        // 3) Grid lines — projected from bin boundaries (matches the cell size on screen)
        hCtx.strokeStyle = binLockedRef.current ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.2)';
        hCtx.lineWidth = 0.75;
        hCtx.beginPath();
        for (let c = colMin; c <= colMax + 1; c++) {
          const p1 = s.map.latLngToContainerPoint(s.map.unproject({ x: c * displayPx, y: rowMin * displayPx }, binZoom));
          const p2 = s.map.latLngToContainerPoint(s.map.unproject({ x: c * displayPx, y: rowMax * displayPx }, binZoom));
          hCtx.moveTo(p1.x, p1.y);
          hCtx.lineTo(p2.x, p2.y);
        }
        for (let r = rowMin; r <= rowMax + 1; r++) {
          const p1 = s.map.latLngToContainerPoint(s.map.unproject({ x: colMin * displayPx, y: r * displayPx }, binZoom));
          const p2 = s.map.latLngToContainerPoint(s.map.unproject({ x: colMax * displayPx, y: r * displayPx }, binZoom));
          hCtx.moveTo(p1.x, p1.y);
          hCtx.lineTo(p2.x, p2.y);
        }
        hCtx.stroke();

        // 4) Highlight selected cell or area
        const sel = selectedCellRef.current;
        if (sel) {
          const sw = s.map.latLngToContainerPoint([sel.bounds.minLat, sel.bounds.minLon]);
          const ne = s.map.latLngToContainerPoint([sel.bounds.maxLat, sel.bounds.maxLon]);
          const sx = Math.min(sw.x, ne.x);
          const sy = Math.min(sw.y, ne.y);
          const sw2 = Math.abs(ne.x - sw.x);
          const sh = Math.abs(sw.y - ne.y);
          hCtx.strokeStyle = 'rgba(255, 220, 0, 0.95)';
          hCtx.lineWidth = 2 / dpr;
          hCtx.strokeRect(sx + 1 / dpr, sy + 1 / dpr, sw2 - 2 / dpr, sh - 2 / dpr);
        }

        // 6) Live selection rectangle during shift+drag
        const selRect = selectRectRef.current;
        if (selRect) {
          const rx = Math.min(selRect.x1, selRect.x2);
          const ry = Math.min(selRect.y1, selRect.y2);
          const rw = Math.abs(selRect.x2 - selRect.x1);
          const rh = Math.abs(selRect.y2 - selRect.y1);
          hCtx.fillStyle = 'rgba(255, 220, 0, 0.08)';
          hCtx.fillRect(rx, ry, rw, rh);
          hCtx.strokeStyle = 'rgba(255, 220, 0, 0.9)';
          hCtx.lineWidth = 2 / dpr;
          hCtx.setLineDash([6 / dpr, 3 / dpr]);
          hCtx.strokeRect(rx + 1 / dpr, ry + 1 / dpr, rw - 2 / dpr, rh - 2 / dpr);
          hCtx.setLineDash([]);
        }

        hCtx.restore();
      };

      // Refresh heatmap every 5 seconds to pick up new strikes
      s.heatmapTimer = setInterval(() => { if (!document.hidden) s.drawHeatmap?.(); }, 5_000);

      // ── Ring animation RAF loop ──
      // Full 60fps only while rings animate, wind is on, or the map is moving.
      // Otherwise the overlay only holds slow-fading dots — 4fps is plenty.
      const ctx = overlay.getContext('2d')!;
      let lastMoveAt = 0;
      map.on('move', () => { lastMoveAt = performance.now(); });
      let lastOverlayDraw = 0;
      const drawRings = (now: number) => {
        const animating = s.rings.length > 0
          || (windEnabledRef.current && s.windScreenGrid)
          || s.windWasActive
          || now - lastMoveAt < 300;
        if (!animating && now - lastOverlayDraw < 250) {
          s.rafId = requestAnimationFrame(drawRings);
          return;
        }
        lastOverlayDraw = now;

        ctx.clearRect(0, 0, overlay.width, overlay.height);

        // Screen transform from precomputed mercator coords — one Leaflet call per frame
        const scale = 256 * Math.pow(2, map.getZoom());
        const org = map.latLngToContainerPoint([0, 0]);
        const ox = org.x - scale * 0.5;
        const oy = org.y - scale * 0.5;

        if (s.rings.length > 0) {
          ctx.save();
          ctx.scale(dpr, dpr);

          const zoom = map.getZoom();
          const metersPerPx = 156_543 / Math.pow(2, zoom);
          const soundMaxPx = Math.max(160, Math.min(600, Math.round(25_000 / metersPerPx)));
          const hmActive = heatmapEnabledRef.current;

          let i = s.rings.length;
          while (i--) {
            const ring = s.rings[i];
            if (ring.zoomed) {
              if (zoom < 11) continue;
              const p = Math.min((now - ring.startTime) / 73_000, 1);
              if (p >= 1) { s.rings.splice(i, 1); continue; }
              if (p <= 0 || hmActive) continue;
              ctx.beginPath();
              ctx.arc(ring.nx * scale + ox, ring.ny * scale + oy, Math.max(1, soundMaxPx * p), 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(255,255,255,${(Math.pow(1 - p, 2) * 0.85).toFixed(3)})`;
              ctx.lineWidth = 0.5 + (1 - p) * 2.5;
              ctx.stroke();
            } else {
              if (zoom >= 11) continue;
              const p = Math.min((now - ring.startTime) / 600, 1);
              if (p >= 1) { s.rings.splice(i, 1); continue; }
              if (p <= 0 || hmActive) continue;
              ctx.beginPath();
              ctx.arc(ring.nx * scale + ox, ring.ny * scale + oy, Math.max(1, Math.sqrt(p) * 40), 0, Math.PI * 2);
              ctx.strokeStyle = `rgba(255,220,60,${(Math.pow(1 - p, 1.5) * 0.95).toFixed(3)})`;
              ctx.lineWidth = 2.5 * (1 - p) + 0.5;
              ctx.stroke();
            }
          }

          ctx.restore();
        }

        // Live strike dots drawn on top (z=450) whenever the dot view is active
        if (!heatmapEnabledRef.current && s.liveDots.length > 0) {
          ctx.save();
          ctx.scale(dpr, dpr);
          const nowMs = Date.now();
          const maxAge = 30 * 60 * 1000;
          let j = s.liveDots.length;
          while (j--) {
            const dot = s.liveDots[j];
            const age = nowMs - dot.addedAt;
            if (age > maxAge) { s.liveDots.splice(j, 1); continue; }
            const alpha = Math.pow(1 - age / maxAge, 0.4); // slow fade
            const radius = age < 10_000 ? 4 : 3;
            ctx.beginPath();
            ctx.arc(dot.nx * scale + ox, dot.ny * scale + oy, radius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,224,64,${alpha.toFixed(3)})`;
            ctx.fill();
            if (age < 10_000) {
              ctx.strokeStyle = `rgba(255,34,34,${Math.min(1, alpha * 1.4).toFixed(3)})`;
              ctx.lineWidth = 2.5;
              ctx.stroke();
            }
          }
          ctx.restore();
        }

        // Wind particle layer — screen-space grid lookup, one stroke per particle
        if (s.windCanvas && s.windCtx) {
          const wCtx = s.windCtx;
          const wCnv = s.windCanvas;
          const sg = s.windScreenGrid;
          if (windEnabledRef.current && sg) {
            const css_w = wCnv.width / dpr;
            const css_h = wCnv.height / dpr;
            s.windWasActive = true;

            if (s.windParticles.length === 0) {
              for (let i = 0; i < WIND_N; i++) {
                s.windParticles.push({
                  x: Math.random() * css_w,
                  y: Math.random() * css_h,
                  trail: [],
                  age: Math.floor(Math.random() * 100),
                  maxAge: 80 + Math.floor(Math.random() * 160),
                });
              }
            }

            wCtx.clearRect(0, 0, wCnv.width, wCnv.height);
            wCtx.save();
            wCtx.scale(dpr, dpr);
            wCtx.strokeStyle = 'rgba(180,220,255,0.4)';
            wCtx.lineWidth = 1;
            wCtx.lineCap = 'round';

            for (const p of s.windParticles) {
              // Look up precomputed screen-space wind (no Leaflet calls per frame)
              const ci = Math.max(0, Math.min(sg.cols - 1, Math.floor(p.x / sg.cell)));
              const ri = Math.max(0, Math.min(sg.rows - 1, Math.floor(p.y / sg.cell)));
              const base = (ri * sg.cols + ci) * 2;
              const dx = sg.dxdy[base], dy = sg.dxdy[base + 1];

              p.trail.push([p.x, p.y]);
              if (p.trail.length > WIND_TRAIL) p.trail.shift();

              p.x += dx;
              p.y += dy;
              p.age++;

              if (p.x < -5 || p.x > css_w + 5 || p.y < -5 || p.y > css_h + 5 || p.age > p.maxAge) {
                p.x = Math.random() * css_w;
                p.y = Math.random() * css_h;
                p.trail = [];
                p.age = 0;
                p.maxAge = 80 + Math.floor(Math.random() * 160);
                continue;
              }

              if (p.trail.length < 2) continue;
              // One stroke per particle (not per segment) — avoids 150k GPU state changes/sec
              wCtx.beginPath();
              wCtx.moveTo(p.trail[0][0], p.trail[0][1]);
              for (let i = 1; i < p.trail.length; i++) wCtx.lineTo(p.trail[i][0], p.trail[i][1]);
              wCtx.stroke();
            }

            wCtx.restore();
          } else if (s.windWasActive) {
            // Only clear when transitioning from active → inactive
            wCtx.clearRect(0, 0, wCnv.width, wCnv.height);
            s.windWasActive = false;
          }
        }

        s.rafId = requestAnimationFrame(drawRings);
      };
      s.rafId = requestAnimationFrame(drawRings);

      s.ready = true;

      // Always seed DB data on load
      fetchViewportRef.current?.();
    });

    return () => {
      const s = stateRef.current;
      if (s.heatmapTimer) clearInterval(s.heatmapTimer);
      if (s.rafId !== null) cancelAnimationFrame(s.rafId);
      if (flashRafRef.current !== null) cancelAnimationFrame(flashRafRef.current);
      if (windFetchTimerRef.current) clearTimeout(windFetchTimerRef.current);
      s.map?.remove();
      s.map = null;
      s.ready = false;
    };
  }, []);

  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready || !s.tileLayer) return;
    s.tileLayer.setUrl(satellite ? TILE_SAT.url : TILE_DARK.url);
    (s.map.getPanes().tilePane as HTMLElement).style.filter = satellite ? 'brightness(0.55)' : '';
    if (satellite) { s.labelsLayer.addTo(s.map); } else { s.labelsLayer.remove(); }
  }, [satellite]);

  // Native click + shift+drag handlers on the map container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = (e: MouseEvent) => {
      const s = stateRef.current;
      if (!s.map || !heatmapEnabledRef.current) return;
      if (window.matchMedia('(pointer: coarse)').matches) return;
      if (Date.now() - lastDragEndRef.current < 300) return;
      if (isSelectingRef.current) return;
      const rect = container.getBoundingClientRect();
      const latlng = s.map.containerPointToLatLng([e.clientX - rect.left, e.clientY - rect.top]);

      const { binZoom, displayPx } = (binLockedRef.current && lockedLevelRef.current)
        ? lockedLevelRef.current
        : getHeatmapLevel(s.map.getZoom());
      const p = s.map.project(latlng, binZoom);
      const col = Math.floor(p.x / displayPx);
      const row = Math.floor(p.y / displayPx);

      const sw = s.map.unproject({ x: col * displayPx, y: (row + 1) * displayPx }, binZoom);
      const ne = s.map.unproject({ x: (col + 1) * displayPx, y: row * displayPx }, binZoom);
      const bounds = {
        minLat: Math.min(sw.lat, ne.lat),
        maxLat: Math.max(sw.lat, ne.lat),
        minLon: Math.min(sw.lng, ne.lng),
        maxLon: Math.max(sw.lng, ne.lng),
      };

      const cutoff = Date.now() - WINDOW_MS[timeWindowRef.current];
      const inMemory = heatmapBufferRef.current.filter(pt =>
        pt.time >= cutoff &&
        pt.lat >= bounds.minLat && pt.lat <= bounds.maxLat &&
        pt.lon >= bounds.minLon && pt.lon <= bounds.maxLon
      );

      setSelectedCell({
        id: `${col},${row}`, col, row, count: inMemory.length,
        strikes: [...inMemory].sort((a, b) => b.time - a.time),
        binZoom, displayPx, bounds,
      });
      setApiData(null);
      fetchCellData(bounds);
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (!e.shiftKey) return;
      const s = stateRef.current;
      if (!s.map || !heatmapEnabledRef.current) return;
      if (window.matchMedia('(pointer: coarse)').matches) return;
      e.preventDefault();
      const cRect = container.getBoundingClientRect();
      const x = e.clientX - cRect.left;
      const y = e.clientY - cRect.top;
      isSelectingRef.current = true;
      selectStartRef.current = { x, y };
      selectRectRef.current = { x1: x, y1: y, x2: x, y2: y };
      s.map.dragging.disable();
      container.style.cursor = 'crosshair';
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isSelectingRef.current || !selectStartRef.current) return;
      const cRect = container.getBoundingClientRect();
      const x = e.clientX - cRect.left;
      const y = e.clientY - cRect.top;
      selectRectRef.current = { x1: selectStartRef.current.x, y1: selectStartRef.current.y, x2: x, y2: y };
      stateRef.current.drawHeatmap?.();
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!isSelectingRef.current) return;
      isSelectingRef.current = false;
      container.style.cursor = '';
      const s = stateRef.current;
      s.map?.dragging.enable();

      const rect = selectRectRef.current;
      selectRectRef.current = null;

      if (!rect || !s.map) { s.drawHeatmap?.(); return; }

      const minX = Math.min(rect.x1, rect.x2);
      const maxX = Math.max(rect.x1, rect.x2);
      const minY = Math.min(rect.y1, rect.y2);
      const maxY = Math.max(rect.y1, rect.y2);

      // Tiny drag — ignore, clear canvas rect
      if (maxX - minX < 10 || maxY - minY < 10) { s.drawHeatmap?.(); return; }

      // Suppress the click event that fires immediately after mouseup
      lastDragEndRef.current = Date.now();

      const sw = s.map.containerPointToLatLng([minX, maxY]);
      const ne = s.map.containerPointToLatLng([maxX, minY]);
      const bounds = {
        minLat: Math.min(sw.lat, ne.lat),
        maxLat: Math.max(sw.lat, ne.lat),
        minLon: Math.min(sw.lng, ne.lng),
        maxLon: Math.max(sw.lng, ne.lng),
      };

      const cutoff = Date.now() - WINDOW_MS[timeWindowRef.current];
      const inMemory = heatmapBufferRef.current.filter(pt =>
        pt.time >= cutoff &&
        pt.lat >= bounds.minLat && pt.lat <= bounds.maxLat &&
        pt.lon >= bounds.minLon && pt.lon <= bounds.maxLon
      );

      const { binZoom, displayPx } = (binLockedRef.current && lockedLevelRef.current)
        ? lockedLevelRef.current
        : getHeatmapLevel(s.map.getZoom());
      setSelectedCell({
        id: 'area', col: 0, row: 0, count: inMemory.length,
        strikes: [...inMemory].sort((a, b) => b.time - a.time),
        binZoom, displayPx, bounds,
      });
      setApiData(null);
      fetchCellData(bounds);
    };

    container.addEventListener('click', handleClick);
    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      container.removeEventListener('click', handleClick);
      container.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Keep selectedCellRef in sync and redraw highlight
  useEffect(() => {
    selectedCellRef.current = selectedCell
      ? { col: selectedCell.col, row: selectedCell.row, binZoom: selectedCell.binZoom, displayPx: selectedCell.displayPx, bounds: selectedCell.bounds }
      : null;
    const s = stateRef.current;
    if (s.ready && s.drawHeatmap) s.drawHeatmap();
  }, [selectedCell]);

  // Refetch + redraw when heatmap or 24h window changes
  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready) return;
    dbBufferRef.current = [];
    s.drawHeatmap?.();
    fetchViewportRef.current?.();
  }, [heatmapEnabled]);

  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready) return;
    dbBufferRef.current = [];
    s.drawHeatmap?.();
    fetchViewportRef.current?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extend24h]);

  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready) return;
    dbBufferRef.current = [];
    s.drawHeatmap?.();
    scheduleFetchViewport();
  }, [timeWindow]);

  useEffect(() => {
    const s = stateRef.current;
    if (!windEnabled) {
      windGridRef.current = null;
      s.windScreenGrid = null;
      s.windParticles = [];
      return;
    }
    if (!s.map) return;
    const b = s.map.getBounds();
    const south = Math.max(-85, b.getSouth());
    const north = Math.min(85, b.getNorth());
    const west = b.getWest();
    const east = b.getEast();
    const COLS = 10, ROWS = 6;
    const lats: string[] = [], lons: string[] = [];
    for (let r = 0; r < ROWS; r++) {
      const lat = south + (north - south) * r / (ROWS - 1);
      for (let c = 0; c < COLS; c++) {
        lats.push(lat.toFixed(3));
        lons.push((west + (east - west) * c / (COLS - 1)).toFixed(3));
      }
    }
    fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC`
    )
      .then(r => r.json())
      .then(data => {
        const arr = Array.isArray(data) ? data : [data];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const points = arr.map((item: any) => {
          const speed = item?.current?.wind_speed_10m ?? 0;
          const dir = item?.current?.wind_direction_10m ?? 0;
          const rad = (dir * Math.PI) / 180;
          return { u: -speed * Math.sin(rad), v: -speed * Math.cos(rad) };
        });
        windGridRef.current = { points, cols: COLS, rows: ROWS, south, north, west, east };
        s.buildScreenGrid?.();
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windEnabled]);

  useEffect(() => {
    const s = stateRef.current;
    if (!s.ready || strikes.length === 0) return;

    let scheduledTicks = 0;
    const newPoints: HeatPoint[] = []; // collected newest-first, appended oldest-first below
    for (const strike of strikes) {
      if (s.processed.has(strike.id)) break;
      s.processed.add(strike.id);

      const nx = mercNX(strike.lon);
      const ny = mercNY(strike.lat);

      newPoints.push({ lat: strike.lat, lon: strike.lon, time: strike.time, nx, ny });

      if (!strike.id.startsWith('hist-')) {
        const zoom = s.map.getZoom();
        // Stagger ring starts across the batch window so pulses stay continuous
        s.rings.push({ nx, ny, startTime: performance.now() + Math.random() * 700, zoomed: zoom >= 11 });
        s.liveDots.push({ nx, ny, addedAt: Date.now() });

        if (heatmapEnabledRef.current) {
          const { displayPx, binZoom } = (binLockedRef.current && lockedLevelRef.current)
            ? lockedLevelRef.current
            : getHeatmapLevel(zoom);
          const binScale = 256 * Math.pow(2, binZoom);
          const col = Math.floor(nx * binScale / displayPx);
          const row = Math.floor(ny * binScale / displayPx);
          cellFlashMapRef.current.set(row * CELL_KEY_MULT + col, Date.now());
          startFlashLoop();
        }

        if (soundRef.current && scheduledTicks < 12 && s.map.getBounds().contains([strike.lat, strike.lon])) {
          if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
          scheduledTicks++;
          // Spread ticks across the batch window instead of firing all at once
          setTimeout(() => {
            const now = performance.now();
            if (now - lastTickRef.current > 30) {
              lastTickRef.current = now;
              playTick(audioCtxRef.current!);
            }
          }, Math.random() * 700);
        }
      }
    }

    // Keep the heatmap buffer ascending by time — the 72h prune scans from the front
    for (let i = newPoints.length - 1; i >= 0; i--) heatmapBufferRef.current.push(newPoints[i]);

    // `processed` iterates in insertion order — drop oldest ids once well past the
    // 20k strikes the list can hold, so the break-at-first-seen loop stays valid
    if (s.processed.size > 30_000) {
      const it = s.processed.values();
      while (s.processed.size > 20_000) s.processed.delete(it.next().value as string);
    }

    // Prune heatmap buffer: keep last 72h, cap at 50k entries
    const buf = heatmapBufferRef.current;
    const cutoff72h = Date.now() - 3 * 24 * 60 * 60 * 1000;
    let start = 0;
    while (start < buf.length && buf[start].time < cutoff72h) start++;
    if (start > 0) heatmapBufferRef.current = buf.slice(start);
    if (heatmapBufferRef.current.length > 50_000) {
      heatmapBufferRef.current = heatmapBufferRef.current.slice(-50_000);
    }

    // Redraw heatmap to show newly arrived strikes
    s.drawHeatmap?.();
  }, [strikes]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#0a0a0f' }} />
      {!historyLoaded && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: '#0a0a0f', zIndex: 9999,
        }}>
          <span style={{ color: '#888', fontSize: '0.95rem', letterSpacing: '0.05em' }}>Loading strikes…</span>
        </div>
      )}
      {zoom !== null && (
        <div className="zoom-debug">z{zoom}</div>
      )}
      {heatmapEnabled && selectedCell && (
        <div className="cell-drawer open">
          <div className="cell-drawer-header">
            <span>{selectedCell.id === 'area' ? 'Area selection' : `Cell ${selectedCell.id}`}</span>
            <button className="cell-drawer-close" onClick={() => { setSelectedCell(null); setApiData(null); }}>×</button>
          </div>

          <div className="cell-drawer-section">
            {apiLoading && <div className="cell-drawer-empty">Loading…</div>}

            {apiData && (
              <>
                <div className="cell-drawer-count">
                  {apiData.total.toLocaleString()} <span>archived strikes</span>
                </div>

                {apiData.total === 0 ? (
                  <div className="cell-drawer-empty">No archived data yet — strikes are stored as they arrive.</div>
                ) : (
                  <>
                    <table className="cell-strike-table">
                      <tbody>
                        {apiData.strikes.map((s) => (
                          <tr key={s.id}>
                            <td>{formatDateTime(s.strike_time)}</td>
                            <td>{s.lat.toFixed(3)}</td>
                            <td>{s.lon.toFixed(3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    {apiData.pages > 1 && (
                      <div className="cell-pagination">
                        <button
                          className="cell-pg-btn"
                          disabled={apiData.page <= 1}
                          onClick={() => fetchCellData(selectedCell.bounds, apiData.page - 1)}
                        >‹</button>
                        <span className="cell-pg-info">{apiData.page} / {apiData.pages}</span>
                        <button
                          className="cell-pg-btn"
                          disabled={apiData.page >= apiData.pages}
                          onClick={() => fetchCellData(selectedCell.bounds, apiData.page + 1)}
                        >›</button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {heatmapEnabled && (
        <div className="heatmap-filter">
          <span className="heatmap-filter-label">Heatmap interval</span>
          <div className="heatmap-filter-buttons">
            {(['30m', '1h', '3h', '1d'] as HeatmapWindow[]).map(w => (
              <button
                key={w}
                className={`hm-filter-btn${timeWindow === w ? ' active' : ''}`}
                onClick={() => setTimeWindow(w)}
              >
                {WINDOW_LABELS[w]}
              </button>
            ))}
            <button
              className={`hm-filter-btn${binLocked ? ' active' : ''}`}
              onClick={() => {
                setBinLocked(locked => {
                  const next = !locked;
                  binLockedRef.current = next;
                  if (next) {
                    const z = stateRef.current.map?.getZoom() ?? 6;
                    const level = getHeatmapLevel(z);
                    lockedLevelRef.current = level;
                    localStorage.setItem('gridLockedLevel', JSON.stringify(level));
                    localStorage.setItem('gridBinLocked', 'true');
                  } else {
                    lockedLevelRef.current = null;
                    localStorage.removeItem('gridLockedLevel');
                    localStorage.setItem('gridBinLocked', 'false');
                    stateRef.current.drawHeatmap?.();
                  }
                  return next;
                });
              }}
              title={binLocked ? 'Unlock grid zoom level' : 'Lock grid zoom level'}
            >
              {binLocked ? 'Unlock grid' : 'Lock grid'}
            </button>
          </div>
          <label className="hm-opacity-label">
            Opacity
            <input
              type="range"
              className="hm-opacity-slider"
              min={0.1}
              max={1}
              step={0.05}
              value={gridOpacity}
              onChange={e => {
                const v = parseFloat(e.target.value);
                setGridOpacity(v);
                localStorage.setItem('gridOpacity', String(v));
                stateRef.current.drawHeatmap?.();
              }}
            />
            <span>{Math.round(gridOpacity * 100)}%</span>
          </label>
        </div>
      )}
    </div>
  );
}
